// Saved custom grids: the definition only. A view holds no rows - running it (services/tableRun.ts) re-reads
// every source under the RUNNER's own scopes, which is what makes sharing one safe.
//
// Validation here is structural: the base must be a registered one, the operators must exist, the caps must
// hold. Whether a particular field exists, and whether this caller may see it, is decided at RUN time against
// the catalogue - so a view authored by an admin keeps its columns when an admin edits it, and quietly loses
// the ones a narrower reader may not have.
import { and, eq, isNull, isNotNull, like, or, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { invalidArgument } from "../lib/errors";
import { CODE_WIDTH, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { has, type CrudSpec, type SetOf } from "./crud";
import {
  BASES, FILTER_OPS, MAX_COLUMNS, MAX_FILTERS,
  type ViewColumn, type ViewFilter, type ViewParams, type ViewSort, type ViewSpec,
} from "../domain/tableFields";

export type TableViewInput = {
  display_name?: string;
  description?: string | null;
  base?: string;
  columns?: ViewColumn[];
  filters?: ViewFilter[];
  sort?: ViewSort[];
  params?: ViewParams;
};

// A catalogue key: dotted column/link segments, an `@source` segment, and a `:` for the per-component and
// per-leave-type leaves (`@comp.component:<id>`). Shape only - whether the key EXISTS is the catalogue's
// answer at run time, not a write-time one (see the file header).
const FIELD_KEY = /^[a-z0-9_.:@-]{1,200}$/i;

function cleanColumns(input: unknown): ViewColumn[] {
  if (!Array.isArray(input)) throw invalidArgument("columns must be an array");
  if (input.length > MAX_COLUMNS) throw invalidArgument(`a table may hold at most ${MAX_COLUMNS} columns`);
  const seen = new Set<string>();
  return input.map((c) => {
    const col = c as ViewColumn;
    if (!col || typeof col.field !== "string" || !FIELD_KEY.test(col.field)) throw invalidArgument("each column needs a field key");
    if (seen.has(col.field)) throw invalidArgument(`duplicate column: ${col.field}`);
    seen.add(col.field);
    return {
      field: col.field,
      ...(col.label ? { label: String(col.label).slice(0, 120) } : {}),
      ...(col.hidden ? { hidden: true } : {}),
    };
  });
}

function cleanFilters(input: unknown): ViewFilter[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw invalidArgument("filters must be an array");
  if (input.length > MAX_FILTERS) throw invalidArgument(`a table may hold at most ${MAX_FILTERS} filters`);
  return input.map((f) => {
    const flt = f as ViewFilter;
    if (!flt || typeof flt.field !== "string" || !FIELD_KEY.test(flt.field)) throw invalidArgument("each filter needs a field key");
    if (!FILTER_OPS.includes(flt.op)) throw invalidArgument(`unknown filter operator: ${String(flt.op)}`);
    const value = flt.value === undefined || flt.value === null ? undefined : typeof flt.value === "string" ? flt.value.slice(0, 200) : flt.value;
    return { field: flt.field, op: flt.op, ...(value === undefined ? {} : { value }) };
  });
}

function cleanSort(input: unknown): ViewSort[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw invalidArgument("sort must be an array");
  return input.slice(0, 4).map((s) => {
    const sort = s as ViewSort;
    if (!sort || typeof sort.field !== "string" || !FIELD_KEY.test(sort.field)) throw invalidArgument("each sort needs a field key");
    return { field: sort.field, dir: sort.dir === "asc" ? "asc" : "desc" };
  });
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function cleanParams(input: unknown): ViewParams {
  const p = (input ?? {}) as Record<string, unknown>;
  const out: ViewParams = {};
  for (const key of ["from", "to"] as const) {
    const v = p[key];
    if (typeof v === "string" && v) {
      if (!YMD.test(v)) throw invalidArgument(`${key} must be a YYYY-MM-DD date`);
      out[key] = v;
    }
  }
  for (const key of ["pay_period", "financial_year", "department", "employee"] as const) {
    const v = p[key];
    if (typeof v === "string" && v) out[key] = v.slice(0, 120);
  }
  return out;
}

/**
 * The stored spec, parsed and re-validated on the way out (a hand-edited row can never crash a run).
 *
 * The caps are TRIMMED here rather than enforced. On the write path an over-long list is a 400 the author can
 * act on; on the read path it is a row that already exists, and throwing would make the view unopenable and
 * unfixable - the editor cannot load what it is meant to correct. That is also true of a row written before a
 * cap was introduced, which is exactly how a stored spec comes to be over one.
 */
export function parseSpec(base: string, json: string): ViewSpec {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  return {
    base,
    columns: Array.isArray(raw.columns) ? cleanColumns(raw.columns.slice(0, MAX_COLUMNS)) : [],
    filters: Array.isArray(raw.filters) ? cleanFilters(raw.filters.slice(0, MAX_FILTERS)) : [],
    sort: cleanSort(raw.sort),
    params: cleanParams(raw.params),
  };
}

const serializeSpec = (spec: Omit<ViewSpec, "base">) => JSON.stringify(spec);

export async function listTableViews(
  deps: Deps,
  scope: ListScope | undefined,
  maxPageSize: number,
  pageToken?: string,
  base?: string,
  q?: string,
  showDeleted = false,
  deletedOnly = false,
) {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.tableViews.code, schema.tableViews.ownerId)];
  if (deletedOnly) conds.push(isNotNull(schema.tableViews.deleteTime));
  else if (!showDeleted) conds.push(isNull(schema.tableViews.deleteTime));
  if (base) conds.push(eq(schema.tableViews.base, base));
  // Name search, narrowing only - the scope predicate above still decides which rows exist at all.
  if (q && q.trim().length >= 2) {
    const term = `%${q.trim().replace(/[%_]/g, "")}%`;
    conds.push(or(like(schema.tableViews.name, term), like(schema.tableViews.description, term)));
  }
  return keysetPage(deps, schema.tableViews, "table-views", and(...(conds.filter(Boolean) as SQL[])), { max: maxPageSize, pageToken });
}

export const tableViewSpec: CrudSpec<TableViewInput, typeof schema.tableViews> = {
  table: schema.tableViews,
  collection: "table-views",
  auditName: "table_view",
  notFound: "table view not found",
  // Owner-coded, so a `me`-scoped grant reaches the author's own views and an object share on the code is how
  // one is handed to somebody else (see [[me-scope-needs-owned-codes]]).
  allocCode: (deps, table, values, attempt) => allocOwnedCode(deps, table, schema.tableViews.ownerId, values.ownerId as string, CODE_WIDTH.owned, attempt > 1),
  insert: (input, _deps, actor) => {
    const name = input.display_name?.trim();
    if (!name) throw invalidArgument("display_name is required");
    if (!input.base || !BASES[input.base]) throw invalidArgument("base must be a table base you can build on");
    // The author owns it, always. An admin building a view for somebody else shares it instead - which keeps
    // "who may see this view" one mechanism (the ACL) rather than two.
    if (!actor.employeeId) throw invalidArgument("only a caller with an employee record can save a table");
    return {
      ownerId: actor.employeeId,
      name: name.slice(0, 160),
      description: input.description?.trim() || null,
      base: input.base,
      specJson: serializeSpec({
        columns: cleanColumns(input.columns ?? []),
        filters: cleanFilters(input.filters),
        sort: cleanSort(input.sort),
        params: cleanParams(input.params),
      }),
    };
  },
  patch: (patch, row, _deps, _actor) => {
    const set: SetOf<typeof schema.tableViews> = {};
    if (has(patch, "display_name")) {
      const name = patch.display_name?.trim();
      if (!name) throw invalidArgument("display_name cannot be empty");
      set.name = name.slice(0, 160);
    }
    if (has(patch, "description")) set.description = patch.description?.trim() || null;
    // The base is the shape of every column key in the spec, so changing it means the columns go with it.
    if (has(patch, "base")) {
      if (!patch.base || !BASES[patch.base]) throw invalidArgument("base must be a table base you can build on");
      set.base = patch.base;
    }
    if (has(patch, "columns") || has(patch, "filters") || has(patch, "sort") || has(patch, "params")) {
      const current = parseSpec(row.base as string, row.specJson as string);
      set.specJson = serializeSpec({
        columns: has(patch, "columns") ? cleanColumns(patch.columns ?? []) : current.columns,
        filters: has(patch, "filters") ? cleanFilters(patch.filters) : (current.filters ?? []),
        sort: has(patch, "sort") ? cleanSort(patch.sort) : (current.sort ?? []),
        params: has(patch, "params") ? cleanParams(patch.params) : (current.params ?? {}),
      });
    }
    // Changing what a row IS invalidates every column key, because a key names a field of the base it was
    // picked from: `first_name` on People is not a column of Tickets, and `@identity.pan` hangs off a
    // different subject. Left alone they would be dropped one at a time at run time, which reads as a broken
    // table rather than as a base change - so the spec is cleared instead and the builder starts clean. Only
    // on a REAL change: re-sending the same base (a name edit that resends the whole form) must not wipe the
    // columns. The author's runtime parameters survive - a window and a department are about the reader.
    if (set.base && set.base !== row.base && !has(patch, "columns")) {
      const current = parseSpec(set.base, (row.specJson as string) ?? "{}");
      set.specJson = serializeSpec({ columns: [], filters: [], sort: [], params: current.params ?? {} });
    }
    return set;
  },
};

/** One view row by id, for the `:run` verb (the factory's own get is for the resource response). */
export async function getTableViewRow(deps: Deps, id: string) {
  return (await deps.db.select().from(schema.tableViews).where(eq(schema.tableViews.uuid, id)).limit(1))[0];
}
