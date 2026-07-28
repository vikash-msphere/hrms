// Cashfree Aadhaar eSign driver. THE ONLY place that knows Cashfree's wire shape - everything else is
// provider-neutral (see src/domain/esign.ts). Cashfree's flow is three calls, all hidden inside createRequest
// + getStatus: (1) upload the PDF (multipart), (2) create the e-sign request against the returned document_id,
// (3) webhook or poll for completion, then download the signed PDF from `signed_doc_url`. Auth is the
// x-client-id / x-client-secret header pair; the webhook is HMAC-SHA256 (base64) over `timestamp + rawBody`
// keyed by the CLIENT SECRET (Cashfree has no separate webhook secret). All I/O is the Workers global fetch.
import type { EsignProvider, CreateRequestInput, WebhookInput, WebhookResult, EsignProviderCfg, EsignSecrets, EsignStatus, StatusResult } from "../../domain/esign";
import { assertPublicHttpsUrl } from "../../lib/urlGuard";

const VENDOR_TIMEOUT_MS = 15_000;
const MAX_SIGNED_PDF_BYTES = 25 * 1024 * 1024; // mirrors the upload cap (documentsCommon.ts)
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Cashfree's hard document cap; fail here with a readable error rather than an opaque vendor 400.
const WEBHOOK_SKEW_MS = 5 * 60 * 1000; // reject webhooks whose timestamp is > 5 min from now (replay protection)
const MAX_WEBHOOK_ATTEMPT = 5; // drop stale redeliveries: a late webhook past this retry count is reconciled by the poll fallback instead
const DEFAULT_BASE = "https://api.cashfree.com/verification"; // sandbox: https://sandbox.cashfree.com/verification

// Map Cashfree's status vocabulary onto ours. Unknown / in-flight -> "sent" so a stray value never looks signed.
function mapStatus(s: unknown): EsignStatus {
  switch (String(s || "").toUpperCase()) {
    case "SUCCESS": case "SIGNED": return "signed";
    case "EXPIRED": return "expired";
    case "FAILURE": case "FAILED": case "ERROR": return "failed";
    default: return "sent"; // IN_PROGRESS / SIGN_INITIATED / SIGN_IN_PROGRESS / RECEIVED / anything else
  }
}

const apiBase = (cfg: EsignProviderCfg): string => String(cfg.api_base || DEFAULT_BASE).replace(/\/+$/, "");
const num = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) ? Number(v) : dflt);

// Append Cashfree's error body to a failure message so the real reason is visible (e.g. 422 ->
// insufficient_balance) instead of a bare status code. The body is Cashfree's own error JSON - no secrets;
// truncated defensively.
async function failDetail(res: Response): Promise<string> {
  let body = "";
  try { body = (await res.text()).trim().slice(0, 300); } catch { /* ignore */ }
  return body ? `(${res.status}): ${body}` : `(${res.status})`;
}

// Production X-Cf-Signature (public-key 2FA). Cashfree's scheme is NOT a private-key signature: it is
// RSA-OAEP(SHA-1) *encryption* of "clientId.<unix-seconds>" with the Cashfree-provided PUBLIC key, base64'd
// (mirrors their PHP openssl_public_encrypt + OPENSSL_PKCS1_OAEP_PADDING, whose default MGF1/label hash is
// SHA-1). Cashfree decrypts with its private key and checks the clientId + timestamp freshness (±5 min, so the
// host must be NTP-synced). OAEP is randomized, so the value differs every call - never cache it, only the key.
let cachedKey: { pem: string; key: CryptoKey } | null = null;
async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  if (cachedKey?.pem === publicKey) return cachedKey.key;
  const b64 = publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""); // tolerate PEM armor or bare base64
  const der = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("spki", der.buffer as ArrayBuffer, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["encrypt"]);
  cachedKey = { pem: publicKey, key };
  return key;
}
async function cfSignature(clientId: string, publicKey: string): Promise<string> {
  const key = await importPublicKey(publicKey);
  const data = new TextEncoder().encode(`${clientId}.${Math.floor(Date.now() / 1000)}`);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, data));
  let bin = ""; for (let i = 0; i < enc.length; i++) bin += String.fromCharCode(enc[i]!);
  return btoa(bin);
}

// Auth headers for every vendor call: the client-id/secret pair, plus the X-Cf-Signature 2FA header when a
// public key is configured (production). No public key -> header omitted (sandbox / secret-only accounts).
async function authHeaders(secrets: EsignSecrets): Promise<Record<string, string>> {
  const h: Record<string, string> = { "x-client-id": secrets.apiKey ?? "", "x-client-secret": secrets.apiSecret ?? "" };
  if (secrets.publicKey && secrets.apiKey) h["x-cf-signature"] = await cfSignature(secrets.apiKey, secrets.publicKey);
  return h;
}

