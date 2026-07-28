/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import seedSql from "../scripts/seed.sql?raw";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";
import { DEFAULT_POLICY } from "../src/domain/manifests";

// Drift guard for the `policy` seed row. Both generated SQL files embed DEFAULT_POLICY (audit classification,
// protected fields, reference gates, supported scopes) as one JSON blob. If the manifest changes in code and a
// snapshot is not regenerated, a local/bootstrapped DB would run on stale policy - e.g. a new sensitive verb
// would not be audited. Companion to seedDrift.test.ts, which pins the access_rules block the same way.
// To fix a failure: `npx tsx scripts/genSeed.ts` / `npx tsx bootstrap/genBootstrap.ts` and replace the file.
const expected = `('manifest','${JSON.stringify(DEFAULT_POLICY).replace(/'/g, "''")}'`;

describe("policy manifest seed drift", () => {
  it("scripts/seed.sql embeds the current DEFAULT_POLICY", () => {
    expect(seedSql).toContain(expected);
  });
  it("bootstrap/bootstrap.sql embeds the current DEFAULT_POLICY", () => {
    expect(bootstrapSql).toContain(expected);
  });
});
