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
import { lifecycleVerb } from "./lifecycleVerb";
import { accessHint, withAccess } from "./accessHint";
import { subjectScopes } from "../domain/access";
import { LIST_OWNER_COLUMNS, OWNER_COLUMN_COLLECTIONS, pageOwnerCodes } from "../lib/authzResolve";
import { clampPageSize } from "./pagination";
import { lastWriteAt, listEtag, etagMatches } from "./listEtag";
import { jsonBody } from "./jsonRequest";
import { queryFlag, queryParam } from "./query";
import { crudService, type CrudService, type CrudSpec, type CrudTable } from "../services/crud";
import type { PurgeCascade } from "../services/softDelete";
import { isInternalId } from "../lib/idCodec";
import { invalidArgument, notFound } from "../lib/errors";

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
      /**
       * Also answer this verb on GET, so a browser can reach it without JavaScript - an `<img src>`, a link, a
       * calendar subscription. Only for a `raw` verb that READS: the authorization key is identical either way
       * (domain/permissions.ts splits the `:verb` off before it looks at the method), but a GET carries no CSRF
       * header (middleware/csrf.ts checks mutations only), so a verb that writes must never be reachable by one.
       */
      get?: boolean;
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
  /** `?show_deleted=true`: include soft-deleted rows alongside the live ones. */
  showDeleted: boolean;
  /** `?deleted_only=true`: the trash BY ITSELF. A "Deleted" view is its own fetch rather than a client-side
   *  filter over a page of mostly-live rows - which on any list longer than one page would show an empty
   *  trash while deleted rows sat past the cursor. */
  deletedOnly: boolean;
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
   * payload is redacted below super, an employee's signature marker is owner-only. `can` is this caller's
   * allowed verbs on this row - the access hint, computed BEFORE serializing - for a resource whose shape
   * depends on what the caller may DO rather than only on who they are. Most serializers ignore both.
   */
  serialize: (row: any, user?: AppUser, can?: string[]) => unknown;
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
  /**
   * The item response carries `access.subject`: what the caller may reach ABOUT THE PERSON this row IS, across
   * every collection (`domain/access.ts subjectScopes`). For `employees` alone - it is the answer a profile's
   * tabs need, and the only one that correlates with who the subject is rather than reporting a blanket tier.
   */
  subjectScopes?: boolean;
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

// The collections that actually answer `DELETE ?force=true` with a hard purge, written here as each one is
// mounted. The authz middleware escalates a forced delete from `write` to `admin`, and this is how it knows
// there is something to escalate TO: a collection whose delete is already permanent ignores `?force`
// entirely (see the DELETE handler below), so refusing the caller over that parameter would deny a delete
// they hold on a purge that does not exist. Nothing outside this factory reads `force`.
const forcePurgeable = new Set<string>();

/** Whether `DELETE /v1/<collection>?force=true` means a hard purge, rather than the collection's own delete. */
export function hasForcePurge(collection: string): boolean {
  return forcePurgeable.has(collection);
}

// Every declared teardown, recorded as its collection is mounted, so a test can hold each one against the
// foreign keys the schema actually declares (test/purgeCascadeDrift). A cascade may be ABSENT - an employee
// with payslips is a row the org may not quietly erase, and the resulting 409 is the intended answer - but
// one that exists must be COMPLETE: the purge deletes the children it lists before the row it cannot delete,
// so a half-listed cascade destroys the named children and then 409s over the ones it forgot.
const purgeCascades = new Map<string, { table: unknown; cascade: PurgeCascade }>();

