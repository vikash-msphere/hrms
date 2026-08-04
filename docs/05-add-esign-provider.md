# Adding an e-sign provider

The e-signature layer is vendor-agnostic. Every provider — the legacy in-app image signing, an
Aadhaar-eSign vendor, or a new one — implements a single driver contract; the rest of the system
(settings UI, webhook edge, status polling, PDF plumbing, per-letter gating) is provider-neutral and
dispatches by driver `id`.

Adding a vendor is four edits: **a driver file, one registry line, env secrets, and enabling it in
Settings**. No UI, route, or webhook code changes.

## The contract

`src/domain/esign.ts` owns the pure contract and config shape — no I/O, no vendor specifics. A driver
is exactly `EsignProvider`:

```ts
export interface EsignProvider {
  id: string;                    // stable key; also the settings + secrets map key
  label: string;                 // human name for the Settings provider dropdown
  requiresAadhaar: boolean;      // true gates letter generation on an Aadhaar being on file
  supportsWebhook: boolean;      // false -> UI/cron must poll getStatus instead
  configFields: EsignConfigField[]; // operator-settable, NON-secret config the UI renders dynamically
  createRequest(i: CreateRequestInput): Promise<CreateRequestResult>;
  parseWebhook(i: WebhookInput): Promise<WebhookResult>;   // return null when unrecognized
  getStatus?(ref, cfg, secrets): Promise<StatusResult>;    // poll fallback; required if no webhook
}
```

Secrets are **never** part of `configFields` or the settings blob — they live in env and arrive
separately as `EsignSecrets` (`{ apiKey?, apiSecret?, webhookSecret? }`). `configFields` are the
non-secret, operator-facing inputs (base URL, expiry days, redirect URL...) that the Settings form
renders automatically from the driver.

Reference drivers: `src/services/esign/internal.ts` (no vendor call, in-app signing) and
`src/services/esign/cashfree.ts` (full Aadhaar-eSign vendor: multipart PDF upload → REST
create-request, HMAC-verified webhook, status poll). Copy `cashfree.ts` as the template for any REST
vendor.

## 1. Write the driver

Create `src/services/esign/<vendor>.ts` exporting an `EsignProvider`.

```ts
import type {
  EsignProvider, CreateRequestInput, WebhookInput, WebhookResult,
  EsignProviderCfg, EsignSecrets, EsignStatus, StatusResult,
} from "../../domain/esign";

// Map the vendor's status vocabulary onto ours. Unknown -> "sent" (in-flight) so a stray value
// never reads as "signed".
function mapStatus(s: unknown): EsignStatus {
  switch (String(s || "").toLowerCase()) {
    case "signed": case "completed": return "signed";
    case "viewed": case "opened":    return "viewed";
    case "declined": case "rejected":return "declined";
    case "expired":                  return "expired";
    case "failed": case "error":     return "failed";
    default:                         return "sent";
  }
}

export const myVendorProvider: EsignProvider = {
  id: "myvendor",
  label: "MyVendor (Aadhaar eSign)",
  requiresAadhaar: true,
  supportsWebhook: true,
  configFields: [
    { key: "api_base", label: "API base URL", type: "text", placeholder: "https://api.myvendor.com" },
    { key: "expiry_days", label: "Request expiry (days)", type: "number", hint: "How long the signing link stays valid." },
  ],

  async createRequest(i: CreateRequestInput) {
    // i.pdf, i.fileName          -> the document to sign
    // i.signers[].aadhaar        -> decrypted, TLS-only. NEVER log or persist it.
    // i.docId                    -> echo as the vendor's reference so the webhook can match the row
    // i.cfg                      -> your configFields values; i.secrets -> env secrets
    // Return { providerRef, signUrl?, status }. providerRef is stored on the document row and is
    // what parseWebhook / getStatus key on.
  },

  async parseWebhook(i: WebhookInput): Promise<WebhookResult> {
    // Verify the vendor's signature over i.rawBody FIRST (Web Crypto HMAC). Return null on any
    // failure or unrecognized payload — the edge still acks so the vendor stops retrying.
    // On success return { providerRef, status, signedPdf? }.
  },

  // Only if supportsWebhook is false, or to reconcile missed webhook deliveries.
  async getStatus(providerRef, cfg: EsignProviderCfg, secrets: EsignSecrets): Promise<StatusResult> {
    // Fetch current status; return { status, signedPdf? }.
  },
};
```

Rules that matter:

- **All I/O is the Workers global `fetch`.** No Node APIs, no SDK that assumes Node.
- **Verify webhook signatures before trusting the body.** The callback route is mounted outside
  `/v1` (no session auth) — trust comes solely from the driver's signature check. Use Web Crypto
  (`crypto.subtle`) for HMAC and a constant-time compare. See `hmacB64` / `timingSafeEqual` in
  `cashfree.ts` (Cashfree signs base64 HMAC-SHA256 over `timestamp + rawBody`, which also gives replay
  protection).
- **Aadhaar is PII.** It arrives on `i.signers[].aadhaar`, decrypted from identity details, passed
  over TLS only. Never log it, never write it to the document row.
