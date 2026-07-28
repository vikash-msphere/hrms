import { describe, it, expect } from "vitest";
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
});