/** The `purgeCascade` of every factory-built collection that declares one, by collection name. */
export function declaredPurgeCascades(): Map<string, { table: unknown; cascade: PurgeCascade }> {
  return purgeCascades;
}

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
    spec.decorate && rows.length ? spec.decorate(c.get("deps"), c.get("user"), rows, c.get("scope")) : rows;
  // An item response carries the per-object-merged grant (a share can lift a caller above their role), so the
  // SPA's affordances on a single record are share-accurate. Lists pass the role grant - one grant, many rows.
  const item = async (c: Context<AppEnv>, row: { code?: string | null } | undefined) => {
    const [decorated] = await decorate(c, row ? [row] : []);
    const user = c.get("user");
    const grant = c.get("objectGrant");
    // Hint first, then serialize: a resource may shape itself around what the caller may do. The owner code is
    // the one the middleware already decided with (no second lookup), so the hint cannot disagree with the
    // request that produced it.
    const hint = accessHint(user, collection, row?.code, grant, hintVerbs, c.get("itemOwnerCode"));
    // `subjectScopes: true` (employees) adds what the caller may reach ABOUT THIS PERSON, across every
    // collection - the question a profile's tabs ask, which `access.can` (verbs on THIS row) cannot answer.
    // Computed here because this is where the per-object-merged grant and the request's own matcher context
    // both are, so a share and a manager-chain grant are both in the answer. Pure and in-memory: no reads.
    if (spec.subjectScopes && row?.code) hint.subject = subjectScopes(grant, c.get("self"), row.code);
    const res = serialize(decorated ?? row, user, hint.can) as object;
    return c.json(withAccess(res, user, collection, row?.code, grant, hintVerbs, hint));
  };
  // Soft delete is a property of the TABLE: an append-only collection (event-log, cron-runs) has no
  // `delete_time` column, so it gets no DELETE and no `:restore` rather than a route that writes a column
  // which does not exist. Same rule the lifecycle verbs follow (http/lifecycleVerb.ts). `softDelete: false`
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
  if (softDeletable) forcePurgeable.add(collection);
  if (spec.purgeCascade) purgeCascades.set(collection, { table: spec.table, cascade: spec.purgeCascade });
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
      maxPageSize: clampPageSize(Number(queryParam(c, "max_page_size")) || undefined),
      pageToken: queryParam(c, "page_token"),
      // `deleted_only` implies "deleted are visible", so a list hook that only knows the boolean cannot
      // accidentally exclude the very rows being asked for.
      showDeleted: queryFlag(c, "show_deleted") || queryFlag(c, "deleted_only"),
      deletedOnly: queryFlag(c, "deleted_only"),
    };
    const user = c.get("user");
    // Conditional GET (src/http/listEtag.ts). The client caches this page and revalidates when its freshness
    // window lapses, which is usually to be told nothing has changed - so answer that in one indexed row
    // instead of a hundred.
    //
    // The stamp is read BEFORE the list query, always. Reading the two concurrently looked free and was not:
    // two D1 statements issued together have no ordering between them, so a write landing in the middle can be
    // seen by the stamp read and missed by the list query - rows from before the write, stamped with the
    // validator from after it. The client would then store those rows, revalidate, match, and be told to keep
    // them. Ordering it this way can only be wrong the harmless way round: a write after the stamp makes the
    // next revalidation miss and re-read. The cost is one indexed row of latency, and only on a miss - the
    // path that is about to read a whole page anyway.
    const ifNoneMatch = c.req.header("If-None-Match");
    const now = Date.now(); // one clock for both etags below, so the window can't flip between them
    const lastWrite = await lastWriteAt(c.get("deps"), now);
    const etag = listEtag(lastWrite, user, c.req.url, now);
    // A match means the list query never runs, which is the whole saving.
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) return c.body(null, 304, { ETag: etag });
    const listed = spec.list
      ? await spec.list(c, page)
      : await svc.list(c.get("deps"), user, c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, page.deletedOnly, c.req.query("q"));
    const { items, nextPageToken, extra }: { items: any[]; nextPageToken?: string; extra?: Record<string, unknown> } = listed;
    const rows = await decorate(c, items);
    // Owner codes for the page, in ONE read, for the flat-coded owner-column collections only. The hint needs
    // them for the same reason the item lane does; per row they would be a lookup per row.
    const ownerProp = OWNER_COLUMN_COLLECTIONS.has(collection) ? LIST_OWNER_COLUMNS[collection] : undefined;
    const ownerCodes = ownerProp ? await pageOwnerCodes(c.get("deps"), rows, ownerProp) : undefined;
    // `extra` is for an aggregate the page itself cannot carry - notifications ships `snoozed_count` so the
    // bell can say "3 snoozed" without a second request.
    return c.json(
      {
        results: rows.map((r) => {
          const hint = accessHint(user, collection, r.code, user.grant, hintVerbs, ownerCodes?.get(r.code));
          return withAccess(serialize(r, user, hint.can) as object, user, collection, r.code, user.grant, hintVerbs, hint);
        }),
        next_page_token: nextPageToken,
        ...(extra ?? {}),
      },
      200,
      { ETag: etag },
    );
  });

  app.get(`/:${param}`, async (c) => {
    // A READ-ONLY custom method that asked to be reachable by GET (`verbs.<name>.get`) is answered here, off
    // the same param this route already binds: Hono will not bind a param followed by a literal `:verb`, which
    // is why the POST lane parses the last segment itself (http/customMethod.ts) and why this one does too.
    // Without the opt-in the path falls through exactly as before - to a `get` for an id that ends in `:verb`,
    // which finds nothing.
    const { id, verb } = customMethod(c);
    const own = verb ? spec.verbs?.[verb] : undefined;
    if (own?.raw && own.get) return own.raw(c, id);
    return item(c, await svc.get(c.get("deps"), c.get("user"), itemId(c)));
  });

  // No `insert` means the collection is not created through its own endpoint (an acknowledgement is written by
  // org-documents :acknowledge), and no `patch` means it is read-only history. Mounting nothing is the honest
  // answer: the route does not exist, rather than existing and refusing.
  if (canCreate && createSchema) {
    app.post("/", zValidator("json", createSchema), async (c) => {
      // A caller-chosen `?id` becomes the row's PRIMARY KEY, so it is checked HERE, once, for every collection -
      // not in the generic create alone, which the bespoke `overrides.create` of most collections replace
      // wholesale (and which used to be the only place it was checked). An id that is not a canonical internal id
      // cannot be tokenized on the way out, so it would either leak raw or break the outbound edge and every
      // cursor that lands on its row.
      const id = queryParam(c, "id");
      if (id !== undefined && !isInternalId(id)) throw invalidArgument("`id` must be a 13-character base32 resource id");
      return item(c, await svc.create(c.get("deps"), c.get("user"), c.req.valid("json") as I, id));
    });
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
      //
      // READ THROUGH http/query.ts, NOT `c.req.query()`. This is the one parameter in the app that lifts a
      // request's required level, and middleware/authz.ts decides that lift with `new URL().searchParams`.
      // Hono's parser reads past a `#`, the WHATWG one does not, so `#?force=true` was gated as a `write`
      // soft delete here and executed as an `admin` hard purge - see the header of http/query.ts. Both
      // readers now use the same parser, so the gate and the act cannot mean different things by `force`.
      if (softDeletable && queryFlag(c, "force")) await svc.purge(c.get("deps"), c.get("user"), id, ifMatch);
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
      // A verb that declared `get` is a READ addressed by a URL - the contract specifies it as a GET and the
      // app reaches it as one (an `<img src>`). Answering the same thing on POST as well would be a second
      // spelling of one operation, so it is not offered: the method that is documented is the method that
      // works. Not a refusal worth its own status - as far as this route is concerned there is no such POST.
      if (own.raw && own.get) throw notFound("no such method");
      if (own.raw) return own.raw(c, id);
      // A verb body is optional on the wire (`:unblock` carries none), so a missing/!JSON body parses as {}.
      // Read through jsonBody, not c.req.json(): the latter parses whatever bytes arrived whatever the declared
      // type, which would let a verb body that the authz field/reference gate declined to inspect (it gates
      // JSON-family types only) still reach the service - a gate the request talked its way around.
      const body = own.schema ? own.schema.parse(await jsonBody(c)) : undefined;
      return item(c, (await own.run(c.get("deps"), c.get("user"), id, body, c)) as { code?: string | null });
    }
    if (verb === "restore" && softDeletable) return item(c, await svc.restore(c.get("deps"), c.get("user"), id));
    // A shared lifecycle verb answers through `item()` like every other item response, so it carries the access
    // hint and the collection's derived fields instead of a bare row.
    const lc = await lifecycleVerb(c, {
      table: spec.table,
      singular: spec.lifecycleName ?? spec.auditName,
      collection,
      publish: spec.publish,
      publishTime: spec.publishTime,
    });
    if (lc) return item(c, lc.row as { code?: string | null } | undefined);
    return c.notFound();
  });

  return app;
}
