// The app lock, browser half (app-lock-plan.md; the server half is src/services/appLock.ts).
//
// THE SERVER IS THE LOCK. Every /v1 call from a browser without a valid unlock proof answers 401
// `/errors/app-locked`, so nothing here decides what anybody may see. What this module owns is that the PAGE
// has nothing to show once it is locked:
//
//   1. an opaque cover goes over the page in the same task as the click, before the next frame is painted;
//   2. every other tab of the app in this browser is told, and does the same;
//   3. the app unmounts and storage is wiped (lib/clientStore.ts purgeForLock - the encrypted records stay,
//      unreadable, and everything readable goes);
//   4. the server revokes this browser's proof and clears the HTTP cache (POST /auth/lock);
//   5. the page reloads into a FRESH document, so nothing survives in memory - not a module cache, not a
//      React tree, not a string a heap snapshot could find.
//
// The fresh document asks /users/me as it always does, gets the app-locked refusal, and renders the lock
// screen instead of the app (App.tsx). Unlocking reloads again, into the app.
import { useSyncExternalStore } from "react";
import { publishToAll, subscribeTopic } from "@/lib/crossTabBus";
import { purgeForLock } from "@/lib/clientStore";

export type LockHint = { pinLength: number; firstName?: string };
export type LockConfig = { enabled: boolean; pinLength: number | null; idleMinutes: number; expireTime: number | null };
type State = {
  /** This page is the lock screen. */
  locked: boolean;
  hint: LockHint | null;
  /** The signed-in person's lock, once the shell knows it (null on the lock screen). */
  config: LockConfig | null;
  /** When an auto-lock will happen, while the 30-second warning is showing. */
  warnAt: number | null;
};

// Kept through a lock by clientStore's KEPT_ON_LOCK ("hrms.lock." prefix). Neither says anything about the
// person: one is a digit count, the other a timestamp.
const PENDING = "hrms.lock.pending"; // this browser locked and has not unlocked since; value = PIN length
const ACTIVE = "hrms.lock.active"; // last keyboard/pointer/touch activity in ANY tab, epoch ms
const WARN_MS = 30_000;
/** Mirrors src/lib/appLock.ts SERVER_IDLE_MARGIN_MS: how much past the auto-lock the server keeps a proof. */
const SERVER_MARGIN_MS = 5 * 60_000;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage denied: the server-side lock still holds */
  }
};

const pendingLength = () => {
  const v = Number(read(PENDING));
  return v === 4 || v === 6 ? v : read(PENDING) ? 6 : 0;
};

let state: State = { locked: !!pendingLength(), hint: pendingLength() ? { pinLength: pendingLength() } : null, config: null, warnAt: null };
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
/** The lock's state, for the lock screen, the top bar button and the auto-lock warning. */
export const useAppLock = () => useSyncExternalStore(subscribe, () => state, () => state);
export const appLockState = () => state;

// ---- Locking ---------------------------------------------------------------------------------------------

let root: { unmount(): void } | null = null;
/** main.tsx hands over the React root, so locking can take the whole app down before the reload. */
export function registerAppRoot(r: { unmount(): void }) {
  root = r;
}

/** The cover: a plain opaque layer over everything, outside React, so it is up before React could render. */
function cover() {
  if (typeof document === "undefined" || document.getElementById("app-lock-cover")) return;
  const el = document.createElement("div");
  el.id = "app-lock-cover";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "2147483647", background: "hsl(var(--background))" });
  document.body.appendChild(el);
  document.getElementById("root")?.setAttribute("inert", "");
  (document.activeElement as HTMLElement | null)?.blur?.();
}

let locking = false;

