import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { signedInCaller, type UserRow } from "../middleware/auth";
import { keyedCounter } from "../lib/isolateRate";
import { jsonBody } from "../http/jsonRequest";
import { UNLOCK_COOKIE, FREE_TRIES, DEFAULT_IDLE_MINUTES } from "../lib/appLock";
import { forbidden, failedPrecondition, invalidArgument, resourceExhausted } from "../lib/errors";
import {
  assertUsablePin, checkPin, clearProofCookie, issueProof, loadLock, removePin, renewProof, revokeAllProofs, revokeProof,
  setIdleMinutes, storePin, validProof, type Attempt,
} from "../services/appLock";

// The app lock's own door (app-lock-plan.md): the requests a LOCKED browser has to be able to make. Under /auth,
// beside sign-out, because this is sign-in state rather than data - no access rules decide any of it, only
// "is this the signed-in person, and do they know their PIN".
//
//   GET    /auth/lock            this browser's lock status (the lock screen and the settings panel)
//   POST   /auth/lock            lock this browser, or { everywhere: true } for every device
//   PATCH  /auth/lock            { idle_minutes } - the person's own auto-lock time
//   POST   /auth/lock/unlock     { pin } -> an unlock proof
//   POST   /auth/lock/keepalive  renew the proof while the page is in use
//   PUT    /auth/lock/pin        { pin, current_pin? } - set or change
//   DELETE /auth/lock/pin        { current_pin } - turn the lock off
//
// CSRF: every write carries the app's X-Requested-By header, the same posture as /auth/logout and /v1.

// Floors per signed-in person, not per address: an office behind one address would otherwise spend a shared
// budget on keepalives. Generous, because guessing is bounded where it matters (the reservation in
// services/appLock.ts) and these only stop a client stuck in a loop.
const perUser = keyedCounter(60);

type Caller = { user: UserRow; binding: string };

async function caller(c: Context<AppEnv>): Promise<Caller> {
  const found = await signedInCaller(c, c.get("deps"));
  if (perUser.throttled(found.user.uuid, Date.now())) throw resourceExhausted(`too many requests; retry in ${perUser.retryAfterSeconds}s`);
  return found;
}

const csrfOk = (c: Context<AppEnv>) => c.req.header("X-Requested-By") === "hrms-spa";
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const b = (await jsonBody(c)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** This browser's valid proof, if it has one. */
const proofOf = (c: Context<AppEnv>, { user, binding }: Caller) =>
  validProof(c.env.FIELD_ENCRYPTION_KEY, getCookie(c, UNLOCK_COOKIE), user.uuid, user, binding, Date.now());

/** The refusal for a wrong or waiting PIN, shaped like every other problem so the client reads it one way. */
function refused(c: Context<AppEnv>, a: Exclude<Attempt, { ok: true }>) {
  if (a.reason === "none") return c.json({ type: "/errors/failed-precondition", title: "Failed Precondition", status: 409, detail: "no app PIN is set" }, 409);
  if (a.reason === "wait") {
    const secs = Math.ceil(a.retryAfterMs / 1000);
    return c.json(
      { type: "/errors/pin-wait", title: "Too Many Attempts", status: 429, detail: `too many wrong PINs; try again in ${secs}s`, retry_after: secs },
      429,
      { "Retry-After": String(secs), "Content-Type": "application/problem+json" },
    );
  }
  return c.json(
    {
      type: "/errors/pin-incorrect",
      title: "Wrong PIN",
      status: 403,
      detail: "wrong PIN",
      attempts_left: a.attemptsLeft,
      ...(a.retryAfterMs ? { retry_after: Math.ceil(a.retryAfterMs / 1000) } : {}),
    },
    403,
    { "Content-Type": "application/problem+json" },
  );
}

/** Registered in src/index.ts on both `/auth/lock` and `/auth/lock/*`, ahead of the routes. */
export const lockCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !csrfOk(c)) throw forbidden("missing X-Requested-By header");
  await next();
};

