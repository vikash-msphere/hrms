// Checks the collection-change-stamp triggers (the ones behind `GET /v1/changes`) that the migrations create
// against what the registry describes - drizzle-kit cannot emit triggers.
//
// The generated block lives in 0000, which production has applied, and migrations are append-only, so this never
// writes. The triggers the migrations leave in place, applied in order, are compared with the generator's
// (src/db/changeDdl.ts#appliedChangeTriggers). They match: pass. They differ - a new collection or table adds
// triggers - and this prints exactly what the newest migration has to carry (CREATE for a new trigger, DROP +
// CREATE for a changed one) and fails, because that SQL has to be written into the migration by hand.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genChangeDdl.ts        (or just `npm run db:generate`)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appliedChangeTriggers, changeDdlDelta, CHANGE_DDL_MARKER } from "../src/db/changeDdl";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(join(DIR, f), "utf8"));
const holders = files.filter((_, i) => sql[i]!.includes(CHANGE_DDL_MARKER));
if (holders.length !== 1) {
  throw new Error(`expected the generated change DDL in exactly one migration in ${DIR}, found it in ${holders.length}: ${holders.join(", ")}`);
}

const delta = changeDdlDelta(appliedChangeTriggers(sql));
if (delta.length) {
  console.error(delta.join("\n--> statement-breakpoint\n"));
  throw new Error(
    `the change-stamp triggers the migrations create differ from the registry. Append the ${delta.length} statement(s) above to ` +
      `the newest migration (${files[files.length - 1]}), separated by statement breakpoints; ${holders[0]} is applied to the ` +
      "live database and is never rewritten.",
  );
}
console.error(`change DDL matches the registry across ${files.length} migrations`);
