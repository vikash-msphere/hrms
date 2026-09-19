// Interfaces for the seams worth abstracting (testable, swappable). No I/O here.

export interface Clock {
  now(): Date;
}

export interface Encryptor {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  // Raw-byte variants for file payloads: same AES-256-GCM [IV][ct+tag] layout, no base64 (R2 holds bytes).
  encryptBytes(plaintext: Uint8Array): Promise<Uint8Array>;
  decryptBytes(ciphertext: Uint8Array): Promise<Uint8Array>;
}

// One file attached to an email. `content` is the raw (plaintext) bytes; providers base64-encode as needed.
export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface EmailSender {
  send(to: string, subject: string, html: string, attachments?: EmailAttachment[]): Promise<void>;
}

export interface DocumentStore {
  put(key: string, body: ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

// Browser Web Push delivery to one device subscription. Optional: absent unless VAPID keys are configured.
// "gone" = the push service says the subscription is dead (404/410) and the caller should prune it.
export interface PushSender {
  send(subscription: unknown, payload: { title: string; body?: string; link?: string }): Promise<"ok" | "gone" | "error">;
}

// Inference against Workers AI. OPTIONAL, like `push` and `webhook`: absent unless the deployment binds `AI`,
// and every caller degrades to its non-AI path rather than failing (FTS search instead of semantic search, a
// manual pick instead of a suggestion), so a deployment without the binding is a deployment without the AI
// features and nothing else.
//
// Deliberately dumb transport. It enforces the model allowlist and suppresses gateway payload logging because
// those are properties of the CALL, but it knows nothing about budgets, caching or what may be put in a
// prompt - services/ai.ts owns that, the same way lib/email.ts sends one message and services/emailFanOut.ts
// decides who gets one.
//
// `embed` takes an array because the embedding model does: one subrequest for a batch of rows is the
// difference between indexing a collection inside the free allocation and not.
export interface TextModel {
  embed(texts: string[]): Promise<number[][]>;
  generate(req: { system: string; user: string; maxTokens?: number }): Promise<string>;
  /** Score `candidates` against `query`, best first. Returns the input indices, not the strings. */
  rerank(query: string, candidates: string[]): Promise<{ index: number; score: number }[]>;
}

// The semantic half of global search. OPTIONAL, like `ai`: absent = the FTS index answers on its own, which
// is what search did before this existed.
//
// `id` is `"<collection>:<recordId>"`, the same key `search_docs` is unique on, so a match maps back to a row
// without a lookup table. Metadata carries the COLLECTION ONLY - never a name, a code or an owner id. That is
// deliberate: an index outside the main tables should not be independently readable as a directory of who
// works here, and the collection is all the pre-filter needs. The authoritative row filter is applied
// afterwards in SQL, against `search_docs`, by the same `applyScope` the FTS path uses.
export interface VectorIndex {
  upsert(vectors: { id: string; values: number[]; collection: string }[]): Promise<void>;
  /** Nearest neighbours, best first, restricted to `collections`. Returns ids, not rows. */
  query(vector: number[], opts: { topK: number; collections: string[] }): Promise<{ id: string; score: number }[]>;
  /**
   * The stored vectors for these ids, for asking "what is near THIS record" without paying to embed it again.
   * Missing ids are simply absent from the result - a record the drain has not reached yet is a normal state,
   * not an error. Costs no neurons, which is the whole reason it exists rather than a re-embed.
   */
  fetch(ids: string[]): Promise<Map<string, number[]>>;
  remove(ids: string[]): Promise<void>;
}

// Outbound egress for the automation engine's `webhook` action. Optional/absent by default (egress off): the
// engine records the action as skipped when no sender is wired, so a rule can't leak data to the internet
// unless an operator explicitly configures a destination allowlist. See docs/workflow-engine-plan.md.
export interface WebhookSender {
  post(url: string, body: unknown): Promise<void>;
}
