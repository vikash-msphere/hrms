import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { ListScope } from "../domain/access";
import { jsonBody } from "../http/jsonRequest";
import { suggestTableView, MAX_QUESTION } from "../services/tableAssist";
import { basesFor, buildCatalogue } from "../services/tableCatalog";
import { catalogueFieldGate } from "../http/tableFieldAccess";
import { BASES } from "../domain/tableFields";
import { fullHeader } from "../domain/tableHeaders";
import { invalidArgument } from "../lib/errors";

// Virtual capability (no table, no rows of its own): the table builder's field catalogue.
//
// `GET /v1/table-fields` lists the bases this caller may build a grid on; `?base=<collection>` returns that
// base's offerable fields, grouped. Like `workflow-meta` it owns no data and grants nothing - the middleware
// gates the endpoint itself (`table-fields.read`) and leaves the per-collection list VERDICTS on the request,
// and every field is filtered by them. A field the caller could never read is therefore not even offered,
// which is what keeps the builder honest rather than a menu of future 403s. The base picker asks the verdict's
// other half too (`basesFor` -> `scopeCanMatch`): a collection-level capability whose breadth binds to nothing
// is not a base anybody can build on, and offering it is the same broken promise one level up.
export const tableFields = new Hono<AppEnv>().get("/", async (c) => {
  // The SAME map the runner is handed (`tableScopes`), so the builder and the run cannot disagree about what
  // this caller may touch. Its keys are the boolean half - which collections may be listed, and therefore
  // whose fields may be offered - and the scopes on it are what says whether a base can return a row at all.
  const scopes = c.get("tableScopes") ?? new Map<string, ListScope>();
  const listable = new Set(scopes.keys());
  const bases = basesFor(scopes);
  const base = c.req.query("base");
  if (!base) return c.json({ bases, groups: [], fields: [] });
  if (!BASES[base]) throw invalidArgument(`unknown table base: ${base}`);
  // A base this caller cannot get a row of has no fields to offer; saying so as an empty catalogue (rather than
  // a 403) keeps the builder's base picker and this answer consistent - the base simply is not among `bases`.
  // Asked of `bases`, not of `listable`: those two stopped being the same set once reachability was part of the
  // answer, and gating on the looser one would have served the field list for a base the picker refuses to
  // offer. A saved view whose base became unreachable therefore opens on an empty catalogue and reports its
  // columns as dropped, which is what the run does with the same view - a normal state of a saved view, not a
  // fault.
  if (!bases.some((b) => b.collection === base)) return c.json({ bases, base, path: "", groups: [], fields: [], links: [] });
  // `?path=` walks the links: `employee_id` is the requester of a ticket, `employee_id.department_id` their
  // department. Each node answers with its own fields plus where you can go next, so a join is as deep as
  // somebody cares to open rather than as deep as one response can afford to be.
  const path = (c.req.query("path") ?? "").split(".").filter(Boolean);
  const catalogue = await buildCatalogue(c.get("deps"), base, listable, path, catalogueFieldGate(c.get("user")!, c.get("self")));
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
      // The picker files a field under the node it came from, so inside the picker `label` is the whole
      // story. The CHOSEN-columns list stands outside all of them, and there "Name" is three fields at once -
      // so it carries the qualified name. The grid shortens the same name again, against its own columns.
      ...(f.trail?.length ? { column_label: fullHeader({ key: f.key, label: f.label, trail: f.trail, nodeName: f.nodeName }) } : {}),
      group: f.group,
      kind: f.kind,
      collection: f.collection,
      ...(f.masked ? { masked: true } : {}),
      ...(f.enumValues ? { enum_values: [...f.enumValues] } : {}),
    })),
    links: catalogue.links,
  });
});

// Collection-level custom method `table-fields:describe` - say what the grid should show in words, get a
// spec back for the builder to render.
//
// `base` is OPTIONAL. Left out, the collection one row is gets chosen from the same description, out of the
// bases this caller may build on, and comes back in the answer - so the client always learns which base the
// spec is for rather than assuming the one it asked about.
//
// Mounted on THIS capability rather than on `table-views`, because the thing it needs is the catalogue, and
// `table-fields.read` is already the gate that decides who may see one. Gating it anywhere else would be a
// second answer to a question this endpoint has already answered - and the middleware sets `tableScopes` for
// this collection, so the fields offered to the model are exactly the fields the picker would have offered.
//
// Nothing is saved. The spec is returned, the builder renders it, and the person edits and saves it through
// the ordinary table-views write, which validates the spec again on its own account.
export const tableDescribe = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = describeSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("body must be { question, base? }");
  const scopes = c.get("tableScopes") ?? new Map<string, ListScope>();
  const out = await suggestTableView(
    c.get("deps"),
    c.get("user")!,
    scopes,
    c.get("self"),
    parsed.data.base ?? null,
    parsed.data.question,
  );
  return c.json({ base: out.base, spec: out.spec, unmatched: out.unmatched, cached: out.cached });
});

const describeSchema = z
  .object({ base: z.string().min(1).max(64).optional(), question: z.string().min(1).max(MAX_QUESTION) })
  .strict();
