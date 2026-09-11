import { Hono } from "hono";
import type { AppEnv } from "../env";
import { basesFor, buildCatalogue } from "../services/tableCatalog";
import { BASES } from "../domain/tableFields";
import { invalidArgument } from "../lib/errors";

// Virtual capability (no table, no rows of its own): the table builder's field catalogue.
//
// `GET /v1/table-fields` lists the bases this caller may build a grid on; `?base=<collection>` returns that
// base's offerable fields, grouped. Like `workflow-meta` it owns no data and grants nothing - the middleware
// gates the endpoint itself (`table-fields.read`) and leaves the set of collections this caller may LIST on the
// request, and every field is filtered by that set. A field the caller could never read is therefore not even
// offered, which is what keeps the builder honest rather than a menu of future 403s.
export const tableFields = new Hono<AppEnv>().get("/", async (c) => {
  const listable = c.get("listableCollections") ?? new Set<string>();
  const bases = basesFor(listable);
  const base = c.req.query("base");
  if (!base) return c.json({ bases, groups: [], fields: [] });
  if (!BASES[base]) throw invalidArgument(`unknown table base: ${base}`);
  // A base the caller cannot list has no fields to offer; saying so as an empty catalogue (rather than a 403)
  // keeps the builder's base picker and this answer consistent - the base simply is not among `bases`.
  if (!listable.has(base)) return c.json({ bases, base, path: "", groups: [], fields: [], links: [] });
  // `?path=` walks the links: `employee_id` is the requester of a ticket, `employee_id.department_id` their
  // department. Each node answers with its own fields plus where you can go next, so a join is as deep as
  // somebody cares to open rather than as deep as one response can afford to be.
  const path = (c.req.query("path") ?? "").split(".").filter(Boolean);
  const catalogue = await buildCatalogue(c.get("deps"), base, listable, path);
  return c.json({
    bases,
    base: catalogue.base,
    label: catalogue.label,
    path: catalogue.path,
    ...(catalogue.nodeLabel ? { node_label: catalogue.nodeLabel } : {}),
    ...(catalogue.collection ? { collection: catalogue.collection } : {}),
    groups: catalogue.groups,
    fields: catalogue.fields.map((f) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      kind: f.kind,
      collection: f.collection,
      ...(f.masked ? { masked: true } : {}),
      ...(f.enumValues ? { enum_values: [...f.enumValues] } : {}),
    })),
    links: catalogue.links,
  });
});
