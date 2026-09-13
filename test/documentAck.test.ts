/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { makeDocumentService } from "../src/services/documentService";
import { handleEsignCallback, reconcilePendingEsign } from "../src/services/esign/callback";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CF_SECRET = "cf_test_secret"; // Cashfree client secret = webhook HMAC key
// 1x1 transparent PNG - a real image pdf-lib can embed.
const PNG_1x1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));

let deps: Deps;
const b = env as unknown as Bindings;
const orgSvc = makeDocumentService({ table: schema.orgDocuments, collection: "org-documents", singular: "org document", owned: false, acknowledgeable: true });
const ANCHOR = { page: 1, x1: 40, y1: 90, x2: 220, y2: 40 };

// base64(HMAC-SHA256(secret, timestamp + rawBody)) - Cashfree's webhook scheme.
async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  let s = ""; for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]!);
  return btoa(s);
}
async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([240, 240]);
  return await doc.save();
}

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  (b as Record<string, unknown>).ESIGN_CASHFREE_CLIENT_ID = "cf_id";
  (b as Record<string, unknown>).ESIGN_CASHFREE_CLIENT_SECRET = CF_SECRET;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const CLEAR = [schema.documentAcknowledgements, schema.personalDocuments, schema.orgDocuments, schema.employees];
beforeEach(async () => { for (const t of CLEAR) await deps.db.delete(t); });
afterEach(() => vi.unstubAllGlobals());

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", legalName: "Test User", workEmail: `${uuid}@t.example`, status: "active", ...over });
  return uuid;
}
async function seedOrgDoc(method: "internal" | "cashfree", pdf: Uint8Array): Promise<string> {
  const uuid = genId();
  const r2Key = `org-documents/${uuid}`;
  await deps.docs.put(r2Key, pdf, "application/pdf");
  await deps.db.insert(schema.orgDocuments).values({
    uuid, code: `od-${genId().slice(0, 4)}`, title: "Policy", documentType: "POLICY", visibility: "org",
    r2Key, fileName: "policy.pdf", contentType: "application/pdf", sizeBytes: pdf.byteLength,
    requiresAck: true, ackVersion: 1, ackMethod: method, signAnchorJson: JSON.stringify(ANCHOR), published: true,
  } as any);
  return uuid;
}
const actorFor = (employeeId: string): AppUser => ({ uuid: genId(), email: `${employeeId}@t.example`, role: "employee", status: "active", employeeId } as unknown as AppUser);

describe("internal acknowledgement stamps the signature and completes synchronously", () => {
  it("files a signed copy with the signature stamped in place and records the ack", async () => {
    const emp = await seedEmployee({ signatureKey: `sigs/${genId()}` });
    await deps.docs.put((await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp)).limit(1))[0]!.signatureKey!, PNG_1x1, "image/png");
    const docId = await seedOrgDoc("internal", await makePdf());

    await orgSvc.acknowledge(deps, actorFor(emp), docId);

    const ack = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.documentId, docId)))[0]!;
    expect(ack).toBeTruthy();
    expect(ack.acknowledgedTime).toBeTruthy();      // completed immediately
    expect(ack.signedDocId).toBeTruthy();
    const copy = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, ack.signedDocId!)))[0]!;
    expect(copy.sourceDocId).toBe(docId);
    expect(copy.signedTime).toBeTruthy();
    expect(copy.fileName).toMatch(/\.pdf$/); // generated copies still download with an extension
    const bytes = await deps.docs.get(copy.r2Key);
    expect(bytes).toBeTruthy();
    expect(new TextDecoder().decode(new Uint8Array(bytes!).slice(0, 5))).toBe("%PDF-"); // a real stamped PDF
  });
});

