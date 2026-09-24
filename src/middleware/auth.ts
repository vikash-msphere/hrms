import { allocFlatCode } from "../services/codeAlloc";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq, sql, and, asc, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import type { Grant } from "../domain/permissions";
import type { Policy } from "../domain/manifests";
import { mergeGrants, mergeGuards } from "../domain/compileGrants";
import type { GuardIndex } from "../domain/ruleCondition";
import { loadRoleGrant, loadUserGrant, loadUserRoles, loadManifest, loadRoleGuards, loadUserGuards } from "../lib/policyLoad";
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
import { touchLastSeen } from "../services/users";

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
  /** The linked employee's soft-delete stamp, when they have one. See `assertLive`. */
  employeeDeleteTime: Date | number | null;
  sessionsValidFrom: Date | number | null;
  lastSeenAt: Date | number | null;
};

/**
 * Run a write off the response path.
 *
 * `c.executionCtx` THROWS when the context has none (the test runner, and any in-process dispatch) rather than
 * returning undefined, so this cannot be an optional-chain. Without an execution context there is nothing to
 * hand the promise to, so the write settles inline - it is one small statement, and dropping it unawaited
 * would surface as an unhandled rejection. Never fatal either way: these are convenience columns, and failing
 * a request because a bookkeeping stamp did not land would be the wrong trade.
 */
async function detach(c: Context<AppEnv>, write: Promise<unknown>): Promise<void> {
  const settled = write.then(() => undefined, () => undefined);
  try {
    c.executionCtx.waitUntil(settled);
    return;
  } catch {
    /* no execution context */
  }
  await settled;
}

/**
 * Stamp when this account was last seen, at most once per throttle window.
 *
 * Every lane ends here, which is the point: "last seen" has to mean the last request of any kind, and a stamp
 * written by only the browser lanes would report an account that lives on an API key as dormant. The READ is
 * free - `loadUserRow` already fetches this row on every request to check `status` - so the only cost is the
 * write, and `shouldTouchLastUsed` keeps that to once every 15 minutes per account rather than once per
 * request. That throttle is also the field's accuracy: it answers "today / last week / never", which is the
 * resolution the question is actually asked at, and not "at 09:41:03".
 *
 * Skipped under `__sharedCtx` - an internal dispatch (an automation's apiCall re-entering the app) is the
 * system acting, not the person, and stamping there would keep a departed employee's account looking active
 * for as long as a rule they once wrote keeps firing.
 *
 * Takes the AUTHENTICATED row, and is called before `resolveViewAs` swaps the principal - so an admin
 * simulating somebody stamps themselves, never the subject. The same rule the audit trail keeps: a
 * simulation is the admin looking, and it must not make a dormant account read as active.
 */
async function touchSeen(c: Context<AppEnv>, deps: Deps, user: UserRow, now: Date): Promise<void> {
  if (c.env.__sharedCtx) return;
  if (!shouldTouchLastUsed(user.lastSeenAt, +now)) return;
  await detach(c, touchLastSeen(deps, user.uuid, now));
}

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
      employeeDeleteTime: schema.employees.deleteTime,
      sessionsValidFrom: schema.users.sessionsValidFrom,
      lastSeenAt: schema.users.lastSeenAt,
    })
    .from(schema.users)
    .leftJoin(schema.employees, eq(schema.users.employeeId, schema.employees.uuid))
    .where(where);
  return (await (stable ? q.orderBy(asc(schema.users.createdAt), asc(schema.users.uuid)) : q).limit(1))[0];
}

