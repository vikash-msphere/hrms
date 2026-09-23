import type { Encryptor } from "../ports";

// AES-256-GCM field encryption. Byte layout: [12-byte IV][ciphertext+tag], base64-encoded.
// VERIFIED to round-trip. Do not change the layout.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64e = (buf: Uint8Array) => Buffer.from(buf).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export function makeEncryptor(keyBase64: string): Encryptor {
  // IMPORTED ONCE PER ENCRYPTOR, not once per call. The key material is fixed for the life of this object, so
  // re-importing it is pure repeated work - and it is repeated per ROW, not per request: a bank file or a
  // payroll build decrypts one bank-details blob per employee, so a 500-person run paid for 500 key imports
  // on an isolate whose CPU is metered. A CryptoKey is immutable and safe to share across concurrent
  // operations, so the promise is cached rather than the resolved key (concurrent first calls then share one
  // import instead of racing several).
  //
  // The cache is dropped on failure. An unusable FIELD_ENCRYPTION_KEY fails deterministically and will fail
  // again, but holding a rejected promise forever turns a transient platform error into a dead encryptor for
  // the isolate's whole life, and keeps a rejected promise alive with nothing awaiting it.
  let keyPromise: Promise<CryptoKey> | null = null;
  const importKey = (): Promise<CryptoKey> =>
    (keyPromise ??= crypto.subtle
      .importKey("raw", b64d(keyBase64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
      .catch((e: unknown) => {
        keyPromise = null;
        throw e;
      }));

  return {
    async encrypt(plaintext) {
      const key = await importKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
      const out = new Uint8Array(iv.length + ct.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ct), iv.length);
      return b64e(out);
    },
    async decrypt(ciphertext) {
      const key = await importKey();
      const data = b64d(ciphertext);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));
      return dec.decode(pt);
    },
    // File payloads: operate on raw bytes (no base64) so large uploads skip the costly base64 pass.
    async encryptBytes(plaintext) {
      const key = await importKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext as BufferSource);
      const out = new Uint8Array(iv.length + ct.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ct), iv.length);
      return out;
    },
    async decryptBytes(ciphertext) {
      const key = await importKey();
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.slice(0, 12) as BufferSource }, key, ciphertext.slice(12) as BufferSource);
      return new Uint8Array(pt);
    },
  };
}
