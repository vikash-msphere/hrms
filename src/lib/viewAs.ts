// Server-side "view as" (access-mode simulation). While an access admin holds a simulation open, the SPA
// sends `X-View-As: users/<id>` (or `employees/<id>`) on EVERY request and the app answers as that person:
// auth.ts installs the subject's fully-assembled principal, so the authz middleware, the list scopes, the
// per-field redaction and the `access.can` hints are all computed for THEM. Nothing downstream knows the
// difference - which is the point. A capability-only swap in the browser (what this replaces) still fetched
// the admin's own rows, so "view as an employee" happily showed records that employee can never see.
//
// Three rails keep the simulation from becoming an escalation path:
//   1. the REAL caller must hold `access-rules.preview` (fail-closed, super by default),
//   2. the simulation never hands the caller MORE authority than they already hold - a non-super caller may
//      not borrow a super subject's identity, and no individual request is answered that the REAL caller
//      would have been denied (decided per request in middleware/authz.ts, off `simulatedBy.grant`),
//   3. it is READ-ONLY: GET/HEAD plus the GET-only `/v1/batch:run` transport, nothing else. Acting AS someone
//      is never allowed - the admin stops the simulation and acts as themselves.
// The audit trail keeps naming the real human (lib/audit.ts stamps `viewing_as` on the row), so a simulated
// read is attributable to the admin who ran it, never to the person they were watching the app as.
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import * as schema from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import { forbidden, invalidArgument, notFound } from "./errors";
import { decide, type Grant } from "../domain/permissions";
import { mergeGrants, mergeGuards } from "../domain/compileGrants";
import { EMPTY_GRANT, isSuperGrant } from "../domain/grants";
import type { GuardIndex } from "../domain/ruleCondition";
import { loadRoleGrant, loadRoleGuards, loadUserGrant, loadUserGuards, loadUserRoles } from "./policyLoad";

export const VIEW_AS_HEADER = "X-View-As";
const TOKEN_RE = /^[0-9a-hj-km-np-tv-z]{26}$/; // a wire-id token (the SPA speaks tokens, tests speak internal ids)

// Prefix every refusal so the SPA can tell "the simulation itself is invalid" (drop it and reload) apart from
// "the person you are simulating cannot see this" (the honest, expected answer).
const reject = (why: string) => forbidden(`view as: ${why}`);

// Is this request one the simulation may carry? `batch:run` is the read transport (routes/batch.ts rejects
// any non-GET sub-request), so it rides along; every other write verb is refused before it reaches a handler.
function isReadOnly(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || (m === "POST" && pathname === "/v1/batch:run");
}