async function vendorFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS) });
  } catch {
    throw new Error(`esign: Cashfree ${what} did not respond in time`);
  }
}

// base64(HMAC-SHA256(clientSecret, timestamp + rawBody)) - Cashfree's webhook signature scheme.
async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  let s = "";
  for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]!);
  return btoa(s);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Cashfree returns the signed document as a URL. Run it through the SSRF guard (defense in depth - the
// payload is HMAC-verified, but a compromised/misbehaving vendor URL must not become an internal fetch) and
// cap the size so an oversized/chunked response can't OOM the isolate.
async function downloadSigned(url: string, secrets: EsignSecrets): Promise<Uint8Array | undefined> {
  try { assertPublicHttpsUrl(url); } catch { return undefined; }
  const res = await vendorFetch(url, { headers: await authHeaders(secrets) }, "signed-doc download");
  if (!res.ok) return undefined;
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > MAX_SIGNED_PDF_BYTES) return undefined;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_SIGNED_PDF_BYTES) return undefined;
  return buf;
}

type CfSignPosition = { page: number; top_left_x_coordinate: number; bottom_right_x_coordinate: number; top_left_y_coordinate: number; bottom_right_y_coordinate: number };

// Cashfree requires a signature box per signer (corner coords, PDF points, bottom-left origin). We do NOT
// guess a static box - it can't be right for documents of different lengths. Instead the letter renderer
// reports where each e-signature placeholder actually landed (i.signAnchors), and we translate those to
// Cashfree's field names. The static fallback below is defensive only (an e-sign letter always carries an
// e-signature block, so anchors are normally present); it puts a box near the bottom-left of page 1.
const FALLBACK_POSITION: CfSignPosition = { page: 1, top_left_x_coordinate: 72, bottom_right_x_coordinate: 272, top_left_y_coordinate: 140, bottom_right_y_coordinate: 80 };
function signPositions(i: CreateRequestInput): CfSignPosition[] {
  const fromAnchors = (i.signAnchors ?? []).map((a) => ({
    page: Math.round(a.page),
    top_left_x_coordinate: Math.round(a.x1),
    bottom_right_x_coordinate: Math.round(a.x2),
    top_left_y_coordinate: Math.round(a.y1),
    bottom_right_y_coordinate: Math.round(a.y2),
  }));
  return fromAnchors.length ? fromAnchors : [FALLBACK_POSITION];
}

