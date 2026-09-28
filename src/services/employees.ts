import { allocFlatCode, allocUnderDept, withFreshCode, CODE_WIDTH } from "./codeAlloc";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { mayAdministerAccount, type ListScope } from "../domain/access";
import { eq, and, asc, isNotNull, isNull, sql } from "drizzle-orm";
import { roleHolderEmployeeIds, holdsForAnyone } from "./capabilityHolders";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, fieldDiff } from "../lib/audit";
import { emitEvent } from "./eventBus";
import { notify, notifyMany } from "./notifications";
import { invalidArgument, failedPrecondition, notFound, aborted, isCodeCollision, isEmployeeNumberCollision } from "../lib/errors";
import { hasOpening } from "./leaveAdjustments";
import { moveEmployee } from "./codeCascade";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";
import { getSettingValue } from "./settings";
import { DEFAULT_EMPLOYEE_NUMBER_CONFIG, formatEmployeeNumber, nextSeq } from "../domain/employeeNumber";
import { checkEtag, updateAtVersion } from "./versionGuard";
import { softDeleteRow } from "./softDelete";
import { orgToday } from "./orgDay";
import { provisionedRole } from "./roles";

// Wire input is snake_case (matches the OpenAPI schema). national_id/bank_details are write-only.
export type EmployeeInput = {
  first_name?: string;
  last_name?: string;
  legal_name?: string | null;
  work_email?: string;
  job_title?: string | null;
  employee_number?: string | null; // human ID; auto-assigned on create when omitted, HR-overridable
  department?: string | null; // departments/{id}
  manager?: string | null; // employees/{id}
  start_date?: string | null; // YYYY-MM-DD
  probation_end_date?: string | null; // YYYY-MM-DD
  tracked_from?: string | null; // YYYY-MM-DD - the day HRMS records start (db/schema.ts employees.trackedFrom)
  epf_enrolled?: boolean;
  eps_excluded?: boolean;
  national_id?: string | null;
  // bank details are managed via the dedicated :getBankDetails/:setBankDetails methods.
};

// Next auto employee number from the org format (settings/employee-number) + the highest existing sequence.
// Read-then-write like code allocation - a concurrent double-create can race, but the UNIQUE index on
// employee_number is the backstop (the loser's insert fails). Fine for an internal-scale app.
async function allocEmployeeNumber(deps: Deps): Promise<string> {
  const cfg = await getSettingValue(deps, "employee-number", DEFAULT_EMPLOYEE_NUMBER_CONFIG);
  const rows = await deps.db.select({ n: schema.employees.employeeNumber }).from(schema.employees);
  return formatEmployeeNumber(cfg, nextSeq(cfg, rows.map((r) => r.n)), new Date().getUTCFullYear());
}

// Reject a duplicate human ID (case-insensitive), so an HR override never collides. `exceptId` skips the row
// being updated. The UNIQUE index enforces this at the DB too; this is the friendly, pre-flight check.
async function assertNumberFree(deps: Deps, number: string, exceptId?: string): Promise<void> {
  const key = number.trim().toLowerCase();
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid, n: schema.employees.employeeNumber })
    .from(schema.employees);
  if (rows.some((r) => r.uuid !== exceptId && (r.n ?? "").trim().toLowerCase() === key))
    throw invalidArgument(`employee number ${number} is already in use`);
}

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dateMs = (s?: string | null) => (s ? new Date(s + "T00:00:00Z") : null);
// `tracked_from` decides which days payroll may dock, so a value that is not a calendar day is refused rather
// than stored as an Invalid Date the way the looser `dateMs` would - and so is a FUTURE day, which would leave
// every no-show between now and then undocked (services/trackedFrom.ts refuses one for the same reason).
async function parseTrackedFrom(deps: Deps, s?: string | null): Promise<Date | null> {
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00Z") : null;
  if (!d || Number.isNaN(+d) || d.toISOString().slice(0, 10) !== s) throw invalidArgument("tracked_from must be a calendar date (YYYY-MM-DD)");
  if (s > (await orgToday(deps))) throw invalidArgument("tracked_from can't be in the future");
  return d;
}
const addMonths = (ms: number, months: number) => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
};

