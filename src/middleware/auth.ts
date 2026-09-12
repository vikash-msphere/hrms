import { allocFlatCode } from "../services/codeAlloc";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq, sql, and, asc, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import type { Grant } from "../domain/permissions";
import type { Policy } from "../domain/manifests";
import { mergeGrants } from "../domain/compileGrants";
import { loadRoleGrant, loadUserGrant, loadManifest } from "../lib/policyLoad";
import { resolveViewAs, VIEW_AS_HEADER } from "../lib/viewAs";
import { unauthenticated, forbidden, isUserEmailCollision, isUserEmployeeCollision } from "../lib/errors";
import { getCookie } from "hono/cookie";
import { fnv1a64 } from "../lib/fnv";
import { openSession } from "../lib/session";
import { SESSION_COOKIE } from "../routes/authRoutes";
import type { SQL } from "drizzle-orm";
import { hasApiKeyBearer, parseToken } from "../lib/apiKeyToken";
import { findLiveKeyByPrefix, shouldTouchLastUsed, touchLastUsed } from "../services/apiKeys";
import { narrowGrant, parseScope } from "../domain/keyScope";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

type UserRow = {
  uuid: string;
  email: string;
  role: string;
  status: "active" | "disabled";
  employeeId: string | null;
  employeeCode: string | null;
  firstName: string | null;
  lastName: string | null;
  sessionsValidFrom: Date | number | null;
};

// The one caller read, shared by every lane: user + their employee `code` (the dept-scope key) in a single
// left join. The browser lanes look the caller up by email; the API-key lane already holds the owner's uuid.
//
// `stable` orders the result before taking one row, and is for the predicates that are NOT unique. `email` is
// UNIQUE on the raw column, so `lower(email) = ?` can match two rows (`Alice@x` and `alice@x` may both exist -
// see the second lookup below); with no ORDER BY, which of them answers is whatever the engine returned first,
// and the two rows carry different roles and different access rules. Which account a person signs in to must
// not be a plan detail, so the tie is broken by age: the older row is the one that has been accruing the
// grants. Off by default because the exact-match lookup IS unique and runs on every request - a sort step
// there would buy nothing.
async function loadUserRow(deps: Deps, where: SQL | undefined, stable = false): Promise<UserRow | undefined> {
  const q = deps.db
    .select({
      uuid: schema.users.uuid,
      email: schema.users.email,
      role: schema.users.role,
      status: schema.users.status,
      employeeId: schema.users.employeeId,
      employeeCode: schema.employees.code,
      firstName: schema.employees.firstName,
      lastName: schema.employees.lastName,
      sessionsValidFrom: schema.users.sessionsValidFrom,
    })
    .from(schema.users)
    .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
    .where(where);
  return (await (stable ? q.orderBy(asc(schema.users.createdAt), asc(schema.users.uuid)) : q).limit(1))[0];
}

// The caller's broad authority: their role grant (which already folds in `everyone`) merged with their own
// broad user rules. Both cached, so warm this costs ~0 reads.
async function loadAuthority(deps: Deps, user: UserRow): Promise<{ grant: Grant; policy: Policy }> {
  const [roleGrant, userGrant, policy] = await Promise.all([loadRoleGrant(deps, user.role), loadUserGrant(deps, user.uuid), loadManifest(deps)]);
  return { grant: mergeGrants(roleGrant, userGrant), policy };
}

