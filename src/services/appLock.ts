// The app lock's state and its rules against the database (app-lock-plan.md). The cryptography is
// lib/appLock.ts; the HTTP surface is routes/appLockRoutes.ts; the per-request check is `unlockState` below,
// called from middleware/auth.ts.
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppEnv, AppUser } from "../env";
import {
  DEFAULT_IDLE_MINUTES, FREE_TRIES, IDLE_CHOICES, NOTIFY_AT, PROOF_MAX_MS, UNLOCK_COOKIE, hashPin, newProofId, openProof,
  parseRevoked, pinMatches, proofExpiry, sealProof, waitAfter, weakPinReason, withRevoked, type UnlockProof,
} from "../lib/appLock";
import { AppLockedError, invalidArgument, failedPrecondition, notFound } from "../lib/errors";
import { fnv1a64 } from "../lib/fnv";
import { audit } from "../lib/audit";
import { notify } from "./notifications";

/** The lock columns the auth read joins onto the caller's row. All null when the person never set a PIN. */
export type LockColumns = {
  lockPinHash: string | null;
  lockPinLength: number | null;
  lockIdleMinutes: number | null;
  lockValidFrom: Date | number | null;
  lockRevoked: string | null;
  lockKeyEpoch: number | null;
};

/** What the rest of the request knows about the caller's lock, carried on AppUser. */
export type AppLockInfo = NonNullable<AppUser["appLock"]>;

/** Whose proof this is, as it appears in the cookie: a hash, so the internal id stays off the wire. */
export const proofOwner = (userUuid: string) => fnv1a64(`unlock:${userUuid}`);

/** What a proof is bound to. The session's sitting in Google mode; nothing narrower where there is no session. */
export const sessionBinding = (sessionId: string | undefined) => sessionId ?? "-";

const idleOf = (m: number | null | undefined) => (m === null || m === undefined ? DEFAULT_IDLE_MINUTES : m);

/**
 * The proof this request carries, if it is valid for THIS person and THIS session right now. Null otherwise,
 * which is what "locked" means: there is no lock flag anywhere, only proofs that do or do not check out.
 */
export async function validProof(master: string, token: string | undefined, userUuid: string, lock: LockColumns, binding: string, now: number): Promise<UnlockProof | null> {
  if (!token) return null;
  const p = await openProof(token, master, now);
  if (!p) return null;
  if (p.u !== proofOwner(userUuid) || p.s !== binding) return null;
  // Strictly before, like the session cut-off: a proof minted in the same millisecond as the stamp (a PIN
  // change mints the new proof right after moving it) survives.
  if (lock.lockValidFrom !== null && p.iat < +new Date(lock.lockValidFrom)) return null;
  if (parseRevoked(lock.lockRevoked).some((r) => r.i === p.i)) return null;
  return p;
}

/**
 * The per-request check (middleware/auth.ts). Throws the locked refusal for a person with a PIN whose browser
 * holds no valid proof; otherwise says what the rest of the request needs to know about their lock.
 */
export async function unlockState(
  c: Context<AppEnv>,
  user: { uuid: string; firstName: string | null } & LockColumns,
  binding: string,
  now: number,
): Promise<AppLockInfo> {
  const base = { keyOwner: user.uuid, keyEpoch: user.lockKeyEpoch ?? 0, idleMinutes: idleOf(user.lockIdleMinutes) };
  if (!user.lockPinHash) return { ...base, enabled: false, pinLength: null, expiresAt: null };
  const proof = await validProof(c.env.FIELD_ENCRYPTION_KEY, getCookie(c, UNLOCK_COOKIE), user.uuid, user, binding, now);
  if (!proof) throw new AppLockedError({ pin_length: user.lockPinLength ?? 6, ...(user.firstName ? { first_name: user.firstName } : {}) });
  return { ...base, enabled: true, pinLength: user.lockPinLength, expiresAt: proof.exp };
}

// ---- Cookies --------------------------------------------------------------------------------------------

