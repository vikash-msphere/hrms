/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import seedSql from "../scripts/seed.sql?raw";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";

// Drift guard for the `policy` seed row. Both generated SQL files embed the seeded manifest
// (bootstrap/authz/policy.ts: audit classification, protected fields, reference gates, supported scopes) as one
// JSON blob. If the seed data changes and a snapshot is not regenerated, a fresh DB would start on stale policy -
// e.g. a new sensitive verb would not be audited. Companion to seedDrift.test.ts, which pins the roles and
// access_rules the same way. A LIVE database only gets a manifest change through a migration or the policy API.
// To fix a failure: `node --import ./scripts/tsResolve.mjs scripts/genSeed.ts` / `node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts` and replace the file.
const expected = `('manifest','${JSON.stringify(DEFAULT_POLICY).replace(/'/g, "''")}'`;

describe("policy manifest seed drift", () => {
  it("scripts/seed.sql embeds the current DEFAULT_POLICY", () => {
    expect(seedSql).toContain(expected);
  });
  it("bootstrap/bootstrap.sql embeds the current DEFAULT_POLICY", () => {
    expect(bootstrapSql).toContain(expected);
  });
});
