// Appends the generated collection-change-stamp DDL (the triggers behind `GET /v1/changes`) to the single
// Drizzle migration, exactly as scripts/genSearchDdl.ts does for the search index - drizzle-kit cannot emit
// triggers. Idempotent: an existing block is replaced, never duplicated, so it survives the "squash back to
// one migration" workflow with no manual step.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genChangeDdl.ts        (or just `npm run db:generate`)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderChangeDdl, CHANGE_DDL_MARKER } from "../src/db/changeDdl";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
if (files.length !== 1) {
  throw new Error(`expected exactly one migration in ${DIR}, found ${files.length}: ${files.join(", ")}`);
}

const path = join(DIR, files[0]!);
const current = readFileSync(path, "utf8");
const cut = current.indexOf(CHANGE_DDL_MARKER);
const base = (cut >= 0 ? current.slice(0, cut) : current)
  .replace(/\s*$/, "")
  .replace(/(?:\s*-->\s*statement-breakpoint)+\s*$/, "")
  .replace(/\s*$/, "");
writeFileSync(path, `${base}\n--> statement-breakpoint\n${renderChangeDdl()}\n`);
console.error(`change DDL ${cut >= 0 ? "replaced in" : "appended to"} ${path}`);
