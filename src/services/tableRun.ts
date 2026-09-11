// Runs one saved grid: base rows for the caller's own scope, then each selected source joined onto them in a
// batch, then one cell per selected column.
//
// It decides NO access. Everything it is allowed to touch arrived as `scopes` - the per-collection list
// verdicts the authz middleware resolved for this request (scopesForCollections), exactly the map
// `people-analytics` and `dashboard-summary` are handed. A column whose collection is missing from that map is
// dropped from the answer; the base rows, every LINKED row and every SOURCE read are bound by `applyScope`
// like any other list; and the employee sub-resources (identity / personal / bank) are additionally gated per
// row and per FIELD by the same in-memory `decide()` the profile endpoint runs.
//
// The distinction that matters, because getting it wrong is silent: presence in `scopes` is the BOOLEAN half
// of the decision only - a collection is in the map when the caller may list it AT ANY BREADTH - and the
// breadth lives on the ListScope. Gating anything on presence alone hands a whole page's rows to a caller
// entitled to one of them. See `scopedTo` in loadSource.
//
// Cost discipline: one query per SOURCE per page, never one per row. A source nobody selected is never read.
import { and, eq, ne, gt, gte, lt, lte, inArray, isNull, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type AnySQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { deniedSubresourceKeys } from "../http/tableFieldAccess";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { TABLES, listOwnerColumn } from "../lib/authzResolve";
import { audit } from "../lib/audit";
import { invalidArgument, forbidden } from "../lib/errors";
import { MAX_COLUMNS, type ViewFilter, type ViewSpec } from "../domain/tableFields";
import { resolveFields, type ResolvedField } from "./tableCatalog";
import { getFieldDefs, maskIdentityValue } from "./identityDetails";
import { maskAccount } from "./bankDetails";
import { refPayComponents, refPayPeriods } from "../lib/refData";
import { getSettingValue } from "./settings";
import { orgToday } from "./orgDay";
import { applyStructure, ctcLines, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import { peopleAnalytics } from "./peopleAnalytics";
import { byIdChunks } from "../lib/dbBatch";
import { round2 } from "../domain/money";

export type RunColumn = {
  key: string;
  label: string;
  kind: ResolvedField["kind"];
  collection: string;
  /** True when the value is masked because the caller lacks the `unmask` capability. */
  masked?: boolean;
};

export type RunRow = {
  /** The base row's wire path, so the grid can link a row back to the record it came from. */
  path: string;
  cells: Record<string, unknown>;
  /** Column keys this caller may not read on THIS row (per-field deny) - rendered as a restricted marker. */
  denied?: string[];
};

export type RunResult = {
  base: string;
  columns: RunColumn[];
  rows: RunRow[];
  next_page_token?: string;
  /** Columns the view asks for that this caller does not get, with the reason. */
  dropped: { field: string; reason: string }[];
};

export type RunOptions = {
  maxPageSize: number;
  pageToken?: string;
  /** Whether the caller holds the `unmask` capability (decided by the route from the grant). */
  unmask?: boolean;
  /** The view's own code, for the audit row. */
  viewCode?: string | null;
};

const INTERNAL_ID = /^[0-9a-hj-km-np-tv-z]{13}$/;
const ymd = (d: Date | number) => new Date(d).toISOString().slice(0, 10);

// Every id-keyed loader below reads a whole page's worth of employees in one `IN`, which sat right on D1's
// bound-parameter cap and went over it as soon as `applyScope` bound anything alongside it - see
// lib/dbBatch.ts#byIdChunks for the full account of why the cap is where it is.

/** Run `spec` and return one page of the grid. */
export async function runTableView(deps: Deps, user: AppUser, scopes: Map<string, ListScope>, spec: ViewSpec, opts: RunOptions): Promise<RunResult> {
  const base = spec.base;
  const table = TABLES[base] as (SQLiteTable & Record<string, any>) | undefined;
  const scope = scopes.get(base);
  if (!table) throw invalidArgument(`unknown table base: ${base}`);
  // The middleware only puts a collection in the map when this caller's own `GET /v1/<base>` would be allowed.
  if (!scope) throw forbidden(`you cannot list ${base}`);
  if (spec.columns.length > MAX_COLUMNS) throw invalidArgument(`a table may hold at most ${MAX_COLUMNS} columns`);

  const listable = new Set(scopes.keys());
  // Only the nodes this view actually reaches into are built - the base itself plus one per distinct link path
  // its keys name, rather than the whole reachable tree.
  const byKey = await resolveFields(deps, base, listable, [
    ...spec.columns.map((c) => c.field),
    ...(spec.filters ?? []).map((f) => f.field),
    ...(spec.sort ?? []).map((s) => s.field),
  ]);

  // ---- Which columns this caller actually gets ------------------------------------------------------------
  const dropped: { field: string; reason: string }[] = [];
  const selected: { col: { field: string; label?: string }; field: ResolvedField }[] = [];
  for (const col of spec.columns) {
    if (col.hidden) continue;
    const field = byKey.get(col.field);
    if (!field) {
      // Either the field does not exist (a stale saved view after a schema change) or the caller may not list
      // the collection behind it. Both are "you do not get this column", said out loud rather than silently.
      dropped.push({ field: col.field, reason: "not available to you" });
      continue;
    }
    selected.push({ col, field });
  }
  const columns: RunColumn[] = selected.map(({ col, field }) => ({
    key: field.key,
    label: col.label || field.label,
    kind: field.kind,
    collection: field.collection,
    masked: field.masked && !opts.unmask ? true : undefined,
  }));

  // ---- The base page -------------------------------------------------------------------------------------
  const cols = getTableColumns(table) as Record<string, any>;
  // The owner column comes from the registry, NOT from guessing `employeeId`. Every base whose owner is named
  // something else - `employees` by `uuid`, `assets` by `assignedTo`, `referrals` by `referrerId`,
  // `transition-tasks` by `assigneeId` - resolved to undefined under the guess, and `applyScope` fails closed
  // on a missing owner column, so an own-breadth caller got an empty grid with nothing saying why. See
  // lib/authzResolve.ts#LIST_OWNER_COLUMNS.
  const conds: (SQL | undefined)[] = [applyScope(scope, table.code, listOwnerColumn(base, table))];
  if (table.deleteTime) conds.push(isNull(table.deleteTime));
  // The two standing narrowings a report is asked for: one department, one person. Applied only where the base
  // actually carries the column - they never WIDEN, so a base without them simply ignores them.
  const params = spec.params ?? {};
  const depId = params.department?.split("/").pop();
  const empId = params.employee?.split("/").pop();
  if (depId && cols.departmentId) conds.push(eq(table.departmentId, depId));
  if (empId) {
    if (base === "employees") conds.push(eq(table.uuid, empId));
    else if (cols.employeeId) conds.push(eq(table.employeeId, empId));
  }
  // Filters on the base's own columns go into SQL; everything else is applied over the page below.
  //
  // WITHIN A PARAMETER BUDGET, which is the half that was missing. D1 binds at most 100 parameters per
  // statement (lib/dbBatch.ts#PARAM_CAP) and an `in` filter spends ONE PER ITEM: `?filter=in` with a
  // comma-separated list, plus the caller's scope predicates and the keyset bounds in the same statement, went
  // past the cap and the whole grid answered `D1_ERROR: too many SQL variables` - a 500 on a saved view, at
  // whatever list length happened to cross it. The budget leaves room for everything else the statement binds;
  // a filter that would not fit is DEFERRED to the in-memory half rather than refused, so the view still
  // answers and still narrows - which is why that path had to be made correct for unselected fields first.
  const deferred: ViewFilter[] = [];
  let paramsSpent = 0;
  for (const f of spec.filters ?? []) {
    const field = byKey.get(f.field);
    if (!field) continue;
    const cost = filterParamCost(f);
    const pushable = field.path.length === 0 && !field.source && paramsSpent + cost <= FILTER_PARAM_BUDGET;
    const sqlCond = pushable ? baseFilterSql(table, field, f) : undefined;
    if (sqlCond) {
      conds.push(sqlCond);
      paramsSpent += cost;
    } else deferred.push(f);
  }
  const page = await keysetPage<Record<string, any>>(deps, table, base, and(...(conds.filter(Boolean) as SQL[])), {
    max: opts.maxPageSize,
    pageToken: opts.pageToken,
  });
  const baseRows = page.items;

  // ---- Linked rows: one query per (path, collection), never one per row ------------------------------------
  // `linked` maps "employeeId" / "employeeId.departmentId" to the row each base row's chain lands on.
  const linked = new Map<string, Map<string, Record<string, any>>>();
  const linkPaths = new Set<string>();
  for (const { field } of selected) if (field.path.length) linkPaths.add(field.path.join("."));
  for (const f of deferred) {
    const field = byKey.get(f.field);
    if (field?.path.length) linkPaths.add(field.path.join("."));
  }
  // Employee sub-resource sources need the employee ROW (its code gates the sub-resource, and the PII blobs
  // live on it), so their subject path is loaded even when no column of that row was picked.
  const subjectPaths = new Set<string>();
  for (const { field } of selected) if (field.source) subjectPaths.add(field.path.join("."));
  for (const p of subjectPaths) if (p) linkPaths.add(p);

  // Load shallow-to-deep so a depth-2 link can read the ids off its depth-1 parent.
  for (const path of [...linkPaths].sort((a, b) => a.split(".").length - b.split(".").length)) {
    const segs = path.split(".");
    const parentPath = segs.slice(0, -1).join(".");
    const fkCol = segs[segs.length - 1]!;
    const parents: Record<string, any>[] = parentPath
      ? [...(linked.get(parentPath)?.values() ?? [])]
      : baseRows;
    const target = targetOf(parentPath ? collectionAt(base, segs.slice(0, -1)) : base, fkCol);
    if (!target || !listable.has(target.collection)) continue;
    const ids = [...new Set(parents.map((r) => r[fkCol]).filter((v): v is string => typeof v === "string"))];
    if (!ids.length) {
      linked.set(path, new Map());
      continue;
    }
    // Bound by the caller's scope for the TARGET collection too: following a link must not become a way to
    // read a row of a collection the caller may list only narrowly. The owner column is the target's own -
    // guessing `employeeId` here blanked the commonest column in the app, because the commonest link target
    // is `employees` (owned by `uuid`), so a caller reading employees at `me` breadth got a name column that
    // was empty on every row of a grid whose base rows were all correctly their own.
    const targetTable = TABLES[target.collection] as SQLiteTable & Record<string, any>;
    const targetScope = scopes.get(target.collection)!;
    const rows = await byIdChunks(ids, (group) =>
      deps.db
        .select()
        .from(targetTable)
        .where(and(inArray(targetTable.uuid, group), applyScope(targetScope, targetTable.code, listOwnerColumn(target.collection, targetTable)))) as PromiseLike<Record<string, any>[]>,
    );
    linked.set(path, new Map(rows.map((r) => [r.uuid as string, r])));
  }

  /** The row a field's path lands on, for one base row. */
  const rowAt = (baseRow: Record<string, any>, path: string[]): Record<string, any> | undefined => {
    if (!path.length) return baseRow;
    let cur: Record<string, any> | undefined = baseRow;
    for (let i = 0; i < path.length; i++) {
      const id: unknown = cur?.[path[i]!];
      if (typeof id !== "string") return undefined;
      cur = linked.get(path.slice(0, i + 1).join("."))?.get(id);
      if (!cur) return undefined;
    }
    return cur;
  };

  // ---- Sources -------------------------------------------------------------------------------------------
  // Per subject path: the employee row each base row resolves to, then one load per selected source.
  const sourceValues = new Map<string, Map<string, Record<string, unknown>>>(); // `${path}|${source}` -> rowId -> values
  const deniedByRow = new Map<string, Set<string>>();
  const usedSources = new Set<string>();
  for (const { field } of selected) if (field.source) usedSources.add(`${field.path.join(".")}|${field.source}`);
  for (const f of deferred) {
    const field = byKey.get(f.field);
    if (field?.source) usedSources.add(`${field.path.join(".")}|${field.source}`);
  }

  const self = { employeeCode: user.employeeCode };
  for (const used of usedSources) {
    const [pathKey, source] = used.split("|") as [string, string];
    const path = pathKey ? pathKey.split(".") : [];
    // rowId -> the employee row this source is about.
    const subjects = new Map<string, Record<string, any>>();
    for (const r of baseRows) {
      const emp = rowAt(r, path);
      if (emp) subjects.set(r.uuid as string, emp);
    }
    if (!subjects.size) continue;
    const values = await loadSource(deps, user, scopes, source, subjects, spec, opts);
    sourceValues.set(used, values);
    // Per-row + per-field access for the three field-gated sub-resources. Both decisions are pure in-memory
    // matches against the caller's grant - the same ones GET /v1/employees/<id>/identity is answered by.
    const sub = SUBRESOURCE[source];
    if (!sub) continue;
    const keys = selected.filter((s) => s.field.source === source && s.field.path.join(".") === pathKey).map((s) => s.field.fieldKey ?? s.field.leaf);
    for (const [rowId, emp] of subjects) {
      const denied = deniedByRow.get(rowId) ?? new Set<string>();
      const bad = deniedSubresourceKeys(user.grant, emp.code as string | null, sub, keys, self);
      for (const s of selected) {
        if (s.field.source !== source || s.field.path.join(".") !== pathKey) continue;
        if (bad.has(s.field.fieldKey ?? s.field.leaf)) denied.add(s.field.key);
      }
      if (denied.size) deniedByRow.set(rowId, denied);
    }
  }

  // ---- Cells ---------------------------------------------------------------------------------------------
  //
  // A deferred filter's field is NOT necessarily a selected column. It can be a hidden one (`ViewColumn.hidden`
  // - "narrow by department without showing the department") or a field the view filters on and never displays,
  // and the loading above already anticipates both: the deferred loop registers their link paths and their
  // sources. Only the CELL was missing, so `row.cells[f.field]` was `undefined` and `matches` judged every row
  // against nothing - a filter on a hidden linked column emptied the grid, silently and always. Those fields
  // are computed here into a side map, used for the predicate and never returned: filtering by a column is not
  // a way to read it.
  const judgedOnly = [...new Set(deferred.map((f) => f.field))]
    .map((key) => byKey.get(key))
    .filter((f): f is ResolvedField => !!f && !selected.some((s) => s.field.key === f.key));
  const rows: RunRow[] = [];
  const judged = new Map<string, Record<string, unknown>>();
  for (const r of baseRows) {
    const rowId = r.uuid as string;
    const denied = deniedByRow.get(rowId);
    const cells: Record<string, unknown> = {};
    for (const { field } of selected) {
      if (denied?.has(field.key)) {
        cells[field.key] = null;
        continue;
      }
      cells[field.key] = cellValue(base, field, r, rowAt, sourceValues, opts.unmask === true);
    }
    if (judgedOnly.length) {
      const extra: Record<string, unknown> = {};
      // A field this caller may not see stays null here too - the field-access denial applies to what a filter
      // may judge on, not only to what a cell may show.
      for (const field of judgedOnly) extra[field.key] = denied?.has(field.key) ? null : cellValue(base, field, r, rowAt, sourceValues, opts.unmask === true);
      judged.set(rowId, extra);
    }
    rows.push({ path: `${base}/${rowId}`, cells, ...(denied?.size ? { denied: [...denied] } : {}) });
  }

  // Deferred filters (anything not a plain base column, plus anything the parameter budget could not fit) over
  // the assembled page. Filtering a page at a time is the same answer as filtering the union: each row is
  // judged on its own values.
  const cellFor = (row: RunRow, key: string) =>
    key in row.cells ? row.cells[key] : judged.get(row.path.split("/").pop()!)?.[key];
  const filtered = deferred.length ? rows.filter((row) => deferred.every((f) => matches(cellFor(row, f.field), f, byKey.get(f.field)?.kind))) : rows;

  // The saved sort, applied to the page. Base rows page in the cursor's own (createdAt, uuid) order - that is
  // what makes a page boundary stable - so this ORDERS A PAGE, exactly as CrudSpec.sort does for every other
  // collection. The grid follows the cursor to the end of the report and DataTable then sorts the whole set,
  // so a multi-page view still reads in the author's order; this is what makes a one-page view and an export
  // come out sorted without the client having to.
  for (const s of [...(spec.sort ?? [])].reverse()) {
    if (!byKey.has(s.field)) continue;
    const dir = s.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => dir * compareCells(a.cells[s.field], b.cells[s.field]));
  }

  // ---- Audit ---------------------------------------------------------------------------------------------
  // One row per RUN that touched masked PII, not one per person: a per-record row (what a profile read writes)
  // would put a page of rows in the feed for one report and bury the trail it exists to be. Field keys and
  // counts only - never a value.
  const sensitive = columns.filter((c) => selected.find((s) => s.field.key === c.key)?.field.masked);
  if (sensitive.length) {
    await audit(deps, user, "table-views.run.sensitive", "table-views", undefined, {
      view: opts.viewCode ?? null,
      base,
      fields: sensitive.map((c) => c.key).slice(0, 64),
      rows: filtered.length,
      unmasked: opts.unmask === true,
    });
  }

  return { base, columns, rows: filtered, next_page_token: page.nextPageToken, dropped };
}

// ---- Column values --------------------------------------------------------------------------------------

/** The sub-resource each PII source is field-gated under. */
const SUBRESOURCE: Record<string, string | undefined> = { identity: "identity", personal: "personal-info", bank: "bank-account" };

function cellValue(
  base: string,
  field: ResolvedField,
  baseRow: Record<string, any>,
  rowAt: (r: Record<string, any>, p: string[]) => Record<string, any> | undefined,
  sources: Map<string, Map<string, Record<string, unknown>>>,
  unmask: boolean,
): unknown {
  if (field.source) {
    const v = sources.get(`${field.path.join(".")}|${field.source}`)?.get(baseRow.uuid as string)?.[field.leaf];
    if (v === undefined) return null;
    if (field.masked && !unmask && typeof v === "string") {
      return field.source === "bank" ? maskAccount(v) : maskIdentityValue(v);
    }
    return v;
  }
  const row = rowAt(baseRow, field.path);
  if (!row) return null;
  const raw = row[field.leaf];
  if (raw === undefined || raw === null) return null;
  // A foreign key leaves as `<collection>/<internal id>`, which the outbound edge (middleware/encodeWireIds)
  // rewrites to a wire token. Never the bare id: that is the one shape that would publish an internal id.
  if (field.kind === "ref") return typeof raw === "string" && field.refCollection ? `${field.refCollection}/${raw}` : null;
  if (raw instanceof Date) return field.kind === "datetime" ? raw.toISOString() : ymd(raw);
  if (typeof raw === "number" && (field.kind === "date" || field.kind === "datetime")) {
    return field.kind === "datetime" ? new Date(raw).toISOString() : ymd(raw);
  }
  // Defence in depth: an internal id must never leave as a bare string. A reference is emitted as
  // `<collection>/<id>` (which the outbound edge tokenizes); anything else that LOOKS like an id is a column
  // the catalogue should not have offered, so it is dropped rather than published.
  if (typeof raw === "string" && INTERNAL_ID.test(raw)) return null;
  return raw;
}

/** The collection a chain of FK columns lands on (used to resolve the next hop's target). */
function collectionAt(base: string, path: string[]): string {
  let cur = base;
  for (const seg of path) {
    const t = targetOf(cur, seg);
    if (!t) return cur;
    cur = t.collection;
  }
  return cur;
}

// The collection a foreign-key column points at, resolved from the schema (not a hand-written map). Memoised
// per isolate: the answer is a property of the schema, so it can never change while the worker is alive.
const targetCache = new Map<string, { collection: string } | null>();
function targetOf(collection: string, fkColumn: string): { collection: string } | null {
  const key = `${collection}.${fkColumn}`;
  const hit = targetCache.get(key);
  if (hit !== undefined) return hit;
  const table = TABLES[collection];
  let found: { collection: string } | null = null;
  if (table) {
    const cols = getTableColumns(table as SQLiteTable) as Record<string, { name: string }>;
    const wire = cols[fkColumn]?.name;
    for (const fk of getTableConfig(table as SQLiteTable).foreignKeys) {
      const ref = fk.reference();
      if (ref.columns.length !== 1 || ref.columns[0]!.name !== wire) continue;
      const targetName = getTableConfig(ref.foreignTable as SQLiteTable).name;
      const target = Object.entries(TABLES).find(([, t]) => getTableConfig(t as SQLiteTable).name === targetName);
      if (target) found = { collection: target[0] };
      break;
    }
  }
  targetCache.set(key, found);
  return found;
}

// ---- Filters ----------------------------------------------------------------------------------------------

/**
 * `%` and `_` inside a `contains` needle, escaped rather than removed.
 *
 * They used to be STRIPPED, which silently searched for a different string than the one typed - `50%` searched
 * `50`, `first_name` searched `firstname` - and disagreed with `matches()` below, the in-memory half of the
 * same operator, which never stripped anything. So the same saved filter meant two things depending on whether
 * its column happened to sit on the base table. Escaped under an explicit ESCAPE clause, the pattern means
 * exactly what the reader wrote, and the two halves agree. The backslash itself is escaped first, or a needle
 * ending in one would escape the closing `%` this builds.
 */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Operators that ORDER two values rather than compare them as text. */
const ORDERING_OPS = new Set(["gt", "gte", "lt", "lte"]);

/** The items of an `in` filter's comma-joined value. One place, so the SQL half and the cost estimate below
 *  can never disagree about how many parameters the list is going to spend. */
const inList = (v: ViewFilter["value"]) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Bound parameters the pushed-down filters may spend between them.
 *
 * D1's ceiling is 100 PER STATEMENT and the filters are not the only thing binding in this one: `applyScope`
 * spends one for a dept/own breadth and two per per-object share or deny, the department and employee params
 * one each, and the keyset cursor two. 40 leaves that room with margin, and is far above what a report
 * actually asks for - the only filter that can spend more than one parameter is `in`, and a list of forty
 * values is already a browse rather than a filter. Past the budget a filter is deferred to the in-memory
 * half, which narrows the same rows; nothing is refused and nothing is silently dropped.
 */
const FILTER_PARAM_BUDGET = 40;

/** What pushing this filter into SQL would cost in bound parameters. Must mirror `baseFilterSql` exactly. */
const filterParamCost = (f: ViewFilter): number =>
  f.op === "empty" || f.op === "not_empty" ? 0 : f.op === "in" ? inList(f.value).length : 1;

/** A filter on a plain base column, pushed into SQL. Returns undefined when it cannot be (then it is deferred). */
function baseFilterSql(table: SQLiteTable & Record<string, any>, field: ResolvedField, f: ViewFilter): SQL | undefined {
  const col = table[field.leaf];
  if (!col) return undefined;
  const v = f.value;
  switch (f.op) {
    case "empty": return isNull(col);
    case "not_empty": return isNotNull(col);
    case "eq": return v == null ? undefined : eq(col, coerce(field, v));
    case "ne": return v == null ? undefined : ne(col, coerce(field, v));
    case "gt": return v == null ? undefined : gt(col, coerce(field, v));
    case "gte": return v == null ? undefined : gte(col, coerce(field, v));
    case "lt": return v == null ? undefined : lt(col, coerce(field, v));
    case "lte": return v == null ? undefined : lte(col, coerce(field, v));
    case "contains": return typeof v === "string" && v ? sql`${col} like ${`%${likeEscape(v)}%`} escape '\\'` : undefined;
    case "in": {
      const list = inList(v);
      return list.length ? or(...list.map((x) => eq(col, coerce(field, x)))) : undefined;
    }
    default: return undefined;
  }
}

const coerce = (field: ResolvedField, v: string | number | boolean) => {
  if (field.kind === "number" || field.kind === "money") return Number(v);
  if (field.kind === "bool") return v === true || v === "true" ? 1 : 0;
  if (field.kind === "date" || field.kind === "datetime") return new Date(String(v));
  return v;
};

/**
 * The in-memory half, over an assembled cell. Same operators, same meaning as `baseFilterSql`.
 *
 * `kind` is the catalogue's own type for the column, and the ordering operators NEED it. A date cell is
 * `ymd()` / ISO TEXT by the time it reaches here (see `cellValue`), so comparing it with `Number(cell)` gave
 * `NaN`, and `NaN > NaN` is false - every one of gt/gte/lt/lte answered false for every row. A date RANGE
 * filter on any column behind a link or a source therefore returned an empty grid, silently and always, while
 * the identical filter on a base column went to SQL and worked. Dates are compared as instants and everything
 * else numerically, and a bound that parses to nothing excludes the row rather than throwing.
 *
 * A date-only bound against a datetime cell resolves to UTC midnight, which is what `coerce` does on the SQL
 * side for the same input - so a filter reads the same either side of the split.
 */
function matches(cell: unknown, f: ViewFilter, kind?: ResolvedField["kind"]): boolean {
  const v = f.value;
  if (f.op === "empty") return cell === null || cell === undefined || cell === "";
  if (f.op === "not_empty") return !(cell === null || cell === undefined || cell === "");
  if (cell === null || cell === undefined) return false;
  if (ORDERING_OPS.has(f.op)) {
    const temporal = kind === "date" || kind === "datetime";
    const l = temporal ? Date.parse(String(cell)) : Number(cell);
    const r = temporal ? Date.parse(String(v ?? "")) : Number(v);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
    switch (f.op) {
      case "gt": return l > r;
      case "gte": return l >= r;
      case "lt": return l < r;
      default: return l <= r; // "lte"
    }
  }
  const s = String(cell).toLowerCase();
  switch (f.op) {
    case "eq": return s === String(v ?? "").toLowerCase();
    case "ne": return s !== String(v ?? "").toLowerCase();
    case "contains": return s.includes(String(v ?? "").toLowerCase());
    case "in": return String(v ?? "").split(",").map((x) => x.trim().toLowerCase()).includes(s);
    default: return true;
  }
}

// ---- Source loaders ---------------------------------------------------------------------------------------
// Each returns `baseRowId -> { <leaf>: value }` for the whole page in one or two queries. `subjects` maps a
// base row to the EMPLOYEE row the source is about, which is what makes a source work identically whether the
// grid's base is people or the tickets they raised.

async function loadSource(
  deps: Deps,
  user: AppUser,
  scopes: Map<string, ListScope>,
  source: string,
  subjects: Map<string, Record<string, any>>,
  spec: ViewSpec,
  opts: RunOptions,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const byEmp = new Map<string, string[]>(); // employee id -> base row ids
  // The DISTINCT employees this page is about. Two tickets from the same person are one employee here, so the
  // decrypt (and every query below) happens once for them rather than once per row.
  const people = new Map<string, Record<string, any>>();
  for (const [rowId, emp] of subjects) {
    const empId = emp.uuid as string;
    people.set(empId, emp);
    const list = byEmp.get(empId) ?? [];
    list.push(rowId);
    byEmp.set(empId, list);
  }
  const empIds = [...people.keys()];
  const put = (empId: string, values: Record<string, unknown>) => {
    for (const rowId of byEmp.get(empId) ?? []) out.set(rowId, { ...(out.get(rowId) ?? {}), ...values });
  };
  const params = spec.params ?? {};

  /**
   * The caller's list scope for the collection a source reads, bound to that table's own (code, owner) pair -
   * the same predicate the base page and every linked row already carry.
   *
   * Presence in `scopes` is only the BOOLEAN half of the decision: `scopesForCollections` puts a collection in
   * the map when `decide()` allows a bare `GET /v1/<collection>` AT ANY BREADTH, and the breadth lives on the
   * ListScope. So gating a source on `listable.has(...)` alone - which is all the catalogue does, and all this
   * function used to do - reads the whole page's worth of rows for a caller entitled to one of them: a reader
   * holding `compensation.read` at `me` breadth, on a grid based on People they may list by department, got
   * every colleague's CTC, payslip net, loan balance and tax declarations. `applyScope` fails closed on an
   * absent scope (`1 = 0`), so an unmapped collection yields nothing rather than everything.
   *
   * The collection is `SOURCES[].collection` from domain/tableFields.ts - the one whose LIST decision gates the
   * source, and therefore the one whose SCOPE does too.
   */
  const scopedTo = (collection: string, code: AnySQLiteColumn, owner: AnySQLiteColumn): SQL | undefined =>
    applyScope(scopes.get(collection), code, owner);

  switch (source) {
    // The three PII blobs already ride on the employee row this page loaded - decrypt CPU, zero extra reads.
    case "identity": {
      const defs = await getFieldDefs(deps);
      for (const [empId, emp] of people) {
        const values = await decryptBlob(deps, emp.identityDetailsEnc);
        put(empId, Object.fromEntries(defs.map((d) => [d.key, values[d.key] ?? null])));
      }
      return out;
    }
    case "personal": {
      for (const [empId, emp] of people) put(empId, await decryptBlob(deps, emp.personalDetailsEnc));
      return out;
    }
    case "bank": {
      for (const [empId, emp] of people) put(empId, await decryptBlob(deps, emp.bankDetailsEnc));
      return out;
    }
    case "comp": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db
          .select()
          .from(schema.compensation)
          .where(and(
            inArray(schema.compensation.employeeId, ids),
            isNull(schema.compensation.deleteTime),
            scopedTo("compensation", schema.compensation.code, schema.compensation.employeeId),
          )),
      );
      const components = await refPayComponents(deps);
      const pfBasis = (await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG)).pf_wage_basis ?? "basic";
      const grades = await deps.db.select().from(schema.payGrades);
      const structures = await deps.db.select().from(schema.salaryStructures);
      const gradeName = new Map(grades.map((g) => [g.uuid, g.name]));
      const structureName = new Map(structures.map((s) => [s.uuid, s.name]));
      // Newest effective row per employee - the one in force, the same pick letters and payroll make.
      const current = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const held = current.get(r.employeeId);
        if (!held || +new Date(r.effectiveFrom) > +new Date(held.effectiveFrom)) current.set(r.employeeId, r);
      }
      // One read per DISTINCT structure, not one per person: a page of 100 people on two salary structures
      // used to be 100 reads of the same two rows.
      const structureLines = new Map<string, Awaited<ReturnType<typeof structureLinesById>>>();
      const linesFor = async (structureId: string | null) => {
        if (!structureId) return null;
        if (!structureLines.has(structureId)) structureLines.set(structureId, await structureLinesById(deps, structureId));
        return structureLines.get(structureId)!;
      };
      for (const [empId, emp] of people) {
        const row = current.get(empId);
        if (!row) continue;
        const eff = applyStructure(components, await linesFor(row.structureId));
        const { lines, ctcMonthly } = ctcLines(row.basePay, eff, !!emp.epfEnrolled, row.specialAllowance, pfBasis);
        const values: Record<string, unknown> = {
          ctc_annual: row.ctcAnnual,
          base_pay: row.basePay,
          special_allowance: row.specialAllowance,
          effective_from: ymd(row.effectiveFrom),
          pay_grade: row.payGradeId ? (gradeName.get(row.payGradeId) ?? null) : null,
          structure: row.structureId ? (structureName.get(row.structureId) ?? null) : null,
          ctc_monthly: ctcMonthly,
        };
        // The breakdown, one cell per component, matched to the annexure line by name.
        const byName = new Map(lines.map((l) => [l.name, l.monthly]));
        for (const c of components) values[`component:${c.uuid}`] = byName.get(c.name) ?? null;
        put(empId, values);
      }
      return out;
    }
    case "position": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db.select().from(schema.positions).where(and(
          inArray(schema.positions.employeeId, ids),
          scopedTo("positions", schema.positions.code, schema.positions.employeeId),
        )),
      );
      const current = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const held = current.get(r.employeeId);
        if (!held || +new Date(r.effectiveFrom) > +new Date(held.effectiveFrom)) current.set(r.employeeId, r);
      }
      for (const [empId, r] of current) put(empId, { job_title: r.jobTitle ?? null, location: r.location ?? null, effective_from: ymd(r.effectiveFrom) });
      return out;
    }
    case "payslip": {
      // The period the view names, or the most recent one that has slips.
      const periods = await refPayPeriods(deps);
      const wanted = params.pay_period?.split("/").pop();
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db.select().from(schema.payslips).where(and(
          inArray(schema.payslips.employeeId, ids),
          scopedTo("payslips", schema.payslips.code, schema.payslips.employeeId),
        )),
      );
      if (!rows.length) return out;
      // A page of a hundred people can carry more than a hundred DISTINCT runs (each person's whole slip
      // history is read here), so this list is chunked for its own sake, not only because empIds was.
      const runs = await byIdChunks([...new Set(rows.map((r) => r.runId))], (ids) =>
        deps.db.select().from(schema.payrollRuns).where(inArray(schema.payrollRuns.uuid, ids)),
      );
      const periodOfRun = new Map(runs.map((r) => [r.uuid, r.payPeriodId]));
      const periodLabel = new Map(periods.map((p) => [p.uuid, p.label]));
      const periodEnd = new Map(periods.map((p) => [p.uuid, +new Date(p.periodEnd)]));
      const pick = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const period = periodOfRun.get(r.runId);
        if (!period) continue;
        if (wanted && period !== wanted) continue;
        const held = pick.get(r.employeeId);
        const heldPeriod = held ? periodOfRun.get(held.runId) : undefined;
        if (!held || (periodEnd.get(period) ?? 0) > (periodEnd.get(heldPeriod ?? "") ?? 0)) pick.set(r.employeeId, r);
      }
      for (const [empId, r] of pick) {
        put(empId, {
          gross: r.gross, taxable_gross: r.taxableGross, total_deductions: r.totalDeductions, tax: r.tax, net: r.net,
          period: periodLabel.get(periodOfRun.get(r.runId) ?? "") ?? null,
        });
      }
      return out;
    }
    case "leave": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db.select().from(schema.leaveBalances).where(and(
          inArray(schema.leaveBalances.employeeId, ids),
          scopedTo("leave-balances", schema.leaveBalances.code, schema.leaveBalances.employeeId),
        )),
      );
      const acc = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        const v = acc.get(r.employeeId) ?? {};
        v[`type:${r.leaveTypeId}`] = r.balanceDays;
        acc.set(r.employeeId, v);
      }
      for (const [empId, v] of acc) put(empId, v);
      return out;
    }
    case "asset": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db
          .select()
          .from(schema.assets)
          .where(and(
            inArray(schema.assets.assignedTo, ids),
            scopedTo("assets", schema.assets.code, schema.assets.assignedTo),
          )),
      );
      const acc = new Map<string, { count: number; tags: string[] }>();
      for (const r of rows) {
        if (!r.assignedTo) continue;
        const v = acc.get(r.assignedTo) ?? { count: 0, tags: [] };
        v.count += 1;
        if (r.assetTag) v.tags.push(r.assetTag);
        acc.set(r.assignedTo, v);
      }
      for (const [empId, v] of acc) put(empId, { count: v.count, tags: v.tags.join(", ") });
      return out;
    }
    case "loan": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db
          .select()
          .from(schema.loans)
          .where(and(
            inArray(schema.loans.employeeId, ids),
            isNull(schema.loans.deleteTime),
            scopedTo("loans", schema.loans.code, schema.loans.employeeId),
          )),
      );
      const acc = new Map<string, { outstanding: number; monthly: number; count: number }>();
      for (const r of rows) {
        if (r.status !== "DISBURSED" && r.status !== "APPROVED") continue;
        const v = acc.get(r.employeeId) ?? { outstanding: 0, monthly: 0, count: 0 };
        v.outstanding += Math.max(0, r.principal - (r.repaid ?? 0));
        v.monthly += r.monthlyAmount ?? 0;
        v.count += 1;
        acc.set(r.employeeId, v);
      }
      for (const [empId, v] of acc) put(empId, { outstanding: round2(v.outstanding), monthly: round2(v.monthly), count: v.count });
      return out;
    }
    case "benefit": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db
          .select()
          .from(schema.benefitEnrollments)
          .where(and(
            inArray(schema.benefitEnrollments.employeeId, ids),
            isNull(schema.benefitEnrollments.deleteTime),
            scopedTo("benefit-enrollments", schema.benefitEnrollments.code, schema.benefitEnrollments.employeeId),
          )),
      );
      const plans = await deps.db.select().from(schema.benefitPlans);
      const planName = new Map(plans.map((p) => [p.uuid, p.name]));
      const acc = new Map<string, string[]>();
      for (const r of rows) {
        if (r.status !== "enrolled") continue;
        const v = acc.get(r.employeeId) ?? [];
        v.push(planName.get(r.planId) ?? "");
        acc.set(r.employeeId, v);
      }
      for (const [empId, v] of acc) put(empId, { plans: v.filter(Boolean).join(", "), count: v.length });
      return out;
    }
    case "dependent": {
      const rows = await byIdChunks(empIds, (ids) =>
        deps.db
          .select()
          .from(schema.dependents)
          .where(and(
            inArray(schema.dependents.employeeId, ids),
            isNull(schema.dependents.deleteTime),
            scopedTo("dependents", schema.dependents.code, schema.dependents.employeeId),
          )),
      );
      const acc = new Map<string, string[]>();
      for (const r of rows) {
        const v = acc.get(r.employeeId) ?? [];
        v.push(r.name);
        acc.set(r.employeeId, v);
      }
      for (const [empId, v] of acc) put(empId, { count: v.length, names: v.join(", ") });
      return out;
    }
    case "tax": {
      const fy = params.financial_year;
      const rows = await byIdChunks(empIds, (ids) => {
        const conds = [
          inArray(schema.taxDeclarations.employeeId, ids),
          isNull(schema.taxDeclarations.deleteTime),
          scopedTo("tax-declarations", schema.taxDeclarations.code, schema.taxDeclarations.employeeId),
        ];
        if (fy) conds.push(eq(schema.taxDeclarations.financialYear, fy));
        return deps.db.select().from(schema.taxDeclarations).where(and(...conds));
      });
      const acc = new Map<string, { declared: number; verified: number }>();
      for (const r of rows) {
        const v = acc.get(r.employeeId) ?? { declared: 0, verified: 0 };
        v.declared += r.declaredAmount ?? 0;
        if (r.status === "VERIFIED") v.verified += r.verifiedAmount ?? r.declaredAmount ?? 0;
        acc.set(r.employeeId, v);
      }
      for (const [empId, v] of acc) put(empId, { declared: round2(v.declared), verified: round2(v.verified) });
      return out;
    }
    case "metric": {
      // The measures are computed by the people-analytics service itself, under the SAME scope map - one
      // implementation of every measure, gated once. Only reached when a measure column was selected.
      // The default window is "this month so far", and BOTH ends of it have to be read in the org's
      // timezone or the grid disagrees with every other surface for part of each day - a UTC "today" rolls
      // the window into the next month early east of UTC and keeps it a day behind west of it, and on the
      // 1st that also moves `from`. See services/orgDay.ts.
      const today = await orgToday(deps);
      const from = params.from || `${today.slice(0, 7)}-01`;
      const to = params.to || today;
      const report = await peopleAnalytics(deps, scopes, { from, to, maxPeople: 200 });
      const byId = new Map(report.people.map((p) => [p.employee.split("/").pop()!, p.values]));
      for (const empId of people.keys()) {
        const values = byId.get(empId);
        if (values) put(empId, values as Record<string, unknown>);
      }
      return out;
    }
    default:
      return out;
  }
}


/** Null-last, numbers numerically, everything else by locale - the same order DataTable sorts by. */
function compareCells(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

async function decryptBlob(deps: Deps, enc: string | null | undefined): Promise<Record<string, string>> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as Record<string, string>;
  } catch {
    return {};
  }
}