export async function listEmployees(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, showDeleted = false, q?: string, deletedOnly = false) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  // `q` narrows further via the FTS index - a filter, never a widening (see services/searchFilter.ts).
  const conds = [
    applyScope(scope, schema.employees.code, schema.employees.uuid),
    // `deletedOnly` is the trash by itself - a "Deleted" view is its own fetch, not a filter over a page of
    // mostly-live people.
    deletedOnly ? isNotNull(schema.employees.deleteTime) : showDeleted ? undefined : isNull(schema.employees.deleteTime),
    await searchFilter(deps, "employees", q, schema.employees.uuid),
  ].filter(Boolean);
  return keysetPage(deps, schema.employees, "employees", and(...(conds as any)), { max: maxPageSize, pageToken });
}

export async function getEmployee(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  // Item-level access (own / dept / hr / super) is enforced by the middleware on employees/<code>.
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

// Give the person a sign-in account. An access rule names a `users/{id}` subject (domain/policyValidate.ts),
// so somebody with no account row cannot be granted anything and does not appear in the people pickers at all -
// which is why the access modal used to offer only the handful who had already signed in. Provisioning here
// makes the account exist from the moment the employee does, and first login then finds it by email instead of
// minting a second one (middleware/auth.ts).
//
// An account with the same email may already exist (they signed in before HR added them, or an earlier record
// used the address): link it if it is unlinked, and otherwise leave it alone rather than steal it from the
// employee it points at. `email` is UNIQUE, so this must look before it inserts.
async function provisionAccount(deps: Deps, employeeId: string, workEmail: string) {
  const email = workEmail.toLowerCase();
  // Ordered, because `lower(email) = ?` is not a unique predicate: `email` is UNIQUE on the RAW column, so a
  // row stored as `Alice@corp` and one stored as `alice@corp` can both exist and both match. Unordered, which
  // of them this links the new employee to is whatever the engine happened to return first - and the two rows
  // carry different roles and different access rules. Oldest first, so the account that has been accruing the
  // grants is the one that gets the link (middleware/auth.ts breaks the same tie the same way).
  const existing = (
    await deps.db
      .select({ uuid: schema.users.uuid, employeeId: schema.users.employeeId })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`)
      .orderBy(asc(schema.users.createdAt), asc(schema.users.uuid))
      .limit(1)
  )[0];
  if (existing) {
    if (!existing.employeeId) {
      await deps.db
        .update(schema.users)
        .set({ employeeId, updatedAt: new Date() })
        .where(and(eq(schema.users.uuid, existing.uuid), isNull(schema.users.employeeId)));
    }
    return;
  }
  // LOWERCASED, not the address as typed. This row IS the sign-in identity, and every lane that resolves a
  // caller lowercases first (the Access JWT's `email`, the session cookie's, the dev bypass) - so a work email
  // entered as `Aarav.Sharma@corp.com` was provisioned verbatim and then never found by the login that came
  // looking for `aarav.sharma@corp.com`. Which minted a SECOND account, at the provisioned role: the
  // person signs in to no access, while the row HR gave their real role to sits unused beside it, holding the
  // access rules and keys that were meant for them. Exactly what the comment above says this exists to avoid.
  const role = await provisionedRole(deps);
  await deps.db
    .insert(schema.users)
    .values({ code: await allocFlatCode(deps, schema.users), email, role, employeeId });
}

/**
 * Does this account hold nothing beyond what hiring gives anybody: the provisioned role as its primary, no
 * secondary role, and no access rule written for it personally? Such an account is what HR creates by hiring,
 * so HR re-pointing its sign-in address hands nobody anything HR could not have given. Two reads, on a
 * work-email change only.
 */
async function isPlainAccount(deps: Deps, account: { uuid: string; role: string }): Promise<boolean> {
  const provisioned = await provisionedRole(deps);
  if (account.role !== provisioned) return false;
  const extraRole = (await deps.db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, account.uuid))).some((r) => r.role !== provisioned);
  if (extraRole) return false;
  const ownRule = await deps.db
    .select({ uuid: schema.accessRules.uuid })
    .from(schema.accessRules)
    .where(and(eq(schema.accessRules.subjectKind, "user"), eq(schema.accessRules.subject, account.uuid), eq(schema.accessRules.effect, "allow")))
    .limit(1);
  return ownRule.length === 0;
}

export async function createEmployee(deps: Deps, actor: AppUser, input: EmployeeInput, id?: string) {
  if (!input.first_name || !input.last_name || !input.work_email)
    throw invalidArgument("first_name, last_name, work_email are required");
  // Read out here rather than off `input` below: the insert runs inside a closure (the allocation retry), and
  // a narrowing from the guard above does not survive into one.
  const { first_name: firstName, last_name: lastName, work_email: workEmail } = input;
  const nationalIdEnc = input.national_id ? await deps.encryptor.encrypt(input.national_id) : null;
  // Human ID: an HR-provided override (validated unique), else auto-assigned from the org format.
  const override = input.employee_number?.trim();
  if (override) await assertNumberFree(deps, override);
  const startDate = dateMs(input.start_date);
  const trackedFrom = await parseTrackedFrom(deps, input.tracked_from);
  // Default probation end to start_date + the org default probation period when not given explicitly.
  let probationEndDate = dateMs(input.probation_end_date);
  if (!probationEndDate && startDate) {
    const { default_months } = await getSettingValue(deps, "probation", { default_months: 3 });
    probationEndDate = addMonths(+startDate, default_months);
  }
  // Both allocated numbers sit inside the retry: the authz `code` under the department, and the human
  // employee number - each read-max-then-write, each unique, so two people added at once collide on one of
  // them (codeAlloc.ts withFreshCode). An HR admin pasting a new intake while a manager adds one hire is
  // exactly that. A number typed in by hand is not re-allocated: it is the number the org has decided on,
  // and a second attempt would not free it, so that collision still reaches the caller as a conflict.
  const row = (await withFreshCode(
    async () =>
      deps.db
    .insert(schema.employees)
    .values({
      // `uuid`, which is the primary key (schema.ts). Spelled `{ id }` this named no column at all, so a
      // caller-specified id was silently dropped and a random one minted - and that path exists to make a
      // create IDEMPOTENT, so a client retrying a timed-out request made a second person instead of being
      // told the first already existed.
      ...(id ? { uuid: id } : {}),
      firstName,
      lastName,
      // Empty string clears, like an omitted field: the SPA sends "" for a text box the user left blank
      // (nothing on the wire is ever null - see web/src/api.ts).
      legalName: input.legal_name?.trim() || null,
      workEmail,
      jobTitle: input.job_title?.trim() || null,
      employeeNumber: override || (await allocEmployeeNumber(deps)),
      code: await allocUnderDept(deps, idFromPath(input.department) ?? null, CODE_WIDTH.employee),
      departmentId: idFromPath(input.department),
      managerId: idFromPath(input.manager),
      startDate,
      probationEndDate,
      trackedFrom,
      nationalIdEnc,
    })
        .returning(),
    (e) => isCodeCollision(e) || (!override && isEmployeeNumberCollision(e)),
  ))[0]!;
  await audit(deps, actor, "employee.create", "employees", row.uuid, createdMeta(row, "employees"), row);
  await provisionAccount(deps, row.uuid, row.workEmail);
  await emitEvent(deps, actor, "employee.created", {
    subject: `employees/${row.uuid}`,
    employeeId: row.uuid,
    payload: { departmentId: row.departmentId ?? null, startDate: row.startDate ? new Date(row.startDate).toISOString() : null },
  });
  return row;
}

// Move the linked account onto the employee's new work email (or provision one, for an employee created
// before accounts were provisioned on create). A DIFFERENT account already holding the new address is left
// alone: `email` is UNIQUE, and stealing or clobbering it would sign somebody else out of their own account -
// the employee edit still stands, and the two rows are reconciled by whoever owns that other account.
//
// WHO MAY MOVE IT. The account is the identity every grant hangs off, and auth resolves a caller by this column,
// so moving it re-points whatever that account holds at the new mailbox. Editing employee records is HR's; the
// accounts themselves are not (`users.*` is an account admin's). So the login follows the work email only when
// the editor may administer that account, or when the account is a PLAIN one - the default role, no second role,
// no rule of its own - which is no more than HR hands anybody by hiring them. Anything more privileged keeps its
// sign-in address, the mismatch goes on the record, and the account admins are told.
async function syncAccountEmail(deps: Deps, actor: AppUser, employeeId: string, workEmail: string) {
  const taken = (
    await deps.db
      .select({ uuid: schema.users.uuid })
      .from(schema.users)
      .where(and(sql`lower(${schema.users.email}) = ${workEmail.toLowerCase()}`, sql`${schema.users.employeeId} is not ${employeeId}`))
      .limit(1)
  ).length > 0;
  // Said out loud rather than returned in silence. The employee row moves to the new address either way, so
  // after this the person's work email and their sign-in address disagree - which is a state somebody has to
  // reconcile and nothing else in the app will mention.
  if (taken) {
    console.warn(`[employees] work email for employees/${employeeId} moved to an address another account already holds; the sign-in address was left as it was`);
    return;
  }
  const linked = (
    await deps.db.select({ uuid: schema.users.uuid, code: schema.users.code, role: schema.users.role }).from(schema.users).where(eq(schema.users.employeeId, employeeId)).limit(1)
  )[0];
  if (!linked) return provisionAccount(deps, employeeId, workEmail);
  if (!(await isPlainAccount(deps, linked)) && !(linked.code && mayAdministerAccount(actor, linked.code))) {
    await audit(deps, actor, "employee.loginEmailMismatch", "employees", employeeId, {
      account: `users/${linked.uuid}`,
      work_email: workEmail.toLowerCase(),
      reason: "the account holds more than a plain employee account, and only an account admin may move its sign-in address",
    });
    const admins = await roleHolderEmployeeIds(deps, holdsForAnyone("users.*", "write"), actor.employeeId);
    if (admins.length) {
      await notifyMany(deps, admins, {
        type: "account.loginEmailMismatch",
        title: "Sign-in address left unchanged",
        body: `A work email was changed to ${workEmail.toLowerCase()}, but the linked account holds elevated access, so its sign-in address was not moved. Update it from the account if the change is right.`,
        link: "settings/users",
        actorId: actor.employeeId,
      }).catch(() => {});
    }
    return;
  }
  // Lowercased, for the reason `provisionAccount` gives: this column is what a login is looked up by.
  //
  // AND THE LIVE SESSIONS END WITH IT. A session cookie carries the EMAIL and nothing else (lib/session.ts), and
  // it is verified by signature alone for its full 12 hours - so moving this column leaves a valid cookie naming
  // an address no account holds any more. The next request with it does not fail: middleware/auth.ts misses on
  // both lookups, finds the old address still inside an allowed domain, finds no employee with that work email
  // (this edit just moved it), and AUTO-PROVISIONS a second account - default `employee` role, no employee link.
  // Every `me`-scoped grant matches by employee code, so the person carries on in an app with nothing in it and
  // no error, while their real account sits unused with their real roles on it. The phantom row then owns the
  // old address, so the `taken` check above silently declines to move anybody else onto it later.
  //
  // `sessionsValidFrom` is the mechanism already built for exactly this (routes/authRoutes.ts stamps it on sign
  // out): every cookie issued before this instant is refused, so the person signs in again - silently, since
  // Google re-auth is a redirect - and comes back on the account that moved. Stamped in the SAME write, so
  // there is no window where the address has changed and the old sessions are still good.
  await deps.db
    .update(schema.users)
    .set({ email: workEmail.toLowerCase(), sessionsValidFrom: new Date(), updatedAt: new Date() })
    .where(eq(schema.users.uuid, linked.uuid));
}

/**
 * Soft-delete an employee AND end their access, which the generic lane did not.
 *
 * There are two ways out of the company and they used to give two different answers. Offboarding says what it
 * means - `terminateForOffboarding` stamps the employee terminated and sets the linked `users` row to
 * `disabled`, under the comment "disable their login". `DELETE /v1/employees/<id>` declared no override, so the
 * generic `softDeleteRow` ran: it stamped `employees.delete_time` and touched nothing else. The person vanished
 * from the directory and went on signing in with full self-service - clocking in, filing leave, raising
 * tickets, posting to the board - because every `me`-scoped grant still resolved off the deleted row.
 *
 * The delete itself stays the generic one (etag check, lifecycle lock, `removedMeta` audit, restorable); what
 * is added is the half offboarding already does. The login is disabled AFTER the delete lands, so a delete that
 * loses its version guard leaves the account alone.
 *
 * A restore does NOT re-enable the login, deliberately: re-granting access is a decision, not a side effect of
 * undoing a deletion, and `users.status` is editable on its own.
 */
export async function removeEmployee(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.employees, "employee", "employees", id, ifMatch);
  const disabled = await deps.db
    .update(schema.users)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(and(eq(schema.users.employeeId, id), eq(schema.users.status, "active")))
    .returning({ uuid: schema.users.uuid });
  // Recorded separately from the delete: "their account was switched off" is a different fact from "their row
  // was removed", and it is the one somebody asks about later.
  if (disabled.length) await audit(deps, actor, "employee.disableLogin", "employees", id, { via: "delete", users: disabled.length });
}

/** How far up a reporting line is walked before the depth itself is treated as a cycle. */
const MANAGER_CHAIN_CAP = 100;

/**
 * Refuse a manager assignment that would close the reporting line into a loop.
 *
 * The DEPARTMENT hierarchy has had this since it existed (codeCascade.ts#moveDepartment refuses a self-parent
 * and a move under a descendant), and goals check both `parent` and `blocked_by` the same way. The manager line
 * had nothing: `set.managerId` took whatever the patch named, so "Priya now reports to Sam" while Sam still
 * reports to Priya - a state an HR admin passes through mid-reorg - was writable, from the API and from the two
 * manager pickers alike. The client refused it in exactly one place, the org chart's drag handler, and that
 * check reads a tree capped at 1000 rows so it cannot even see a descendant past the cap.
 *
 * Here rather than in the UI because this is the only place that holds for every write path, and because the
 * cost of a cycle lands on every consumer that walks the chain afterwards.
 *
 * ONE STATEMENT, for the reason goals.ts#followChain gives: a D1 query is a subrequest against a 50-per-
 * invocation budget, and an update that also cascades codes, writes, audits and notifies cannot spend a read
 * per level. The walk starts AT the proposed manager and climbs; finding `id` on the way up means the edit
 * would point the line back at itself. Deleted rows are walked through rather than stopping the walk - a
 * soft-deleted manager in the middle still links the two ends.
 */
async function assertNoManagerCycle(deps: Deps, id: string, nextManagerId: string): Promise<void> {
  if (nextManagerId === id) throw invalidArgument("an employee cannot be their own manager");
  const rows = await deps.db.all<{ id: string | null }>(sql`
    with recursive chain(id, depth) as (
      select "manager_id", 1 from "employees" where "uuid" = ${nextManagerId}
      union all
      select e."manager_id", c.depth + 1 from "employees" e join chain c on e."uuid" = c.id
      where c.id is not null and c.depth <= ${MANAGER_CHAIN_CAP}
    )
    select id from chain where id is not null
  `);
  const chain = rows.map((r) => r.id).filter((x): x is string => !!x);
  if (chain.includes(id)) throw invalidArgument("that would make the reporting line circular: they already report to this employee");
  // A chain longer than the cap is degenerate whatever it is - a loop the walk could not close inside the cap,
  // or a hierarchy deeper than any real org - and either way it is not a shape to write more of.
  if (chain.length > MANAGER_CHAIN_CAP) throw invalidArgument("reporting line is too deep");
}

// JSON Merge Patch: present = set, explicit null = clear, absent = unchanged.
export async function updateEmployee(deps: Deps, actor: AppUser, id: string, patch: EmployeeInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  assertNotLocked(row);
  checkEtag(row, ifMatch);

  const set: SetOf<typeof schema.employees> = { updatedAt: new Date() };
  let moved = false; // a re-parent writes this row itself - see the note by the guarded write below
  const has = (k: keyof EmployeeInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("first_name")) set.firstName = patch.first_name;
  if (has("last_name")) set.lastName = patch.last_name;
  if (has("legal_name")) set.legalName = patch.legal_name?.trim() || null;
  if (has("work_email")) set.workEmail = patch.work_email;
  if (has("job_title")) set.jobTitle = patch.job_title?.trim() || null;
  if (has("employee_number")) {
    const n = patch.employee_number?.trim();
    if (!n) throw invalidArgument("employee_number can't be blank");
    await assertNumberFree(deps, n, id);
    set.employeeNumber = n;
  }
  if (has("department")) {
    const next = idFromPath(patch.department) ?? null;
    // Re-parent: recompute the employee's code + cascade every owned row (leave, payslips, comp, ...) + any
    // access-rule codes. moveEmployee sets departmentId itself, so it's not added to `set`.
    // Refs, not the bare ids the column holds: an internal id must not reach the wire, and `departments/<id>`
    // is a thing the reader's client resolves to the department's NAME.
    if (next !== row.departmentId) { await moveEmployee(deps, id, row.code!, next); moved = true; await audit(deps, actor, "employee.reparent", "employees", id, { from: row.departmentId ? `departments/${row.departmentId}` : null, to: next ? `departments/${next}` : null }); }
  }
  if (has("manager")) {
    const nextMgr = idFromPath(patch.manager) ?? null;
    if (nextMgr && nextMgr !== row.managerId) await assertNoManagerCycle(deps, id, nextMgr);
    set.managerId = nextMgr;
  }
  if (has("start_date")) set.startDate = dateMs(patch.start_date);
  if (has("probation_end_date")) set.probationEndDate = dateMs(patch.probation_end_date);
  if (has("tracked_from")) {
    const next = await parseTrackedFrom(deps, patch.tracked_from);
    // An opening balance was measured against this day (services/leaveAdjustments.ts): what HRMS credited
    // before it was taken off and the old system's figure put on. Moving the day now would leave that
    // arithmetic describing a different day, so it stays; a balance that needs changing gets an adjustment.
    if (+(next ?? 0) !== +(row.trackedFrom ?? 0) && (await hasOpening(deps, id))) {
      throw failedPrecondition("leave opening balances were entered as of this day, so it can't move now - adjust the balance instead");
    }
    set.trackedFrom = next;
  }
  if (has("epf_enrolled")) set.epfEnrolled = !!patch.epf_enrolled;
  if (has("eps_excluded")) set.epsExcluded = !!patch.eps_excluded;
  if (has("national_id")) set.nationalIdEnc = patch.national_id ? await deps.encryptor.encrypt(patch.national_id) : null;

  // THE CASCADE ABOVE REWRITES THIS VERY ROW, so the version to guard the write below with is the one that
  // exists AFTER it, not the one read at the top. The guard is there to refuse somebody ELSE'S concurrent
  // write; pinning the pre-cascade version would make this request conflict with itself and answer 409 for a
  // re-parent that was working perfectly. Re-read only on the path that moved something.
  const version = moved ? (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0] ?? row : row;
  const updated = await updateAtVersion(deps, schema.employees, "employee", version, set);
  // Diff non-sensitive fields (never the encrypted national id) for the activity trail; fall back to field names.
  // The sign-in account is keyed by email, so a corrected work address has to move with it - otherwise the
  // account keeps the old address and the person's next login mints a SECOND one under the new email.
  if (set.workEmail && set.workEmail.toLowerCase() !== row.workEmail.toLowerCase()) await syncAccountEmail(deps, actor, id, set.workEmail);
  const keys = Object.keys(set).filter((k) => k !== "updatedAt" && k !== "nationalIdEnc");
  const diff = fieldDiff(row, updated!, keys, "employees");
  const changedSensitive = "nationalIdEnc" in set;
  await audit(deps, actor, "employee.update", "employees", id, Object.keys(diff).length || changedSensitive ? { diff, ...(changedSensitive ? { fields: ["national_id"] } : {}) } : undefined);
  // A manager reassignment tells the employee who they now report to, and the new manager who joined their team.
  if (has("manager") && updated!.managerId !== row.managerId && updated!.managerId) {
    const empName = `${updated!.firstName} ${updated!.lastName}`.trim();
    if (updated!.managerId !== actor.employeeId)
      await notify(deps, { recipient: updated!.managerId, type: "system.reports_to_you", title: "New report", body: `${empName} now reports to you.`, link: "employees", subject: `employees/${id}`, actorId: actor.employeeId });
    if (id !== actor.employeeId)
      await notify(deps, { recipient: id, type: "system.manager_changed", title: "Your manager was updated", body: "Your reporting manager has changed - see your profile.", link: "profile", subject: `employees/${id}`, actorId: actor.employeeId });
  }
  return updated;
}




/** Public "about me" one-liner shown on profile heroes and the directory. Plain text on the base
 *  record (not PII, no encryption) so display rides every employee read for free. Access (owner /
 *  HR / super) is enforced by the middleware on employees/<code>/bio. */
export async function setBio(deps: Deps, actor: AppUser, id: string, bio: string | null | undefined) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  const v = (bio ?? "").trim();
  if (v.length > 280) throw invalidArgument("bio is too long (max 280 characters)");
  await deps.db.update(schema.employees).set({ bio: v || null, updatedAt: new Date() }).where(eq(schema.employees.uuid, id));
  await audit(deps, actor, "employee.bio.update", "employees", id, { diff: { bio: { from: row.bio, to: v || null } } }, row);
  return { bio: v || undefined };
}