describe("acknowledging twice files ONE signed copy", () => {
  // The idempotency used to be a read with nothing claiming it, so the same person in two tabs (or the
  // Aadhaar path re-entering its own pending ack) filed two stamped copies of the same policy - each
  // `locked: true`, so neither could be tidied away - and on the vendor lane bought a second Aadhaar
  // transaction. `dack_once_idx` is what makes the second caller lose; the service claims the ack before it
  // stamps anything.
  it("two concurrent acknowledgements leave one ack row and one copy", async () => {
    const emp = await seedEmployee({ signatureKey: `sigs/${genId()}` });
    await deps.docs.put((await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp)).limit(1))[0]!.signatureKey!, PNG_1x1, "image/png");
    const docId = await seedOrgDoc("internal", await makePdf());
    const actor = actorFor(emp);

    await Promise.allSettled([orgSvc.acknowledge(deps, actor, docId), orgSvc.acknowledge(deps, actor, docId)]);

    const acks = await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.documentId, docId));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.acknowledgedTime).toBeTruthy();
    const copies = await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.sourceDocId, docId));
    expect(copies).toHaveLength(1);
  });

  it("acknowledging again after it completed is a no-op that reports the version", async () => {
    const emp = await seedEmployee({ signatureKey: `sigs/${genId()}` });
    await deps.docs.put((await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp)).limit(1))[0]!.signatureKey!, PNG_1x1, "image/png");
    const docId = await seedOrgDoc("internal", await makePdf());
    const actor = actorFor(emp);

    await orgSvc.acknowledge(deps, actor, docId);
    const again = await orgSvc.acknowledge(deps, actor, docId);

    expect((again as { ackedVersion: number }).ackedVersion).toBe(1);
    expect(await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.documentId, docId))).toHaveLength(1);
    expect(await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.sourceDocId, docId))).toHaveLength(1);
  });
});

describe("cashfree acknowledgement completes on the signed webhook", () => {
  it("a signed Cashfree webhook for the copy flips the linked ack to acknowledged and signs the copy", async () => {
    const emp = await seedEmployee();
    const docId = await seedOrgDoc("cashfree", await makePdf());
    // Simulate the state right after :acknowledge fired the vendor request: a pending ack + a copy linked to it
    // carrying the vendor reference id, awaiting the signed webhook.
    const providerRef = "555";
    const ack = (await deps.db.insert(schema.documentAcknowledgements).values({
      code: `da-${genId().slice(0, 4)}`, employeeId: emp, documentId: docId, version: 1, signature: "Test User",
    }).returning())[0]!;
    const copyId = genId();
    await deps.db.insert(schema.personalDocuments).values({
      uuid: copyId, code: `pd-${genId().slice(0, 4)}`, employeeId: emp, documentType: "POLICY", title: "Policy - signed (v1)",
      r2Key: `personal-documents/${copyId}`, contentType: "application/pdf", sourceDocId: docId, ackId: ack.uuid,
      requiresSignature: true, esignProvider: "cashfree", esignRequestId: providerRef, esignStatus: "sent", published: true,
    });
    await deps.db.update(schema.documentAcknowledgements).set({ signedDocId: copyId }).where(eq(schema.documentAcknowledgements.uuid, ack.uuid));

    // The signed PDF is fetched from signed_doc_url; stub that network call.
    const signedPdf = await makePdf();
    vi.stubGlobal("fetch", async () => new Response(signedPdf as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(signedPdf.byteLength) } }));

    const rawBody = JSON.stringify({ event_type: "ESIGN_VERIFICATION_SUCCESS", data: { reference_id: Number(providerRef), status: "SUCCESS", signed_doc_url: "https://vendor.example.com/signed.pdf" } });
    const ts = String(Date.now()); // within the webhook replay window
    const sig = await hmacB64(CF_SECRET, ts + rawBody);
    const res = await handleEsignCallback(deps, "cashfree", { "x-webhook-signature": sig, "x-webhook-timestamp": ts }, rawBody);
    expect(res.ok).toBe(true);

    const copy = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, copyId)))[0]!;
    expect(copy.signedTime).toBeTruthy();                 // copy stamped signed
    const done = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ack.uuid)))[0]!;
    expect(done.acknowledgedTime).toBeTruthy();           // linked ack finalized by the completion hook
  });
});

