// The app lock's cryptography and rules, with no database and no framework in it (see app-lock-plan.md).
//
// Three things are derived from FIELD_ENCRYPTION_KEY, each under its own HKDF label so none can stand in for
// another: the PIN key, the unlock-proof key and the client-store keys. FIELD_ENCRYPTION_KEY because it is
// the one secret every deployment has in both sign-in modes; AUTH_SESSION_KEY exists only in Google mode.
const enc = new TextEncoder();

/** The cookie that proves this browser entered the PIN. Everything without a valid one is locked. */
export const UNLOCK_COOKIE = "hrms_unlock";
export const PIN_LENGTHS = [4, 6] as const;
/** Auto-lock choices in minutes. 0 is "only when I lock". */
export const IDLE_CHOICES = [0, 5, 15, 30, 60] as const;
export const DEFAULT_IDLE_MINUTES = 15;
/** How much longer than the person's own auto-lock time the SERVER keeps a proof alive without a keepalive.
 *  The page locks itself at the exact time; this is the backstop for a page that never got to (a closed
 *  browser, a laptop asleep), so it only has to be close, and a margin keeps a slow keepalive from locking
 *  somebody mid-sentence. */
export const SERVER_IDLE_MARGIN_MS = 5 * 60_000;
/** A proof never outlives this, whatever the session says. Matches the Google session's own TTL. */
export const PROOF_MAX_MS = 12 * 60 * 60_000;
/** Wrong PINs allowed before the first wait. */
export const FREE_TRIES = 5;
/** The wrong-PIN count at which the owner is told. */
export const NOTIFY_AT = 3;

/** The wait imposed after the `failures`-th consecutive wrong PIN, in ms (0 = none). */
export function waitAfter(failures: number): number {
  if (failures < FREE_TRIES) return 0;
  const schedule = [30_000, 60_000, 5 * 60_000, 15 * 60_000];
  return schedule[failures - FREE_TRIES] ?? 60 * 60_000;
}

// ---- Keys -----------------------------------------------------------------------------------------------

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const fromB64 = (s: string, url = false): Uint8Array<ArrayBuffer> => {
  const b = Buffer.from(s, url ? "base64url" : "base64");
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

// Derived keys, per isolate. The auth middleware opens a proof on every request of a person with a PIN, and a
// derivation plus an import per request would be pure repeated work. The promise is cached so concurrent first
// calls share one derivation; a failure is dropped rather than remembered.
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(masterB64: string, label: string): Promise<CryptoKey> {
  const id = `${label}:${masterB64}`;
  let key = keyCache.get(id);
  if (!key) {
    if (keyCache.size >= 16) keyCache.clear();
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", fromB64(masterB64), "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("hrms/app-lock"), info: enc.encode(label) }, base, 256);
      return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
    key.catch(() => keyCache.delete(id));
    keyCache.set(id, key);
  }
  return key;
}

// ---- The PIN --------------------------------------------------------------------------------------------
//
// HMAC under a key that is not in the database, not a slow hash. A 4 or 6 digit PIN falls to any hash, however
// slow, within seconds for someone holding the stored value, so PBKDF2 or scrypt would protect nothing - and
// would not fit the free plan's 10 ms CPU cap either. A leaked database is protected by this key living
// somewhere else; a live account is protected by the attempt limit (services/appLock.ts). The user id is in the
// message so two people with the same PIN store different values.

const pinMessage = (userUuid: string, pin: string) => enc.encode(`v1|${userUuid}|${pin}`);

export async function hashPin(masterB64: string, userUuid: string, pin: string): Promise<string> {
  return b64(await crypto.subtle.sign("HMAC", await hmacKey(masterB64, "pin"), pinMessage(userUuid, pin)));
}

/** Whether `pin` is the one stored. Constant-time (subtle.verify), and false on a malformed stored value. */
export async function pinMatches(masterB64: string, userUuid: string, pin: string, stored: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(masterB64, "pin"), fromB64(stored), pinMessage(userUuid, pin));
  } catch {
    return false;
  }
}

// The PINs people pick first and an attacker tries first. Short on purpose: each one here is a PIN somebody
// cannot use, and the attempt limit already makes the long tail of guesses slow.
const COMMON = new Set([
  "1212", "1004", "2000", "2580", "6969", "1122", "4321", "0852", "7777", "1313", "2222", "5683", "1010",
  "112233", "121212", "123123", "159753", "147258", "258369", "696969", "131313", "101010", "142536", "123321",
]);

