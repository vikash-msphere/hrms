// Effective-access preview: run the SAME engine (decide over role+everyone+user grants, merged with the
// target object's exception rules) for arbitrary subject users against one target, and report the verdicts.
// Read-only and side-effect free - this powers the ACL modal's "view as" panel and the impact warning
// before a destructive rule change. It is a REPORT of what the engine would decide, never an enforcement
// path: the middleware keeps making every real decision per request.
import { inArray, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { decide, matchingPattern, capabilitiesOf, type Grant, type Level } from "../domain/permissions";
import { mergeGrants, rulesToGrant, deriveNarrowing, type ScopeKind } from "../domain/compileGrants";
import { EVERYONE_ROLE, EMPTY_GRANT, isSuperGrant } from "../domain/grants";
import { ancestorsOf } from "../domain/codes";
import { loadRoleGrant, loadUserGrant, loadObjectRulesForRequest } from "../lib/policyLoad";
import { uuidToCode, tableFor } from "../lib/authzResolve";
import { invalidArgument, notFound } from "../lib/errors";

const NAME_RE = /^[a-z][a-z0-9-]*$/; // collection / field tokens
const VERB_RE = /^[a-zA-Z]+$/;
const MAX_SUBJECTS = 100;

export type PreviewBody = {
  subjects: string[]; // "users/<uuid>" or "employees/<uuid>" (wire ids already decoded at the edge)
  collection?: string; // optional ONLY with include_capabilities (capability-set-only call)
  object?: string; // "<collection>/<uuid>", must match `collection`
  field?: string; // requires `object` (field keys are object-anchored in the engine)
  verb?: string; // custom method to check alongside the standard ladder
  // Also return capabilitiesOf(broad grant) per subject - the same scope-stripped set /users/me carries,
  // which is exactly what the web shell gates nav/pages/buttons on. Powers app-wide "view as".
  include_capabilities?: boolean;
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

export async function previewAccess(deps: Deps, body: PreviewBody): Promise<PreviewVerdict[]> {
  const { field, verb } = body;
  // Capability-only calls may omit the collection (there is no target to grade); a graded call needs one.
  const collection = body.collection ?? "";
  if (!collection && !body.include_capabilities) throw invalidArgument("collection required");
  if (collection && !NAME_RE.test(collection)) throw invalidArgument("invalid collection");
  if (!collection && (body.object !== undefined || field !== undefined || verb !== undefined)) throw invalidArgument("object/field/verb need a collection");
  if (field !== undefined && !NAME_RE.test(field)) throw invalidArgument("invalid field");
  if (verb !== undefined && !VERB_RE.test(verb)) throw invalidArgument("invalid verb");
  if (!Array.isArray(body.subjects) || body.subjects.length === 0) throw invalidArgument("subjects required");
  if (body.subjects.length > MAX_SUBJECTS) throw invalidArgument(`at most ${MAX_SUBJECTS} subjects per call`);
  // A subject is a sign-in account ("users/<id>") OR a person ("employees/<id>"). People resolve to their
  // linked account when one exists; a person who has never signed in is graded as the account they WOULD
  // get on first sign-in (the default `employee` role + everyone, their employee code, no user rules) - so
  // "what would Priya see" has an answer before Priya's first login.
  const parsed = body.subjects.map((s) => {
    if (typeof s === "string" && s.startsWith("users/")) return { kind: "account" as const, id: s.slice("users/".length), ref: s };
    if (typeof s === "string" && s.startsWith("employees/")) return { kind: "person" as const, id: s.slice("employees/".length), ref: s };
    throw invalidArgument("subjects must be users/<id> or employees/<id> refs");
  });

  // Resolve the object ref to its internal CODE - scope tokens (me / my-dept / prefix) match codes, not
  // uuids. An object of a foreign collection is a caller error; an unknown id is not-found (fail closed).
  let code: string | null = null;
  if (body.object !== undefined) {
    const slash = body.object.indexOf("/");
    const objCollection = slash > 0 ? body.object.slice(0, slash) : "";
    if (objCollection !== collection) throw invalidArgument("object does not belong to the target collection");
    if (!tableFor(collection)) throw invalidArgument("collection has no addressable objects");
    code = await uuidToCode(deps, collection, body.object.slice(slash + 1));
    if (!code) throw notFound("target object not found");
  }
  if (field !== undefined && code === null) throw invalidArgument("a field target needs an object");

  // One uniform record per subject, whichever way it was addressed.
  type Subject = { ref: string; userUuid: string | null; email: string; role: string; status: string; employeeCode: string | null; firstName: string | null; lastName: string | null };
  const userIds = parsed.filter((p) => p.kind === "account").map((p) => p.id);
  const empIds = parsed.filter((p) => p.kind === "person").map((p) => p.id);
  const userRows = userIds.length
    ? await deps.db
        .select({
          uuid: schema.users.uuid,
          email: schema.users.email,
          role: schema.users.role,
          status: schema.users.status,
          employeeCode: schema.employees.code,
          firstName: schema.employees.firstName,
          lastName: schema.employees.lastName,
        })
        .from(schema.users)
        .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
        .where(inArray(schema.users.uuid, userIds))
    : [];
  const empRows = empIds.length
    ? await deps.db
        .select({
          empUuid: schema.employees.uuid,
          empCode: schema.employees.code,
          firstName: schema.employees.firstName,
          lastName: schema.employees.lastName,
          workEmail: schema.employees.workEmail,
          userUuid: schema.users.uuid,
          email: schema.users.email,
          role: schema.users.role,
          status: schema.users.status,
        })
        .from(schema.employees)
        .leftJoin(schema.users, eq(schema.users.employeeId, schema.employees.uuid))
        .where(inArray(schema.employees.uuid, empIds))
    : [];
  const byUserId = new Map(userRows.map((u) => [u.uuid, u]));
  const byEmpId = new Map(empRows.map((e) => [e.empUuid, e]));
  const subjectsResolved: Subject[] = parsed.map((p) => {
    if (p.kind === "account") {
      const u = byUserId.get(p.id);
      if (!u) throw notFound(`subject ${p.ref} not found`);
      return { ref: p.ref, userUuid: u.uuid, email: u.email, role: u.role, status: u.status, employeeCode: u.employeeCode ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null };
    }
    const e = byEmpId.get(p.id);
    if (!e) throw notFound(`subject ${p.ref} not found`);
    return e.userUuid
      ? { ref: p.ref, userUuid: e.userUuid, email: e.email!, role: e.role!, status: e.status!, employeeCode: e.empCode, firstName: e.firstName, lastName: e.lastName }
      : { ref: p.ref, userUuid: null, email: e.workEmail, role: "employee", status: "active", employeeCode: e.empCode, firstName: e.firstName, lastName: e.lastName };
  });

  const resource = [collection, ...(code ? [code] : []), ...(field ? [field] : [])].join(".");
  const ancestors = code ? ancestorsOf(code) : [];

  const out: PreviewVerdict[] = [];
  for (const u of subjectsResolved) {
    // Same assembly as the middleware: role grant (everyone folded in, super-exempt) + the user's own
    // broad rules, then - for an object target - that object's exception rules for this subject.
    const [roleGrant, userGrant] = await Promise.all([loadRoleGrant(deps, u.role), u.userUuid ? loadUserGrant(deps, u.userUuid) : Promise.resolve(EMPTY_GRANT)]);
    // The BROAD grant (pre object-exception merge) is what /users/me derives capabilities from - keep it
    // for include_capabilities so the simulated shell gates exactly like the real one would.
    const broadGrant: Grant = mergeGrants(roleGrant, userGrant);
    let grant: Grant = broadGrant;
    if (code) {
      const roleSubjects = isSuperGrant(grant) ? [u.role] : [u.role, EVERYONE_ROLE];
      const objRules = await loadObjectRulesForRequest(deps, u.userUuid ?? "", roleSubjects, collection, ancestors);
      if (objRules.length) grant = mergeGrants(grant, rulesToGrant(objRules));
    }
    const self = { employeeCode: u.employeeCode ?? null };
    const graded = collection !== "";
    const level = (l: Level) => (graded ? decide(grant, { kind: "standard", resource, level: l }, self) : { allow: false as const, reason: "" });
    const readD = level("read");
    const writeD = level("write");
    const adminD = level("admin");
    const verbD = verb ? decide(grant, { kind: "custom", resource, verb }, self) : null;
    const disabled = u.status !== "active";
    // A disabled account never gets past auth - report all-false so the preview matches reality, but keep
    // the flag so the UI can say WHY.
    const allow = (d: { allow: boolean }) => !disabled && d.allow;
    const readPat = readD.allow ? matchingPattern(grant, { kind: "standard", resource, level: "read" }, self) : null;
    const deniedBy = (d: { allow: boolean; reason?: string }) => !d.allow && (d as { reason?: string }).reason?.startsWith("denied by") === true;
    out.push({
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
      ...(body.include_capabilities ? { capabilities: disabled ? [] : capabilitiesOf(broadGrant) } : {}),
    });
  }
  return out;
}
