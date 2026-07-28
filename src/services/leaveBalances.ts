import { eq, and } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { keysetPage } from "./keysetPage";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Read-only: balances are produced by the accrual cron. Visibility (own / dept / all) comes from the grant.
export async function listLeaveBalances(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string) {
  const conds = [applyScope(scope, schema.leaveBalances.code, schema.leaveBalances.employeeId)];
  const empFilter = idFromPath(employee);
  if (empFilter) conds.push(eq(schema.leaveBalances.employeeId, empFilter));
  return keysetPage(deps, schema.leaveBalances, "leave-balances", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getLeaveBalance(deps: Deps, _actor: AppUser, id: string) {
  // Item access (own / dept / all) is enforced by the middleware on leave-balances/<code>.
  const row = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave balance not found");
  return row;
}
