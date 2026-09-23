// Appends the generated search DDL (FTS5 table + sync triggers + backfill) to the single Drizzle migration.
// drizzle-kit cannot emit virtual tables or triggers, so this runs straight after `drizzle-kit generate` -
// see the `db:generate` script. Idempotent: an existing block is replaced, never duplicated, so it survives
// the "squash back to one migration" workflow without any manual step.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts        (or just `npm run db:generate`)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSearchDdl, SEARCH_DDL_MARKER } from "../src/db/searchDdl";

const DIR = "src/db/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
if (files.length !== 1) {
  // The repo keeps exactly one squashed migration; more than one means the squash was left half-done and we
  // would not know which file the DDL belongs to.
  throw new Error(`expected exactly one migration in ${DIR}, found ${files.length}: ${files.join(", ")}`);
}

const path = join(DIR, files[0]!);
const current = readFileSync(path, "utf8");
const cut = current.indexOf(SEARCH_DDL_MARKER);
// Cut at the marker, then drop the separator the previous run wrote just above it - otherwise each re-run
// keeps the old breakpoint AND adds a fresh one, so the file grows a blank statement every time.
const base = (cut >= 0 ? current.slice(0, cut) : current)
  .replace(/\s*$/, "")
  .replace(/(?:\s*-->\s*statement-breakpoint)+\s*$/, "")
  .replace(/\s*$/, "");
writeFileSync(path, `${base}\n--> statement-breakpoint\n${renderSearchDdl()}\n`);
console.error(`search DDL ${cut >= 0 ? "replaced in" : "appended to"} ${path}`);
