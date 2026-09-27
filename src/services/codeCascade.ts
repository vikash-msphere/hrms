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
// `code = oldPrefix OR code GLOB oldPrefix||'-*'` selects exactly the subtree.
//
// TWO TABLES ARE MIXED, and that collision is not hypothetical for them. `jobs` and `announcements` allocate
// an OWNED code when the act has an employee behind it and a FLAT one when it does not (payroll.ts publishRun:
// "a creator with no employee record gets a flat code + null owner"; announcements.ts: author-owned or flat).
// `CODE_WIDTH.flat` and `CODE_WIDTH.dept` are both 2 over the same alphabet, so the flat code `0a` IS a
// well-formed department code - and the `code = oldPrefix` arm matched it. Reparenting department `0a` rewrote
// the eleventh job ever queued to that department's new code, on a UNIQUE column: either the row silently
// claimed a department it has nothing to do with (and `code_sequences` still hands `0a` out again later, so the
// next enqueue collides), or the UPDATE threw and took the whole cascade with it. `ownedWhen` is the
// discriminator the allocation itself uses - the owner column is non-null exactly when the code is owned - so a
// mixed table contributes only its hierarchical rows and its flat ones are left alone.
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { allocUnderDept, CODE_WIDTH } from "./codeAlloc";
import { invalidateCodeCache } from "../lib/authzResolve";
import { clearCachePrefix } from "../lib/cache";
import { invalidArgument } from "../lib/errors";
import { runBatch, type BatchStmt } from "../lib/dbBatch";

/**
 * A table whose `code` lives in the dept/employee hierarchy.
 *
 * `collection` is the wire collection whose `access_rules` namespace may carry a code for these rows, or null
 * for an internal table that has no wire collection at all (`comp_off_credits`) - such a table still needs its
 * codes rewritten, but no rule can name it, so it contributes nothing to the namespace filter below.
 *
 * `ownedWhen` narrows a MIXED table to the rows that actually took an owned code (see the header).
 */
type HierTable = { table: any; collection: string | null; ownedWhen?: (t: any) => SQL };

// {employees, departments} + every `allocOwnedCode` site (owner = an employee). Kept in lockstep with
// codeAlloc by test/reparenting.test.ts, which scans the services for every owned-code allocation and fails
// when one of them is missing from this list - the direction that had let four collections drift out of it.
export const HIERARCHICAL_TABLES: HierTable[] = [
  { table: schema.departments, collection: "departments" },
  { table: schema.employees, collection: "employees" },
  { table: schema.leaveRequests, collection: "leave-requests" },
  { table: schema.leaveBalances, collection: "leave-balances" },
  { table: schema.leaveEncashments, collection: "leave-encashments" },
  { table: schema.leaveAdjustments, collection: "leave-adjustments" },
  { table: schema.payrollOpenings, collection: "payroll-openings" },
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
  { table: schema.attendanceDayMarks, collection: "attendance-day-marks" },
  { table: schema.overtimeRequests, collection: "overtime-requests" },
  { table: schema.remoteWorkRequests, collection: "remote-work-requests" },
  { table: schema.lateEarlyRequests, collection: "late-early-requests" },
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
  { table: schema.workPatternAssignments, collection: "work-pattern-assignments" },
  { table: schema.timeEntries, collection: "time-entries" },
  { table: schema.loans, collection: "loans" },
  { table: schema.taxDeclarations, collection: "tax-declarations" },
  { table: schema.referrals, collection: "referrals" },
  { table: schema.interviewFeedback, collection: "interview-feedback" },
  { table: schema.backgroundChecks, collection: "background-checks" },
  // Mixed: owned when the poster/creator has an employee record, flat when they do not. See the header.
  { table: schema.announcements, collection: "announcements", ownedWhen: (t) => isNotNull(t.authorEmployeeId) },
  { table: schema.jobs, collection: "operations", ownedWhen: (t) => isNotNull(t.employeeId) },
  { table: schema.tickets, collection: "tickets" },
  // These four are owned-coded (`allocOwnedCode`) and were NOT in this list, so a reparent left their codes
  // under the old prefix while the employee moved. Authz scope is a code-prefix match, so the rows stayed
  // inside the OLD department's breadth, never appeared in the new one's - and, because a `me`-scoped rule
  // matches by code too, the employee lost sight of their own rows. Silent, permanent, and invisible to the
  // tripwire below until it learned to check this direction.
  { table: schema.assetRequests, collection: "asset-requests" },
  { table: schema.approvalDelegations, collection: "approval-delegations" },
  { table: schema.tableViews, collection: "table-views" },
  // Internal: credited by the comp-off cron, no wire collection, so no access rule can name it. Its code is
  // owner-embedded all the same, and a code left behind is a trap for whoever exposes the collection next.
  { table: schema.compOffCredits, collection: null },
  // Loss-of-pay corrections for closed periods. Same shape as comp-off credits above and here for the same
  // reason: no wire collection today, an owner-embedded code regardless, and re-parenting it on a transfer
  // costs nothing now while back-filling it later would mean repairing codes on rows that already exist.
  //
  // KEEPING THE OWNED CODE WAS A DECISION, not an inheritance. Nothing resolves it today - the rows are read
  // by the run build and become a payslip line - so the allocation could have been dropped instead of
  // cascaded. Two things decided it. An employee who is owed a refund has a real claim to SEE it before it
  // turns up on a payslip, which makes serving this collection likely rather than hypothetical; and an
  // adjustment is raised only when attendance moves for an ALREADY-PAID period, which is rare, so the
  // allocation is not on any hot path. Dropping the code to avoid this entry would also have been optimising
  // against the guard rather than satisfying it.
  { table: schema.lopAdjustments, collection: null },
];

