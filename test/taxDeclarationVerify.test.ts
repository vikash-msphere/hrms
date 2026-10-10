/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { etagOf } from "../src/http/serialize";
import { verifyTaxDeclaration, rejectTaxDeclaration, updateTaxDeclaration } from "../src/services/taxDeclarations";

// VERIFYING IS A DECISION ABOUT A ROW ITS OWN SUBJECT CAN MOVE.
//
// A declaration is editable by the employee it belongs to for as long as it is not verified (an edit resets
// `status` to DECLARED, deliberately), and the proof behind it is an attachment slot an upload overwrites.
// Only a VERIFIED amount reduces withholding - so a verify that re-reads the row and stamps whatever it finds
// accepts a figure nobody reviewed, whenever an edit lands between reading the queue and pressing the button.
// This is the one decision in the app whose beneficiary controls its input, and it had neither an `If-Match`
// nor a from-state guard while every other consequential write has one or the other.
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

beforeEach(async () => {
  await deps.db.delete(schema.taxDeclarations);
  await deps.db.delete(schema.notifications);
  await deps.db.delete(schema.users);
  await deps.db.delete(schema.employees);
});

let n = 0;
async function seed() {
  n += 1;
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-002-${String(n).padStart(3, "0")}`, firstName: "Test", lastName: "User",
    workEmail: `p${n}@example.com`, status: "active",
  });
  const uuid = genId();
  await deps.db.insert(schema.taxDeclarations).values({
    uuid, code: `04-002-${String(n).padStart(3, "0")}-1`, employeeId,
    financialYear: "2025-26", section: "80C", declaredAmount: 50_000, status: "DECLARED",
  });
  // `decided_by` is a real foreign key into `users`, so the deciding account has to exist.
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR admin" }).onConflictDoNothing();
  const mkUser = async (empId: string | null) => {
    const id = genId();
    await deps.db.insert(schema.users).values({ uuid: id, code: `u${n}-${id.slice(0, 4)}`, email: `${id}@example.com`, role: "hr_admin", employeeId: empId });
    return { uuid: id, email: `${id}@example.com`, role: "hr_admin", status: "active", employeeId: empId, employeeCode: null } as unknown as AppUser;
  };
  const actor = await mkUser(null);
  const employee = await mkUser(employeeId);
  return { id: uuid, employeeId, actor, employee };
}
const read = async (id: string) => (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0]!;

describe("verifying a tax declaration is pinned to the version that was read", () => {
  it("verifies the amount on the row as read", async () => {
    const { id, actor } = await seed();
    const seen = await read(id);
    const out = await verifyTaxDeclaration(deps, actor, id, undefined, etagOf(+new Date(seen.updatedAt)));
    expect(out.status).toBe("VERIFIED");
    expect(out.verifiedAmount).toBe(50_000);
  });

  // THE CASE THIS EXISTS FOR: the employee raises their claim between the verifier reading the queue and
  // deciding. The old code verified ₹5,00,000 against a review of ₹50,000, silently.
  it("refuses when the declaration was edited after the verifier read it", async () => {
    const { id, actor, employee } = await seed();
    const stale = etagOf(+new Date((await read(id)).updatedAt));
    await updateTaxDeclaration(deps, employee, id, { declared_amount: 500_000 });

    await expect(verifyTaxDeclaration(deps, actor, id, undefined, stale)).rejects.toThrow();
    const after = await read(id);
    expect(after.status).toBe("DECLARED"); // still awaiting a decision
    expect(after.verifiedAmount).toBeNull();
  });

  it("refuses a rejection of a row that has moved too", async () => {
    const { id, actor, employee } = await seed();
    const stale = etagOf(+new Date((await read(id)).updatedAt));
    await updateTaxDeclaration(deps, employee, id, { declared_amount: 60_000 });
    await expect(rejectTaxDeclaration(deps, actor, id, "No proof attached", stale)).rejects.toThrow();
    expect((await read(id)).status).toBe("DECLARED");
  });

  // Sending no ETag is a request not to be bothered about a stale read; the row still has to be the one that
  // was read a moment ago, which is what `updateAtVersion` enforces either way (services/versionGuard.ts).
  it("still verifies when no ETag is sent and nothing has changed", async () => {
    const { id, actor } = await seed();
    expect((await verifyTaxDeclaration(deps, actor, id, 40_000)).verifiedAmount).toBe(40_000);
  });
});
