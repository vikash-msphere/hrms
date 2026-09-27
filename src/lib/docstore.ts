import type { DocumentStore, Encryptor } from "../ports";

// Objects are encrypted at the app layer (AES-256-GCM via the shared Encryptor) before they reach R2, and
// decrypted on read - so the bucket holds ciphertext for everything the app considers a document: payslips,
// letters, personal documents, expense invoices, signature images. Raw bytes, no base64 (keeps the CPU cost to
// the AES pass alone). Callers (documents, payslips, attachments) speak plaintext bytes either way.
//
// ONE EXCEPTION, ASKED FOR BY NAME: an employee's profile photo (`{ encrypt: false }`, services/employeePhoto.ts).
// A face is not a payslip - it was only ever ciphertext because it rides this store - and encryption is what
// stops it being STREAMED: WebCrypto's AES-GCM is one-shot, so a decrypting read has to hold the whole image in
// the isolate before it can answer. The trade is recorded where the caller makes it.
//
// WHICH LANE AN OBJECT IS IN IS STORED ON THE OBJECT, never inferred. `customMetadata.enc = "0"` marks a
// plaintext write; anything else - including every object written before that flag existed - is decrypted. So
// this change needs no migration and no backfill, and reversing it needs no more than flipping the flag.
const PLAIN = { enc: "0" } as const;
const isPlain = (meta: Record<string, string> | undefined): boolean => meta?.enc === PLAIN.enc;

export function makeDocumentStore(bucket: R2Bucket, encryptor: Encryptor): DocumentStore {
  return {
    async put(key, body, contentType, opts) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      if (opts?.encrypt === false) {
        await bucket.put(key, bytes as unknown as ArrayBuffer, { httpMetadata: { contentType }, customMetadata: { ...PLAIN } });
        return;
      }
      const sealed = await encryptor.encryptBytes(bytes);
      await bucket.put(key, sealed, { httpMetadata: { contentType } });
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      const stored = new Uint8Array(await o.arrayBuffer());
      if (isPlain(o.customMetadata)) return stored.buffer as ArrayBuffer;
      return (await encryptor.decryptBytes(stored)).buffer as ArrayBuffer;
    },
    async open(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      // The point of this method: a plaintext object is handed over as R2 produced it, so the bytes never sit
      // in the isolate at all. An encrypted one cannot do that (see the header), so it is decrypted whole and
      // wrapped in a one-chunk stream - the same answer `get` gives, in the shape the caller asked for.
      if (isPlain(o.customMetadata)) return { body: o.body, size: o.size };
      const plain = await encryptor.decryptBytes(new Uint8Array(await o.arrayBuffer()));
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(plain);
            controller.close();
          },
        }),
        size: plain.byteLength,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
