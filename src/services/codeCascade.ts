// Re-parenting cascade: moving a department under a new parent, or an employee into a new department, changes
// that entity's hierarchical `code` (dept-subdept-employee-leaf, domain/codes.ts) - and therefore the code of
// EVERY row nested under it, because authz scope is a code-prefix match (listScope.ts). This recomputes the
// whole moved subtree's codes in place. The wire `id` (uuid) never changes, so there is ZERO client / wire-
// token impact; only the internal scope key moves.
//
// CORRECTNESS: reprefix runs ONLY over the HIERARCHICAL tables (departments, employees, and every
// employee-owned table). Flat tables (holidays, pay-periods, users, boards, ...) are excluded on purpose: a
// flat top-level code like `04` can coincide with a department's top-level code `04`, so an org-wide prefix
// rewrite would corrupt an unrelated flat row. Within the hierarchical set no such collision exists, so
// `code = oldPrefix OR code LIKE oldPrefix||'-%'` selects exactly the subtree.
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { allocUnderDept, CODE_WIDTH } from "./codeAlloc";
import { invalidateCodeCache } from "../lib/authzResolve";
import { invalidArgument } from "../lib/errors";

// The tables whose `code` lives in the dept/employee hierarchy. {employees, departments} + every
// `allocOwnedCode` site (owner = an employee). Kept in lockstep with codeAlloc by test/reparenting.test.ts.
export const HIERARCHICAL_TABLES: { table: any; collection: string }[] = [
  { table: schema.departments, collection: "departments" },
  { table: schema.employees, collection: "employees" },
  { table: schema.leaveRequests, collection: "leave-requests" },
  { table: schema.leaveBalances, collection: "leave-balances" },
  { table: schema.leaveEncashments, collection: "leave-encashments" },
  { table: schema.holidaySelections, collection: "holiday-selections" },
  { table: schema.personalDocuments, collection: "personal-documents" },
  { table: schema.documentAcknowledgements, collection: "document-acknowledgements" },
  { table: schema.payslips, collection: "payslips" },
  { table: schema.compensation, collection: "compensation" },
  { table: schema.positions, collection: "positions" },
  { table: schema.bonuses, collection: "bonuses" },
  { table: schema.settlements, collection: "settlements" },
  { table: schema.reimbursements, collection: "reimbursements" },
  { table: schema.expenses, collection: "expenses" },
  { table: schema.attendanceSessions, collection: "attendance" },
  { table: schema.attendanceRegularizations, collection: "attendance-regularizations" },
  { table: schema.overtimeRequests, collection: "overtime-requests" },
  { table: schema.remoteWorkRequests, collection: "remote-work-requests" },
  { table: schema.noticePeriods, collection: "notice-periods" },
  { table: schema.suggestions, collection: "suggestions" },
  { table: schema.notifications, collection: "notifications" },
  { table: schema.goals, collection: "goals" },
  { table: schema.cards, collection: "cards" },
  { table: schema.reviews, collection: "reviews" },
  { table: schema.reviewFeedback, collection: "review-feedback" },
  { table: schema.transitions, collection: "transitions" },
  { table: schema.transitionTasks, collection: "transition-tasks" },
  { table: schema.checkIns, collection: "check-ins" },
  { table: schema.dependents, collection: "dependents" },
  { table: schema.benefitEnrollments, collection: "benefit-enrollments" },
  { table: schema.shiftAssignments, collection: "shift-assignments" },
  { table: schema.timeEntries, collection: "time-entries" },
  { table: schema.loans, collection: "loans" },
  { table: schema.taxDeclarations, collection: "tax-declarations" },
  { table: schema.referrals, collection: "referrals" },
  { table: schema.interviewFeedback, collection: "interview-feedback" },
  { table: schema.announcements, collection: "announcements" },
  { table: schema.jobs, collection: "operations" },
  { table: schema.tickets, collection: "tickets" },
];

