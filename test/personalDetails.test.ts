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
import { getPersonalDetails, setPersonalDetails } from "../src/services/personalDetails";

// A person's contact and emergency details are ONE encrypted record, edited from TWO dialogs on their own
// profile - "contact details" and "who to call". So the write has to merge: what a save does not mention is
// not what it is deciding about, and a full replace made whichever dialog saved second wipe the other's
// fields, with nothing to show for it until the page was reloaded.
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

const TABLES = [schema.auditLog, schema.eventLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedPerson(): Promise<{ actor: AppUser; employeeId: string }> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { actor: { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser, employeeId };
}

describe("a person's own contact and emergency details", () => {
  it("keeps what a save does not mention", async () => {
    const { actor, employeeId } = await seedPerson();

    // The contact dialog saves what it knows about.
    await setPersonalDetails(deps, actor, employeeId, { personal_phone: "+91 90000 00000", communication_address: "12 Test Lane" });
    // The emergency dialog saves what IT knows about, and says nothing about the address.
    await setPersonalDetails(deps, actor, employeeId, { emergency_name: "Kin", emergency_phone: "+91 90000 00001" });

    const stored = await getPersonalDetails(deps, actor, employeeId);
    expect(stored.communication_address).toBe("12 Test Lane");
    expect(stored.personal_phone).toBe("+91 90000 00000");
    expect(stored.emergency_name).toBe("Kin");
  });

  it("clears a field that is sent empty", async () => {
    const { actor, employeeId } = await seedPerson();
    await setPersonalDetails(deps, actor, employeeId, { emergency_name: "Kin", emergency_phone: "+91 90000 00001", personal_phone: "+91 90000 00000" });

    // Emptying the boxes in the emergency dialog is how somebody takes that contact off their record - the
    // forms send "" for a box that was cleared, and never null.
    await setPersonalDetails(deps, actor, employeeId, { emergency_name: "", emergency_phone: "" });

    const stored = await getPersonalDetails(deps, actor, employeeId);
    expect(stored.emergency_name).toBeUndefined();
    expect(stored.emergency_phone).toBeUndefined();
    expect(stored.personal_phone).toBe("+91 90000 00000"); // untouched by that save
  });

  it("mirrors the permanent address while the flag is on, and stops when it comes off", async () => {
    const { actor, employeeId } = await seedPerson();
    await setPersonalDetails(deps, actor, employeeId, { communication_address: "12 Test Lane", same_as_communication: true });
    expect((await getPersonalDetails(deps, actor, employeeId)).permanent_address).toBe("12 Test Lane");

    await setPersonalDetails(deps, actor, employeeId, { permanent_address: "9 Other Road", same_as_communication: false });
    const stored = await getPersonalDetails(deps, actor, employeeId);
    expect(stored.permanent_address).toBe("9 Other Road");
    expect(stored.same_as_communication).toBeUndefined();
    expect(stored.communication_address).toBe("12 Test Lane");
  });
});