export const cashfreeProvider: EsignProvider = {
  id: "cashfree",
  label: "Cashfree (Aadhaar eSign)",
  // The signer authenticates with Aadhaar via OTP inside Cashfree's signing journey, so no Aadhaar needs to be
  // on file to START the request (only an optional last-4 hint is passed). Hence this is false, unlike a driver
  // that must submit a full Aadhaar up front.
  requiresAadhaar: false,
  supportsWebhook: true,
  configFields: [
    { key: "api_base", label: "API base URL", type: "text", placeholder: DEFAULT_BASE, hint: "Sandbox: https://sandbox.cashfree.com/verification" },
    { key: "expiry_days", label: "Request expiry (days)", type: "number", hint: "How long the signing link stays valid (max 15)." },
    { key: "redirect_url", label: "Redirect URL after signing", type: "text", hint: "Where the signer lands once done (optional)." },
  ],

  async createRequest(i: CreateRequestInput) {
    const base = apiBase(i.cfg);
    if (!i.secrets.apiKey || !i.secrets.apiSecret) throw new Error("esign: Cashfree client id/secret not configured (env ESIGN_CASHFREE_CLIENT_ID / ESIGN_CASHFREE_CLIENT_SECRET)");

    // Fail fast on documents Cashfree will reject: it accepts only a PDF (magic bytes "%PDF") at most 10 MB.
    // Catching it here turns an opaque vendor 400 into a readable error before any network call.
    if (i.pdf.byteLength > MAX_UPLOAD_BYTES) throw new Error(`esign: document is ${(i.pdf.byteLength / 1024 / 1024).toFixed(1)} MB; Cashfree's limit is 10 MB`);
    if (!(i.pdf[0] === 0x25 && i.pdf[1] === 0x50 && i.pdf[2] === 0x44 && i.pdf[3] === 0x46)) throw new Error("esign: document is not a valid PDF (missing %PDF header)");

    // 1) Upload the PDF as multipart/form-data (field name "document"). Let fetch set the boundary header.
    const form = new FormData();
    form.append("document", new Blob([i.pdf as BlobPart], { type: "application/pdf" }), i.fileName);
    const up = await vendorFetch(`${base}/esignature/document`, { method: "POST", headers: await authHeaders(i.secrets), body: form }, "upload");
    if (!up.ok) throw new Error(`esign: Cashfree document upload failed ${await failDetail(up)}`);
    const uj = (await up.json()) as { document_id?: number };
    if (uj.document_id == null) throw new Error("esign: Cashfree did not return a document_id");

    // 2) Create the e-sign request. verification_id = our docId (<=50 chars, alphanumeric/./-/_ - the
    // personal-document uuid qualifies) so the webhook can be correlated back to the row. sign_positions come
    // from where the renderer actually drew the e-signature block on THIS document, not a static guess.
    const positions = signPositions(i);
    const body = {
      verification_id: i.docId,
      document_id: uj.document_id,
      notification_modes: ["email"],
      auth_type: "AADHAAR",
      expiry_in_days: String(Math.min(15, Math.max(1, num(i.cfg.expiry_days, 7)))),
      capture_location: false,
      redirect_url: i.cfg.redirect_url || undefined,
      signers: i.signers.map((s, idx) => ({
        name: s.name,
        email: s.email,
        phone: s.phone,
        sequence: idx + 1,
        aadhaar_last_four_digit: s.aadhaar ? s.aadhaar.replace(/\D/g, "").slice(-4) || undefined : undefined,
        sign_positions: positions,
      })),
    };
    const res = await vendorFetch(`${base}/esignature`, {
      method: "POST",
      headers: { ...(await authHeaders(i.secrets)), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "createRequest");
    if (!res.ok) throw new Error(`esign: Cashfree createRequest failed ${await failDetail(res)}`);
    const j = (await res.json()) as { reference_id?: number; signing_link?: string; status?: string };
    if (j.reference_id == null) throw new Error("esign: Cashfree did not return a reference_id");
    return { providerRef: String(j.reference_id), signUrl: j.signing_link, status: mapStatus(j.status) };
  },

  async parseWebhook(i: WebhookInput): Promise<WebhookResult> {
    // Verify base64 HMAC-SHA256 over (timestamp + rawBody) before trusting anything. Cashfree signs with the
    // client secret (apiSecret); webhookSecret is accepted as an override if an operator configures one.
    const provided = i.headers["x-webhook-signature"] || "";
    const ts = i.headers["x-webhook-timestamp"] || "";
    const secret = i.secrets.apiSecret || i.secrets.webhookSecret;
    if (!secret || !provided || !ts) return null;
    const expected = await hmacB64(secret, ts + i.rawBody);
    if (!timingSafeEqual(provided, expected)) return null;
    // Replay protection: reject a payload whose signed timestamp is > 5 min from now. The timestamp is epoch
    // seconds (some deliveries use ms); normalize before comparing. A missing/unparseable ts already failed above.
    const tsNum = Number(ts);
    if (Number.isFinite(tsNum)) {
      const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1000;
      if (Math.abs(Date.now() - tsMs) > WEBHOOK_SKEW_MS) return null;
    }
    // Drop stale redeliveries: a webhook past the max retry count is left to the poll fallback (refreshEsign / cron).
    const attempt = Number(i.headers["x-webhook-attempt"] || "0");
    if (Number.isFinite(attempt) && attempt > MAX_WEBHOOK_ATTEMPT) return null;
    let j: { data?: { status?: string; reference_id?: number; signed_doc_url?: string } };
    try { j = JSON.parse(i.rawBody); } catch { return null; }
    const data = j.data ?? {};
    const providerRef = data.reference_id != null ? String(data.reference_id) : "";
    if (!providerRef) return null;
    const status = mapStatus(data.status);
    let signedPdf: Uint8Array | undefined;
    if (status === "signed" && data.signed_doc_url) signedPdf = await downloadSigned(data.signed_doc_url, i.secrets);
    return { providerRef, status, signedPdf };
  },

  async getStatus(providerRef: string, cfg: EsignProviderCfg, secrets: EsignSecrets): Promise<StatusResult> {
    const base = apiBase(cfg);
    const res = await vendorFetch(`${base}/esignature?reference_id=${encodeURIComponent(providerRef)}`, { headers: await authHeaders(secrets) }, "getStatus");
    if (!res.ok) throw new Error(`esign: Cashfree getStatus failed ${await failDetail(res)}`);
    const j = (await res.json()) as { status?: string; signed_doc_url?: string };
    const status = mapStatus(j.status);
    let signedPdf: Uint8Array | undefined;
    if (status === "signed" && j.signed_doc_url) signedPdf = await downloadSigned(j.signed_doc_url, secrets);
    return { status, signedPdf };
  },
};