const HIER_COLLECTIONS = HIERARCHICAL_TABLES.map((h) => h.collection);

// Rewrite every hierarchical row under `oldPrefix` to sit under `newPrefix`, preserving the child segments
// (`newPrefix || substr(code, len(oldPrefix)+1)`: the self row -> newPrefix exactly, a child `oldPrefix-x` ->
// `newPrefix-x`). Also fixes any access-rule that references a moved code (per-object `match_code` shares and
// `scope_code` subtree/dept rules), scoped to hierarchical namespaces so a flat code is never touched.
export async function reprefixSubtree(deps: Deps, oldPrefix: string, newPrefix: string): Promise<void> {
  if (!oldPrefix || oldPrefix === newPrefix) return;
  const from = oldPrefix.length + 1; // 1-indexed substr start just past the old prefix
  const under = (c: any) => or(eq(c, oldPrefix), like(c, `${oldPrefix}-%`)); // exact or nested (boundary-safe)
  for (const { table } of HIERARCHICAL_TABLES) {
    await deps.db
      .update(table)
      .set({ code: sql`${newPrefix} || substr(${table.code}, ${from})` })
      .where(under(table.code));
  }
  // access_rules: matchCode (per-object) + scopeCode (subtree/dept) may point at a moved code. Only touch rules
  // in a hierarchical namespace (a flat namespace's code can collide with a dept's top-level code).
  const hierNs = inArray(schema.accessRules.namespace, HIER_COLLECTIONS);
  await deps.db
    .update(schema.accessRules)
    .set({ matchCode: sql`${newPrefix} || substr(${schema.accessRules.matchCode}, ${from})`, updatedAt: new Date() })
    .where(and(hierNs, under(schema.accessRules.matchCode)));
  await deps.db
    .update(schema.accessRules)
    .set({ scopeCode: sql`${newPrefix} || substr(${schema.accessRules.scopeCode}, ${from})`, updatedAt: new Date() })
    .where(and(hierNs, under(schema.accessRules.scopeCode)));
  // Codes changed: drop this isolate's uuid->code cache immediately (others self-heal via its TTL).
  invalidateCodeCache();
}

// Move an employee into a new department (null = top-level/unassigned). Allocates the employee's new segment
// under the target dept, reprefixes the employee row + all its owned rows, then repoints departmentId.
export async function moveEmployee(deps: Deps, employeeId: string, oldCode: string, newDeptId: string | null): Promise<string> {
  const newCode = await allocUnderDept(deps, newDeptId, CODE_WIDTH.employee);
  await reprefixSubtree(deps, oldCode, newCode);
  await deps.db.update(schema.employees).set({ departmentId: newDeptId, updatedAt: new Date() }).where(eq(schema.employees.uuid, employeeId));
  return newCode;
}

// Move a department under a new parent (null = top-level). Cycle-guarded (a dept can't move under itself or a
// descendant). Allocates the dept's new segment under the target parent, then reprefixes the whole subtree
// (sub-departments, their employees, and every owned row) and repoints parentId.
export async function moveDepartment(deps: Deps, deptId: string, oldCode: string, newParentId: string | null): Promise<string> {
  if (newParentId === deptId) throw invalidArgument("a department cannot be its own parent");
  if (newParentId) {
    const parent = (await deps.db.select({ code: schema.departments.code }).from(schema.departments).where(eq(schema.departments.uuid, newParentId)).limit(1))[0];
    if (!parent) throw invalidArgument("parent department not found");
    if (parent.code && (parent.code === oldCode || parent.code.startsWith(`${oldCode}-`))) throw invalidArgument("a department cannot be moved under itself or one of its descendants");
  }
  const newCode = await allocUnderDept(deps, newParentId, CODE_WIDTH.dept);
  await reprefixSubtree(deps, oldCode, newCode);
  await deps.db.update(schema.departments).set({ parentId: newParentId, updatedAt: new Date() }).where(eq(schema.departments.uuid, deptId));
  return newCode;
}
