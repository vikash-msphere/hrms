// Vendor-agnostic e-signature layer. This module owns only the PURE contract every provider implements and
// the config shape - no I/O, no vendor specifics. Drivers live in src/services/esign/*. The HRMS treats
// signing uniformly as "a provider": the legacy in-place image signing is the `internal` driver, an
// Aadhaar-eSign vendor (Cashfree) is the `cashfree` driver, and which one runs - and per which letter - is
// entirely settings-driven (see EsignConfig + esignFor).

export type EsignStatus = "none" | "sent" | "viewed" | "signed" | "declined" | "expired" | "failed";

// The person who signs. `aadhaar` is decrypted from identity details for Aadhaar-eSign vendors; passed over
// TLS only, never logged, never persisted on the document row.
export type EsignSigner = { name: string; aadhaar?: string; email?: string; phone?: string };

// Per-provider free-form config (from the `esign` setting) + secrets (from env, never the settings blob).
export type EsignProviderCfg = Record<string, unknown>;
export type EsignSecrets = { apiKey?: string; apiSecret?: string; webhookSecret?: string; publicKey?: string };

// Which of the above a driver cannot work without. Declared by the driver so the gate lives with the vendor
// that knows its own requirements, and checked BEFORE any row is created (see esign/index.ts
// `assertProviderConfigured`) - otherwise the first sign of a missing secret is the vendor call throwing deep
// inside createRequest, which surfaces as an opaque 500 after a document has already been written.
export type EsignRequiredSecret = "apiKey" | "apiSecret" | "webhookSecret" | "publicKey";

// Where the signature placeholder(s) actually landed on the rendered PDF, for a vendor that must be told
// where to stamp the signature. Points, PDF bottom-left origin; (x1,y1) top-left, (x2,y2) bottom-right; page
// 1-based. Produced by the letter renderer per document (never a static guess).
export type EsignSignAnchor = { page: number; x1: number; y1: number; x2: number; y2: number };

export type CreateRequestInput = {
  pdf: Uint8Array;
  fileName: string;
  signers: EsignSigner[];
  docId: string; // the personal-documents uuid, echoed back so a webhook can be matched if the vendor supports it
  signAnchors?: EsignSignAnchor[]; // per-document signature box(es); a driver that places signatures uses these
  cfg: EsignProviderCfg;
  secrets: EsignSecrets;
};
export type CreateRequestResult = { providerRef: string; signUrl?: string; status: EsignStatus };
export type WebhookInput = { headers: Record<string, string>; rawBody: string; secrets: EsignSecrets };
export type WebhookResult = { providerRef: string; status: EsignStatus; signedPdf?: Uint8Array } | null;
export type StatusResult = { status: EsignStatus; signedPdf?: Uint8Array };

// A config field the vendor exposes for an operator to fill in Settings (non-secret; secrets live in env). The
// UI renders these dynamically from the driver, so adding a vendor needs no UI change.
export type EsignConfigField = { key: string; label: string; type?: "text" | "number"; hint?: string; placeholder?: string };

// Non-secret descriptor of a driver, sent to the web so the provider dropdown + its config form are generic.
export type EsignProviderMeta = { id: string; label: string; requiresAadhaar: boolean; supportsWebhook: boolean; configFields: EsignConfigField[] };

// The driver contract. A vendor is exactly this much surface - everything else in the system is provider-neutral.
// Register a driver in the registry and it becomes selectable + self-describing (label + configFields) with no
// other code or UI change.
export interface EsignProvider {
  id: string;
  label: string; // human name for the provider dropdown
  requiresAadhaar: boolean; // gate generation on an Aadhaar being on file
  supportsWebhook: boolean; // false -> the UI/cron must poll getStatus
  configFields: EsignConfigField[]; // operator-settable, non-secret config the UI renders
  // Env secrets this driver cannot run without. Empty/absent = works with none (the `internal` driver).
  requiredSecrets?: EsignRequiredSecret[];
  createRequest(i: CreateRequestInput): Promise<CreateRequestResult>;
  // Verify + normalize an inbound webhook. Returns null when the payload is unrecognized (still ack to the vendor).
  parseWebhook(i: WebhookInput): Promise<WebhookResult>;
  // Poll fallback for vendors without reliable webhooks.
  getStatus?(providerRef: string, cfg: EsignProviderCfg, secrets: EsignSecrets): Promise<StatusResult>;
}

// A recipient e-signature METHOD, chosen per e-signature block (letters) / per document (org-documents) - NOT
// a global setting. "internal" = the signer's on-file signature image, embedded in place; "cashfree" = an
// Aadhaar e-Sign via the vendor. (Physical "sign on paper / wet ink" is a different template block, not an
// e-signature method.) The id doubles as the driver id in the provider registry.
export type EsignMethod = "internal" | "cashfree";
export const DEFAULT_ESIGN_METHOD: EsignMethod = "internal";

// The `esign` setting. It is now purely: the master `enabled` switch + per-driver NON-secret vendor config
// (keyed by driver id - e.g. Cashfree's api_base/expiry). Secrets live in env. The signing METHOD is NOT here:
// it is chosen per e-signature block on a template (letters) or per document (org-documents). WHICH letters
// require signing is likewise driven by the e-signature block in the template, optionally overridden per
// generation.
export type EsignConfig = {
  enabled: boolean;
  providers: Record<string, Record<string, unknown>>;
};

export const DEFAULT_ESIGN: EsignConfig = {
  enabled: true,
  providers: {},
};

// Whether a given letter should be e-signed. The template's e-signature block is the switch; a per-generation
// override can force it on/off. Gated by the master enable.
export function esignFor(cfg: EsignConfig, templateHasEsignatureBlock: boolean, override?: boolean): boolean {
  if (!cfg.enabled) return false;
  return override ?? templateHasEsignatureBlock;
}