export const HIER_COLLECTIONS = HIERARCHICAL_TABLES.map((h) => h.collection).filter((c): c is string => c !== null);

/**
 * The id-position tokens that are SCOPE WORDS, not codes. Never rewritten, and the guard is not cosmetic.
 *
 * `me` and `my-dept` are resolved per caller (domain/permissions.ts matchToken), so they carry no literal code
 * and a move must leave them alone. The reason they need an explicit skip rather than falling out of the
 * prefix test is that a CODE SEGMENT CAN SPELL THEM: segments come from the Crockford alphabet
 * (domain/codes.ts), which contains m, y, e and d - so a two-character department really can be coded `my`,
 * and `"my-dept".startsWith("my-")` is true. Without this list, re-parenting that department would rewrite
 * every `my-dept` rule in the app into a subtree rule for the moved department - turning "your own department"
 * into "that one", for every holder, silently. `*` / `**` have no separator and could not match anyway; they
 * are listed because the set is "tokens that are not codes", not "tokens that happen to be safe".
 */
const SCOPE_WORDS = new Set(["me", "my-dept", "*", "**"]);

/**
 * One access-rule pattern, retargeted from `oldPrefix` to `newPrefix`, or null when it names no moved code.
 *
 * WHY THIS EXISTS AT ALL. The cascade rewrote `match_code` and `scope_code` and left `pattern` alone - and
 * `pattern` is the one that decides. schema.ts says so on the column ("VERBATIM grant pattern - the decision
 * input, never re-derived") and domain/compileGrants.ts says the others are "DERIVED narrowing keys the DB
 * uses to fetch a SUPERSET of candidate rows". So after a move the narrowing key found the rule and the engine
 * then failed to match it: `decide()` compared the stored `employees.04-002.**` against the resource
 * `employees.05-001` and answered no.
 *
 * That is a SILENT revocation of every per-object share and every subtree rule pointing into the moved
 * subtree, and it displayed as working: services/accessRules.ts resolves a rule's `scope_ref` from
 * `match_code`, the column that WAS updated, so the manage-access modal went on showing the rule as active and
 * pointing at the moved record. Fail-closed (access is lost, never gained) and invisible, which is the pair
 * that makes it worth a helper of its own rather than an inline expression.
 *
 * The code lives at token[1] - the id position - in every shape the ACL authors (`<col>.<code>.**`,
 * `<col>.<code>.<field>.**`, `<col>.<code>.<verb>`, and the subtree form `<col>.<code>-*.**`). Only that token
 * is touched, so a field path or a verb tail rides through untouched.
 *
 * PURE, and exported, because the shapes it must refuse are the ones no scenario test naturally produces.
 */
