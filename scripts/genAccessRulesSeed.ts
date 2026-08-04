// Single source for the `access_rules` seed rows: compiles the typed default grants (GRANTS) into rows and
// renders the exact `INSERT INTO access_rules ...` block embedded in scripts/seed.sql. seed.sql holds a
// MATERIALIZED snapshot of this output (fixed ids/timestamp, local-dev only); test/seedDrift.test.ts asserts
// the file matches this function byte-for-byte, so the seed can never silently drift from the compiler.
//
// Run `node --import ./scripts/tsResolve.mjs scripts/genAccessRulesSeed.ts` to print the block when the grants change, then paste it in.
import { GRANTS } from "../src/domain/grants";
import { compileGrant } from "../src/domain/compileGrants";

const SEED_TS = 1700000000000; // the fixed timestamp the rest of seed.sql uses
const sql = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

export function renderAccessRulesSeed(): string {
  const cols = "(uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at)";
  const rows: string[] = [];
  let n = 0;
  for (const role of Object.keys(GRANTS)) {
    for (const r of compileGrant(GRANTS[role as keyof typeof GRANTS])) {
      const id = `arseed${String(n++).padStart(3, "0")}`;
      rows.push(
        ` (${sql(id)},${sql(role)},'role',${sql(r.namespace)},${sql(r.pattern)},${sql(r.scopeKind)},` +
          `${sql(r.scopeCode)},${sql(r.matchCode)},${sql(r.level)},${sql(r.effect)},${SEED_TS},${SEED_TS})`,
      );
    }
  }
  return `INSERT INTO access_rules ${cols} VALUES\n${rows.join(",\n")};`;
}

// Printed when run directly (tsx/node). Guarded so importing this module in a test is side-effect free
// (the worker test pool has no `process`).
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
  console.log(renderAccessRulesSeed());
}
