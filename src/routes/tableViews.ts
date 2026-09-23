import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toTableViewResource } from "../http/serialize";
import { unmaskGate } from "../http/tableFieldAccess";
import { clampPageSize } from "../http/pagination";
import { getTableViewRow, listTableViews, parseSpec, tableViewSpec, type TableViewInput } from "../services/tableViews";
import { runTableView } from "../services/tableRun";
import { notFound } from "../lib/errors";
import { FILTER_OPS, MAX_FILTERS } from "../domain/tableFields";

const column = z.object({ field: z.string().min(1), label: z.string().optional(), hidden: z.boolean().optional() }).strict();
const filter = z
  .object({ field: z.string().min(1), op: z.enum(FILTER_OPS as unknown as [string, ...string[]]), value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() })
  .strict();
const sort = z.object({ field: z.string().min(1), dir: z.enum(["asc", "desc"]) }).strict();
const params = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    pay_period: z.string().optional(),
    financial_year: z.string().optional(),
    department: z.string().optional(),
    employee: z.string().optional(),
  })
  .strict();

const writeSchema = z
  .object({
    display_name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    base: z.string().min(1).optional(),
    columns: z.array(column).optional(),
    filters: z.array(filter).max(MAX_FILTERS).optional(),
    sort: z.array(sort).optional(),
    params: params.optional(),
  })
  .strict();

/**
 * Saved custom grids. Ordinary CRUD through the shared lane (owner-coded, If-Match, audit diffs, soft delete
 * and restore, `:disable` for a draft) plus one verb of its own: `:run`, which produces the rows.
 *
 * `:run` is a `raw` verb because it answers with a grid - columns, rows and a cursor - rather than with the
 * view resource. Its authorization is the ordinary custom-method one (`table-views.<code>.run`), and every
 * collection the grid reads is separately gated by the scope map the middleware left on the request.
 */
export const tableViews = collectionRoutes<TableViewInput, typeof schema.tableViews>({
  ...tableViewSpec,
  param: "table_view_id",
  writeSchema,
  serialize: toTableViewResource,
  list: (c, page) =>
    listTableViews(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      c.req.query("base"),
      c.req.query("q"),
      page.showDeleted,
      page.deletedOnly,
    ),
  verbs: {
    run: {
      raw: async (c, id) => {
        const deps = c.get("deps");
        const user = c.get("user");
        const row = await getTableViewRow(deps, id);
        if (!row || row.deleteTime) throw notFound("table view not found");
        const spec = parseSpec(row.base, row.specJson);
        // Query parameters override the STORED parameters for this run only - the window a report is read
        // over is a question the reader asks, not a property of the definition.
        const q = c.req.query();
        const params = { ...(spec.params ?? {}) };
        for (const key of ["from", "to", "pay_period", "financial_year", "department", "employee"] as const) {
          if (q[key]) params[key] = q[key]!;
        }
        const result = await runTableView(deps, user, c.get("tableScopes") ?? new Map(), { ...spec, params }, {
          maxPageSize: clampPageSize(Number(q.max_page_size) || undefined),
          pageToken: q.page_token,
          unmask: unmaskGate(user),
          viewCode: row.code,
        });
        return c.json(result);
      },
    },
  },
});
