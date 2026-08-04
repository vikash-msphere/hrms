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

// Outbound egress for the automation engine's `webhook` action. Optional/absent by default (egress off): the
// engine records the action as skipped when no sender is wired, so a rule can't leak data to the internet
// unless an operator explicitly configures a destination allowlist. See docs/workflow-engine-plan.md.
export interface WebhookSender {
  post(url: string, body: unknown): Promise<void>;
}
