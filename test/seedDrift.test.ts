/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import seedSql from "../scripts/seed.sql?raw";
import { renderAccessRulesSeed } from "../scripts/genAccessRulesSeed";

// Drift guard: scripts/seed.sql holds a MATERIALIZED snapshot of the compiled access_rules rows. If the
// default grants change and the seed is not regenerated, the local DB would seed stale authority. This
// asserts the embedded `INSERT INTO access_rules ...;` block matches the compiler byte-for-byte. To fix a
// failure: `node --import ./scripts/tsResolve.mjs scripts/genAccessRulesSeed.ts` and paste the output over the block in seed.sql.
describe("seed access_rules drift", () => {
  it("seed.sql's access_rules block matches the compiler output", () => {
    const block = seedSql.match(/INSERT INTO access_rules[\s\S]*?;/);
    expect(block, "no INSERT INTO access_rules block found in seed.sql").not.toBeNull();
    expect(block![0]).toBe(renderAccessRulesSeed());
  });
});
