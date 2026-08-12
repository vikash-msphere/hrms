import { eq, and } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { keysetPage } from "./keysetPage";
import { crudService, type CrudSpec } from "./crud";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Read-only: balances are produced by the accrual cron. Visibility (own / dept / all) comes from the grant.
export async function listLeaveBalances(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string) {
  const conds = [applyScope(scope, schema.leaveBalances.code, schema.leaveBalances.employeeId)];
  const empFilter = idFromPath(employee);
  if (empFilter) conds.push(eq(schema.leaveBalances.employeeId, empFilter));
  return keysetPage(deps, schema.leaveBalances, "leave-balances", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

// Balances are produced by the accrual cron, never written through the API, and never deleted - so the spec
// carries no insert/patch and the table no delete_time. The factory mounts exactly list + get from that.
// Item access (own / dept / all) is enforced by the middleware on leave-balances/<code>.
export const leaveBalanceSpec: CrudSpec<never> = {
  table: schema.leaveBalances,
  collection: "leave-balances",
  auditName: "leave_balance",
  notFound: "leave balance not found",
};

export const { get: getLeaveBalance } = crudService(leaveBalanceSpec);
