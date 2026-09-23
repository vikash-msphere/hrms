/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// Separation of duties on the step where the money actually leaves: may the person who APPROVED a payroll run
// also generate its payout file?
//
// Written because the rule had no test behind it - only the call sites that pass an actor through. The whole
// control is one identity comparison against one setting, which is exactly the kind of thing that looks
// obviously right and has four ways to be wrong: off when it should be on, on when nobody asked, applied to
// the wrong person, or applied to a caller who is not a person at all.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { assertMayGenerateBankFile } from "../src/services/payroll";

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

beforeEach(async () => { await deps.db.delete(schema.settings); });

const actorFor = (uuid: string): AppUser => ({ uuid, email: `${uuid}@t.example`, role: "payroll_admin", status: "active" } as unknown as AppUser);

/** The org's separation-of-duties switches. Absent = the default, which is off. */
async function setPolicy(v: { separate_bank_file?: boolean }) {
  await deps.db.insert(schema.settings)
    .values({ key: "payroll-approval", value: JSON.stringify(v) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(v) } });
}

describe("four eyes on the payout file", () => {
  const approver = genId();
  const somebodyElse = genId();

  it("is off unless the org turns it on", async () => {
    // The default every separation-of-duties rule in this app takes, and for the stated reason: a finance team
    // of one has nobody to hand the file to, and a control they cannot satisfy is one they route around.
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: approver })).resolves.toBeUndefined();
    await setPolicy({});
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: approver })).resolves.toBeUndefined();
    await setPolicy({ separate_bank_file: false });
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: approver })).resolves.toBeUndefined();
  });

  it("refuses the approver once it is on", async () => {
    await setPolicy({ separate_bank_file: true });
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: approver }))
      .rejects.toThrow(/someone other than the person who approved/i);
  });

  it("lets anybody else generate it", async () => {
    // The rule is about one person doing both things, not about who may produce a payout file - that is the
    // grant's question, decided before this is reached.
    await setPolicy({ separate_bank_file: true });
    await expect(assertMayGenerateBankFile(deps, actorFor(somebodyElse), { approvedBy: approver })).resolves.toBeUndefined();
  });

  it("has nothing to say about a run nobody approved", async () => {
    // An unapproved run is refused earlier, by state. If this threw here it would be answering a question it
    // was not asked, on a null.
    await setPolicy({ separate_bank_file: true });
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: null })).resolves.toBeUndefined();
  });

  it("does not apply when no person asked", async () => {
    // An automation attaching the file to an email has no actor. A rule about WHICH PERSON may do two things
    // has nobody to be about, so it does not apply - and the gap that leaves (an approver who can write
    // automation rules) is named in the code rather than left to be discovered.
    await setPolicy({ separate_bank_file: true });
    await expect(assertMayGenerateBankFile(deps, null, { approvedBy: approver })).resolves.toBeUndefined();
  });

  it("is independent of the submit-side rule", async () => {
    // Two flags in one blob, guarding different pairs of hands. Turning on the approve-side rule alone must
    // not silently start refusing payout files, or an org would get a control it never asked for.
    await setPolicy({ enabled: true } as { separate_bank_file?: boolean });
    await expect(assertMayGenerateBankFile(deps, actorFor(approver), { approvedBy: approver })).resolves.toBeUndefined();
  });
});
