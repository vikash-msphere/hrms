import type { Encryptor } from "../ports";

// AES-256-GCM field encryption. Byte layout: [12-byte IV][ciphertext+tag], base64-encoded.
// VERIFIED to round-trip. Do not change the layout.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64e = (buf: Uint8Array) => Buffer.from(buf).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export function makeEncryptor(keyBase64: string): Encryptor {
  const importKey = () =>
    crypto.subtle.importKey("raw", b64d(keyBase64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

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
