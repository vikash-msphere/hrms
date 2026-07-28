import { allocFlatCode } from "../services/codeAlloc";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq, sql, and, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import type { Grant } from "../domain/permissions";
import type { Policy } from "../domain/manifests";
import { mergeGrants } from "../domain/compileGrants";
import { loadRoleGrant, loadUserGrant, loadManifest } from "../lib/policyLoad";
import { unauthenticated, forbidden } from "../lib/errors";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

// Verifies the Cloudflare Access JWT, resolves the caller, auto-provisions on first login.
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Batch sub-request: the caller was already verified once for the batch envelope. Reuse the resolved user
  // (skip the JWT verify + user join + grant/manifest load) - authz still runs per sub-request below, so this
  // changes CPU cost, not access control. The flag lives on the Worker env, unreachable by the client.
  const shared = c.env.__sharedCtx;
  if (shared?.user) {
    c.set("user", shared.user);
    await next();
    return;
  }
  const deps = c.get("deps");
  const team = c.env.CF_ACCESS_TEAM_DOMAIN;

  let email: string;
  // LOCAL-ONLY dev bypass. Requires BOTH DEV_FAKE_EMAIL and an explicit, dedicated `ALLOW_DEV_AUTH=true` flag.
  // The flag exists only in `.dev.vars`; production secrets never set it, so a stray `DEV_FAKE_EMAIL` copied
  // into a prod env is HARMLESS on its own - the request falls through to real JWT verification instead of
  // silently bypassing auth. Two independent signals must align for the bypass to engage.
  const devBypass = !!c.env.DEV_FAKE_EMAIL && c.env.ALLOW_DEV_AUTH === "true";
  if (devBypass) {
    email = c.env.DEV_FAKE_EMAIL!.toLowerCase();
  } else {
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) throw unauthenticated("missing Access token");
    jwks ??= createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: c.env.CF_ACCESS_AUD });
      email = String(payload.email).toLowerCase();
    } catch {
      throw unauthenticated("invalid Access token");
    }
  }

  // Resolve the caller AND their employee `code` (the dept-scope key) in one read via a left join, so
  // authz needs no extra caller lookup. The role grant + global manifest are loaded from the compiled
  // `access_rules` / `policy` store (cached per role / globally, short TTL), so the hot path reads them
  // from the isolate cache (~0 reads warm) and the decision needs no per-request policy join.
  let user = (
    await deps.db
      .select({
        uuid: schema.users.uuid,
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
      .where(eq(schema.users.email, email))
      .limit(1)
  )[0];
  if (!user) {
    // First-login auto-provisioning. Optional second perimeter (Access is primary): if ALLOWED_EMAIL_DOMAINS
    // is configured, only those domains may mint a new user, so a too-broad Access policy can't silently create
    // employee-role accounts for outside emails. Unset/empty = no restriction. Existing users skip this entirely.
    const allowed = (c.env.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length) {
      const domain = email.split("@")[1] ?? "";
      if (!allowed.includes(domain)) throw forbidden("email domain not permitted");
    }
    // Auto-link to an employee record with the same work email, if one exists.
    const emp = (
      await deps.db
        .select({ uuid: schema.employees.uuid, code: schema.employees.code })
        .from(schema.employees)
        .where(and(sql`lower(${schema.employees.workEmail}) = ${email}`, isNull(schema.employees.deleteTime)))
        .limit(1)
    )[0];
    const inserted = (
      await deps.db
        .insert(schema.users)
        .values({ code: await allocFlatCode(deps, schema.users), email, role: "employee", employeeId: emp?.uuid ?? null })
        .returning()
    )[0]!;
    user = {
      uuid: inserted.uuid,
      email: inserted.email,
      role: inserted.role,
      status: inserted.status,
      employeeId: inserted.employeeId,
      employeeCode: emp?.code ?? null,
      firstName: null,
      lastName: null,
    };
  }
  if (user.status !== "active") throw forbidden("user disabled");
  // The caller's broad authority = their role's grant + their own broad user rules (both cached, warm ~0
  // reads). Users are first-class like roles: a user can hold collection/dept/field-scope access, not only
  // per-object exceptions (those still ride the narrowed lane in authz.ts). The common case (no user rules)
  // is EMPTY_GRANT, so mergeGrants is a no-op.
  // The role grant already includes the `everyone` pseudo-role (unioned inside loadRoleGrant in the SAME query,
  // super-exempt), so the broad authority is just role + the caller's own user rules - no extra `everyone` read.
  const [roleGrant, userGrant] = await Promise.all([loadRoleGrant(deps, user.role), loadUserGrant(deps, user.uuid)]);
  const grant: Grant = mergeGrants(roleGrant, userGrant);
  const policy: Policy = await loadManifest(deps);

  c.set("user", {
    uuid: user.uuid,
    email: user.email,
    role: user.role,
    status: user.status,
    employeeId: user.employeeId,
    employeeCode: user.employeeCode,
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    grant,
    policy,
  });
  await next();
};
