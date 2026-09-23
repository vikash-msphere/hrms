// Single source for the `access_rules` seed rows: compiles the typed default grants (GRANTS) into rows and
// renders the exact `INSERT INTO access_rules ...` block embedded in scripts/seed.sql. seed.sql holds a
// MATERIALIZED snapshot of this output (fixed ids/timestamp, local-dev only); test/seedDrift.test.ts asserts
// the file matches this function byte-for-byte, so the seed can never silently drift from the compiler.
//
// Run `node --import ./scripts/tsResolve.mjs scripts/genAccessRulesSeed.ts` to print the block when the grants change, then paste it in.
import { GRANTS } from "../src/domain/grants";
import { compileGrant } from "../src/domain/compileGrants";
import { bytesToBase32 } from "../src/lib/idCodec";

const SEED_TS = 1700000000000; // the fixed timestamp the rest of seed.sql uses
const sql = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

// A seeded rule id is a REAL internal id: 8 bytes rendered as 13 Crockford-base32 chars, the shape idCodec
// requires. A short hand-written id (`arseed000`) is not encodable, and the list cursor tokenizes the last
// row's uuid - which made every paged access-rules list a 500. Deterministic from the counter, offset far
// above the range scripts/genSeed.ts mints from so the two seeds can never collide.
const ID_BASE = 1_000_000;
export const seedRuleId = (n: number) => {
  const b = new Uint8Array(8);
  let x = BigInt(n + ID_BASE);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return bytesToBase32(b);
};

export function renderAccessRulesSeed(): string {
  const cols = "(uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at)";
  const rows: string[] = [];
  let n = 0;
  for (const role of Object.keys(GRANTS)) {
    for (const r of compileGrant(GRANTS[role as keyof typeof GRANTS])) {
      const id = seedRuleId(n++);
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
