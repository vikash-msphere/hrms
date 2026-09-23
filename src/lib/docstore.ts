import type { DocumentStore, Encryptor } from "../ports";

// Every object is encrypted at the app layer (AES-256-GCM via the shared Encryptor) before it reaches R2,
// and decrypted on read - so the bucket only ever holds ciphertext. Raw bytes, no base64 (keeps the CPU
// cost to the AES pass only). Callers (documents, payslips, attachments) are unaffected: put/get still
// speak plaintext bytes.
export function makeDocumentStore(bucket: R2Bucket, encryptor: Encryptor): DocumentStore {
  return {
    async put(key, body, contentType) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const sealed = await encryptor.encryptBytes(bytes);
      await bucket.put(key, sealed, { httpMetadata: { contentType } });
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      const sealed = new Uint8Array(await o.arrayBuffer());
      return (await encryptor.decryptBytes(sealed)).buffer as ArrayBuffer;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
