// Server-side "view as" (access-mode simulation). While an access admin holds a simulation open, the SPA
// sends `X-View-As: users/<id>` (or `employees/<id>`) on EVERY request and the app answers as that person:
// auth.ts installs the subject's fully-assembled principal, so the authz middleware, the list scopes, the
// per-field redaction and the `access.can` hints are all computed for THEM. Nothing downstream knows the
// difference - which is the point. A capability-only swap in the browser (what this replaces) still fetched
// the admin's own rows, so "view as an employee" happily showed records that employee can never see.
//
// Three rails keep the simulation from becoming an escalation path:
//   1. the REAL caller must hold `access-rules.preview` (fail-closed, super by default),
//   2. a non-super caller may not borrow a super subject's authority,
//   3. it is READ-ONLY: GET/HEAD plus the GET-only `/v1/batch:run` transport, nothing else. Acting AS someone
//      is never allowed - the admin stops the simulation and acts as themselves.
// The audit trail keeps naming the real human (lib/audit.ts stamps `viewing_as` on the row), so a simulated
// read is attributable to the admin who ran it, never to the person they were watching the app as.
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import * as schema from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import { forbidden, invalidArgument, notFound } from "./errors";
import { decide, type Grant } from "../domain/permissions";
import { mergeGrants } from "../domain/compileGrants";
import { EMPTY_GRANT, isSuperGrant } from "../domain/grants";
import { loadRoleGrant, loadUserGrant } from "./policyLoad";

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
  const id = TOKEN_RE.test(rawId) ? await deps.idCodec.decode(kind, rawId) : rawId;
  if (!id) throw notFound("view as: subject not found");

  // A subject is a sign-in account OR a person. A person with an account is graded as that account; one who has
  // never signed in is graded as the account they WOULD get on first login (default `employee` role, their own
  // employee code, no user rules) - the same rule services/accessPreview.ts uses, so the two agree.
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
            })
            .from(schema.employees)
            .leftJoin(schema.users, eq(schema.users.employeeId, schema.employees.uuid))
            .where(eq(schema.employees.uuid, id))
            .limit(1)
        )[0];
  if (!row) throw notFound("view as: subject not found");

  const userUuid = row.userUuid ?? null;
  const email = row.email ?? (row as { workEmail?: string }).workEmail ?? "";
  const roleName = row.role ?? "employee";
  const status = row.status ?? "active";
  // A disabled account never gets past auth for real, so simulating it would be a lie. Refuse loudly instead
  // of quietly rendering an empty app.
  if (status !== "active") throw reject("that account is disabled");

  const [roleGrant, userGrant] = await Promise.all([loadRoleGrant(deps, roleName), userUuid ? loadUserGrant(deps, userUuid) : Promise.resolve(EMPTY_GRANT)]);
  const grant: Grant = mergeGrants(roleGrant, userGrant);
  // Rail 2: the simulation must never hand the caller MORE authority than they already hold. Full containment
  // isn't computable over pattern grants, but the one case that matters - borrowing the break-glass identity -
  // is, so a non-super caller may not step into a super subject.
  if (isSuperGrant(grant) && !isSuperGrant(real.grant)) throw reject("you may not simulate a super admin");

  return {
    uuid: userUuid ?? "", // a person who never signed in has no account row; no user rules can match ""
    email,
    role: roleName,
    status: "active",
    employeeId: row.employeeId ?? null,
    employeeCode: row.employeeCode ?? null,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || null,
    grant,
    policy: real.policy, // the body-AC manifest is global - reuse the one auth already loaded
    simulatedBy: { uuid: real.uuid, email: real.email, employeeId: real.employeeId, name: real.name },
  };
}
