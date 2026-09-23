import * as schema from "../db/schema";
import type { Deps } from "../deps";

// Read-mostly REFERENCE tables, read whole ONCE PER REQUEST.
//
// Why these tables: each is a small catalog (org settings, pay components, leave types, holidays, departments,
// pay periods) that services read WHOLE, and read repeatedly inside one operation. A payroll build scanned
// `pay_components` three times; a request that consults three settings keys scanned `settings` three times; a
// `batch:run` of twenty reads paid all of it per sub-request. D1 bills rows read, so those repeats are the bill,
// and none of them can change mid-request.
//
// Scope is deliberately ONE REQUEST, not the isolate. These are the tables the money math reads - a stale pay
// component or CTC setting prices payroll wrong - so nothing here may outlive the request that read it. Where
// cross-request caching IS safe and worthwhile, it lives in the client (the SPA holds catalogs for minutes, see
// web/src/lib/resourceStore.ts) or behind an explicit bust (the policy cache, lib/cache.ts).
//
// The memo rides `deps.refCache`, which the request middleware creates. Deps built outside a request (a cron
// tick, a service called directly from a test) have none, and then every read goes straight to D1 - so nothing
// can be served a snapshot older than the caller's own call. A batch's sub-requests SHARE the parent's Deps, so
// the whole fan-out shares one snapshot.
//
// Consumers get the SHARED array - treat it as immutable (map/filter, never sort or splice in place).

export type RefTable =
  | "settings"
  | "pay_components"
  | "leave_types"
  | "holidays"
  | "departments"
  | "pay_periods"
  | "pay_grades"
  | "salary_structures"
  | "asset_categories";

/** Create the per-request memo. Called by the request middleware; absent everywhere else. */
export const makeRefCache = (): Map<string, Promise<unknown>> => new Map();

function once<T>(deps: Deps, table: RefTable, load: () => Promise<T>): Promise<T> {
  const memo = deps.refCache;
  if (!memo) return load(); // no request scope -> always fresh
  const hit = memo.get(table) as Promise<T> | undefined;
  if (hit) return hit;
  // `load()` hands back a drizzle query BUILDER, which runs the query on every await - so awaiting a stored
  // builder twice would be two reads and defeat the whole point. Settle it into a real promise first.
  const p = (async () => await load())();
  memo.set(table, p as Promise<unknown>);
  return p;
}

export const refSettings = (deps: Deps) => once(deps, "settings", () => deps.db.select().from(schema.settings));
export const refPayComponents = (deps: Deps) => once(deps, "pay_components", () => deps.db.select().from(schema.payComponents));
export const refLeaveTypes = (deps: Deps) => once(deps, "leave_types", () => deps.db.select().from(schema.leaveTypes));
export const refHolidays = (deps: Deps) => once(deps, "holidays", () => deps.db.select().from(schema.holidays));
export const refDepartments = (deps: Deps) => once(deps, "departments", () => deps.db.select().from(schema.departments));
export const refPayPeriods = (deps: Deps) => once(deps, "pay_periods", () => deps.db.select().from(schema.payPeriods));
// The two ladder catalogs. Every compensation answer decorates its rows with the grade's name/band and the
// structure's name (services/compensation.ts withGrades), and the custom-grid `comp` source needs the same two
// maps - so they are read whole, repeatedly, by the surfaces that read compensation. They belong here for the
// reason every table above does: a `batch:run` carrying several compensation sub-requests shares one Deps, so
// without the memo it paid both catalogs once per sub-request. Deleted rows are deliberately INCLUDED: these
// reads resolve a name for a stored foreign key, and a grade retired after a revision was signed still names
// the grade that revision was priced at.
export const refPayGrades = (deps: Deps) => once(deps, "pay_grades", () => deps.db.select().from(schema.payGrades));
export const refSalaryStructures = (deps: Deps) => once(deps, "salary_structures", () => deps.db.select().from(schema.salaryStructures));
// The asset catalogue, read for its `useful_life_months` when an asset answer is valued (services/assets.ts).
// Here for the reason the ladder catalogs are: the valuation runs over every row of an asset page, so without
// the memo a page of 100 assets would resolve the same handful of categories 100 times. Deleted categories are
// INCLUDED, again for the same reason - an asset still pointing at a retired category is still depreciated on
// the life that category was given.
export const refAssetCategories = (deps: Deps) => once(deps, "asset_categories", () => deps.db.select().from(schema.assetCategories));

/**
 * Drop this request's snapshot of a table, so a later read in the SAME request sees a write it just made.
 * (Across requests there is nothing to drop - the memo dies with the request.)
 */
export function bustRef(deps: Deps, table: RefTable): void {
  deps.refCache?.delete(table);
}
