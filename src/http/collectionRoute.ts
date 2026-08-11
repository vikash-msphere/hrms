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
  /** Replace individual generic methods, keeping the rest (a bespoke create, a scoped list, ...). */
  overrides?: Partial<CrudService<I>>;
  /** This collection's own custom methods, by verb. Reached after the lifecycle verbs and `:restore`. */
  verbs?: Record<string, (c: Context<AppEnv>, id: string, svc: CrudService<I>) => Promise<Response>>;
};

export function collectionRoutes<I>(spec: CollectionRouteSpec<I>) {
  const svc: CrudService<I> = { ...crudService(spec), ...spec.overrides };
  const { param, collection, serialize } = spec;
  const itemId = (c: Context<AppEnv>) => c.req.param(param)!;

  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
      const user = c.get("user");
      const { items, nextPageToken } = await svc.list(c.get("deps"), user, maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
      return c.json({ results: items.map((r) => withAccess(serialize(r) as object, user, collection, r.code)), next_page_token: nextPageToken });
    })
    .get(`/:${param}`, async (c) => {
      const row = await svc.get(c.get("deps"), c.get("user"), itemId(c));
      return c.json(serialize(row));
    })
    .post("/", zValidator("json", spec.writeSchema), async (c) => {
      const row = await svc.create(c.get("deps"), c.get("user"), c.req.valid("json") as I, c.req.query("id"));
      return c.json(serialize(row));
    })
    .patch(`/:${param}`, zValidator("json", spec.writeSchema), async (c) => {
      const row = await svc.update(c.get("deps"), c.get("user"), itemId(c), c.req.valid("json") as I, c.req.header("If-Match"));
      return c.json(serialize(row));
    })
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
      if (verb === "restore") return c.json(serialize(await svc.restore(c.get("deps"), c.get("user"), id)));
      const own = spec.verbs?.[verb];
      if (own) return own(c, id, svc);
      return c.notFound();
    });
}
