/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import seedSql from "../scripts/seed.sql?raw";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";
import { renderAuthzSeed } from "../bootstrap/authz/accessRules";

// Drift guard: both generated seeds hold a MATERIALIZED snapshot of the seeded roles and their compiled
// access_rules rows. If the seed data in bootstrap/authz/ changes and a snapshot is not regenerated, a fresh DB
// would seed stale authority. This asserts each file embeds the renderer's output byte-for-byte. To fix a
// failure, regenerate both: `node --import ./scripts/tsResolve.mjs scripts/genSeed.ts > scripts/seed.sql` and
// `node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts > bootstrap/bootstrap.sql`.
describe("seed roles + access_rules drift", () => {
  it("scripts/seed.sql embeds the rendered roles and rules", () => {
    expect(seedSql).toContain(renderAuthzSeed());
  });
  it("bootstrap/bootstrap.sql embeds the rendered roles and rules", () => {
    expect(bootstrapSql).toContain(renderAuthzSeed());
  });
  // D1 refuses one statement over its size limit (SQLITE_TOOBIG, about 100 KB), and a seed that trips it fails
  // the whole bootstrap - which the single access_rules INSERT did once the rule set grew. Held with headroom.
  it("no seed statement is near D1's statement-size limit", () => {
    for (const [name, sql] of [["scripts/seed.sql", seedSql], ["bootstrap/bootstrap.sql", bootstrapSql]] as const) {
      const largest = Math.max(...sql.split(/;\n/).map((s) => new TextEncoder().encode(s).length));
      expect(largest, `${name}: largest statement is ${largest} bytes`).toBeLessThan(90_000);
    }
  });
});
