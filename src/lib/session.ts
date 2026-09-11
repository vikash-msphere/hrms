// Stateless signed session for DIRECT Google sign-in mode (no Cloudflare Access in front). The cookie value
// is `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))` keyed by AUTH_SESSION_KEY - nothing
// is stored server-side, so verifying costs zero reads and revocation is by expiry (short TTL) or key
// rotation. The payload carries only the authenticated email + times; role/grant/status are resolved fresh
// from the DB on every request by the auth middleware, so disabling a user takes effect immediately even
// with a live cookie.
const enc = new TextEncoder();

export type Session = { email: string; iat: number; exp: number };

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const b = Buffer.from(s, "base64url");
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

async function hmacKey(secretB64: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(secretB64, "base64")), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function sealSession(session: Session, secretB64: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secretB64, "sign"), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** The session the token carries, or null when the signature/shape/expiry fails. Never throws. */
export async function openSession(token: string, secretB64: string, nowMs: number): Promise<Session | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  try {
    // crypto.subtle.verify is constant-time - never compare the MAC with ===.
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secretB64, "verify"), fromB64url(token.slice(dot + 1)), enc.encode(payload));
    if (!ok) return null;
    const session = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (typeof session.email !== "string" || !session.email) return null;
    // `iat` is checked as strictly as `exp`, because the auth middleware makes a SECURITY decision from it: a
    // session issued before the user's `sessions_valid_from` stamp is dead, which is what "sign out everywhere"
    // and "I lost my phone" mean. A payload without one left `sessionIat` undefined, which passes the `!== null`
    // guard there and then compares `undefined < stamp` as false - so the revocation check waved the cookie
    // through, and the audit trail's session id read `<uuid>:undefined`. Nothing mints such a cookie today
    // (`sealSession` always writes both), and the MAC means an attacker cannot either; this is here so the one
    // field that decides revocation is not also the one field nobody validates.
    if (!Number.isFinite(session.exp) || !Number.isFinite(session.iat)) return null;
    if (session.exp <= nowMs) return null;
    return session;
  } catch {
    return null;
  }
}
