import { describe, it, expect } from "vitest";
import { esignFor, DEFAULT_ESIGN, type EsignConfig } from "../src/domain/esign";
import { getProvider, providerIds, providerMeta } from "../src/services/esign";
import { internalProvider } from "../src/services/esign/internal";
import { cashfreeProvider } from "../src/services/esign/cashfree";

const cfg = (o: Partial<EsignConfig>): EsignConfig => ({ ...DEFAULT_ESIGN, ...o });

// Cashfree webhook signature: base64(HMAC-SHA256(clientSecret, timestamp + rawBody)).
async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  let s = "";
  for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]!);
  return btoa(s);
}

describe("esignFor decision (pure)", () => {
  it("the template's e-signature block is the switch (default config)", () => {
    expect(esignFor(DEFAULT_ESIGN, true)).toBe(true);
    expect(esignFor(DEFAULT_ESIGN, false)).toBe(false);
  });
  it("is off when disabled, regardless of block", () => {
    expect(esignFor(cfg({ enabled: false }), true)).toBe(false);
  });
  it("a per-generation override beats the block default", () => {
    expect(esignFor(DEFAULT_ESIGN, false, true)).toBe(true);
    expect(esignFor(DEFAULT_ESIGN, true, false)).toBe(false);
  });
});

describe("provider registry", () => {
  it("registers internal + cashfree; getProvider resolves them", () => {
    expect(providerIds().sort()).toEqual(["cashfree", "internal"]);
    // Cashfree does its Aadhaar auth via OTP in the signing journey, so no Aadhaar is required on file.
    expect(getProvider("cashfree")?.requiresAadhaar).toBe(false);
    expect(getProvider("internal")?.requiresAadhaar).toBe(false);
    expect(getProvider("nope")).toBeUndefined();
  });
  it("providerMeta exposes non-secret descriptors for the generic UI", () => {
    const meta = providerMeta();
    const cashfree = meta.find((m) => m.id === "cashfree")!;
    expect(cashfree.label).toContain("Cashfree");
    expect(cashfree.configFields.map((f) => f.key)).toContain("api_base");
    expect(meta.find((m) => m.id === "internal")!.configFields).toEqual([]);
    // never leaks secrets
    expect(JSON.stringify(meta)).not.toMatch(/apiKey|webhookSecret|secret/i);
  });
});

describe("internal provider", () => {
  it("createRequest marks sent with no signUrl; no webhook", async () => {
    const r = await internalProvider.createRequest({ pdf: new Uint8Array(), fileName: "x", signers: [], docId: "d", cfg: {}, secrets: {} });
    expect(r).toMatchObject({ status: "sent", signUrl: undefined });
    expect(await internalProvider.parseWebhook({ headers: {}, rawBody: "{}", secrets: {} })).toBeNull();
  });
});

describe("cashfree webhook verification (no network)", () => {
  const secret = "cfsecret_test"; // Cashfree signs webhooks with the client secret (apiSecret)
  const ts = String(Date.now()); // within the replay window
  const hdr = (sig: string) => ({ "x-webhook-signature": sig, "x-webhook-timestamp": ts });

  it("rejects when the signature header, timestamp, or secret is missing/wrong", async () => {
    const body = JSON.stringify({ event_type: "ESIGN_VERIFICATION_SUCCESS", data: { reference_id: 32, status: "SUCCESS" } });
    expect(await cashfreeProvider.parseWebhook({ headers: {}, rawBody: body, secrets: { apiSecret: secret } })).toBeNull();
    expect(await cashfreeProvider.parseWebhook({ headers: hdr("bad=="), rawBody: body, secrets: { apiSecret: secret } })).toBeNull();
    // correct signature but no secret configured -> still rejected
    const sig = await hmacB64(secret, ts + body);
    expect(await cashfreeProvider.parseWebhook({ headers: hdr(sig), rawBody: body, secrets: {} })).toBeNull();
  });
  it("accepts a correctly-signed SUCCESS payload and normalizes to signed (no url -> no fetch)", async () => {
    const body = JSON.stringify({ event_type: "ESIGN_VERIFICATION_SUCCESS", data: { reference_id: 42, status: "SUCCESS" } });
    const sig = await hmacB64(secret, ts + body);
    const r = await cashfreeProvider.parseWebhook({ headers: hdr(sig), rawBody: body, secrets: { apiSecret: secret } });
    expect(r).toMatchObject({ providerRef: "42", status: "signed" });
    expect(r?.signedPdf).toBeUndefined(); // no signed_doc_url in the payload -> nothing downloaded
  });
  it("maps a non-terminal status without fetching a file", async () => {
    const body = JSON.stringify({ data: { reference_id: 9, status: "IN_PROGRESS" } });
    const sig = await hmacB64(secret, ts + body);
    const r = await cashfreeProvider.parseWebhook({ headers: hdr(sig), rawBody: body, secrets: { apiSecret: secret } });
    expect(r).toMatchObject({ providerRef: "9", status: "sent" });
    expect(r?.signedPdf).toBeUndefined();
  });

  it("rejects a correctly-signed but STALE payload (replay protection)", async () => {
    const body = JSON.stringify({ data: { reference_id: 7, status: "SUCCESS" } });
    const staleTs = String(Date.now() - 10 * 60 * 1000); // 10 min ago, outside the 5-min window
    const sig = await hmacB64(secret, staleTs + body);
    const r = await cashfreeProvider.parseWebhook({ headers: { "x-webhook-signature": sig, "x-webhook-timestamp": staleTs }, rawBody: body, secrets: { apiSecret: secret } });
    expect(r).toBeNull();
  });

  it("drops a correctly-signed delivery past the max retry count (stale redelivery)", async () => {
    const body = JSON.stringify({ data: { reference_id: 8, status: "SUCCESS" } });
    const sig = await hmacB64(secret, ts + body);
    const r = await cashfreeProvider.parseWebhook({ headers: { ...hdr(sig), "x-webhook-attempt": "6" }, rawBody: body, secrets: { apiSecret: secret } });
    expect(r).toBeNull();
    // the same payload within the retry budget is accepted
    const ok = await cashfreeProvider.parseWebhook({ headers: { ...hdr(sig), "x-webhook-attempt": "3" }, rawBody: body, secrets: { apiSecret: secret } });
    expect(ok).toMatchObject({ providerRef: "8", status: "signed" });
  });
});

describe("cashfree createRequest input guards (fail before any network call)", () => {
  const secrets = { apiKey: "cf_id", apiSecret: "cf_secret" };
  const pdfHeader = Uint8Array.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

  it("rejects a document over Cashfree's 10 MB cap", async () => {
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
    tooBig.set(pdfHeader, 0);
    await expect(cashfreeProvider.createRequest({ pdf: tooBig, fileName: "x.pdf", signers: [], docId: "d", cfg: {}, secrets })).rejects.toThrow(/10 MB/);
  });
  it("rejects a non-PDF (missing %PDF header)", async () => {
    const notPdf = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]); // a ZIP magic, not a PDF
    await expect(cashfreeProvider.createRequest({ pdf: notPdf, fileName: "x.pdf", signers: [], docId: "d", cfg: {}, secrets })).rejects.toThrow(/not a valid PDF/);
  });
  it("still requires configured secrets", async () => {
    await expect(cashfreeProvider.createRequest({ pdf: pdfHeader, fileName: "x.pdf", signers: [], docId: "d", cfg: {}, secrets: {} })).rejects.toThrow(/not configured/);
  });
});