export function reprefixPattern(pattern: string, oldPrefix: string, newPrefix: string): string | null {
  const toks = pattern.split(".");
  const id = toks[1];
  if (id === undefined || SCOPE_WORDS.has(id)) return null;
  // The subtree spelling carries a `-*` tail on the code; strip it, rewrite the code, put it back.
  const subtree = id.endsWith("-*");
  const code = subtree ? id.slice(0, -2) : id;
  // Exactly the containment `reprefixSubtree` selects rows by: the moved row itself, or something under it.
  // Boundary-anchored, so the neighbour `04-0029` is not caught by a move of `04-002`.
  if (code !== oldPrefix && !code.startsWith(`${oldPrefix}-`)) return null;
  toks[1] = `${newPrefix}${code.slice(oldPrefix.length)}${subtree ? "-*" : ""}`;
  return toks.join(".");
}

/**
 * Rewrite every hierarchical row under `oldPrefix` to sit under `newPrefix`, preserving the child segments
 * (`newPrefix || substr(code, len(oldPrefix)+1)`: the self row -> newPrefix exactly, a child `oldPrefix-x` ->
 * `newPrefix-x`). Also fixes any access-rule that references a moved code (per-object `match_code` shares and
 * `scope_code` subtree/dept rules), scoped to hierarchical namespaces so a flat code is never touched.
 *
 * ONE ATOMIC BATCH, and `also` is what makes that complete. This used to be forty-odd `await`ed UPDATEs in a
 * loop, and the caller then repointed `parentId`/`departmentId` in a statement of its own AFTERWARDS. Two
 * problems, one shape:
 *
 *   - NOT ATOMIC. Any failure partway - a UNIQUE collision on a mixed table (see the header), a timeout, the
 *     subrequest ceiling - left the subtree's codes HALF rewritten with the parent pointer still on the old
 *     parent. That is corruption of the authz scope key itself: some rows answer to the old prefix and some to
 *     the new, so the moved employee is partly in each department and fully in neither. Nothing detects it and
 *     there is no operation that repairs it.
 *   - FORTY-THREE SEQUENTIAL ROUND TRIPS. A D1 query is a subrequest; the free per-invocation budget is 50 and
 *     wrangler.toml claims every request path is shaped for it. This one path spent the whole budget on its
 *     own, before auth, the audit row and the event emission were counted.
 *
 * `db.batch` is one subrequest and one implicit transaction (lib/dbBatch.ts), so the caller's repoint travels
 * INSIDE it: the codes and the pointer that explains them now land together or not at all.
 */
