/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createAnnouncement, updateAnnouncement } from "../src/services/announcements";

// Recognition is peer-to-peer by definition: nobody may hand themselves a kudo, and no edit may turn an
// honest kudo into a self-kudo after the fact. Three ways it could be attempted, all refused here.
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

const TABLES = [schema.announcements, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(first: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: first, lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

describe("kudos: nobody can recognize themselves", () => {
  it("refuses a kudo whose giver is the recipient", async () => {
    const giver = await seedActor("Giver");
    await expect(
      createAnnouncement(deps, giver, { kind: "kudos", recipient: `employees/${giver.employeeId}`, message: "great work me" }),
    ).rejects.toThrow(/yourself/);
  });

  it("refuses a kudo the caller posts to themselves under another author's name", async () => {
    const caller = await seedActor("Caller");
    const other = await seedActor("Other");
    await expect(
      createAnnouncement(deps, caller, { kind: "kudos", author: `employees/${other.employeeId}`, recipient: `employees/${caller.employeeId}`, message: "signed by someone else" }),
    ).rejects.toThrow(/yourself/);
  });

  it("refuses an edit that re-points a kudo's author at its recipient", async () => {
    const giver = await seedActor("Giver");
    const recipient = await seedActor("Recipient");
    const row = await createAnnouncement(deps, giver, { kind: "kudos", recipient: `employees/${recipient.employeeId}`, message: "genuinely great work" });
    await expect(
      updateAnnouncement(deps, giver, row.uuid, { author: `employees/${recipient.employeeId}` }),
    ).rejects.toThrow(/recipient/);
    // A different author is still a legal correction - only the recipient is off limits.
    const fixed = await updateAnnouncement(deps, giver, row.uuid, { author: `employees/${giver.employeeId}` });
    expect(fixed.authorEmployeeId).toBe(giver.employeeId);
  });

  it("still allows an ordinary peer kudo", async () => {
    const giver = await seedActor("Giver");
    const recipient = await seedActor("Recipient");
    const row = await createAnnouncement(deps, giver, { kind: "kudos", recipient: `employees/${recipient.employeeId}`, message: "thanks for the save" });
    expect(row.authorEmployeeId).toBe(giver.employeeId);
    expect(row.recipientEmployeeId).toBe(recipient.employeeId);
  });
});