/** Tell the server this browser is locked. Capped, because a slow network must not hold the lock open. */
async function tellServer(): Promise<void> {
  try {
    await Promise.race([
      fetch("/auth/lock", { method: "POST", keepalive: true, credentials: "include", headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" }, body: "{}" }),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* offline: the pending flag re-sends it from the lock screen, and the server's idle expiry closes it anyway */
  }
}

/** Lock this browser now: cover, tell the other tabs, wipe, revoke, reload. */
export async function lockNow(opts: { tellServer?: boolean; broadcast?: boolean } = {}): Promise<void> {
  if (locking) return;
  locking = true;
  cover();
  write(PENDING, String(state.config?.pinLength ?? state.hint?.pinLength ?? 6));
  if (opts.broadcast !== false) publishToAll("lock", { op: "lock" });
  try {
    root?.unmount();
  } catch {
    /* the reload below discards whatever did not unmount */
  }
  await purgeForLock();
  if (opts.tellServer !== false) await tellServer();
  // The path only: a query string or a hash can hold a table filter, and a filter can hold a name.
  window.location.replace(window.location.pathname);
}

let shellUp = false;
let confirming = false;
/** A PIN set, change or removal in flight from this page (it moves the server's cut-off; see serverSaysLocked). */
let pinChange: Promise<unknown> | null = null;

/**
 * The server answered `/errors/app-locked` (lib/api.ts). With the app on screen that is a lock that happened
 * somewhere else - "lock all my devices", or the server's idle expiry - and it gets the whole sequence. At boot
 * it is simply the lock screen, after wiping what the last page left readable.
 */
export function serverSaysLocked(lock?: { pin_length?: number; first_name?: string } | null): void {
  const hint: LockHint = { pinLength: lock?.pin_length === 4 ? 4 : 6, ...(lock?.first_name ? { firstName: lock.first_name } : {}) };
  if (shellUp) {
    // ASKED AGAIN before acting, with the cookie this browser holds NOW. A refusal can describe a moment that
    // has passed: setting or changing a PIN moves the cut-off and hands this browser a fresh proof in the same
    // answer, so a read that left just before carries the old cookie and comes back locked - and acting on it
    // locked the person out a second after they set their PIN. Only a lock the server still stands by is one.
    // Offline, the refusal is taken at its word: failing towards locked is the safe way round.
    if (confirming) return;
    confirming = true;
    // A PIN change of this page's own still on its way back is the fresh proof the question needs.
    void (pinChange ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => fetchLockStatus())
      .then((s) => {
        if (s && s !== "signed-out" && s.enabled && !s.locked) return;
        set({ hint });
        void lockNow({ tellServer: false });
      })
      .finally(() => {
        confirming = false;
      });
    return;
  }
  if (state.locked && state.hint?.firstName) return;
  write(PENDING, String(hint.pinLength));
  void purgeForLock();
  set({ locked: true, hint });
}

// ---- The lock screen's calls -----------------------------------------------------------------------------

export type LockStatus = {
  enabled: boolean;
  locked: boolean;
  pin_length: number | null;
  idle_minutes: number;
  expire_time: string | null;
  attempts_left: number | null;
  retry_after: number | null;
  last_failed_at: string | null;
  first_name: string | null;
};

const JSON_HEADERS = { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" };

/** This browser's lock status. Null when the call could not be made (offline) or the session is gone. */
export async function fetchLockStatus(): Promise<LockStatus | "signed-out" | null> {
  try {
    const res = await fetch("/auth/lock", { credentials: "include", headers: JSON_HEADERS });
    if (res.status === 401) return "signed-out";
    return res.ok ? ((await res.json()) as LockStatus) : null;
  } catch {
    return null;
  }
}

/** The lock screen's first act: make sure the server knows (a lock sent while offline), then say what it knows. */
export async function settleLockScreen(): Promise<LockStatus | "signed-out" | null> {
  let status = await fetchLockStatus();
  if (status && status !== "signed-out") {
    if (!status.enabled) {
      // The PIN is gone (turned off elsewhere, or reset by an admin): nothing is locked any more.
      write(PENDING, null);
      window.location.replace(window.location.pathname);
      return status;
    }
    if (!status.locked) {
      await tellServer();
      status = { ...status, locked: true };
    }
    set({ hint: { pinLength: status.pin_length === 4 ? 4 : 6, ...(status.first_name ? { firstName: status.first_name } : {}) } });
  }
  return status;
}

export type UnlockResult =
  | { ok: true }
  | { ok: false; kind: "wrong"; attemptsLeft: number; retryAfter: number }
  | { ok: false; kind: "wait"; retryAfter: number }
  | { ok: false; kind: "signed-out" | "offline" | "failed" };

export async function unlock(pin: string): Promise<UnlockResult> {
  let res: Response;
  try {
    res = await fetch("/auth/lock/unlock", { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ pin }) });
  } catch {
    return { ok: false, kind: "offline" };
  }
  const body = (await res.json().catch(() => ({}))) as { attempts_left?: number; retry_after?: number };
  if (res.ok) {
    write(PENDING, null);
    write(ACTIVE, String(Date.now()));
    publishToAll("lock", { op: "unlocked" });
    return { ok: true };
  }
  if (res.status === 403) return { ok: false, kind: "wrong", attemptsLeft: body.attempts_left ?? 0, retryAfter: body.retry_after ?? 0 };
  if (res.status === 429) return { ok: false, kind: "wait", retryAfter: body.retry_after ?? Number(res.headers.get("Retry-After") ?? 60) };
  if (res.status === 401) return { ok: false, kind: "signed-out" };
  return { ok: false, kind: "failed" };
}

/** Into the app, after an unlock. */
export const enterApp = () => window.location.replace(window.location.pathname);

// ---- Settings calls (the settings panel) -----------------------------------------------------------------

export type LockCallError = { status: number; message: string; attemptsLeft?: number; retryAfter?: number };

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: "include", headers: JSON_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof json.detail === "string" ? json.detail : "";
    const message =
      res.status === 403 && json.type === "/errors/pin-incorrect"
        ? "That's not your current PIN."
        : res.status === 429
          ? `Too many wrong PINs. Try again in ${fmtWait(Number(json.retry_after ?? 60))}.`
          : detail.replace(/^(pin|current_pin|idle_minutes): /, "").replace(/^./, (c) => c.toUpperCase()) || "Something went wrong. Try again.";
    throw { status: res.status, message, attemptsLeft: json.attempts_left as number | undefined, retryAfter: json.retry_after as number | undefined } satisfies LockCallError;
  }
  return json as T;
}

type PinAnswer = { enabled: boolean; pin_length?: number; idle_minutes?: number; expire_time?: string | null };

const adopt = (a: PinAnswer) => {
  const cfg: LockConfig = {
    enabled: a.enabled,
    pinLength: a.pin_length ?? null,
    idleMinutes: a.idle_minutes ?? state.config?.idleMinutes ?? 15,
    expireTime: a.expire_time ? Date.parse(a.expire_time) : null,
  };
  configureLock(cfg);
};

/** Run a PIN change with `pinChange` set, so a refusal racing it waits for its fresh proof. */
async function changingPin(req: Promise<PinAnswer>): Promise<void> {
  pinChange = req;
  try {
    adopt(await req);
  } finally {
    if (pinChange === req) pinChange = null;
  }
}

export function setPin(pin: string, currentPin?: string): Promise<void> {
  return changingPin(call<PinAnswer>("/auth/lock/pin", "PUT", { pin, ...(currentPin ? { current_pin: currentPin } : {}) }));
}

export function removePin(currentPin: string): Promise<void> {
  return changingPin(call<PinAnswer>("/auth/lock/pin", "DELETE", { current_pin: currentPin }));
}

export async function setIdleMinutes(minutes: number): Promise<void> {
  const a = await call<{ idle_minutes: number; expire_time: string | null }>("/auth/lock", "PATCH", { idle_minutes: minutes });
  if (state.config) configureLock({ ...state.config, idleMinutes: a.idle_minutes, expireTime: a.expire_time ? Date.parse(a.expire_time) : state.config.expireTime });
}

/** Every browser of this person locks, this one included. */
export async function lockEverywhere(): Promise<void> {
  cover();
  await call("/auth/lock", "POST", { everywhere: true }).catch(() => undefined);
  await lockNow({ tellServer: false });
}

export function fmtWait(secs: number): string {
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  const m = Math.ceil(secs / 60);
  return m < 60 ? `${m} min` : `${Math.ceil(m / 60)} h`;
}

// ---- Idle, keepalive and the hidden-tab shade ------------------------------------------------------------

let lastActive = Date.now();
let lastShared = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let keepaliveInFlight = false;

const idleMs = () => (state.config?.enabled && state.config.idleMinutes > 0 ? state.config.idleMinutes * 60_000 : 0);
const activeAt = () => Math.max(lastActive, Number(read(ACTIVE)) || 0);

/** Keyboard, pointer or touch activity in this tab. Shared with the other tabs at most every few seconds. */
export function markActive(force = false) {
  const now = Date.now();
  lastActive = now;
  if (force || now - lastShared > 5_000) {
    lastShared = now;
    write(ACTIVE, String(now));
  }
  if (state.warnAt) set({ warnAt: null });
  maybeKeepalive(now);
}

function maybeKeepalive(now: number) {
  const cfg = state.config;
  if (!cfg?.enabled || !cfg.expireTime || keepaliveInFlight || locking) return;
  // Renew once the proof is past half its server window - and only because somebody is actually here.
  const window = cfg.idleMinutes > 0 ? cfg.idleMinutes * 60_000 + SERVER_MARGIN_MS : 0;
  if (!window || cfg.expireTime - now > window / 2 || now - activeAt() > 60_000) return;
  keepaliveInFlight = true;
  void fetch("/auth/lock/keepalive", { method: "POST", credentials: "include", headers: JSON_HEADERS })
    .then(async (res) => {
      if (res.status === 401) {
        const p = (await res.json().catch(() => null)) as { type?: string } | null;
        if (p?.type === "/errors/app-locked") serverSaysLocked({ pin_length: cfg.pinLength ?? 6 });
        return;
      }
      const a = (await res.json().catch(() => null)) as { expire_time?: string } | null;
      if (a?.expire_time && state.config) set({ config: { ...state.config, expireTime: Date.parse(a.expire_time) } });
    })
    .catch(() => undefined)
    .finally(() => {
      keepaliveInFlight = false;
    });
}

/** Lock if the whole browser has been idle past the person's auto-lock time; warn in the last 30 seconds. */
function check() {
  const ms = idleMs();
  if (!ms || locking) return;
  const due = activeAt() + ms;
  const now = Date.now();
  if (now >= due) {
    void lockNow();
    return;
  }
  const warnAt = now >= due - WARN_MS ? due : null;
  if (warnAt !== state.warnAt) set({ warnAt });
  maybeKeepalive(now);
}

const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
let moveAt = 0;
const onMove = () => {
  const now = Date.now();
  if (now - moveAt < 2_000) return;
  moveAt = now;
  markActive();
};
const onActivity = () => markActive();

/** The shade: while the tab is hidden, nothing of the app is painted, so a thumbnail or a return shows nothing. */
function onVisibility() {
  if (!state.config?.enabled) return;
  const html = document.documentElement;
  if (document.visibilityState === "hidden") {
    html.setAttribute("data-lock-shade", "");
    return;
  }
  const ms = idleMs();
  if (ms && Date.now() >= activeAt() + ms) {
    void lockNow();
    return;
  }
  html.removeAttribute("data-lock-shade");
}

/**
 * The signed-in shell reports the person's lock (from /users/me, or from a settings change). With a PIN set,
 * this is what arms auto-lock, the keepalive and the hidden-tab shade.
 */
export function configureLock(cfg: LockConfig | null) {
  shellUp = true;
  set({ config: cfg, warnAt: null });
  const armed = !!cfg?.enabled;
  if (armed && !timer) {
    lastActive = Date.now();
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { capture: true, passive: true });
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    timer = setInterval(check, 5_000);
  } else if (!armed && timer) {
    for (const e of ACTIVITY) window.removeEventListener(e, onActivity, { capture: true });
    window.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", check);
    clearInterval(timer);
    timer = null;
    document.documentElement.removeAttribute("data-lock-shade");
  }
  if (armed) check();
}

// ---- Other tabs, and the back/forward cache ---------------------------------------------------------------

if (typeof window !== "undefined") {
  subscribeTopic<{ op: string }>("lock", (m) => {
    if (m.op === "lock") {
      if (shellUp) void lockNow({ tellServer: false, broadcast: false });
      else if (!state.locked) set({ locked: true, hint: state.hint ?? { pinLength: pendingLength() || 6 } });
    }
    // Another tab unlocked: this one is a lock screen (a fresh document), so going into the app is a reload.
    if (m.op === "unlocked" && state.locked) enterApp();
  });
  // A page restored whole from the back/forward cache ran none of the code above while it was away: if this
  // browser locked in the meantime, what came back is either the cover or something that must not be shown.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && (read(PENDING) || locking)) {
      cover();
      window.location.replace(window.location.pathname);
    }
  });
}