export async function reprefixSubtree(deps: Deps, oldPrefix: string, newPrefix: string, also: BatchStmt[] = []): Promise<void> {
  if (!oldPrefix || oldPrefix === newPrefix) {
    await runBatch(deps.db, also);
    return;
  }
  const from = oldPrefix.length + 1; // 1-indexed substr start just past the old prefix
  // Exact or nested (boundary-safe). GLOB rather than LIKE so the prefix half can use the index on `code`
  // instead of scanning the table - the same reason services/listScope.ts uses it, and it matters more here:
  // this predicate runs once per hierarchical table, so LIKE made a reparent forty-three full table scans.
  const under = (c: any) => or(eq(c, oldPrefix), sql`${c} glob ${`${oldPrefix}-*`}`);
  const stmts: BatchStmt[] = [];
  for (const { table, ownedWhen } of HIERARCHICAL_TABLES) {
    stmts.push(
      deps.db
        .update(table)
        .set({ code: sql`${newPrefix} || substr(${table.code}, ${from})` })
        // A mixed table contributes only the rows that took an OWNED code; its flat-coded rows share the
        // dept-code namespace and must not be touched.
        .where(ownedWhen ? and(under(table.code), ownedWhen(table)) : under(table.code)),
    );
  }
  // access_rules: matchCode (per-object) + scopeCode (subtree/dept) may point at a moved code. Only touch rules
  // in a hierarchical namespace (a flat namespace's code can collide with a dept's top-level code).
  const hierNs = inArray(schema.accessRules.namespace, HIER_COLLECTIONS);
  stmts.push(
    deps.db
      .update(schema.accessRules)
      .set({ matchCode: sql`${newPrefix} || substr(${schema.accessRules.matchCode}, ${from})`, updatedAt: new Date() })
      .where(and(hierNs, under(schema.accessRules.matchCode))),
    deps.db
      .update(schema.accessRules)
      .set({ scopeCode: sql`${newPrefix} || substr(${schema.accessRules.scopeCode}, ${from})`, updatedAt: new Date() })
      .where(and(hierNs, under(schema.accessRules.scopeCode))),
  );
  // AND THE PATTERN, which is the column that actually decides - see `reprefixPattern` for what leaving it
  // behind cost. Rewritten row by row rather than by `substr` arithmetic in SQL, because the code does not sit
  // at a fixed offset in a pattern: the id token is preceded by a namespace of any length and followed by an
  // optional field path or verb, and the subtree spelling carries a `-*` tail that shifts every offset after
  // it by two. One narrow read (hierarchical namespaces, rules whose id position can hold a literal code, and
  // only those under the moved prefix) buys an unambiguous rewrite, on an action an org performs rarely.
  //
  // The updates ride the SAME batch as everything above, so the pattern and the narrowing keys that fetch it
  // can never disagree about where a rule points - which is exactly the split that produced the defect.
  const patternRules = await deps.db
    .select({ uuid: schema.accessRules.uuid, pattern: schema.accessRules.pattern })
    .from(schema.accessRules)
    .where(and(
      hierNs,
      inArray(schema.accessRules.scopeKind, ["exact", "subtree"]),
      or(under(schema.accessRules.matchCode), under(schema.accessRules.scopeCode)),
    ));
  for (const r of patternRules) {
    const next = reprefixPattern(r.pattern, oldPrefix, newPrefix);
    if (!next) continue; // names no moved code (a scope word, or a neighbour the boundary test excludes)
    stmts.push(
      deps.db
        .update(schema.accessRules)
        .set({ pattern: next, updatedAt: new Date() })
        .where(eq(schema.accessRules.uuid, r.uuid)),
    );
  }
  await runBatch(deps.db, [...stmts, ...also]);
  // Codes changed: drop this isolate's uuid->code cache immediately (others self-heal via its TTL).
  invalidateCodeCache();
  // AND THE CACHED AUTHORITY, for the same reason services/accessRules.ts busts it after a rule edit: the rows
  // this just rewrote ARE the compiled grant, and lib/policyLoad.ts caches them (`grant:` per role, `userGrant:`
  // per user, `objRules:` per caller) for a few seconds. Without this the isolate that performed the move goes
  // on deciding from the pre-move patterns until the TTL lapses - so the admin who just re-parented someone is
  // the one person guaranteed to see the old scope. Best-effort and per-isolate exactly like the rule-edit
  // path; other isolates converge on the same TTL. Whole bands, because a move touches whoever holds a rule
  // into the subtree rather than one named subject.
  clearCachePrefix("grant:");
  clearCachePrefix("userGrant:");
  clearCachePrefix("objRules:");
}

// Move an employee into a new department (null = top-level/unassigned). Allocates the employee's new segment
// under the target dept, then reprefixes the employee row + all its owned rows AND repoints departmentId in
// one atomic batch - the pointer and the codes it explains must never disagree (see reprefixSubtree).
export async function moveEmployee(deps: Deps, employeeId: string, oldCode: string, newDeptId: string | null): Promise<string> {
  const newCode = await allocUnderDept(deps, newDeptId, CODE_WIDTH.employee);
  await reprefixSubtree(deps, oldCode, newCode, [
    deps.db.update(schema.employees).set({ departmentId: newDeptId, updatedAt: new Date() }).where(eq(schema.employees.uuid, employeeId)),
  ]);
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
  await reprefixSubtree(deps, oldCode, newCode, [
    deps.db.update(schema.departments).set({ parentId: newParentId, updatedAt: new Date() }).where(eq(schema.departments.uuid, deptId)),
  ]);
  return newCode;
}
