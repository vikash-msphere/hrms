/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { PROVIDERS } from "../src/services/esign";
import { handleEsignCallback, reconcilePendingEsign, RECONCILE_BATCH } from "../src/services/esign/callback";
import type { EsignProvider } from "../src/domain/esign";

// The inbound edge of e-signing, against a real D1: this is the code that decides a document is SIGNED, and
// the three things pinned here are the ones that make that decision trustworthy - it flips the right row, it
// happens once however many times the vendor delivers, and one night's reconcile is a bounded amount of work.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.auditLog, schema.personalDocuments, schema.employees];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

// Two stand-in drivers, registered for the duration of a test. A fake is the point: the real vendor's half is
// signature verification (covered in esign.test.ts), and what is under test here is what the app does with a
// delivery once a driver has vouched for it.
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
let statusCalls = 0;
const fake = (id: string): EsignProvider => ({
  id, label: id, requiresAadhaar: false, supportsWebhook: true, configFields: [],
  createRequest: async () => ({ providerRef: "ref", status: "sent" }),
  parseWebhook: async ({ rawBody }) => JSON.parse(rawBody) as { providerRef: string; status: "signed" } & { signedPdf?: Uint8Array },
  getStatus: async () => { statusCalls++; return { status: "signed", signedPdf: PDF }; },
});
beforeEach(() => {
  statusCalls = 0;
  PROVIDERS.alpha = fake("alpha");
  PROVIDERS.beta = fake("beta");
});
afterEach(() => {
  delete PROVIDERS.alpha;
  delete PROVIDERS.beta;
});

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active",
  });
  return uuid;
}

async function seedDoc(employeeId: string, over: Partial<typeof schema.personalDocuments.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.personalDocuments).values({
    uuid, code: `${genId().slice(0, 6)}-1`, employeeId, documentType: "LETTER", title: "Offer",
    r2Key: `docs/${uuid}.pdf`, esignStatus: "sent", esignSentAt: new Date(), ...over,
  });
  return uuid;
}

const docById = async (id: string) => (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)))[0]!;
const esignAudits = async () => (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "personal-document.esign");

const signedBody = (ref: string) => JSON.stringify({ providerRef: ref, status: "signed", signedPdf: [...PDF] });

describe("a delivery flips the document it belongs to", () => {
  it("matches on (provider, ref), so one vendor's id cannot sign another's document", async () => {
    const emp = await seedEmployee();
    const mine = await seedDoc(emp, { esignProvider: "alpha", esignRequestId: "shared-ref" });
    const theirs = await seedDoc(emp, { esignProvider: "beta", esignRequestId: "shared-ref" });

    // A request id is the VENDOR's namespace, so two drivers may mint the same string. Only beta's document
    // may move on beta's delivery, however the rows happen to be ordered.
    await handleEsignCallback(deps, "beta", {}, signedBody("shared-ref"));

    expect((await docById(theirs)).esignStatus).toBe("signed");
    expect((await docById(mine)).esignStatus).toBe("sent");
    expect((await docById(mine)).signedTime).toBe(null);
  });
});

describe("a redelivery is a no-op, in the trail as well as in the row", () => {
  it("files one audit entry however many times the vendor delivers", async () => {
    const emp = await seedEmployee();
    const doc = await seedDoc(emp, { esignProvider: "alpha", esignRequestId: "r1" });

    const first = await handleEsignCallback(deps, "alpha", {}, signedBody("r1"));
    const second = await handleEsignCallback(deps, "alpha", {}, signedBody("r1"));

    expect(first).toEqual({ ok: true, status: "signed" });
    expect(second).toEqual({ ok: true, status: "signed" }); // idempotent, and still acked so the vendor stops
    // The guarded UPDATE always stopped the second WRITE; the audit entry was written either way, so the
    // e-signature trail said the document had been signed twice.
    expect(await esignAudits()).toHaveLength(1);
  });

  it("finalizes the linked acknowledgement exactly once", async () => {
    const emp = await seedEmployee();
    const ackId = genId();
    const orgDocId = genId();
    await deps.db.insert(schema.orgDocuments).values({
      uuid: orgDocId, code: `${genId().slice(0, 6)}`, documentType: "POLICY", title: "Code of conduct", r2Key: `docs/${orgDocId}.pdf`,
    });
    await deps.db.insert(schema.documentAcknowledgements).values({
      uuid: ackId, code: `${genId().slice(0, 6)}-1`, employeeId: emp, documentId: orgDocId, version: 1, signature: "",
    });
    const doc = await seedDoc(emp, { esignProvider: "alpha", esignRequestId: "r2", ackId });

    await handleEsignCallback(deps, "alpha", {}, signedBody("r2"));
    const [acked] = await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ackId));
    const at = acked!.acknowledgedTime;
    expect(at).not.toBe(null);

    await handleEsignCallback(deps, "alpha", {}, signedBody("r2"));
    const [again] = await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ackId));
    expect(again!.acknowledgedTime).toEqual(at); // the same signature moment, not a fresh one
    expect((await docById(doc)).signedTime).not.toBe(null);
  });
});

describe("the nightly reconcile is bounded", () => {
  it("polls at most RECONCILE_BATCH documents in one tick, oldest first", async () => {
    const emp = await seedEmployee();
    const base = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < RECONCILE_BATCH + 5; i++) {
      await seedDoc(emp, { esignProvider: "alpha", esignRequestId: `r-${i}`, esignSentAt: new Date(base + i * 1000) });
    }

    // Every row here is an outbound vendor call, off one invocation's subrequest budget that twenty-odd other
    // nightly subtasks also draw on - so a backlog must not decide how much work the tick tries to do.
    const advanced = await reconcilePendingEsign(deps);
    expect(statusCalls).toBe(RECONCILE_BATCH);
    expect(advanced).toBe(RECONCILE_BATCH);

    // ...and the remainder is not stranded: the next tick takes what is left.
    statusCalls = 0;
    expect(await reconcilePendingEsign(deps)).toBe(5);
  });
});
