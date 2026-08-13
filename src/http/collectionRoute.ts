// The AEP standard-methods surface for one collection, generated from a spec: list (`?max_page_size`,
// `?page_token`, `?show_deleted`, per-row access hints), get, create (`?id`), patch (`If-Match`), delete
// (`?force` = purge), the shared lifecycle custom methods, `:restore`, and the collection's own custom methods.
// Every collection that exposes the standard methods is built here - that is the single lane, and
// test/collectionLaneDrift.test.ts fails any route file that hand-rolls it instead.
//
// Access control is untouched: every handler here is reached only through the authz middleware, which remains
// the single source of authorization. The factory decides no permission - it only shapes requests.
//
// The factory owns TRANSPORT, never domain logic. A collection's rules live in its service: `insert`/`patch`
// map the wire to columns, `list` keeps a scope-filtered query, `overrides` replaces one generic method, and a
// verb's `run` is just its service call. Bespoke services (payroll, settlements, ATS) stay bespoke behind them.
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { ZodTypeAny } from "zod";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import { customMethod } from "./customMethod";
import { lifecycleVerb } from "./lifecycleRoute";
import { withAccess } from "./accessHint";
import { clampPageSize } from "./pagination";
import { crudService, type CrudService, type CrudSpec, type CrudTable } from "../services/crud";

/**
 * One custom method. The common shape is `{schema?, run}`: the factory parses the body, calls `run`, then
 * serializes the returned row with the item access hint - the parse/call/serialize/hint block every verb used
 * to repeat by hand. `{raw}` is the escape for a verb that does not answer with a resource (streams bytes,
 * returns a receipt), and it owns its whole Response.
 */
export type VerbEntry =
  | {
      schema?: ZodTypeAny;
      run: (deps: Deps, user: AppUser, id: string, body: any, c: Context<AppEnv>) => Promise<unknown>;
      raw?: never;
    }
  | {
      raw: (c: Context<AppEnv>, id: string) => Promise<Response>;
      run?: never;
      schema?: never;
    };

/**
 * The paging the factory already resolved from the query string, handed to a route-level `list` so it does not
 * re-derive it. Every list hook used to open with the same three lines, which is copy-paste in exactly the
 * position that produced the drift this factory exists to remove.
 */
export type PageRequest = {
  /** `?max_page_size`, clamped to the 100-row truncation cap (test/listTruncation.test.ts). */
  maxPageSize: number;
  /** `?page_token`, the opaque cursor as sent. */
  pageToken?: string;
  /** `?show_deleted=true`: include soft-deleted rows. */
  showDeleted: boolean;
};

export type CollectionRouteSpec<I, T extends CrudTable = CrudTable> = CrudSpec<I, T> & {
  /** The item path param, matching the name OpenAPI declares (`holiday_id`). */
  param: string;
  /** Body schema for both POST and PATCH, when they take the same fields. */
  writeSchema?: ZodTypeAny;
  /** POST-only body schema, when create demands fields that patch forbids (a card needs its board). */
  createSchema?: ZodTypeAny;
  /** PATCH-only body schema. */
  updateSchema?: ZodTypeAny;
  /**
   * Row -> wire resource. Receives the caller when the resource itself depends on who is looking: an event-log
   * payload is redacted below super, an employee's signature marker is owner-only. Most serializers ignore it.
   */
  serialize: (row: any, user?: AppUser) => unknown;
  /** `singular` for the lifecycle verbs' audit actions, when it differs from `auditName`. */
  lifecycleName?: string;
  /**
   * Set false for a collection whose rows are HISTORY: an effective-dated position or compensation row is
   * superseded, never deleted, so it gets no DELETE and no `:restore` even though its table carries a
   * delete_time column (that column exists for the employee-level cascade, not for a caller). Leaving this
   * unset keeps the table's own answer - see `softDeletable` below.
   */
  softDelete?: false;
  publish?: boolean; // resource supports :publish/:unpublish
  publishTime?: boolean; // also stamp publish_time on publish
  /** Replace individual generic service methods, keeping the rest (a bespoke create, a bespoke get, ...). */
  overrides?: Partial<CrudService<I>>;
  /**
   * Replaces the generic list. Takes the context because a scoped list needs `c.get("scope")` (the SQL-level
   * row filter the middleware computed) and often its own `?employee` / `?from` / `?to` filters - things a
   * service-level signature cannot see. `page` is the standard paging, already resolved. The factory still owns
   * the response shape and the access hints.
   */
  list?: (c: Context<AppEnv>, page: PageRequest) => Promise<{ items: any[]; nextPageToken?: string; extra?: Record<string, unknown> }>;
  /** This collection's own custom methods, by verb. Reached after the lifecycle verbs and `:restore`. */
  verbs?: Record<string, VerbEntry>;
};