export async function resolveViewAs(c: Context<AppEnv>, deps: Deps, real: AppUser): Promise<AppUser | null> {
  const ref = c.req.header(VIEW_AS_HEADER);
  if (!ref) return null;

  // Rail 0: humans only. Simulation is an interactive affordance whose whole safety story is that a named
  // admin is driving it and the audit trail names them. A machine credential holding `access-rules.preview`
  // would otherwise be able to read the app as ANY employee, turning a scoped key into an unscoped one.
  if (real.apiKey) throw reject("not available to API keys");

  // Rail 1: only an access admin simulates. Same key the preview endpoint is gated on, decided by the engine
  // against the REAL caller's grant (never the subject's).
  const permitted = decide(real.grant, { kind: "custom", resource: "access-rules", verb: "preview" }, { employeeCode: real.employeeCode }).allow;
  if (!permitted) throw reject("you may not simulate another user");

  // Rail 3: read-only. Checked before the subject lookup so a write attempt costs no reads.
  if (!isReadOnly(c.req.method, new URL(c.req.url).pathname)) throw reject("read-only - stop the simulation to make changes");

  const slash = ref.indexOf("/");
  const kind = slash > 0 ? ref.slice(0, slash) : "";
  const rawId = ref.slice(slash + 1);
  if (kind !== "users" && kind !== "employees") throw invalidArgument("view as: subject must be users/<id> or employees/<id>");
  // WIRE TOKEN ONLY. This used to fall back to treating an unrecognised value as an INTERNAL id, annotated
  // "tests speak internal ids" - a test affordance that was live in production. It was never an escalation
  // (the caller must already hold `access-rules.preview`, and the read-only and no-super-subject rails below
  // still apply), but it was the one place in the app where an internal primary key was an accepted inbound
  // identifier, which is precisely what the codec exists to prevent: ids stay non-enumerable and the edge
  // stays the only place they cross. The tests encode now, like the SPA always did.
  if (!TOKEN_RE.test(rawId)) throw invalidArgument("view as: subject must be users/<id> or employees/<id>");
  const id = await deps.idCodec.decode(kind, rawId);
  if (!id) throw notFound("view as: subject not found");

  // A subject is a sign-in account OR a person. A person with an account is graded as that account; one who has
  // never signed in is graded as the account they WOULD get on first login (default `employee` role, their own
  // employee code, no user rules) - the same rule services/accessPreview.ts uses, so the two agree.
  //
  // THE EMPLOYEE'S SOFT-DELETE STAMP RIDES ALONG, and is refused below. A user whose employee row is deleted is
  // refused at the door for a real sign-in (middleware/auth.ts assertLive), so simulating one shows an app that
  // person cannot reach at all - the opposite of what this surface is for. The `employees` lane filters it in
  // SQL (there is no account to grade without the person); the `users` lane reads the column, because a user
  // row outlives the employee it points at and the join must still resolve to say so.
  const row =
    kind === "users"
      ? (
          await deps.db
            .select({
              userUuid: schema.users.uuid,
              email: schema.users.email,
              role: schema.users.role,
              status: schema.users.status,
              employeeId: schema.users.employeeId,
              employeeCode: schema.employees.code,
              firstName: schema.employees.firstName,
              lastName: schema.employees.lastName,
              employeeDeleteTime: schema.employees.deleteTime,
            })
            .from(schema.users)
            .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
            .where(eq(schema.users.uuid, id))
            .limit(1)
        )[0]
      : (
          await deps.db
            .select({
              userUuid: schema.users.uuid,
              email: schema.users.email,
              role: schema.users.role,
              status: schema.users.status,
              employeeId: schema.employees.uuid,
              employeeCode: schema.employees.code,
              firstName: schema.employees.firstName,
              lastName: schema.employees.lastName,
              workEmail: schema.employees.workEmail,
              employeeDeleteTime: schema.employees.deleteTime,
            })
            .from(schema.employees)
            .leftJoin(schema.users, eq(schema.users.employeeId, schema.employees.uuid))
            .where(and(eq(schema.employees.uuid, id), isNull(schema.employees.deleteTime)))
            .limit(1)
        )[0];
  if (!row) throw notFound("view as: subject not found");
  if (row.employeeDeleteTime) throw reject("that person has been removed from the directory");

  const userUuid = row.userUuid ?? null;
  const email = row.email ?? (row as { workEmail?: string }).workEmail ?? "";
  const roleName = row.role ?? "employee";
  const status = row.status ?? "active";
  // A disabled account never gets past auth for real, so simulating it would be a lie. Refuse loudly instead
  // of quietly rendering an empty app.
  if (status !== "active") throw reject("that account is disabled");

  // Every role the subject holds, assembled exactly as middleware/auth.ts assembles it for a real sign-in - a
  // simulation that saw only the primary role would show less than the person actually has, and the whole point
  // of the surface is that what the admin sees IS what the subject sees. A person with no account holds none.
  const extraRoles = userUuid ? await loadUserRoles(deps, userUuid) : [];
  const roles = [...new Set([roleName, ...extraRoles])];
  const [roleGrants, userGrant] = await Promise.all([
    Promise.all(roles.map((r) => loadRoleGrant(deps, r))),
    userUuid ? loadUserGrant(deps, userUuid) : Promise.resolve(EMPTY_GRANT),
  ]);
  const grant: Grant = mergeGrants(roleGrants.reduce(mergeGrants), userGrant);
  // THE SUBJECT'S GUARDS, assembled off the same cached rows as their grant and exactly as middleware/auth.ts
  // does for a real sign-in. They were missing entirely, and a missing guard index is not a neutral default:
  // `guardAllows` returns true for one (domain/ruleCondition.ts), so every threshold, time window and network
  // fence on the subject's rules stopped being evaluated the moment a simulation was open. The surface exists
  // to show what this person sees; a rule that refuses them an expense over fifty thousand, or refuses them
  // anything from outside the office range, is part of that answer, and leaving it out showed the admin MORE
  // than the subject has - which is the one direction this file is written to make impossible.
  const [roleGuards, userGuards] = await Promise.all([
    Promise.all(roles.map((r) => loadRoleGuards(deps, r))),
    userUuid ? loadUserGuards(deps, userUuid) : Promise.resolve(new Map() as GuardIndex),
  ]);
  const guards: GuardIndex = roleGuards.reduce(mergeGuards, userGuards);
  // Rail 2, first half: a non-super caller may not step into a super subject - borrowing the break-glass
  // identity outright.
  //
  // SUBSUMPTION IS NOT COMPUTABLE OVER PATTERN GRANTS, and this used to be the whole of rail 2 because of it -
  // which left every SIDEWAYS widening allowed, and sideways is the interesting direction. The seeded policy
  // keeps both admin roles out of other people's PII on purpose (`...OWN_PII` in domain/grants.ts, written as
  // the record of a fix: "HR sees only their OWN PII ... others' PII stays super-only"), while the `employee`
  // role holds its own outright - so stepping into an ordinary employee and reading
  // `employees/<X>/bank-account` was a self-match on X's own grant, answered with X's decrypted account
  // number, and nothing asked whether the real caller could have made that read.
  //
  // The answer is that containment does not have to be computed over GRANTS: the middleware resolves THIS
  // request and can ask the real caller's grant the same concrete question (see the containment check in
  // middleware/authz.ts, which is why `simulatedBy` carries their grant below). Same shape
  // services/accessPreview.ts already uses as a caller bound for the preview surface next door.
  if (isSuperGrant(grant) && !isSuperGrant(real.grant)) throw reject("you may not simulate a super admin");

  return {
    uuid: userUuid ?? "", // a person who never signed in has no account row; no user rules can match ""
    email,
    role: roleName,
    roles,
    status: "active",
    employeeId: row.employeeId ?? null,
    employeeCode: row.employeeCode ?? null,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || null,
    grant,
    guards,
    policy: real.policy, // the body-AC manifest is global - reuse the one auth already loaded
    // The real admin's SITTING travels with them: a simulation is still something that human did while signed
    // in, and it is the sitting an incident review most wants grouped.
    // The real admin's SITTING travels with them, and so does their own AUTHORITY: rail 2's second half is
    // decided per request in middleware/authz.ts, which needs the real caller's grant and employee code to
    // re-ask the question the subject's grant just answered.
    // ...and their GUARDS with it, for the same reason the grant travels: the containment check re-asks this
    // request of the real caller, and a caller's authority is their grant AS LIMITED BY the guards on the rules
    // that carry it. Without them a fenced or capped rule answered through a simulation as though it were
    // neither, which is a way for an admin to read past their own limits rather than the subject's.
    simulatedBy: {
      uuid: real.uuid,
      email: real.email,
      employeeId: real.employeeId,
      employeeCode: real.employeeCode,
      name: real.name,
      sessionId: real.sessionId,
      grant: real.grant,
      guards: real.guards,
    },
  };
}