export const appLockRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const who = await caller(c);
    const row = await loadLock(c.get("deps"), who.user.uuid);
    const enabled = !!row?.pinHash;
    const proof = enabled ? await proofOf(c, who) : null;
    const now = Date.now();
    const waitMs = row?.blockedUntil ? Math.max(0, +new Date(row.blockedUntil) - now) : 0;
    return c.json({
      enabled,
      locked: enabled && !proof,
      pin_length: row?.pinLength ?? null,
      idle_minutes: row?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      expire_time: iso(proof?.exp),
      attempts_left: enabled ? Math.max(0, FREE_TRIES - (row?.failures ?? 0)) : null,
      retry_after: waitMs ? Math.ceil(waitMs / 1000) : null,
      last_failed_at: row?.lastFailedAt ? new Date(row.lastFailedAt).toISOString() : null,
      first_name: who.user.firstName,
    });
  })
  .post("/", async (c) => {
    // Locking must never fail on the way out: a missing session or no PIN still clears what this browser holds.
    let who: Caller | null = null;
    try {
      who = await caller(c);
    } catch {
      /* not signed in: nothing to revoke, the cookie still goes */
    }
    const { everywhere } = await body(c);
    if (who) {
      const deps = c.get("deps");
      if (everywhere === true) await revokeAllProofs(deps, who.user, deps.clock.now());
      else {
        const proof = await proofOf(c, who);
        if (proof) await revokeProof(deps, who.user.uuid, proof, Date.now());
      }
    }
    clearProofCookie(c);
    // What the browser keeps outside of script's reach goes too: cached photos, and the back/forward cache that
    // could restore the page as it was. NOT "storage" - that would unregister the push service worker; the page
    // clears its own storage before it calls this (web/src/lib/appLock.ts).
    c.header("Clear-Site-Data", '"cache"');
    return c.body(null, 204);
  })
  .patch("/", async (c) => {
    const who = await caller(c);
    if (!(await proofOf(c, who))) throw forbidden("unlock first");
    const minutes = await setIdleMinutes(c.get("deps"), who.user.uuid, (await body(c)).idle_minutes);
    // The proof this browser holds was sized for the old time; re-size it now rather than at the next keepalive.
    const proof = await proofOf(c, who);
    const renewed = proof ? await renewProof(c, proof, minutes, Date.now()) : null;
    return c.json({ idle_minutes: minutes, expire_time: iso(renewed?.exp) });
  })
  .post("/unlock", async (c) => {
    const who = await caller(c);
    const deps = c.get("deps");
    const pin = (await body(c)).pin;
    if (typeof pin !== "string" || !/^\d{4}(\d\d)?$/.test(pin)) throw invalidArgument("pin: 4 or 6 digits");
    const attempt = await checkPin(deps, c.env.FIELD_ENCRYPTION_KEY, who.user, pin, deps.clock.now());
    if (!attempt.ok) return refused(c, attempt);
    const row = await loadLock(deps, who.user.uuid);
    const proof = await issueProof(c, who.user.uuid, who.binding, row?.idleMinutes ?? DEFAULT_IDLE_MINUTES, Date.now());
    return c.json({ expire_time: iso(proof.exp), idle_minutes: row?.idleMinutes ?? DEFAULT_IDLE_MINUTES });
  })
  .post("/keepalive", async (c) => {
    const who = await caller(c);
    const proof = await proofOf(c, who);
    if (!proof) return c.json({ type: "/errors/app-locked", title: "App Locked", status: 401 }, 401, { "Content-Type": "application/problem+json" });
    const renewed = await renewProof(c, proof, who.user.lockIdleMinutes ?? DEFAULT_IDLE_MINUTES, Date.now());
    return c.json({ expire_time: iso(renewed.exp) });
  })
  .put("/pin", async (c) => {
    const who = await caller(c);
    const deps = c.get("deps");
    const { pin, current_pin } = await body(c);
    const usable = await assertUsablePin(deps, who.user.employeeId, pin);
    const changing = !!who.user.lockPinHash;
    if (changing) {
      // Changing needs the browser unlocked AND the current PIN - counted like any unlock attempt, so this is
      // not a second door to guess through.
      if (!(await proofOf(c, who))) throw forbidden("unlock first");
      if (typeof current_pin !== "string") throw invalidArgument("current_pin: required to change the PIN");
      const attempt = await checkPin(deps, c.env.FIELD_ENCRYPTION_KEY, who.user, current_pin, deps.clock.now());
      if (!attempt.ok) return refused(c, attempt);
    }
    const now = deps.clock.now();
    await storePin(deps, c.env.FIELD_ENCRYPTION_KEY, who.user, usable, now, changing);
    // Every other browser's proof died with the old PIN; this one gets a fresh proof so it stays open.
    const row = await loadLock(deps, who.user.uuid);
    const proof = await issueProof(c, who.user.uuid, who.binding, row?.idleMinutes ?? DEFAULT_IDLE_MINUTES, +now);
    return c.json({ enabled: true, pin_length: usable.length, idle_minutes: row?.idleMinutes ?? DEFAULT_IDLE_MINUTES, expire_time: iso(proof.exp) });
  })
  .delete("/pin", async (c) => {
    const who = await caller(c);
    const deps = c.get("deps");
    if (!who.user.lockPinHash) throw failedPrecondition("no app PIN is set");
    if (!(await proofOf(c, who))) throw forbidden("unlock first");
    const current = (await body(c)).current_pin;
    if (typeof current !== "string") throw invalidArgument("current_pin: required to turn the lock off");
    const attempt = await checkPin(deps, c.env.FIELD_ENCRYPTION_KEY, who.user, current, deps.clock.now());
    if (!attempt.ok) return refused(c, attempt);
    await removePin(deps, who.user, deps.clock.now());
    clearProofCookie(c);
    return c.json({ enabled: false });
  });