export function collectionRoutes<I, T extends CrudTable = CrudTable>(spec: CollectionRouteSpec<I, T>) {
  const svc: CrudService<I> = { ...crudService(spec), ...spec.overrides };
  const { param, collection, serialize } = spec;
  const createSchema = spec.createSchema ?? spec.writeSchema;
  const updateSchema = spec.updateSchema ?? spec.writeSchema;
  const itemId = (c: Context<AppEnv>) => c.req.param(param)!;
  // Derived data is attached HERE, on the one path every answer passes through, so no method can bypass it. It
  // used to be applied inside crudService, which an `overrides` entry replaced wholesale - that is how
  // employees' profile flags went missing from its item read - and a route-level `list` skipped it entirely, so
  // 13 collections computed the same field a second time in their list hook, in a second shape.
  const decorate = async (c: Context<AppEnv>, rows: any[]) =>
    spec.decorate && rows.length ? spec.decorate(c.get("deps"), c.get("user"), rows) : rows;
  // An item response carries the per-object-merged grant (a share can lift a caller above their role), so the
  // SPA's affordances on a single record are share-accurate. Lists pass the role grant - one grant, many rows.
  const item = async (c: Context<AppEnv>, row: { code?: string | null } | undefined) => {
    const [decorated] = await decorate(c, row ? [row] : []);
    const res = serialize(decorated ?? row, c.get("user")) as object;
    return c.json(withAccess(res, c.get("user"), collection, row?.code, c.get("objectGrant"), hintVerbs));
  };
  // Soft delete is a property of the TABLE: an append-only collection (event-log, cron-runs) has no
  // `delete_time` column, so it gets no DELETE and no `:restore` rather than a route that writes a column
  // which does not exist. Same rule the lifecycle verbs follow (http/lifecycleRoute.ts). `softDelete: false`
  // additionally opts a history collection out even though its table could store the mark.
  const softDeletable = spec.softDelete !== false && !!(spec.table as Record<string, unknown>).deleteTime;
  // A method exists if EITHER the generic mapper or a bespoke override provides it - `positions` has no
  // `insert` (its create is a role change that closes the previous row) but very much has a create.
  const canCreate = !!(spec.insert || spec.overrides?.create);
  const canUpdate = !!(spec.patch || spec.overrides?.update);
  // A collection can own a HARD delete (an approval delegation is revoked outright - leaving a soft-deleted
  // row would keep re-routing approvals) while having no restore and no `?force`: that is `overrides.remove`
  // plus `softDelete: false`.
  const canDelete = softDeletable || !!spec.overrides?.remove;
  // The access hint must describe THIS collection's actual surface, not a default. Forward and inverse
  // lifecycle members are both listed so the UI gets a hint whichever state a row is in (they share one grant
  // pattern, so it only costs an in-memory decide()).
  const table = spec.table as Record<string, unknown>;
  const hintVerbs: string[] = [
    ...(canUpdate ? ["update"] : []),
    ...(canDelete ? ["delete"] : []),
    ...(softDeletable ? ["restore"] : []),
    ...(table.disabled ? ["enable", "disable"] : []),
    ...(table.locked ? ["lock", "unlock"] : []),
    ...(spec.publish ? ["publish", "unpublish"] : []),
    ...Object.keys(spec.verbs ?? {}),
  ];

  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    // Resolved ONCE, for the generic list and the route-level hook alike.
    const page: PageRequest = {
      maxPageSize: clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      pageToken: c.req.query("page_token"),
      showDeleted: c.req.query("show_deleted") === "true",
    };
    const user = c.get("user");
    const { items, nextPageToken, extra }: { items: any[]; nextPageToken?: string; extra?: Record<string, unknown> } = spec.list
      ? await spec.list(c, page)
      : await svc.list(c.get("deps"), user, c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted);
    const rows = await decorate(c, items);
    // `extra` is for an aggregate the page itself cannot carry - notifications ships `snoozed_count` so the
    // bell can say "3 snoozed" without a second request.
    return c.json({
      results: rows.map((r) => withAccess(serialize(r, user) as object, user, collection, r.code, user.grant, hintVerbs)),
      next_page_token: nextPageToken,
      ...(extra ?? {}),
    });
  });

  app.get(`/:${param}`, async (c) => item(c, await svc.get(c.get("deps"), c.get("user"), itemId(c))));

  // No `insert` means the collection is not created through its own endpoint (an acknowledgement is written by
  // org-documents :acknowledge), and no `patch` means it is read-only history. Mounting nothing is the honest
  // answer: the route does not exist, rather than existing and refusing.
  if (canCreate && createSchema) {
    app.post("/", zValidator("json", createSchema), async (c) =>
      item(c, await svc.create(c.get("deps"), c.get("user"), c.req.valid("json") as I, c.req.query("id"))));
  }
  if (canUpdate && updateSchema) {
    app.patch(`/:${param}`, zValidator("json", updateSchema), async (c) =>
      item(c, await svc.update(c.get("deps"), c.get("user"), itemId(c), c.req.valid("json") as I, c.req.header("If-Match"))));
  }

  if (canDelete) {
    app.delete(`/:${param}`, async (c) => {
      const id = itemId(c);
      const ifMatch = c.req.header("If-Match");
      // ?force is the hard purge (admin); the plain call is the soft delete `:restore` can undo. A collection
      // whose delete is already permanent has neither - there is nothing to escalate to.
      if (softDeletable && c.req.query("force") === "true") await svc.purge(c.get("deps"), c.get("user"), id, ifMatch);
      else await svc.remove(c.get("deps"), c.get("user"), id, ifMatch);
      return c.body(null, 204);
    });
  }

  // The collection's OWN verb is answered first. The shared lifecycle lane and `:restore` are the fallback, so
  // a collection that means something specific by `:enable` gets to say so instead of being silently answered by
  // the generic column write - which is a whole class of shadowing, not one instance (see `automations`, whose
  // `:enable` writes a different column than the lifecycle verb would).
  app.post(`/:${param}`, async (c) => {
    const { id, verb } = customMethod(c);
    const own = spec.verbs?.[verb];
    if (own) {
      if (own.raw) return own.raw(c, id);
      // A verb body is optional on the wire (`:unblock` carries none), so a missing/!JSON body parses as {}.
      const body = own.schema ? own.schema.parse(await c.req.json().catch(() => ({}))) : undefined;
      return item(c, (await own.run(c.get("deps"), c.get("user"), id, body, c)) as { code?: string | null });
    }
    if (verb === "restore" && softDeletable) return item(c, await svc.restore(c.get("deps"), c.get("user"), id));
    const lc = await lifecycleVerb(c, {
      table: spec.table,
      singular: spec.lifecycleName ?? spec.auditName,
      collection,
      serialize,
      publish: spec.publish,
      publishTime: spec.publishTime,
    });
    return lc ?? c.notFound();
  });

  return app;
}
