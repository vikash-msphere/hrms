// API-key token minting + verification.
//
// Token shape: `hrms_<prefix>_<secret>`
//   prefix - 8 base32 chars, stored in the clear and UNIQUE. It is the lookup handle, so verifying a key is
//            one indexed read rather than a scan that HMACs every row. Also what the UI shows to identify a
//            key after the secret is gone.
//   secret - 24 random bytes, base64url. Shown to the operator exactly once, at creation.
//
// The stored verifier is HMAC-SHA256(secret) under a key DERIVED from FIELD_ENCRYPTION_KEY via HKDF with a
// dedicated info label. Three deliberate choices:
//   - HMAC, not a bare SHA-256 digest: a leak of `api_keys` alone is then not a set of working credentials,
//     because forging one also needs the Worker secret.
//   - FIELD_ENCRYPTION_KEY as the source: AUTH_SESSION_KEY is optional (Google sign-in mode only), so it
//     cannot be relied on, and requiring a NEW secret would mean a deploy-time change for every environment.
//   - HKDF with `info="api-key-hmac"`: the same key material therefore never does two jobs, matching how the
//     wire-id codec and the field encryptor derive their own subkeys.
//
// Verification uses crypto.subtle.verify, which is constant-time. Never compare a MAC with `===`.

import { invalidArgument } from "./errors";

const enc = new TextEncoder();
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // base32, no ambiguous 0/1/l/o
const PREFIX_LEN = 8;
const SECRET_BYTES = 24;
const TOKEN_RE = /^hrms_([a-z2-7]{8})_([A-Za-z0-9_-]{16,})$/;

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// HKDF-SHA256(FIELD_ENCRYPTION_KEY) -> a dedicated HMAC key for API-key verifiers.
async function hmacKey(masterKeyB64: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", fromB64(masterKeyB64) as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("api-key-hmac") },
    master,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export type MintedToken = { token: string; prefix: string; hash: string };
export type ApiKeySigner = {
  /** Mint a fresh credential. The plaintext `token` goes to the operator ONCE; only `prefix` + `hash` persist. */
  mint(): Promise<MintedToken>;
  /** Constant-time check of a presented secret against a stored verifier. */
  verify(secret: string, storedHashB64: string): Promise<boolean>;
};

// Closes over the master key the same way makeEncryptor does, so the raw secret never travels on Deps.
export function makeApiKeySigner(masterKeyB64: string): ApiKeySigner {
  return {
    async mint() {
      const raw = crypto.getRandomValues(new Uint8Array(PREFIX_LEN));
      const prefix = [...raw].map((b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join("");
      const secret = b64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
      const sig = await crypto.subtle.sign("HMAC", await hmacKey(masterKeyB64, "sign"), enc.encode(secret));
      return { token: `hrms_${prefix}_${secret}`, prefix, hash: b64(new Uint8Array(sig)) };
    },
    async verify(secret, storedHashB64) {
      try {
        return await crypto.subtle.verify("HMAC", await hmacKey(masterKeyB64, "verify"), fromB64(storedHashB64) as BufferSource, enc.encode(secret));
      } catch {
        return false; // malformed stored hash: fail closed, never throw into the auth path
      }
    },
  };
}

// Pull a well-formed token out of an Authorization header. Returns null when the header is absent or is not
// one of ours, which is what lets the auth middleware fall through to the browser lanes.
//
// IMPORTANT: "not one of ours" must mean the header does not LOOK like an API key at all. A malformed
// `hrms_…` bearer is still an API-key attempt and must fail 401 - see hasApiKeyBearer.
export function parseToken(authorization: string | undefined): { prefix: string; secret: string } | null {
  if (!authorization) return null;
  const m = TOKEN_RE.exec(authorization.replace(/^Bearer\s+/i, "").trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

// Does this request CLAIM to be an API-key request? Deliberately looser than parseToken: any `hrms_`-shaped
// bearer counts, valid or not.
//
// Two callers depend on this being the loose test:
//   - the auth middleware, so a malformed key 401s instead of silently falling back to the session cookie;
//   - the CSRF middleware, which runs BEFORE auth and must skip its check for key callers. The skip is only
//     safe BECAUSE of the no-fallback rule above: if a junk `hrms_` bearer could fall through to the cookie,
//     an attacker could set one from a cross-site page purely to suppress the CSRF check and ride the
//     victim's session.
export function hasApiKeyBearer(authorization: string | undefined): boolean {
  return !!authorization && /^Bearer\s+hrms_/i.test(authorization.trim());
}

// Display form for a key whose secret is gone: `hrms_ab12cd34_...`. Never reconstructs the secret.
export function maskedToken(prefix: string): string {
  return `hrms_${prefix}_...`;
}

export function assertKeyName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw invalidArgument("display_name is required");
  if (trimmed.length > 80) throw invalidArgument("display_name must be 80 characters or fewer");
  return trimmed;
}