describe("cashfree acknowledge (real service path) creates a pending ack + copy", () => {
  it("fires the vendor request and links ack <-> copy across the circular FK", async () => {
    const emp = await seedEmployee();
    const docId = await seedOrgDoc("cashfree", await makePdf());
    // Stub Cashfree's two calls: upload -> document_id, then create -> reference_id + signing_link.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/esignature/document")) return new Response(JSON.stringify({ document_id: 123 }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/esignature")) return new Response(JSON.stringify({ reference_id: 999, signing_link: "https://vendor.example/sign/abc", status: "IN_PROGRESS" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    });

    // Real service path (regression: this used to 500 on a FOREIGN KEY violation - the ack was inserted with
    // signedDocId pointing at a copy row that did not exist yet).
    const res = await orgSvc.acknowledge(deps, actorFor(emp), docId) as { esignUri?: string };
    expect(res.esignUri).toBe("https://vendor.example/sign/abc");

    const ack = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.documentId, docId)))[0]!;
    expect(ack).toBeTruthy();
    expect(ack.acknowledgedTime).toBeNull();     // pending until the signed webhook
    expect(ack.signedDocId).toBeTruthy();        // backfilled after the copy row exists
    const copy = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, ack.signedDocId!)))[0]!;
    expect(copy.esignProvider).toBe("cashfree");
    expect(copy.esignRequestId).toBe("999");
    expect(copy.ackId).toBe(ack.uuid);           // copy -> ack (the other half of the circular FK)
    expect(copy.signedTime).toBeNull();
  });
});

describe("reconcilePendingEsign (poll fallback for a missed webhook)", () => {
  // Seed a pending external-vendor personal-document + its linked pending ack, as after :acknowledge fired.
  async function seedPending(over: Partial<typeof schema.personalDocuments.$inferInsert> = {}): Promise<{ emp: string; copyId: string; ackId: string; ref: string }> {
    const emp = await seedEmployee();
    const docId = await seedOrgDoc("cashfree", await makePdf());
    const ref = String(Math.floor(Math.random() * 1e6));
    const ack = (await deps.db.insert(schema.documentAcknowledgements).values({
      code: `da-${genId().slice(0, 4)}`, employeeId: emp, documentId: docId, version: 1, signature: "Test User",
    }).returning())[0]!;
    const copyId = genId();
    await deps.db.insert(schema.personalDocuments).values({
      uuid: copyId, code: `pd-${genId().slice(0, 4)}`, employeeId: emp, documentType: "POLICY", title: "Policy - signed (v1)",
      r2Key: `personal-documents/${copyId}`, contentType: "application/pdf", sourceDocId: docId, ackId: ack.uuid,
      requiresSignature: true, esignProvider: "cashfree", esignRequestId: ref, esignStatus: "sent", published: true,
      esignSentAt: new Date(), ...over,
    });
    await deps.db.update(schema.documentAcknowledgements).set({ signedDocId: copyId }).where(eq(schema.documentAcknowledgements.uuid, ack.uuid));
    return { emp, copyId, ackId: ack.uuid, ref };
  }

  it("polls the vendor, signs the copy, and finalizes the ack when the vendor reports SUCCESS", async () => {
    const { copyId, ackId, ref } = await seedPending();
    const signedPdf = await makePdf();
    // getStatus fetches JSON status first, then downloadSigned fetches the PDF. Route by URL.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`reference_id=${ref}`)) return new Response(JSON.stringify({ status: "SUCCESS", signed_doc_url: "https://vendor.example.com/signed.pdf" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(signedPdf as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(signedPdf.byteLength) } });
    });

    const advanced = await reconcilePendingEsign(deps);
    expect(advanced).toBeGreaterThanOrEqual(1);
    const copy = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, copyId)))[0]!;
    expect(copy.signedTime).toBeTruthy();
    expect(copy.locked).toBe(true);
    const ack = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ackId)))[0]!;
    expect(ack.acknowledgedTime).toBeTruthy();

    // A second sweep is a no-op (already signed): status advances for nobody.
    const again = await reconcilePendingEsign(deps);
    expect(again).toBe(0);
  });

  it("auto-expires a pending document past its signing window without locking it, and never polls", async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // default expiry is 7 days
    const { copyId } = await seedPending({ esignSentAt: twentyDaysAgo });
    let polled = false;
    vi.stubGlobal("fetch", async () => { polled = true; return new Response("{}", { status: 200 }); });

    const advanced = await reconcilePendingEsign(deps);
    expect(advanced).toBeGreaterThanOrEqual(1);
    expect(polled).toBe(false); // expiry short-circuits before any vendor call
    const copy = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, copyId)))[0]!;
    expect(copy.esignStatus).toBe("expired");
    expect(copy.signedTime).toBeNull(); // expired, not signed - HR can re-issue
    expect(copy.locked).toBe(false);
  });
});