/**
 * A user whose linked employee row has been soft-deleted is not a user any more.
 *
 * TWO EXITS FROM THE COMPANY USED TO GIVE TWO ANSWERS. Offboarding does it properly and says so
 * (services/transitions.ts: "disable their login" - it stamps the employee terminated AND sets the `users` row
 * to disabled). `DELETE /v1/employees/<id>` did not: `employees` declares no `remove` override, so the generic
 * soft delete ran, stamped `employees.delete_time` and touched nothing else. The `users` row stayed active, and
 * this join carried no soft-delete filter - so `employeeCode` and `employeeId` resolved off the deleted row,
 * every `me`-scoped grant still matched, every own-breadth list still bound, and the person kept full
 * self-service (clock in/out, file leave, raise tickets, upload documents, post to the board) while being gone
 * from the directory. None of those services re-checks liveness, and none of them should have to: the
 * invariant belongs at the door.
 *
 * The `employees` remove override now disables the linked user the way offboarding does, which is the fix that
 * matches the stated intent - "gone" should mean the account is off. This is the second half of it: an account
 * whose employee was deleted BEFORE that existed, or by any other path, is refused here rather than quietly
 * losing its scopes. The same file already knew the column mattered - the auto-provision lookup below filters
 * it - so one lookup applied the rule and the other did not.
 */
function assertLive(user: UserRow): void {
  if (user.status !== "active") throw forbidden("user disabled");
  if (user.employeeDeleteTime) throw forbidden("user disabled");
}

/**
 * The caller's broad authority: their PRIMARY role's grant (which already folds in `everyone`), plus each
 * SECONDARY role they hold, plus their own broad user rules. All cached, so warm this costs ~0 reads.
 *
 * UNION, and the order does not matter: `mergeGrants` takes the highest level per pattern and concatenates the
 * allow and deny lanes, so merging is associative here and a role can only ever ADD. That is the same shape
 * `everyone` has always had - this is one more source of the same kind, not a new kind.
 *
 * THE RESULT IS PER USER, NOT PER ROLE, and that is the part to be careful with: the inputs are each cached
 * under their own key (`grant:<role>`, `userRoles:<uuid>`, `userGrant:<uuid>`) and merged fresh per request.
 * Nothing caches the merged grant, so there is no combined key that could be served to the wrong caller when
 * somebody's role set changes - the failure mode a per-role cache of a per-user answer would have.
 */
