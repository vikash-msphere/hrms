/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";
import { AUTOMATIONS } from "../bootstrap/collections/automations";
import { validateAutomation } from "../src/domain/automations";

// Seeded automations are inserted as raw SQL (bootstrap), bypassing the API's validation. This is the guard:
// every default rule must satisfy the same validator the write route uses, so a bad seed can't ship.
describe("bootstrap automations are all valid", () => {
  for (const a of AUTOMATIONS) {
    it(`"${a.name}" validates`, () => {
      expect(validateAutomation({ name: a.name, triggerType: a.trigger, condition: a.condition ?? null, actions: a.actions, schedule: a.schedule ?? null })).toEqual([]);
    });
  }

  it("names are unique", () => {
    const names = AUTOMATIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // THE SNAPSHOT HAS TO KEEP UP WITH THE LIST, and nothing was checking that it did.
  //
  // `bootstrap.sql` is generated from this module and committed beside it, and a new org is bootstrapped from
  // the SQL - so a rule added here and not regenerated exists in the source, passes every test in this file,
  // and is simply absent from every deployment made after it. That shipped once: a commit carried two new
  // rules in `automations.ts` with a `bootstrap.sql` generated before them, and the whole suite went green.
  //
  // `manifestSeedDrift.test.ts` guards the same file for DEFAULT_POLICY and says why in the same words; this
  // is the automations half of that check. To fix a failure:
  // `node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts > bootstrap/bootstrap.sql`
  it("bootstrap/bootstrap.sql carries every seeded rule", () => {
    // Searched as SQL sees it: the generator doubles apostrophes to quote them, so a raw `includes` reports
    // "Chase an offer the candidate hasn't answered" as missing from a file that carries it.
    const missing = AUTOMATIONS.filter((a) => !bootstrapSql.includes(a.name.replace(/'/g, "''"))).map((a) => a.name);
    expect(missing, "seeded automations missing from bootstrap.sql - regenerate it").toEqual([]);
  });
});