/** Mint a proof for this browser and set it. `max` defaults to the proof ceiling from now. */
export async function issueProof(c: Context<AppEnv>, userUuid: string, binding: string, idleMinutes: number, now: number, max = now + PROOF_MAX_MS): Promise<UnlockProof> {
  const proof: UnlockProof = { u: proofOwner(userUuid), s: binding, i: newProofId(), iat: now, exp: proofExpiry(idleMinutes, now, max), max };
  setProofCookie(c, await sealProof(proof, c.env.FIELD_ENCRYPTION_KEY), proof, now);
  return proof;
}

/** Re-seal an existing proof with a later expiry (the keepalive). Same id, so a later per-device lock still names it. */
export async function renewProof(c: Context<AppEnv>, proof: UnlockProof, idleMinutes: number, now: number): Promise<UnlockProof> {
  const next = { ...proof, exp: proofExpiry(idleMinutes, now, proof.max) };
  setProofCookie(c, await sealProof(next, c.env.FIELD_ENCRYPTION_KEY), next, now);
  return next;
}

function setProofCookie(c: Context<AppEnv>, token: string, proof: UnlockProof, now: number) {
  // Strict: nothing another site starts may carry it, which is stricter than the session cookie needs to be
  // (a link into the app from mail is a cross-site navigation, and only the shell answers that; the app's own
  // requests are same-site). The Max-Age is the ceiling; the signed `exp` inside is the real expiry.
  setCookie(c, UNLOCK_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: Math.max(1, Math.floor((proof.max - now) / 1000)) });
}

