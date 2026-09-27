// Checks the search index's sync triggers (the ones behind ⌘K, src/db/searchDdl.ts) that the migrations create
// against what the registry describes - drizzle-kit cannot emit triggers or virtual tables.
//
// The full block lives in 0000, which production has applied, and migrations are append-only, so the triggers
// the migrations leave in place, applied in order, are compared with the generator's. They match: pass. They
// differ - a newly searchable collection, a changed match column - and this prints exactly what the newest
// migration has to carry (CREATE for a new trigger, DROP + CREATE for a changed one, a backfill for a
// collection indexed for the first time) and fails. `--write` appends it to the newest migration instead,
// which must be one production has not applied.
//
//   Check:  node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts        (or `npm run db:generate`)
//   Write:  node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts --write
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appliedSearchTriggers, FTS_TABLE_DDL, searchDdlDelta } from "../src/db/searchDdl";
// The triggers bake in the SEEDED state-visibility rules: DDL is written at migration time, so it can only
// reflect the manifest a fresh database starts with.
import { STATE_VISIBILITY } from "../bootstrap/authz/policy";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(join(DIR, f), "utf8"));

if (!sql.some((s) => s.includes(FTS_TABLE_DDL))) {
  throw new Error("no migration creates the search FTS table as src/db/searchDdl.ts describes it. Changing its columns is a rebuild of every trigger and row, written by hand.");
}

const delta = searchDdlDelta(appliedSearchTriggers(sql), STATE_VISIBILITY);
if (delta.length === 0) {
  console.error(`search DDL matches the registry across ${files.length} migrations`);
} else if (process.argv.includes("--write")) {
  const newest = files[files.length - 1]!;
  const body = sql[sql.length - 1]!;
  appendFileSync(join(DIR, newest), `${body.endsWith("\n") ? "" : "\n"}--> statement-breakpoint\n-- Search index delta (printed by scripts/genSearchDdl.ts).\n${delta.join("\n--> statement-breakpoint\n")}\n`);
  console.error(`appended ${delta.length} search DDL statement(s) to ${newest} - it must be a migration production has not applied`);
} else {
  console.error(delta.join("\n--> statement-breakpoint\n"));
  throw new Error(
    `the search triggers the migrations create differ from the registry. Append the ${delta.length} statement(s) above to ` +
      `the newest migration (${files[files.length - 1]}), or re-run with --write; 0000 is applied to the live database and is never rewritten.`,
  );
}
