// Effective-access preview: run the SAME engine (decide over role+everyone+user grants, merged with the
// target object's exception rules) for arbitrary subject users against one or more targets, and report the
// verdicts. Read-only and side-effect free - this powers the ACL modal's "view as" panel, the impact warning
// before a destructive rule change, and the employee's own "who can see this?" report. It is a REPORT of what
// the engine would decide, never an enforcement path: the middleware keeps making every real decision per
// request.
import { inArray, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { byIdChunks } from "../lib/dbBatch";
import type { Deps } from "../deps";
import { decide, matchingPattern, capabilitiesOf, type Grant, type Level } from "../domain/permissions";
import { mergeGrants, rulesToGrant, deriveNarrowing, type ScopeKind } from "../domain/compileGrants";
import { EMPTY_GRANT, roleSubjectsOf } from "../domain/grants";
import { ancestorsOf } from "../domain/codes";
import { loadRoleGrant, loadUserGrant, loadUserRoles, loadObjectRulesForRequest } from "../lib/policyLoad";
import { uuidToCode, tableFor } from "../lib/authzResolve";
import { invalidArgument, notFound, forbidden } from "../lib/errors";
import type { AppUser } from "../env";
import { provisionedRole } from "./roles";

const NAME_RE = /^[a-z][a-z0-9-]*$/; // collection / field tokens
const VERB_RE = /^[a-zA-Z]+$/;
const MAX_SUBJECTS = 100;

export type PreviewBody = {
  subjects: string[]; // "users/<uuid>" or "employees/<uuid>" (wire ids already decoded at the edge)
  collection?: string; // optional ONLY with include_capabilities (capability-set-only call)
  object?: string; // "<collection>/<uuid>", or "<collection>/me" for each subject's own record; must match `collection`
  field?: string; // requires `object` (field keys are object-anchored in the engine)
  verb?: string; // custom method to check alongside the standard ladder
  // Also return capabilitiesOf(broad grant) per subject - the same scope-stripped set /users/me carries,
  // which is exactly what the web shell gates nav/pages/buttons on. Powers app-wide "view as".
  include_capabilities?: boolean;
};

/**
 * One thing to grade, for the multi-target entry point below.
 *
 * `code` is an INTERNAL escape hatch: an object code the caller already holds, or a synthetic one (a code that
 * no row carries yet, to answer "who would see one of these if I had one"). It is deliberately absent from
 * `PreviewBody`, because a code taken from the wire would let a caller point the report at any prefix in the
 * tree; every route-facing call names an `object` and has it resolved here instead.
 */
export type PreviewTarget = {
  collection: string;
  object?: string;
  code?: string;
  field?: string;
  verb?: string;
};

export type PreviewVerdict = {
  subject: string; // "users/<uuid>" (encoded back to a wire id at the edge)
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  read: boolean;
  write: boolean;
  admin: boolean;
  verb_allowed?: boolean; // present when a verb was asked
  why?: ScopeKind; // scope of the pattern granting read (mirrors access.why)
  denied: boolean; // an explicit deny rule matched (read or the asked verb)
  capabilities?: string[]; // present when include_capabilities was asked ([] for a disabled account)
};

// One uniform record per subject, whichever way it was addressed.
type Subject = {
  ref: string;
  userUuid: string | null;
  userCode: string | null;
  email: string;
  role: string;
  status: string;
  employeeCode: string | null;
  firstName: string | null;
  lastName: string | null;
};

// A subject plus the grant assembly that does not depend on which target is being graded. Built ONCE per
// call and reused across every target, which is what makes a many-target report (services/myViewers.ts grades
// twenty-odd areas over the same roster) cost one subject resolution rather than twenty.
type Assembled = { subject: Subject; roles: string[]; broad: Grant };

/**
 * `actor` is the caller the preview is run FOR, and it is what bounds which subjects they may ask about.
 *
 * Optional only for the internal paths that have no principal, and for the one report whose disclosure is
 * narrower than the check would be (services/myViewers.ts - see its header); every route passes it.
 */
export async function previewAccess(deps: Deps, body: PreviewBody, actor?: AppUser): Promise<PreviewVerdict[]> {
  const { field, verb } = body;
  // Capability-only calls may omit the collection (there is no target to grade); a graded call needs one.
  const collection = body.collection ?? "";
  if (!collection && !body.include_capabilities) throw invalidArgument("collection required");
  if (!collection && (body.object !== undefined || field !== undefined || verb !== undefined)) throw invalidArgument("object/field/verb need a collection");

  const subjects = await resolveSubjects(deps, body.subjects);
  if (actor) assertActorMaySee(actor, subjects);
  const assembled = await assembleGrants(deps, subjects);

  // The ungraded capability-only call: no resource, so nothing to decide - only the capability set.
  if (!collection) return assembled.map((a) => verdict(a, null, null, true));

  const spec = await resolveTarget(deps, { collection, object: body.object, field, verb });
  return gradeTarget(deps, assembled, spec, body.include_capabilities === true);
}

/**
 * The same report over SEVERAL targets, sharing one subject resolution and one grant assembly.
 *
 * Returns one verdict list per target, positionally. Internal only (no wire body): the callers are reports
 * that grade a fixed catalogue of areas, and they hold their own object codes.
 */
export async function previewAccessMany(
  deps: Deps,
  subjectRefs: string[],
  targets: PreviewTarget[],
  actor?: AppUser,
): Promise<PreviewVerdict[][]> {
  const subjects = await resolveSubjects(deps, subjectRefs);
  if (actor) assertActorMaySee(actor, subjects);
  const assembled = await assembleGrants(deps, subjects);
  const out: PreviewVerdict[][] = [];
  for (const t of targets) out.push(await gradeTarget(deps, assembled, await resolveTarget(deps, t), false));
  return out;
}

/** Validate a target and resolve its object ref to the internal CODE the engine matches scope tokens against. */
async function resolveTarget(deps: Deps, t: PreviewTarget): Promise<{ collection: string; resource: string; code: string | null; verb?: string }> {
  const { collection, field, verb } = t;
  if (!NAME_RE.test(collection)) throw invalidArgument("invalid collection");
  if (field !== undefined && !NAME_RE.test(field)) throw invalidArgument("invalid field");
  if (verb !== undefined && !VERB_RE.test(verb)) throw invalidArgument("invalid verb");

  // Scope tokens (me / my-dept / prefix) match codes, not uuids. An object of a foreign collection is a caller
  // error; an unknown id is not-found (fail closed).
  let code: string | null = t.code ?? null;
  if (t.object !== undefined) {
    const slash = t.object.indexOf("/");
    const objCollection = slash > 0 ? t.object.slice(0, slash) : "";
    if (objCollection !== collection) throw invalidArgument("object does not belong to the target collection");
    // `<collection>/me` is each subject's OWN record, decided on the literal key `<collection>.me` - the key a
    // self-acting request (`POST /v1/attendance/me:clockIn`) is decided on, since lib/authzResolve.ts leaves
    // `me` in the path unresolved. A record-level verb asked of the bare collection is decided on
    // `<collection>.<verb>` instead, which no `me`/`my-dept`/object rule can match, so it reported "cannot
    // clockIn" for every employee who could. There is no row behind `me`, so no object exceptions overlay it.
    if (t.object.slice(slash + 1) === "me") {
      if (field !== undefined) throw invalidArgument("a field target needs an object id");
      return { collection, resource: `${collection}.me`, code: null, ...(verb !== undefined ? { verb } : {}) };
    }
    if (!tableFor(collection)) throw invalidArgument("collection has no addressable objects");
    code = await uuidToCode(deps, collection, t.object.slice(slash + 1));
    if (!code) throw notFound("target object not found");
  }
  if (field !== undefined && code === null) throw invalidArgument("a field target needs an object");
  return { collection, resource: [collection, ...(code ? [code] : []), ...(field ? [field] : [])].join("."), code, ...(verb !== undefined ? { verb } : {}) };
}

/** Resolve subject refs to one uniform record each - two reads, whatever the mix of accounts and people. */
async function resolveSubjects(deps: Deps, refs: string[]): Promise<Subject[]> {
  if (!Array.isArray(refs) || refs.length === 0) throw invalidArgument("subjects required");
  if (refs.length > MAX_SUBJECTS) throw invalidArgument(`at most ${MAX_SUBJECTS} subjects per call`);
  // A subject is a sign-in account ("users/<id>") OR a person ("employees/<id>"). People resolve to their
  // linked account when one exists; a person who has never signed in is graded as the account they WOULD
  // get on first sign-in (the default `employee` role + everyone, their employee code, no user rules) - so
  // "what would Priya see" has an answer before Priya's first login.
  const parsed = refs.map((s) => {
    if (typeof s === "string" && s.startsWith("users/")) return { kind: "account" as const, id: s.slice("users/".length), ref: s };
    if (typeof s === "string" && s.startsWith("employees/")) return { kind: "person" as const, id: s.slice("employees/".length), ref: s };
    throw invalidArgument("subjects must be users/<id> or employees/<id> refs");
  });

  const userIds = parsed.filter((p) => p.kind === "account").map((p) => p.id);
  const empIds = parsed.filter((p) => p.kind === "person").map((p) => p.id);
  // Chunked, because MAX_SUBJECTS is 100 and D1 binds at most 100 parameters per statement (PARAM_CAP): a
  // caller previewing 100 accounts spent the entire allowance on the IN list, leaving none for anything else
  // the statement might come to bind. `byIdChunks` returns [] for an empty list without issuing a query, so
  // the length guards these reads used to carry are gone rather than duplicated.
  const userRows = await byIdChunks(userIds, (group) =>
    deps.db
      .select({
        uuid: schema.users.uuid,
        code: schema.users.code,
        email: schema.users.email,
        role: schema.users.role,
        status: schema.users.status,
        employeeCode: schema.employees.code,
        firstName: schema.employees.firstName,
        lastName: schema.employees.lastName,
      })
      .from(schema.users)
      .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
      .where(inArray(schema.users.uuid, group)),
  );
  const empRows = await byIdChunks(empIds, (group) =>
    deps.db
      .select({
        empUuid: schema.employees.uuid,
        empCode: schema.employees.code,
        firstName: schema.employees.firstName,
        lastName: schema.employees.lastName,
        workEmail: schema.employees.workEmail,
        userUuid: schema.users.uuid,
        userCode: schema.users.code,
        email: schema.users.email,
        role: schema.users.role,
        status: schema.users.status,
      })
      .from(schema.employees)
      .leftJoin(schema.users, eq(schema.users.employeeId, schema.employees.uuid))
      .where(inArray(schema.employees.uuid, group)),
  );
  const byUserId = new Map(userRows.map((u) => [u.uuid, u]));
  const byEmpId = new Map(empRows.map((e) => [e.empUuid, e]));
  // A person with no account yet is previewed at the role their first sign-in would give them. Read once, and
  // only when such a person is in the batch.
  const unprovisioned = empRows.some((e) => !e.userUuid) ? await provisionedRole(deps) : null;
  return parsed.map((p) => {
    if (p.kind === "account") {
      const u = byUserId.get(p.id);
      if (!u) throw notFound(`subject ${p.ref} not found`);
      return { ref: p.ref, userUuid: u.uuid, userCode: u.code ?? null, email: u.email, role: u.role, status: u.status, employeeCode: u.employeeCode ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null };
    }
    const e = byEmpId.get(p.id);
    if (!e) throw notFound(`subject ${p.ref} not found`);
    return e.userUuid
      ? { ref: p.ref, userUuid: e.userUuid, userCode: e.userCode ?? null, email: e.email!, role: e.role!, status: e.status!, employeeCode: e.empCode, firstName: e.firstName, lastName: e.lastName }
      : { ref: p.ref, userUuid: null, userCode: null, email: e.workEmail, role: unprovisioned!, status: "active", employeeCode: e.empCode, firstName: e.firstName, lastName: e.lastName };
  });
}

/**
 * THE CALLER'S OWN SCOPE OVER THE SUBJECTS, which this had none of.
 *
 * The verdict rows carry each subject's email, name, role and - with `include_capabilities` - their whole
 * capability set, for up to MAX_SUBJECTS arbitrary refs. The verb gating the route (`access-rules.preview`)
 * is collection-level, so it carries no object to scope on: granting "let the access admins use the preview
 * panel" therefore handed over an org-wide email/role directory, which is exactly what services/users.ts
 * narrowed listUsers to stop ("an admin holds users.**, everyone else holds only users.me.**... so their page
 * is their own account and not every email and role in the company").
 *
 * Decided on the caller's BROAD grant, in memory, with no per-object rule merge: a per-object share that
 * would widen the caller's reach is not consulted, so the check can only be narrower than a real
 * `GET /v1/users/<id>` would be - the fail-closed direction, and no extra read per subject. A subject with no
 * account yet is graded against `employees.<code>` instead, because that is the record they actually are.
 */
function assertActorMaySee(actor: AppUser, subjects: Subject[]): void {
  const self = { employeeCode: actor.employeeCode ?? null };
  const maySee = (s: Subject) => {
    const resource = s.userCode ? `users.${s.userCode}` : s.employeeCode ? `employees.${s.employeeCode}` : null;
    return !!resource && decide(actor.grant, { kind: "standard", resource, level: "read" }, self).allow;
  };
  const hidden = subjects.find((s) => !maySee(s));
  if (hidden) throw forbidden(`you don't have access to ${hidden.ref}`);
}

/**
 * Each subject's role + user grant, merged - the BROAD grant, before any object-exception overlay.
 *
 * Same assembly as the middleware: role grant (everyone folded in, super-exempt) + the user's own broad
 * rules. Every role the subject holds, not just their primary - otherwise the preview understates a person who
 * was given a second role, which is the exact case the preview exists to make legible. A subject with no
 * account (a person who has never signed in) holds no secondary roles by construction.
 */
async function assembleGrants(deps: Deps, subjects: Subject[]): Promise<Assembled[]> {
  return Promise.all(
    subjects.map(async (subject) => {
      const extraRoles = subject.userUuid ? await loadUserRoles(deps, subject.userUuid) : [];
      const roles = [...new Set([subject.role, ...extraRoles])];
      const [roleGrants, userGrant] = await Promise.all([
        Promise.all(roles.map((r) => loadRoleGrant(deps, r))),
        subject.userUuid ? loadUserGrant(deps, subject.userUuid) : Promise.resolve(EMPTY_GRANT),
      ]);
      return { subject, roles, broad: mergeGrants(roleGrants.reduce(mergeGrants), userGrant) };
    }),
  );
}

/** One target graded for every subject: the object's exception rules overlaid, then the ladder decided. */
async function gradeTarget(
  deps: Deps,
  assembled: Assembled[],
  spec: { collection: string; resource: string; code: string | null; verb?: string },
  includeCapabilities: boolean,
): Promise<PreviewVerdict[]> {
  const ancestors = spec.code ? ancestorsOf(spec.code) : [];
  const out: PreviewVerdict[] = [];
  for (const a of assembled) {
    // Per-object exceptions for THIS subject on THIS object: a share raises access, a per-object deny blocks
    // it. The rows are cached per user, so a many-target report pays for them once.
    let grant = a.broad;
    if (spec.code) {
      const roleSubjects = roleSubjectsOf({ role: a.subject.role, roles: a.roles }, grant);
      const objRules = await loadObjectRulesForRequest(deps, a.subject.userUuid ?? "", roleSubjects, spec.collection, ancestors);
      if (objRules.length) grant = mergeGrants(grant, rulesToGrant(objRules));
    }
    out.push(verdict(a, spec, grant, includeCapabilities));
  }
  return out;
}

/** The verdict row: the ladder decided on the merged grant, plus the flags the UI explains itself with. */
function verdict(
  a: Assembled,
  spec: { resource: string; verb?: string } | null,
  grant: Grant | null,
  includeCapabilities: boolean,
): PreviewVerdict {
  const u = a.subject;
  const self = { employeeCode: u.employeeCode ?? null };
  const g = grant ?? a.broad;
  const level = (l: Level) => (spec ? decide(g, { kind: "standard", resource: spec.resource, level: l }, self) : { allow: false as const, reason: "" });
  const readD = level("read");
  const writeD = level("write");
  const adminD = level("admin");
  const verbD = spec?.verb ? decide(g, { kind: "custom", resource: spec.resource, verb: spec.verb }, self) : null;
  const disabled = u.status !== "active";
  // A disabled account never gets past auth - report all-false so the preview matches reality, but keep
  // the flag so the UI can say WHY.
  const allow = (d: { allow: boolean }) => !disabled && d.allow;
  const readPat = spec && readD.allow ? matchingPattern(g, { kind: "standard", resource: spec.resource, level: "read" }, self) : null;
  const deniedBy = (d: { allow: boolean; reason?: string }) => !d.allow && (d as { reason?: string }).reason?.startsWith("denied by") === true;
  return {
    subject: u.ref,
    email: u.email,
    name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || null,
    role: u.role,
    disabled,
    read: allow(readD),
    write: allow(writeD),
    admin: allow(adminD),
    ...(verbD ? { verb_allowed: allow(verbD) } : {}),
    ...(readPat ? { why: deriveNarrowing(readPat).scopeKind } : {}),
    denied: deniedBy(readD) || (verbD ? deniedBy(verbD) : false),
    // The BROAD grant (pre object-exception merge) is what /users/me derives capabilities from - keep it
    // for include_capabilities so the simulated shell gates exactly like the real one would.
    ...(includeCapabilities ? { capabilities: disabled ? [] : capabilitiesOf(a.broad) } : {}),
  };
}