export function clearProofCookie(c: Context<AppEnv>) {
  deleteCookie(c, UNLOCK_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Strict" });
}

// ---- Reads ----------------------------------------------------------------------------------------------

export async function loadLock(deps: Deps, userUuid: string) {
  return (await deps.db.select().from(schema.appLocks).where(eq(schema.appLocks.userId, userUuid)).limit(1))[0];
}

export const lockColumnsOf = (row: Awaited<ReturnType<typeof loadLock>>): LockColumns => ({
  lockPinHash: row?.pinHash ?? null,
  lockPinLength: row?.pinLength ?? null,
  lockIdleMinutes: row?.idleMinutes ?? null,
  lockValidFrom: row?.unlocksValidFrom ?? null,
  lockRevoked: row?.revokedJson ?? null,
  lockKeyEpoch: row?.keyEpoch ?? null,
});

// ---- Guessing -------------------------------------------------------------------------------------------

/** The `blocked_until` a reservation writes, as SQL over the failure count it is about to store. */
function blockExpr(nowMs: number) {
  const next = sql`${schema.appLocks.failures} + 1`;
  const cases = [];
  for (let n = FREE_TRIES; n < FREE_TRIES + 4; n++) cases.push(sql`WHEN ${next} = ${n} THEN ${nowMs + waitAfter(n)}`);
  return sql`CASE WHEN ${next} < ${FREE_TRIES} THEN NULL ${sql.join(cases, sql` `)} ELSE ${nowMs + waitAfter(FREE_TRIES + 4)} END`;
}

export type Attempt =
  | { ok: true }
  | { ok: false; reason: "wrong"; attemptsLeft: number; retryAfterMs: number }
  | { ok: false; reason: "wait"; retryAfterMs: number }
  | { ok: false; reason: "none" };

/**
 * Check a PIN, counted BEFORE it is compared.
 *
 * The reservation is one UPDATE that bumps the failure count only while the account is not in a wait, and
 * returns the stored hash from the same statement. A burst of parallel guesses therefore cannot slip extra
 * comparisons past the counter - checking "not blocked" in one read and counting in a later write is the race
 * that would let a thousand guesses land for the price of five. A correct PIN puts the count back to zero.
 */
export async function checkPin(deps: Deps, master: string, user: { uuid: string; email: string; employeeId: string | null }, pin: string, now: Date): Promise<Attempt> {
  const ms = +now;
  const reserved = (
    await deps.db
      .update(schema.appLocks)
      .set({ failures: sql`${schema.appLocks.failures} + 1`, blockedUntil: blockExpr(ms) as never })
      .where(and(eq(schema.appLocks.userId, user.uuid), isNotNull(schema.appLocks.pinHash), or(isNull(schema.appLocks.blockedUntil), lte(schema.appLocks.blockedUntil, now))))
      .returning({ pinHash: schema.appLocks.pinHash, failures: schema.appLocks.failures, blockedUntil: schema.appLocks.blockedUntil })
  )[0];
  if (!reserved) {
    const row = await loadLock(deps, user.uuid);
    if (!row?.pinHash) return { ok: false, reason: "none" };
    return { ok: false, reason: "wait", retryAfterMs: Math.max(1000, +new Date(row.blockedUntil ?? now) - ms) };
  }
  if (reserved.pinHash && (await pinMatches(master, user.uuid, pin, reserved.pinHash))) {
    await deps.db.update(schema.appLocks).set({ failures: 0, blockedUntil: null }).where(eq(schema.appLocks.userId, user.uuid));
    return { ok: true };
  }
  const failures = reserved.failures;
  await deps.db.update(schema.appLocks).set({ lastFailedAt: now }).where(eq(schema.appLocks.userId, user.uuid));
  // Told at the first threshold and at every fifth after it - enough to notice a pattern, not a stream.
  if (failures === NOTIFY_AT || (failures > NOTIFY_AT && failures % 5 === 0)) {
    await audit(deps, user.email, "user.pinFailed", "users", user.uuid, { reason: `${failures} wrong PINs in a row` });
    if (user.employeeId) {
      await notify(deps, {
        recipient: user.employeeId,
        type: "security.pin_failed",
        title: "Wrong app PIN entered",
        body: `Someone entered a wrong PIN ${failures} times in a row. If it wasn't you, lock all your devices from My Profile › Privacy.`,
        // Straight to the panel the body names, so the fix is one tap away.
        link: "profile/privacy",
        priority: "urgent",
      });
    }
  }
  return {
    ok: false,
    reason: "wrong",
    attemptsLeft: Math.max(0, FREE_TRIES - failures),
    retryAfterMs: reserved.blockedUntil ? Math.max(0, +new Date(reserved.blockedUntil) - ms) : 0,
  };
}

// ---- Writes ---------------------------------------------------------------------------------------------

/** Numbers tied to the person that a PIN must not be: their employee number, for one. */
async function personalNumbers(deps: Deps, employeeId: string | null): Promise<string[]> {
  if (!employeeId) return [];
  const row = (await deps.db.select({ n: schema.employees.employeeNumber }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  return row?.n ? [row.n] : [];
}

/** Refuse a weak PIN with a message the setup form shows against the field. */
export async function assertUsablePin(deps: Deps, employeeId: string | null, pin: unknown): Promise<string> {
  if (typeof pin !== "string") throw invalidArgument("pin: use 4 or 6 digits");
  const reason = weakPinReason(pin, await personalNumbers(deps, employeeId));
  if (reason) throw invalidArgument(`pin: ${reason}`);
  return pin;
}

/**
 * Set a new PIN (first time, or a change the route has already verified). Every other browser's proof dies
 * with the old PIN, so a change is also a lock of every other device - which is what somebody changing their
 * PIN because it was seen wants.
 */
export async function storePin(deps: Deps, master: string, user: { uuid: string; email: string }, pin: string, now: Date, changing: boolean) {
  const pinHash = await hashPin(master, user.uuid, pin);
  await deps.db
    .insert(schema.appLocks)
    .values({ userId: user.uuid, pinHash, pinLength: pin.length, pinSetAt: now, unlocksValidFrom: now, failures: 0, blockedUntil: null })
    .onConflictDoUpdate({ target: schema.appLocks.userId, set: { pinHash, pinLength: pin.length, pinSetAt: now, unlocksValidFrom: now, failures: 0, blockedUntil: null, revokedJson: "[]" } });
  await audit(deps, user.email, changing ? "user.pinChanged" : "user.pinSet", "users", user.uuid, { reason: `${pin.length}-digit app PIN` });
}

export async function removePin(deps: Deps, user: { uuid: string; email: string }, now: Date) {
  await deps.db
    .update(schema.appLocks)
    .set({ pinHash: null, pinLength: null, pinSetAt: null, failures: 0, blockedUntil: null, unlocksValidFrom: now, revokedJson: "[]" })
    .where(eq(schema.appLocks.userId, user.uuid));
  await audit(deps, user.email, "user.pinRemoved", "users", user.uuid, { reason: "app lock turned off" });
}

export async function setIdleMinutes(deps: Deps, userUuid: string, minutes: unknown): Promise<number> {
  if (typeof minutes !== "number" || !(IDLE_CHOICES as readonly number[]).includes(minutes)) {
    throw invalidArgument(`idle_minutes: one of ${IDLE_CHOICES.join(", ")}`);
  }
  const updated = await deps.db.update(schema.appLocks).set({ idleMinutes: minutes }).where(eq(schema.appLocks.userId, userUuid)).returning({ m: schema.appLocks.idleMinutes });
  if (!updated.length) throw failedPrecondition("set a PIN before choosing when the app locks");
  return minutes;
}

/** Revoke one browser's proof (it locked). The entry drops off once that proof would have lapsed anyway. */
export async function revokeProof(deps: Deps, userUuid: string, proof: UnlockProof, now: number) {
  const row = await loadLock(deps, userUuid);
  if (!row) return;
  const next = withRevoked(parseRevoked(row.revokedJson), { i: proof.i, exp: proof.exp }, now);
  await deps.db.update(schema.appLocks).set({ revokedJson: JSON.stringify(next) }).where(eq(schema.appLocks.userId, userUuid));
}

/** Every browser's proof dies: "lock all my devices". */
export async function revokeAllProofs(deps: Deps, user: { uuid: string; email: string }, now: Date) {
  await deps.db.update(schema.appLocks).set({ unlocksValidFrom: now, revokedJson: "[]" }).where(eq(schema.appLocks.userId, user.uuid));
  await audit(deps, user.email, "user.lockEverywhere", "users", user.uuid, { reason: "locked on every device" });
}

/**
 * An admin clears somebody's PIN (the only recovery for a forgotten one). Everything that PIN guarded goes with
 * it: every session is signed out, every proof is dead, and the key their browsers encrypt under moves, so
 * whatever those browsers kept can never be read again. The person is told.
 */
export async function resetPin(deps: Deps, actor: AppUser, targetUserUuid: string) {
  const target = (await deps.db.select({ uuid: schema.users.uuid, employeeId: schema.users.employeeId }).from(schema.users).where(eq(schema.users.uuid, targetUserUuid)).limit(1))[0];
  if (!target) throw notFound("user not found");
  const now = deps.clock.now();
  await deps.db
    .insert(schema.appLocks)
    .values({ userId: target.uuid, pinHash: null, unlocksValidFrom: now, keyEpoch: 1 })
    .onConflictDoUpdate({
      target: schema.appLocks.userId,
      set: { pinHash: null, pinLength: null, pinSetAt: null, failures: 0, blockedUntil: null, unlocksValidFrom: now, revokedJson: "[]", keyEpoch: sql`${schema.appLocks.keyEpoch} + 1` },
    });
  await deps.db.update(schema.users).set({ sessionsValidFrom: now }).where(eq(schema.users.uuid, target.uuid));
  await audit(deps, actor, "user.resetPin", "users", target.uuid, { reason: "app PIN reset by an admin; signed out everywhere" });
  if (target.employeeId) {
    await notify(deps, {
      recipient: target.employeeId,
      type: "security.pin_reset",
      title: "Your app PIN was reset",
      body: "An admin reset your app PIN and signed you out everywhere. Sign in again, and set a new PIN from App lock settings if you want the lock back.",
      priority: "urgent",
      actorId: actor.employeeId,
    });
  }
  return { reset: true };
}
