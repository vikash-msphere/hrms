// Checks the generated collection-change-stamp DDL (the triggers behind `GET /v1/changes`) against the migration
// that carries it, exactly as scripts/genSearchDdl.ts does for the search index - drizzle-kit cannot emit
// triggers.
//
// The block lives in 0000, which production has applied, and migrations are append-only, so this never writes
// (see genSearchDdl.ts for why). An unchanged block passes; a changed one - a new collection or table adds
// triggers - fails, naming the file, because those triggers then have to go into the new migration by hand.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genChangeDdl.ts        (or just `npm run db:generate`)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderChangeDdl, CHANGE_DDL_MARKER } from "../src/db/changeDdl";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const holders = files.filter((f) => readFileSync(join(DIR, f), "utf8").includes(CHANGE_DDL_MARKER));
if (holders.length !== 1) {
  throw new Error(`expected the generated change DDL in exactly one migration in ${DIR}, found it in ${holders.length}: ${holders.join(", ")}`);
}

const path = join(DIR, holders[0]!);
const current = readFileSync(path, "utf8");
const block = current.slice(current.indexOf(CHANGE_DDL_MARKER)).trim();
if (block !== renderChangeDdl().trim()) {
  throw new Error(
    `change DDL changed, but its block lives in ${path}, which is applied to the live database and is never rewritten. ` +
      "Write the new or changed stamp triggers into the newest migration by hand (DROP TRIGGER + CREATE TRIGGER), " +
      "and extend test/changeDdlDrift.test.ts to read them from there.",
  );
}
console.error(`change DDL unchanged in ${path}`);