async function loadAuthority(deps: Deps, user: UserRow): Promise<{ grant: Grant; policy: Policy; roles: string[]; guards: GuardIndex }> {
  const [primary, extraRoles, userGrant, policy, userGuards] = await Promise.all([
    loadRoleGrant(deps, user.role),
    loadUserRoles(deps, user.uuid),
    loadUserGrant(deps, user.uuid),
    loadManifest(deps),
    loadUserGuards(deps, user.uuid),
  ]);
  // The primary can also appear in the join table (an admin ticking the box they already hold); holding a role
  // twice must not mean loading it twice, and the set is what `roleSubjects` fans out over downstream.
  const roles = [...new Set([user.role, ...extraRoles])];
  const secondary = await Promise.all(roles.filter((r) => r !== user.role).map((r) => loadRoleGrant(deps, r)));
  // The thresholds ride alongside, merged the same way and off the same cached rows. They decide nothing on
  // their own (domain/ruleCondition.ts): the middleware consults them only after `decide()` has already allowed,
  // and only ever to refuse.
  const roleGuards = await Promise.all(roles.map((r) => loadRoleGuards(deps, r)));
  return {
    grant: secondary.reduce(mergeGrants, mergeGrants(primary, userGrant)),
    policy,
    roles,
    guards: roleGuards.reduce(mergeGuards, userGuards),
  };
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
  assertLive(user);

  const { grant, policy, roles, guards } = await loadAuthority(deps, user);

  // Convenience column, not an audit record: written at most once per throttle window so a busy integration
  // does not add a D1 write to every call. Off the response path, and never fatal.
  if (shouldTouchLastUsed(key.lastUsedAt, +now) && !c.env.__sharedCtx) await detach(c, touchLastUsed(deps, key.uuid, now));
  // The same for the OWNER of the key: an integration running is that account being used, and the dormant-
  // account review would otherwise read a service owner as never seen while their key calls all day.
  await touchSeen(c, deps, user, now);

  return {
    uuid: user.uuid,
    email: user.email,
    role: user.role,
    roles,
    guards,
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

export type BrowserIdentity = {
  email: string;
  /** When the caller arrived on a session COOKIE, the instant it was issued. `auth` checks it against the user's
   *  revocation stamp once the row is loaded - it cannot be checked here, because the row is what says whether
   *  anything has been revoked, and the email is all that is known at this point. Null on every other lane (dev
   *  bypass, Access JWT): those carry no session to revoke. */
  sessionIat: number | null;
};

/**
 * Who a BROWSER caller is, from the credential their request carries alone: the dev bypass, the Google-mode
 * session cookie or the Access JWT, whichever the deployment's mode selects. No database, no provisioning, no
 * status check - those belong to `auth`, which calls this first and then resolves the person behind the email.
 * Throws `unauthenticated` when the credential is missing or does not verify.
 *
 * Exported for the static-site gate (http/staticSite.ts), which must answer "is this a signed-in browser?" for
 * every request for app code without spending a D1 read on it. It uses THIS function rather than a copy so the
 * two can never disagree about which mode is on or what counts as a valid credential. API keys are deliberately
 * not a lane here: `auth` handles them before calling this, and a machine caller has no use for the SPA.
 */
export async function resolveBrowserIdentity(c: Context<AppEnv>): Promise<BrowserIdentity> {
  const team = c.env.CF_ACCESS_TEAM_DOMAIN;
  // LOCAL-ONLY dev bypass. Requires BOTH DEV_FAKE_EMAIL and an explicit, dedicated `ALLOW_DEV_AUTH=true` flag.
  // The flag exists only in `.dev.vars`; production secrets never set it, so a stray `DEV_FAKE_EMAIL` copied
  // into a prod env is HARMLESS on its own - the request falls through to real JWT verification instead of
  // silently bypassing auth. Two independent signals must align for the bypass to engage.
  const devBypass = !!c.env.DEV_FAKE_EMAIL && c.env.ALLOW_DEV_AUTH === "true";
  if (devBypass) return { email: c.env.DEV_FAKE_EMAIL!.toLowerCase(), sessionIat: null };
  if (c.env.GOOGLE_CLIENT_ID) {
    // Direct Google sign-in mode: the caller is whoever the signed session cookie says, verified by HMAC +
    // expiry (stateless - zero reads). Everything `auth` does after this (status check, role grant,
    // provisioning) still runs fresh per request, so disabling a user bites immediately despite the live cookie.
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await openSession(token, c.env.AUTH_SESSION_KEY!, Date.now()) : null;
    if (!session) throw unauthenticated("not signed in");
    return { email: session.email.toLowerCase(), sessionIat: session.iat };
  }
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
  // provisioning path in `auth` minted a real `employee` account named "undefined" that every service-token
  // request then shared. Today the domain allow-list happens to catch it (an empty domain matches nothing),
  // but that list is optional in Access mode and is a perimeter, not a claim check. This app has no machine
  // lane on the browser path - a machine caller uses an API key - so a token with no human behind it is
  // refused here rather than allowed to become one.
  if (typeof claimed !== "string" || !claimed.includes("@")) throw unauthenticated("Access token carries no email (a service token cannot sign in; use an API key)");
  return { email: claimed.toLowerCase(), sessionIat: null };
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

  const { email, sessionIat } = await resolveBrowserIdentity(c);

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
        // The auto-provision lookup already filters `delete_time`, so an employee resolved here is a live one.
        employeeDeleteTime: null,
        firstName: null,
        lastName: null,
        sessionsValidFrom: inserted.sessionsValidFrom,
        lastSeenAt: inserted.lastSeenAt,
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
  assertLive(user);
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
  const { grant, policy, roles, guards } = await loadAuthority(deps, user);
  await touchSeen(c, deps, user, deps.clock.now());

  const caller: AppUser = {
    uuid: user.uuid,
    email: user.email,
    role: user.role,
    roles,
    guards,
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
