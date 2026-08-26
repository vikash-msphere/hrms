/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { NUDGE_DAYS, nudgeStaleAcks, pendingAck, remindAckPending } from "../src/services/documentAck";

// Chasing an unsigned policy. Publishing used to be the only moment anybody was ever asked to sign, so the
// three things worth pinning are: the reminder ladder fires on its days and NOT on the days between (a daily
// drip is how a reminder becomes invisible), a signature stops the chase, and the fourteen-day mark leaves an
// `document.ackOverdue` event behind for a rule to escalate on.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY_MS = 86_400_000;
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

const TABLES = [schema.documentAcknowledgements, schema.orgDocuments, schema.notifications, schema.auditLog, schema.eventLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.clock = { now: () => new Date() };
});

async function seedEmployee(): Promise<string> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: genId().slice(0, 4),
    workEmail: `${employeeId}@test.example`, status: "active",
  });
  return employeeId;
}

async function seedHr(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
  const employeeId = await seedEmployee();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "hr_admin", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "hr_admin", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

/** A published policy awaiting signatures, whose current version landed `ageDays` ago. */
async function seedPolicy(ageDays: number) {
  const uuid = genId();
  const landed = new Date(Date.now() - ageDays * DAY_MS);
  await deps.db.insert(schema.orgDocuments).values({
    uuid, code: `21-${genId().slice(0, 4)}`, documentType: "POLICY", title: "Code of conduct",
    r2Key: `org-documents/${uuid}`, contentType: "application/pdf", sizeBytes: 1024,
    requiresAck: true, ackVersion: 1, ackVersionTime: landed, ackMethod: "internal",
    signAnchorJson: JSON.stringify({ page: 1, x1: 60, y1: 80, x2: 260, y2: 140 }),
    published: true,
  });
  return uuid;
}

const notifCount = async () => (await deps.db.select().from(schema.notifications)).length;
const eventTypes = async () => (await deps.db.select().from(schema.eventLog)).map((e) => e.type);

describe("policy acknowledgement chase-up", () => {
  it("nudges on the ladder days and stays quiet in between", async () => {
    for (const age of [1, 2, 4, 8, 20]) {
      for (const t of [schema.notifications, schema.orgDocuments, schema.employees]) await deps.db.delete(t);
      await seedEmployee();
      await seedPolicy(age);
      expect(await nudgeStaleAcks(deps), `age ${age} should be quiet`).toBe(0);
      expect(await notifCount()).toBe(0);
    }
    for (const age of NUDGE_DAYS) {
      for (const t of [schema.notifications, schema.orgDocuments, schema.employees]) await deps.db.delete(t);
      await seedEmployee();
      await seedPolicy(age);
      expect(await nudgeStaleAcks(deps), `age ${age} should nudge`).toBe(1);
    }
  });

  it("stops chasing whoever has signed the current version", async () => {
    const signer = await seedEmployee();
    await seedEmployee(); // still outstanding
    const docId = await seedPolicy(3);
    await deps.db.insert(schema.documentAcknowledgements).values({
      code: `22-${genId().slice(0, 4)}`, employeeId: signer, documentId: docId, version: 1,
      signature: "Test User", acknowledgedTime: new Date(),
    });
    const { notStarted, started } = await pendingAck(deps, (await deps.db.select().from(schema.orgDocuments).where(eq(schema.orgDocuments.uuid, docId)).limit(1))[0]!);
    expect(notStarted).toHaveLength(1);
    expect(started).toHaveLength(0);
    expect(await nudgeStaleAcks(deps)).toBe(1);
  });

  it("counts a started-but-unfinished Aadhaar journey as pending, with its own wording", async () => {
    const employeeId = await seedEmployee();
    const docId = await seedPolicy(7);
    // A pending ack row: the vendor journey was opened and never completed.
    await deps.db.insert(schema.documentAcknowledgements).values({
      code: `22-${genId().slice(0, 4)}`, employeeId, documentId: docId, version: 1, signature: "Test User",
    });
    expect(await nudgeStaleAcks(deps)).toBe(1);
    const [n] = await deps.db.select().from(schema.notifications);
    expect(n!.title).toContain("Finish signing");
  });

  it("re-asks after a new version lands, even from someone who signed the old one", async () => {
    const signer = await seedEmployee();
    const docId = await seedPolicy(3);
    await deps.db.insert(schema.documentAcknowledgements).values({
      code: `22-${genId().slice(0, 4)}`, employeeId: signer, documentId: docId, version: 1,
      signature: "Test User", acknowledgedTime: new Date(),
    });
    expect(await nudgeStaleAcks(deps)).toBe(0);
    // Replacing the file bumps the version and re-stamps the clock; the old signature no longer counts.
    await deps.db.update(schema.orgDocuments).set({ ackVersion: 2, ackVersionTime: new Date(Date.now() - 3 * DAY_MS) }).where(eq(schema.orgDocuments.uuid, docId));
    expect(await nudgeStaleAcks(deps)).toBe(1);
  });

  it("leaves an ackOverdue event at the end of the ladder, and only there", async () => {
    await seedEmployee();
    await seedPolicy(3);
    await nudgeStaleAcks(deps);
    expect(await eventTypes()).not.toContain("document.ackOverdue");

    for (const t of [schema.orgDocuments, schema.notifications]) await deps.db.delete(t);
    await seedPolicy(NUDGE_DAYS[NUDGE_DAYS.length - 1]!);
    await nudgeStaleAcks(deps);
    expect(await eventTypes()).toContain("document.ackOverdue");
  });

  it("ignores drafts, disabled and deleted policies", async () => {
    await seedEmployee();
    const docId = await seedPolicy(3);
    for (const patch of [{ published: false }, { disabled: true }, { deleteTime: new Date() }]) {
      await deps.db.update(schema.orgDocuments).set({ published: true, disabled: false, deleteTime: null, ...patch }).where(eq(schema.orgDocuments.uuid, docId));
      expect(await nudgeStaleAcks(deps), JSON.stringify(patch)).toBe(0);
    }
  });

  it("HR can chase everyone, or one person, and is told when there is nobody to chase", async () => {
    const hr = await seedHr();
    const one = await seedEmployee();
    await seedEmployee();
    const docId = await seedPolicy(1); // off-ladder: the manual nudge doesn't wait for a schedule

    // HR's own employee record is part of the active roster, and the roster IS the audience approximation - so
    // assert against the pending list rather than a magic count.
    const doc = (await deps.db.select().from(schema.orgDocuments).where(eq(schema.orgDocuments.uuid, docId)).limit(1))[0]!;
    const { notStarted } = await pendingAck(deps, doc);
    const all = await remindAckPending(deps, hr, docId);
    expect(all.reminded).toBe(notStarted.length);
    expect(all.reminded).toBeGreaterThan(1);

    const single = await remindAckPending(deps, hr, docId, { employee: `employees/${one}` });
    expect(single.reminded).toBe(1);

    await deps.db.insert(schema.documentAcknowledgements).values({
      code: `22-${genId().slice(0, 4)}`, employeeId: one, documentId: docId, version: 1,
      signature: "Test User", acknowledgedTime: new Date(),
    });
    await expect(remindAckPending(deps, hr, docId, { employee: `employees/${one}` })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses to chase a document that does not require acknowledgement", async () => {
    const hr = await seedHr();
    const docId = await seedPolicy(3);
    await deps.db.update(schema.orgDocuments).set({ requiresAck: false }).where(eq(schema.orgDocuments.uuid, docId));
    await expect(remindAckPending(deps, hr, docId)).rejects.toMatchObject({ httpStatus: 400 });
  });
});