// ---- API-key lane ----------------------------------------------------------------------------------------
//
// A key acts as its OWNER, narrowed by its scope (domain/keyScope.ts). Everything downstream - authz, list
// scopes, search scopes, capability hints - therefore works unchanged, because what it sees is an ordinary
// AppUser whose grant happens to be smaller.
//
// INVARIANT (the CSRF middleware depends on this): a request carrying an `hrms_`-shaped bearer is resolved
// HERE or it fails 401. It must never fall through to the cookie/JWT lanes, because csrf.ts skips its check
// on the mere PRESENCE of that header - a fall-through would let an attacker suppress CSRF with a junk
// bearer and then ride the victim's session.
async function authenticateApiKey(c: Parameters<MiddlewareHandler<AppEnv>>[0], deps: Deps): Promise<AppUser> {
  const parsed = parseToken(c.req.header("Authorization"));
  if (!parsed) throw unauthenticated("malformed API key");

  // Refuse simulation loudly rather than ignoring the header. This lane never calls resolveViewAs, so an
  // X-View-As here would otherwise be silently dropped and the request would succeed as the key's owner -
  // a caller could believe they were reading as someone else while actually reading as themselves. A
  // security-relevant header must never be quietly discarded.
  if (c.req.header(VIEW_AS_HEADER)) throw forbidden("view as: not available to API keys");

  // Live read, deliberately NOT cached: revocation and expiry must bite on the very next request. One
  // indexed lookup by prefix, so this costs the same as the JWT verify it replaces.
  const now = deps.clock.now();
  const key = (await findLiveKeyByPrefix(deps, parsed.prefix, now))[0];
  if (!key) throw unauthenticated("invalid API key");
  if (!(await deps.apiKeySigner.verify(parsed.secret, key.hash))) throw unauthenticated("invalid API key");

  const scope = parseScope(safeParse(key.scopeJson));
  if (!scope) throw unauthenticated("API key scope is unreadable"); // corrupt scope = no authority, never full authority

  // No auto-provisioning on this lane: a key can never mint a user. The owner must already exist and be
  // active - disabling a user therefore kills every key they own, with no extra bookkeeping.
  const user = await loadUserRow(deps, eq(schema.users.uuid, key.ownerUserId));
  if (!user) throw unauthenticated("API key owner no longer exists");
  if (user.status !== "active") throw forbidden("user disabled");

  const { grant, policy } = await loadAuthority(deps, user);

  // Convenience column, not an audit record: written at most once per throttle window so a busy integration
  // does not add a D1 write to every call. Off the response path, and never fatal.
  if (shouldTouchLastUsed(key.lastUsedAt, +now) && !c.env.__sharedCtx) {
    const write = touchLastUsed(deps, key.uuid, now).catch(() => {});
    // `c.executionCtx` THROWS when the context has none (the test runner, and any in-process dispatch)
    // rather than returning undefined, so this cannot be an optional-chain. Without an execution context
    // there is nothing to hand the promise to, so settle it inline - it is one small write, and dropping it
    // unawaited would surface as an unhandled rejection.
    let scheduled = false;
    try {
      c.executionCtx.waitUntil(write);
      scheduled = true;
    } catch {
      /* no execution context */
    }
    if (!scheduled) await write;
  }

  return {
    uuid: user.uuid,
    email: user.email,
    role: user.role,
    status: user.status,
    employeeId: user.employeeId,
    employeeCode: user.employeeCode,
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    grant: narrowGrant(grant, scope),
    policy,
    apiKey: { uuid: key.uuid, code: key.code, name: key.name, prefix: key.prefix, scope },
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Authenticates the caller (Cloudflare Access JWT, or the app's own Google-OIDC session cookie - see
// routes/authRoutes.ts for the mode split), resolves them, auto-provisions on first login.
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

  // Machine lane FIRST, and terminal: see authenticateApiKey. `hasApiKeyBearer` is deliberately the loose
  // test (any `hrms_`-shaped bearer counts, valid or not) so a malformed key 401s here rather than silently
  // continuing to the browser lanes below.
  if (hasApiKeyBearer(c.req.header("Authorization"))) {
    c.set("user", await authenticateApiKey(c, deps));
    await next();
    return;
  }

  const team = c.env.CF_ACCESS_TEAM_DOMAIN;

  let email: string;
  // When the caller arrived on a session COOKIE, the instant it was issued. Checked against the user's
  // revocation stamp once the row is loaded below - it cannot be checked here, because the row is what says
  // whether anything has been revoked, and the email we are about to look them up by is all we have so far.
  // Null on every other lane (dev bypass, Access JWT, API key): those carry no session to revoke.
  let sessionIat: number | null = null;
  // LOCAL-ONLY dev bypass. Requires BOTH DEV_FAKE_EMAIL and an explicit, dedicated `ALLOW_DEV_AUTH=true` flag.
  // The flag exists only in `.dev.vars`; production secrets never set it, so a stray `DEV_FAKE_EMAIL` copied
  // into a prod env is HARMLESS on its own - the request falls through to real JWT verification instead of
  // silently bypassing auth. Two independent signals must align for the bypass to engage.
  const devBypass = !!c.env.DEV_FAKE_EMAIL && c.env.ALLOW_DEV_AUTH === "true";
  if (devBypass) {
    email = c.env.DEV_FAKE_EMAIL!.toLowerCase();
  } else if (c.env.GOOGLE_CLIENT_ID) {
    // Direct Google sign-in mode: the caller is whoever the signed session cookie says, verified by HMAC +
    // expiry (stateless - zero reads). Everything below (status check, role grant, provisioning) still runs
    // fresh per request, so disabling a user bites immediately despite the live cookie.
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await openSession(token, c.env.AUTH_SESSION_KEY!, Date.now()) : null;
    if (!session) throw unauthenticated("not signed in");
    email = session.email.toLowerCase();
    sessionIat = session.iat;
  } else {
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) throw unauthenticated("missing Access token");
    // ASSERTED HERE, not only at boot. `makeDeps` already refuses to start an Access-mode deploy that is
    // missing either of these (deps.ts assertConfigured), which is the check that actually protects the
    // deployment - this one exists because of HOW jose reads the options below: `jwtVerify` skips the
    // `iss`/`aud` check ENTIRELY when the option is undefined rather than failing. So a `CF_ACCESS_AUD` that
    // went missing would not narrow verification, it would remove it, and any token signed by the team's
    // Access JWKS - including one minted for a DIFFERENT application in the same team - would authenticate.
    // A silent widening is the wrong thing to leave depending on a check in another module.
    if (!team || !c.env.CF_ACCESS_AUD) throw new Error("Access mode requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD");
    jwks ??= createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    let claimed: unknown;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: c.env.CF_ACCESS_AUD });
      claimed = payload.email;
    } catch {
      throw unauthenticated("invalid Access token");
    }
    // A verified Access token is not automatically a PERSON. A SERVICE TOKEN issued for the same application
    // passes this verification with the same issuer and audience and carries no `email` claim at all - it
    // identifies itself by `common_name`. `String(payload.email)` turned that into the literal string
    // "undefined", which is a valid-looking email address to everything downstream: the lookup missed, so the
    // provisioning path below minted a real `employee` account named "undefined" that every service-token
    // request then shared. Today the domain allow-list happens to catch it (an empty domain matches nothing),
    // but that list is optional in Access mode and is a perimeter, not a claim check. This app has no machine
    // lane on the browser path - a machine caller uses an API key - so a token with no human behind it is
    // refused here rather than allowed to become one.
    if (typeof claimed !== "string" || !claimed.includes("@")) throw unauthenticated("Access token carries no email (a service token cannot sign in; use an API key)");
    email = claimed.toLowerCase();
  }

  // Resolve the caller AND their employee `code` (the dept-scope key) in one read via a left join, so
  // authz needs no extra caller lookup. The role grant + global manifest are loaded from the compiled
  // `access_rules` / `policy` store (cached per role / globally, short TTL), so the hot path reads them
  // from the isolate cache (~0 reads warm) and the decision needs no per-request policy join.
  let user = await loadUserRow(deps, eq(schema.users.email, email));
  // Second look, case-insensitively, before concluding this caller has no account. The exact match above is the
  // indexed one and answers every ordinary request; this runs only when it misses, which is either a genuine
  // first login or a row stored with different case by an older build (`email` is UNIQUE on the raw column, so
  // both could exist at once). Provisioning on top of such a row is the harmful outcome - a second account at
  // the default role, while the one carrying their real role and their access rules goes unused - so it is
  // adopted here instead. One unindexed read, on the path that was about to write a row. `stable`, because
  // this predicate is the one that can match more than one row - see loadUserRow.
  if (!user) user = await loadUserRow(deps, sql`lower(${schema.users.email}) = ${email}`, true);
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
    // Auto-link to an employee record with the same work email, if one exists. Ordered for the same reason the
    // user lookup above is: `work_email` is UNIQUE on the raw column, so a case-only difference can put two
    // live rows behind this predicate, and which person a new account is linked to must not be a plan detail.
    const emp = (
      await deps.db
        .select({ uuid: schema.employees.uuid, code: schema.employees.code })
        .from(schema.employees)
        .where(and(sql`lower(${schema.employees.workEmail}) = ${email}`, isNull(schema.employees.deleteTime)))
        .orderBy(asc(schema.employees.createdAt), asc(schema.employees.uuid))
        .limit(1)
    )[0];
    // ADOPT THE WINNER on a lost race. A first login is not one request: a cold page load fires the bootstrap
    // prefetch and whatever the landing route reads, concurrently, and each of them arrives here having read
    // no user. Both then insert, `users.email` being UNIQUE is what stops the second row, and the loser used
    // to surface as an unhandled `D1_ERROR: UNIQUE constraint failed: users.email` - a 500 on the very first
    // screen a new employee ever sees, on a request that had in fact succeeded a millisecond earlier. So the
    // collision is read as what it is (the row now exists) and the winner's row is loaded instead. The lookup
    // is the case-insensitive one for the same reason the read above falls back to it.
    let provisioned: UserRow;
    try {
      const inserted = (
        await deps.db
          .insert(schema.users)
          .values({ code: await allocFlatCode(deps, schema.users), email, role: "employee", employeeId: emp?.uuid ?? null })
          .returning()
      )[0]!;
      provisioned = {
        uuid: inserted.uuid,
        email: inserted.email,
        role: inserted.role,
        status: inserted.status,
        employeeId: inserted.employeeId,
        employeeCode: emp?.code ?? null,
        firstName: null,
        lastName: null,
        sessionsValidFrom: inserted.sessionsValidFrom,
      };
    } catch (e) {
      // THE OTHER UNIQUE INDEX ON THIS INSERT, and it is not a race.
      //
      // `users_employee_idx` is one account per person (schema.ts). The employee this provisioning matched by
      // work email can already be linked to a DIFFERENT account, at which point the insert above fails on
      // `users.employee_id` rather than on `users.email` - a shape the email-collision branch below does not
      // recognise, so it used to rethrow into the catch-all and answer 500. Nothing about that is retryable or
      // self-healing: the state is stable, so EVERY subsequent request repeats it and the person is locked out
      // of the app entirely, reading "Internal Server Error" while the logs fill with `unhandled error`.
      //
      // Reachable from two ordinary HR edits, because `syncAccountEmail` (services/employees.ts) declines to
      // move a linked account onto an address another account already holds: change employee E's work email to
      // one that is taken, then free that address by editing the OTHER employee, and E now names a work email
      // no account carries while E itself is still linked to the account under its old address.
      //
      // Answered as what it is - a data conflict a person has to resolve - rather than by unlinking or by
      // minting an account with no employee. An unlinked account is the worse outcome it looks like: every
      // self-scoped grant matches by employee CODE (domain/permissions.ts `me`), so such a person signs in to
      // an app with nothing in it and no error, which is harder to diagnose than a refusal that names the fix.
      if (isUserEmployeeCollision(e)) {
        throw forbidden("your work email is linked to a different sign-in account; ask HR to correct the account link");
      }
      if (!isUserEmailCollision(e)) throw e;
      const winner = await loadUserRow(deps, sql`lower(${schema.users.email}) = ${email}`, true);
      // The row was there a moment ago and is not now: only a delete landing between the two statements
      // explains that, and re-entering the race is not better than saying so.
      if (!winner) throw unauthenticated("sign-in raced an account change; try again");
      provisioned = winner;
    }
    user = provisioned;
  }
  if (user.status !== "active") throw forbidden("user disabled");
  // Session revocation. A session cookie issued before the user's cut-off is dead, whatever its `exp` says -
  // this is what makes "sign out" mean something for a stateless token, and what answers a lost device without
  // rotating the signing key for everyone. Strictly BEFORE, so a session minted in the same millisecond as the
  // stamp (sign out, then straight back in) survives; the cut-off is set from the same clock.
  if (sessionIat !== null && user.sessionsValidFrom !== null && sessionIat < +new Date(user.sessionsValidFrom)) {
    throw unauthenticated("session was signed out");
  }
  // The caller's broad authority = their role's grant + their own broad user rules (both cached, warm ~0
  // reads). Users are first-class like roles: a user can hold collection/dept/field-scope access, not only
  // per-object exceptions (those still ride the narrowed lane in authz.ts). The common case (no user rules)
  // is EMPTY_GRANT, so mergeGrants is a no-op.
  // The role grant already includes the `everyone` pseudo-role (unioned inside loadRoleGrant in the SAME query,
  // super-exempt), so the broad authority is just role + the caller's own user rules - no extra `everyone` read.
  const { grant, policy } = await loadAuthority(deps, user);

  const caller: AppUser = {
    uuid: user.uuid,
    email: user.email,
    role: user.role,
    status: user.status,
    employeeId: user.employeeId,
    employeeCode: user.employeeCode,
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    grant,
    policy,
    // The sitting, for grouping a whole login in the audit trail. The cookie's issue instant scoped to the
    // user identifies one session without a session TABLE - this lane is deliberately stateless (zero reads),
    // and adding a store just to name a session would give that up. Two sessions of the same user in the same
    // millisecond would collide; they would also both be that user signing in twice at once, which is one
    // sitting for every purpose this grouping serves.
    //
    // HASHED, because this value goes ON THE WIRE: it is `session_id` on every activity row (http/serialize.ts)
    // and a filter a client passes back (`GET /v1/activity?session=`). Written as `<uuid>:<iat>` it published
    // the INTERNAL users primary key verbatim - the id the whole wire codec exists to keep off the wire
    // (lib/idCodec.ts) - under a comment calling it opaque, which it was not: the first half was the row's PK
    // in the clear. Nothing accepts an internal id inbound any more (lib/viewAs.ts was the last lane that did),
    // so this was disclosure rather than a way in, and the fix is the same either way.
    //
    // fnv1a64 and not an HMAC: everything this value has to be is an EQUALITY KEY - the server re-derives it
    // from the same two facts on every request of the sitting, and never trusts one handed back as anything
    // but a filter. Its input carries the uuid's full 64 bits of entropy, so it is not a hash of a guessable
    // secret; and the same helper already backs `authzVersion` and the list validator, which are identities
    // decided the same way.
    ...(sessionIat !== null ? { sessionId: fnv1a64(`${user.uuid}:${sessionIat}`) } : {}),
  };

  // "View as": an access admin can ask the app to answer as another user (read-only, audited). This swaps the
  // PRINCIPAL, not just the UI's capability set - every decision, list scope and redaction downstream is the
  // simulated person's, so the simulation shows exactly what they would see and nothing more. See lib/viewAs.ts.
  c.set("user", (await resolveViewAs(c, deps, caller)) ?? caller);
  await next();
};