- **`mapStatus` defaults to `"sent"`, not `"signed"`.** An unknown/garbage status must never look
  completed.
- **`signedPdf`** in a webhook/status result is stored to R2 and locks the row. Return it inline
  (base64) or fetch it from the vendor's signed-file URL.

## 2. Register the driver

Add one line to `src/services/esign/index.ts`:

```ts
import { myVendorProvider } from "./myvendor";

export const PROVIDERS: Record<string, EsignProvider> = {
  [internalProvider.id]: internalProvider,
  [cashfreeProvider.id]: cashfreeProvider,
  [myVendorProvider.id]: myVendorProvider,   // <- add
};
```

This alone makes it: selectable via the `esign` setting's `provider` field, listed by
`GET /v1/esign-providers` (which powers the Settings dropdown + dynamic config form from
`configFields`), and accepted by settings validation. No UI change.

## 3. Wire secrets from env

Secrets flow env → `Deps.esignSecrets[<id>]` → driver. Three edits, and the map key **must equal the
driver `id`**:

- `src/env.ts` — declare the vars:
  ```ts
  ESIGN_MYVENDOR_API_KEY?: string;
  ESIGN_MYVENDOR_API_SECRET?: string;
  ESIGN_MYVENDOR_WEBHOOK_SECRET?: string;
  ```
- `src/deps.ts` (`esignSecrets` block) — map them under the driver id:
  ```ts
  esignSecrets: {
    cashfree: { apiKey: env.ESIGN_CASHFREE_CLIENT_ID, apiSecret: env.ESIGN_CASHFREE_CLIENT_SECRET },
    myvendor: { apiKey: env.ESIGN_MYVENDOR_API_KEY, apiSecret: env.ESIGN_MYVENDOR_API_SECRET, webhookSecret: env.ESIGN_MYVENDOR_WEBHOOK_SECRET },
  },
  ```
- Provide the values at runtime — `wrangler secret put ESIGN_MYVENDOR_API_KEY` in prod, `.dev.vars`
  locally.

The env var **names** are not enforced; the `deps.ts` mapping is the only contract. If the
`esignSecrets` key does not match the driver `id`, the driver receives empty secrets and fails at
runtime with "API key not configured".

## 4. Enable it

In Settings, set the `esign` config:

```json
{
  "enabled": true,
  "providers": {
    "myvendor": { "api_base": "https://api.myvendor.com", "expiry_days": 7 }
  }
}
```

`enabled` is the master switch; `providers.<id>` holds each driver's non-secret `configFields` values.
The signing **method is not chosen here** — it is picked per e-signature block on a template (`/letters`)
and per document (`/documents`) as "In-app signature" (the `internal` driver) or the vendor (`myvendor` /
`cashfree`). This tab only enables signing and holds vendor config; `enabled: false` disables it entirely.

**Which letters get signed is not configured here.** It is driven per-template by the e-signature
placeholder block (add the block on `/letters` to require signing), optionally overridden per
generation. See `esignFor()` in `src/domain/esign.ts`.

## How the pieces connect at runtime

- **Generate** (`src/routes/letterGenerate.ts`): if `esignFor()` says the letter needs signing, it
  resolves the provider, calls `createRequest`, stores `providerRef` + `signUrl` on the
  `personal-documents` row, sets `esignStatus`.
- **Webhook** (`POST /esign/callback/:provider`, public, no `/v1`): `handleEsignCallback` →
  `driver.parseWebhook` → `applyEsignEvent` flips the row to `signed`, stores the signed PDF, locks
  the row. Idempotent — repeat deliveries and unknown refs are acked as no-ops.
- **Poll fallback** (`personal-documents:refreshEsign` → `refreshEsign`): for providers without
  webhooks, or to reconcile a missed delivery. Requires `getStatus`.

## Checklist

- [ ] `src/services/esign/<vendor>.ts` implements `EsignProvider` (fetch-only, webhook signature
      verified, Aadhaar never logged, `mapStatus` defaults to `sent`).
- [ ] Registered in `src/services/esign/index.ts` `PROVIDERS`.
- [ ] `src/env.ts` declares `ESIGN_<VENDOR>_*` vars.
- [ ] `src/deps.ts` maps them under a key equal to the driver `id`.
- [ ] Secrets provided (`wrangler secret put` / `.dev.vars`).
- [ ] Settings `esign.provider` + `esign.providers.<id>` set.
- [ ] Template carries the e-signature placeholder block for letters that must be signed.
- [ ] `getStatus` implemented if `supportsWebhook` is false.

---

# Enabling Cashfree (operator guide)

The Cashfree Aadhaar-eSign driver ships built and registered — no code changes. Enabling it is
configuration only: provide secrets, set the `esign` setting, register the webhook.

Cashfree's flow is three calls, all hidden inside the driver: upload the PDF (`POST /esignature/document`,
multipart) → create the request against the returned `document_id` (`POST /esignature`) → the signer
completes an Aadhaar-OTP journey, then a webhook (or the poll fallback) delivers the signed PDF URL.

