// Renders the seeded role set and its compiled `access_rules` rows as SQL, from the seed data beside it
// (roles.ts, grants.ts). The one renderer both seeds use: bootstrap/genBootstrap.ts (a fresh production
// database) and scripts/genSeed.ts (the local demo database). test/seedDrift.test.ts asserts both generated
// files embed this output byte-for-byte, so neither can drift from the data.
import { compileGrant } from "../../src/domain/compileGrants";
import { EVERYONE_ROLE } from "../../src/domain/grants";
import type { Grant } from "../../src/domain/permissions";
import { bytesToBase32 } from "../../src/lib/idCodec";
import { ROLES } from "./roles";
import { EVERYONE_GRANT, GRANTS } from "./grants";

const SEED_TS = 1700000000000; // the fixed timestamp both seeds use
const sql = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
const COLS = "(uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at)";

// A seeded rule id is a REAL internal id: 8 bytes rendered as 13 Crockford-base32 chars, the shape idCodec
// requires. A short hand-written id (`arseed000`) is not encodable, and the list cursor tokenizes the last
// row's uuid - which made every paged access-rules list a 500. Deterministic from the counter, offset far
// above the range scripts/genSeed.ts mints from so the two seeds can never collide.
const ID_BASE = 1_000_000;
const seedRuleId = (n: number) => {
  const b = new Uint8Array(8);
  let x = BigInt(n + ID_BASE);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return bytesToBase32(b);
};

const ruleRows = (subject: string, grant: Grant, idOf: (i: number) => string, from: number): string[] =>
  compileGrant(grant).map(
    (r, i) =>
      ` (${sql(idOf(from + i))},${sql(subject)},'role',${sql(r.namespace)},${sql(r.pattern)},${sql(r.scopeKind)},` +
      `${sql(r.scopeCode)},${sql(r.matchCode)},${sql(r.level)},${sql(r.effect)},${SEED_TS},${SEED_TS})`,
  );

export function renderRolesSeed(): string {
  const b = (v: boolean) => (v ? 1 : 0);
  return (
    "INSERT INTO roles (name,label,protected,provisioned,created_at,updated_at) VALUES\n" +
    ROLES.map((r) => ` (${sql(r.name)},${sql(r.label)},${b(r.protected)},${b(r.provisioned)},${SEED_TS},${SEED_TS})`).join(",\n") +
    ";"
  );
}

// The assignable roles' rules, ids counted from 0 in GRANTS order. ONE INSERT PER ROLE: D1 refuses a statement
// over its size limit (SQLITE_TOOBIG, about 100 KB), and the whole set in one statement crossed it - which
// failed the seed outright. A role's own block is a fraction of that, and a new role adds a statement rather
// than growing an existing one.
export function renderAccessRulesSeed(): string {
  const blocks: string[] = [];
  let n = 0;
  for (const role of Object.keys(GRANTS)) {
    const rows = ruleRows(role, GRANTS[role as keyof typeof GRANTS], seedRuleId, n);
    n += rows.length;
    blocks.push(`INSERT INTO access_rules ${COLS} VALUES\n${rows.join(",\n")};`);
  }
  return blocks.join("\n");
}

// The `everyone` pseudo-role's rules, ids from a range far past the assignable roles' block so growing GRANTS
// never renumbers them.
export function renderEveryoneRulesSeed(): string {
  const rows = ruleRows(EVERYONE_ROLE, EVERYONE_GRANT, (i) => seedRuleId(900_001 + i), 0);
  return `INSERT INTO access_rules ${COLS} VALUES\n${rows.join(",\n")};`;
}

// Everything that seeds authority except the policy manifest: the role set, then the rules that reference it.
export function renderAuthzSeed(): string {
  return [renderRolesSeed(), renderAccessRulesSeed(), renderEveryoneRulesSeed()].join("\n");
}