/**
 * Why `pin` may not be used, or null when it may. `personal` is numbers tied to the person (their employee
 * number) - a PIN a colleague could read off a payslip is not a secret.
 */
export function weakPinReason(pin: string, personal: string[] = []): string | null {
  if (!/^\d+$/.test(pin) || !(PIN_LENGTHS as readonly number[]).includes(pin.length)) return "use 4 or 6 digits";
  if (/^(\d)\1+$/.test(pin)) return "avoid repeating one digit";
  const steps = [...pin].slice(1).map((d, i) => (Number(d) - Number(pin[i]) + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return "avoid digits in a row";
  if (COMMON.has(pin)) return "that PIN is too common";
  // Pairs and halves repeated: 1212, 123123.
  if (pin.length === 6 && pin.slice(0, 3) === pin.slice(3)) return "avoid repeating a pattern";
  if (/^(\d\d)\1+$/.test(pin)) return "avoid repeating a pattern";
  for (const p of personal) {
    const digits = p.replace(/\D/g, "");
    if (digits.length >= 4 && (digits.includes(pin) || pin.includes(digits))) return "avoid numbers tied to you";
  }
  return null;
}

// ---- The unlock proof -----------------------------------------------------------------------------------
//
// A signed, stateless cookie, the same construction as the session cookie (lib/session.ts), so checking it
// costs one HMAC and no read. `u` is a hash of the user id rather than the id, because the cookie is visible in
// DevTools and internal ids stay off the wire (lib/idCodec.ts). `s` binds it to one session: a proof minted
// before a sign-out never unlocks the next sign-in. `i` is what locking one device revokes.

export type UnlockProof = {
  u: string; // user binding
  s: string; // session binding ("-" on lanes with no session)
  i: string; // random id
  iat: number;
  exp: number; // sliding idle expiry
  max: number; // absolute ceiling
};

export async function sealProof(proof: UnlockProof, masterB64: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(proof)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(masterB64, "unlock-proof"), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** The proof a cookie carries, or null when the signature, the shape or either expiry fails. Never throws. */
export async function openProof(token: string, masterB64: string, nowMs: number): Promise<UnlockProof | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(masterB64, "unlock-proof"), fromB64(token.slice(dot + 1), true), enc.encode(payload));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64(payload, true))) as UnlockProof;
    if (typeof p.u !== "string" || typeof p.s !== "string" || typeof p.i !== "string") return null;
    if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp) || !Number.isFinite(p.max)) return null;
    if (p.exp <= nowMs || p.max <= nowMs) return null;
    // Bounded like the session's iat, and for the same reason: the cut-off stamp is compared against it.
    if (p.iat > nowMs + 60_000 || p.max - p.iat > PROOF_MAX_MS + 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

/** A fresh random proof id. */
export const newProofId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

/** When a proof issued or renewed at `now` should lapse for someone whose auto-lock is `idleMinutes`. */
export function proofExpiry(idleMinutes: number, now: number, max: number): number {
  if (!idleMinutes) return max;
  return Math.min(max, now + idleMinutes * 60_000 + SERVER_IDLE_MARGIN_MS);
}

/** The per-device revocations, as stored. Anything unreadable is treated as nothing revoked by it. */
export type Revoked = { i: string; exp: number }[];

export function parseRevoked(json: string | null | undefined): Revoked {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((r): r is Revoked[number] => !!r && typeof r.i === "string" && Number.isFinite(r.exp)) : [];
  } catch {
    return [];
  }
}

/** Add one revocation and drop the ones whose proof has lapsed anyway, which is what keeps the list short. */
export function withRevoked(list: Revoked, add: Revoked[number] | null, now: number): Revoked {
  const kept = list.filter((r) => r.exp > now);
  if (add && !kept.some((r) => r.i === add.i)) kept.push(add);
  return kept.slice(-50);
}

// ---- Client-store keys ----------------------------------------------------------------------------------
//
// The key the SPA encrypts what it keeps in IndexedDB with (web/src/lib/clientStore.ts). Derived, not stored:
// the same person gets the same key until `epoch` moves (an admin reset), so a reload decrypts what the last
// page wrote. It is handed only to an UNLOCKED session, on /users/me, which is the whole of what makes a locked
// browser's storage unreadable.

export async function clientKeyFor(masterB64: string, userUuid: string, epoch: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(masterB64, "client-store"), enc.encode(`v1|${userUuid}|${epoch}`));
  // base64url: a response body string with a "/" in it is what the outbound wire edge inspects for references.
  return b64url(mac);
}
