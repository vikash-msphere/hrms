import { eq, and, lte, gte } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, removedMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { has, type CrudSpec, type SetOf } from "./crud";
import { orgToday, dayStartMs } from "./orgDay";

export type ApprovalDelegationInput = {
  delegator?: string | null;
  delegate?: string | null;
  from_date?: string;
  to_date?: string;
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// The delegates covering an employee's approvals TODAY (their active delegations). Used by the notification
// layer to copy the delegate while the delegator is away. Cheap indexed read; safe to call per-notification
// (the org-day read is memoized per request by lib/refData, so it costs nothing after the first).
//
// "Today" is the ORG's day, never UTC's. This used to take an instant and derive the day from its UTC parts,
// which is the shape services/orgDay.ts exists to remove: `from_date`/`to_date` name calendar days somebody
// picked in the org's timezone, and in IST the UTC day rolls over five and a half hours late. The delegate
// was therefore not copied for the first ~5.5h of the first covered day, nor for the last ~5.5h of the last -
// a cover gap at exactly the edges the person set the delegation for, and invisible in any test run at noon.
// The columns themselves are date-only, anchored at UTC midnight, so the org day is compared through
// `dayStartMs` (its documented inverse) rather than by building a Date out of local parts.
export async function activeDelegatesFor(deps: Deps, delegatorId: string): Promise<string[]> {
  const t = new Date(dayStartMs(await orgToday(deps)));
  const rows = await deps.db
    .select({ delegateId: schema.approvalDelegations.delegateId })
    .from(schema.approvalDelegations)
    .where(and(eq(schema.approvalDelegations.delegatorId, delegatorId), lte(schema.approvalDelegations.fromDate, t), gte(schema.approvalDelegations.toDate, t)));
  return [...new Set(rows.map((r) => r.delegateId))];
}

export async function listApprovalDelegations(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string) {
  const conds = [applyScope(scope, schema.approvalDelegations.code, schema.approvalDelegations.delegatorId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.approvalDelegations.delegatorId, empId));
  const all = await deps.db.select().from(schema.approvalDelegations).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined);
  return paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "desc", { codec: deps.idCodec, collection: "approval-delegations" });
}

// Reject overlapping delegations to the same delegate, so the window stays unambiguous.
async function assertNoOverlap(deps: Deps, delegatorId: string, from: Date, to: Date, excludeId?: string) {
  const rows = await deps.db.select().from(schema.approvalDelegations).where(eq(schema.approvalDelegations.delegatorId, delegatorId));
  for (const r of rows) {
    if (excludeId && r.uuid === excludeId) continue;
    if (+new Date(r.fromDate) <= +to && +new Date(r.toDate) >= +from) throw invalidArgument("overlaps an existing delegation for this period");
  }
}

// Revoking a delegation is a HARD delete: `activeDelegatesFor` matches on the date window alone, so a row left
// behind with a delete mark would keep re-routing the delegator's approvals. Hence no restore, no `?force`.
export async function deleteApprovalDelegation(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.approvalDelegations).where(eq(schema.approvalDelegations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("approval delegation not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  await deps.db.delete(schema.approvalDelegations).where(eq(schema.approvalDelegations.uuid, id));
  // A hard delete (see above): who was covering for whom, and when, survives only here.
  await audit(deps, actor, "approvalDelegation.delete", "approval-delegations", id, removedMeta(row, "approval-delegations"), row);
}

export const approvalDelegationSpec: CrudSpec<ApprovalDelegationInput, typeof schema.approvalDelegations> = {
  table: schema.approvalDelegations,
  collection: "approval-delegations",
  auditName: "approvalDelegation",
  notFound: "approval delegation not found",
  allocCode: (deps, table, values) => allocOwnedCode(deps, table, schema.approvalDelegations.delegatorId, values.delegatorId as string),
  insert: async (input, deps, actor) => {
    const delegatorId = idFromPath(input.delegator) ?? actor.employeeId;
    if (!delegatorId) throw invalidArgument("delegator is required");
    const delegateId = idFromPath(input.delegate);
    if (!delegateId) throw invalidArgument("delegate is required");
    if (delegateId === delegatorId) throw invalidArgument("cannot delegate to yourself");
    const from = dayMs(input.from_date), to = dayMs(input.to_date);
    if (Number.isNaN(from) || Number.isNaN(to)) throw invalidArgument("from_date and to_date are required");
    if (to < from) throw invalidArgument("to_date must be on or after from_date");
    await assertNoOverlap(deps, delegatorId, new Date(from), new Date(to));
    return {
      delegatorId,
      delegateId,
      fromDate: new Date(from),
      toDate: new Date(to),
      reason: input.reason?.trim() || null,
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.approvalDelegations> = {};
    if (has(patch, "delegate")) {
      const delegateId = idFromPath(patch.delegate);
      if (!delegateId) throw invalidArgument("delegate is required");
      if (delegateId === row.delegatorId) throw invalidArgument("cannot delegate to yourself");
      set.delegateId = delegateId;
    }
    if (has(patch, "from_date")) { const v = dayMs(patch.from_date); if (Number.isNaN(v)) throw invalidArgument("from_date is invalid"); set.fromDate = new Date(v); }
    if (has(patch, "to_date")) { const v = dayMs(patch.to_date); if (Number.isNaN(v)) throw invalidArgument("to_date is invalid"); set.toDate = new Date(v); }
    if (has(patch, "reason")) set.reason = patch.reason?.trim() || null;
    const from = (set.fromDate as Date) ?? new Date(row.fromDate), to = (set.toDate as Date) ?? new Date(row.toDate);
    if (+to < +from) throw invalidArgument("to_date must be on or after from_date");
    await assertNoOverlap(deps, row.delegatorId, from, to, row.uuid);
    return set;
  },
};

