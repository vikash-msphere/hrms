// The AEP standard-methods surface for one collection, generated from a spec: list (`?max_page_size`,
// `?page_token`, `?show_deleted`, per-row access hints), get, create (`?id`), patch (`If-Match`), delete
// (`?force` = purge), plus the shared lifecycle custom methods and `:restore`. Around forty collections are
// this exact shape modulo table, zod schema and serializer; each was a hand-copied ~60-line route file.
//
// Access control is untouched: every handler here is reached only through the authz middleware, which remains
// the single source of authorization. The factory decides no permission - it only shapes requests.
//
// A collection is never forced through here. Bespoke services (payroll, settlements, ATS, boards) keep their
// own routes; a mostly-generic one can pass `overrides` for the one method it needs to own, or `verbs` for its
// own custom methods.
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { ZodTypeAny } from "zod";
import type { AppEnv } from "../env";
import { customMethod } from "./customMethod";
import { lifecycleVerb } from "./lifecycleRoute";
import { withAccess } from "./accessHint";
import { clampPageSize } from "./pagination";
import { crudService, type CrudService, type CrudSpec } from "../services/crud";

export type CollectionRouteSpec<I> = CrudSpec<I> & {
  /** The item path param, matching the name OpenAPI declares (`holiday_id`). */
  param: string;
  writeSchema: ZodTypeAny;
  serialize: (row: any) => unknown;
  /** `singular` for the lifecycle verbs' audit actions, when it differs from `auditName`. */
  lifecycleName?: string;
  publish?: boolean; // resource supports :publish/:unpublish
  publishTime?: boolean; // also stamp publish_time on publish
  /** Replace individual generic service methods, keeping the rest (a bespoke create, a bespoke get, ...). */
  overrides?: Partial<CrudService<I>>;
  /**
   * Replaces the generic list. Takes the context because a scoped list needs `c.get("scope")` (the SQL-level
   * row filter the middleware computed) and often its own `?employee` / `?from` / `?to` filters - things a
   * service-level signature cannot see. The factory still owns the response shape and the access hints.
   */
  list?: (c: Context<AppEnv>) => Promise<{ items: any[]; nextPageToken?: string }>;
  /** This collection's own custom methods, by verb. Reached after the lifecycle verbs and `:restore`. */
  verbs?: Record<string, (c: Context<AppEnv>, id: string, svc: CrudService<I>) => Promise<Response>>;
};

export function collectionRoutes<I>(spec: CollectionRouteSpec<I>) {
  const svc: CrudService<I> = { ...crudService(spec), ...spec.overrides };
  const { param, collection, serialize } = spec;
  const itemId = (c: Context<AppEnv>) => c.req.param(param)!;
  // An item response carries the per-object-merged grant (a share can lift a caller above their role), so the
  // SPA's affordances on a single record are share-accurate. Lists pass the role grant - one grant, many rows.
  const item = (c: Context<AppEnv>, row: { code?: string | null } | undefined) =>
    c.json(withAccess(serialize(row) as object, c.get("user"), collection, row?.code, c.get("objectGrant")));

  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
      const user = c.get("user");
      const { items, nextPageToken } = spec.list
        ? await spec.list(c)
        : await svc.list(c.get("deps"), user, maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
      return c.json({ results: items.map((r) => withAccess(serialize(r) as object, user, collection, r.code)), next_page_token: nextPageToken });
    })
    .get(`/:${param}`, async (c) => item(c, await svc.get(c.get("deps"), c.get("user"), itemId(c))))
    .post("/", zValidator("json", spec.writeSchema), async (c) =>
      item(c, await svc.create(c.get("deps"), c.get("user"), c.req.valid("json") as I, c.req.query("id"))))
    .patch(`/:${param}`, zValidator("json", spec.writeSchema), async (c) =>
      item(c, await svc.update(c.get("deps"), c.get("user"), itemId(c), c.req.valid("json") as I, c.req.header("If-Match"))))
    .delete(`/:${param}`, async (c) => {
      const id = itemId(c);
      const ifMatch = c.req.header("If-Match");
      // ?force is the hard purge (admin); the plain call is the soft delete `:restore` can undo.
      if (c.req.query("force") === "true") await svc.purge(c.get("deps"), c.get("user"), id, ifMatch);
      else await svc.remove(c.get("deps"), c.get("user"), id, ifMatch);
      return c.body(null, 204);
    })
    .post(`/:${param}`, async (c) => {
      const lc = await lifecycleVerb(c, {
        table: spec.table,
        singular: spec.lifecycleName ?? spec.auditName,
        collection,
        serialize,
        publish: spec.publish,
        publishTime: spec.publishTime,
      });
      if (lc) return lc;
      const { id, verb } = customMethod(c);
      if (verb === "restore") return item(c, await svc.restore(c.get("deps"), c.get("user"), id));
      const own = spec.verbs?.[verb];
      if (own) return own(c, id, svc);
      return c.notFound();
    });
}