## 1. Secrets (env)

Two secrets, from the Cashfree merchant dashboard (Secure ID / VRS credentials). Names are fixed
(`src/env.ts`):

- `ESIGN_CASHFREE_CLIENT_ID` — the `x-client-id` header value.
- `ESIGN_CASHFREE_CLIENT_SECRET` — the `x-client-secret` header value. **This same secret also signs
  the inbound webhook** (Cashfree has no separate webhook secret), so getting it right covers both the
  API calls and webhook verification.

Production:

```sh
wrangler secret put ESIGN_CASHFREE_CLIENT_ID
wrangler secret put ESIGN_CASHFREE_CLIENT_SECRET
```

Local dev — same keys in `.dev.vars` (gitignored):

```
ESIGN_CASHFREE_CLIENT_ID=...
ESIGN_CASHFREE_CLIENT_SECRET=...
```

## 2. The `esign` setting

Set via the Settings UI (the Aadhaar vendor's config form renders from the driver automatically) or by
PATCHing the `esign` setting. The seeded default (from `bootstrap/collections/settings.ts`, which
generates `bootstrap.sql`) is `DEFAULT_ESIGN` — `enabled: true` with no vendor config. Add Cashfree's
config here (in that file, or via the UI) **after** the secrets and webhook are in place; then choose
"Aadhaar e-Sign" as the method on the templates/documents that should use it. The JSON shape:

```json
{
  "enabled": true,
  "providers": {
    "cashfree": {
      "api_base": "https://api.cashfree.com/verification",
      "expiry_days": 7,
      "redirect_url": "https://your-app.example.com/letters"
    }
  }
}
```

The method itself is **not** set here — it is per e-signature block on a template (`/letters`) and per
document (`/documents`): "In-app signature" or "Aadhaar e-Sign".

Cashfree's `configFields` (non-secret):

| key            | required | meaning                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| `api_base`     | no       | REST base; defaults to `https://api.cashfree.com/verification`. Sandbox: `https://sandbox.cashfree.com/verification`. |
| `expiry_days`  | no       | Signing-link validity in days (Cashfree max 15); defaults to 7.                |
| `redirect_url` | no       | Where the signer lands after signing.                                          |

The signature box Cashfree requires (`sign_positions`) is **not** configured here: it is derived per document
from where the template's e-signature block actually renders (the letter renderer reports the page + rect as
`signAnchors`, which the driver translates to Cashfree's corner coordinates). A one-page offer and a
three-page contract therefore each get a correctly-placed box automatically — move the `esignature` block in
the template on `/letters` to move the signature.

## 3. Register the webhook

In the Cashfree dashboard, register the e-sign webhook at:

```
POST https://<your-worker-host>/esign/callback/cashfree
```

This route is public (mounted outside `/v1`, no session auth) — trust comes solely from the HMAC
signature check in the driver. Cashfree signs each delivery as
`base64(HMAC-SHA256(client_secret, x-webhook-timestamp + rawBody))` in the `x-webhook-signature`
header; the driver verifies it with `ESIGN_CASHFREE_CLIENT_SECRET` (the timestamp also gives replay
protection). The handler is idempotent, and unknown references are acked so Cashfree stops retrying.

## 4. Require signing per letter

Enabling the provider does not sign anything on its own. A letter is e-signed only when its template
carries the **e-signature placeholder block** — add it on `/letters` to the templates that need
signing (offer letters, contracts...). A per-generation override can force it on/off. Cashfree has
`requiresAadhaar: false` — the signer authenticates with Aadhaar via OTP inside Cashfree's journey, so
no Aadhaar needs to be on file; if one is present, only its last four digits are passed as a hint.

## Verifying and troubleshooting

- `GET /v1/esign-providers` should list `cashfree` with its config fields — confirms registration.
- Generate a letter from an esign-enabled template → the `personal-documents` row gets an
  `esignRequestId` (Cashfree's `reference_id`) + `signUrl` (the `signing_link`), `esignStatus: "sent"`.
- After the signer completes, the webhook flips the row to `signed`, downloads the signed PDF from
  `signed_doc_url`, and locks the row.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cashfree client id/secret not configured` | `ESIGN_CASHFREE_CLIENT_ID`/`_SECRET` missing/unbound | `wrangler secret put ESIGN_CASHFREE_CLIENT_ID` + `_CLIENT_SECRET` (or `.dev.vars`). |
| `Cashfree document upload failed (4xx)` | bad credentials, or sandbox creds against prod `api_base` (or vice-versa) | Check the `api_base` matches the credentials' environment. |
| Document stuck at `sent`, never `signed` | webhook signature mismatch (wrong client secret), or webhook not reaching the worker | Confirm `ESIGN_CASHFREE_CLIENT_SECRET` matches the dashboard; verify the callback URL. Reconcile meanwhile via the poll fallback (`personal-documents:refreshEsign`). |
| Signature stamped in the wrong place | the template's `esignature` block isn't where the signature should go | Move the `esignature` block in the template on `/letters`; the sign box follows it (it is derived from the rendered position, not configured). |
