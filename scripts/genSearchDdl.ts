// Checks the generated search DDL (FTS5 table + sync triggers + backfill) against the migration that carries it.
// drizzle-kit cannot emit virtual tables or triggers, so this runs straight after `drizzle-kit generate` - see
// the `db:generate` script.
//
// The block lives in 0000, which production has applied, and migrations are append-only: wrangler tracks them
// by tag and never re-reads an applied file, so rewriting the block there would deploy green and change
// nothing (scripts/freezeMigrations.ts). So this never writes. An unchanged block passes, which is what lets
// `db:generate` run for a schema change that does not touch search. A changed one fails, naming the file,
// because the new or altered triggers then have to be written into the new migration as DROP/CREATE by hand.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts        (or just `npm run db:generate`)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSearchDdl, SEARCH_DDL_MARKER } from "../src/db/searchDdl";
import { CHANGE_DDL_MARKER } from "../src/db/changeDdl";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const holders = files.filter((f) => readFileSync(join(DIR, f), "utf8").includes(SEARCH_DDL_MARKER));
if (holders.length !== 1) {
  throw new Error(`expected the generated search DDL in exactly one migration in ${DIR}, found it in ${holders.length}: ${holders.join(", ")}`);
}

const path = join(DIR, holders[0]!);
const current = readFileSync(path, "utf8");
const cut = current.indexOf(SEARCH_DDL_MARKER);
// The change-stamp block (scripts/genChangeDdl.ts) follows this one in the same file.
const next = current.indexOf(CHANGE_DDL_MARKER, cut);
const block = (next > cut ? current.slice(cut, next) : current.slice(cut)).replace(/(?:\s*-->\s*statement-breakpoint)+\s*$/, "").trim();
if (block !== renderSearchDdl().trim()) {
  throw new Error(
    `search DDL changed, but its block lives in ${path}, which is applied to the live database and is never rewritten. ` +
      "Write the new or changed FTS triggers into the newest migration by hand (DROP TRIGGER + CREATE TRIGGER), " +
      "and extend test/searchDdlDrift.test.ts to read them from there.",
  );
}
console.error(`search DDL unchanged in ${path}`);
