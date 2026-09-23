// Freeze the migrations that a live database has already applied.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/freezeMigrations.ts
//
// WHY THIS EXISTS. `wrangler d1 migrations apply` records what it has run by TAG in the remote
// `d1_migrations` table, and compares nothing about the file's contents. A migration whose tag the database
// has already seen is skipped, whatever is inside it now.
//
// This repo is developed against that fact rather than around it: nothing is deployed, so the schema is kept
// as ONE migration and `npm run db:generate` re-squashes it in place under the same `0000_*` tag. That is
// right up until the first production deploy and silently wrong forever after - the squashed file changes,
// the deploy is green, wrangler skips the tag, and the remote schema never moves. Nothing fails until a query
// hits a column that was never added.
//
// So the moment a migration reaches a real database, it stops being editable. This writes down which ones
// those are and what they contained; `npm run preflight` refuses a deploy that has changed one of them, and
// says to add a new numbered migration instead.
//
// WHEN TO RUN IT: once, right after the first production `npm run db:migrate:remote` (docs/deploy.md step
// 7a), and again after each later deploy that applies a new migration. It is idempotent - re-running it with
// nothing changed rewrites the same file.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, "src/db/migrations");
const lock = resolve(dir, "meta/_frozen.json");

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
if (!files.length) {
  console.error("no migrations found in src/db/migrations - run `npm run db:generate` first.");
  process.exit(1);
}

const previous: Record<string, string> = (() => {
  try {
    return JSON.parse(readFileSync(lock, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
})();

const frozen: Record<string, string> = {};
const changed: string[] = [];
for (const f of files) {
  const tag = f.replace(/\.sql$/, "");
  const hash = createHash("sha256").update(readFileSync(resolve(dir, f), "utf8")).digest("hex");
  frozen[tag] = hash;
  // Re-freezing a tag at a DIFFERENT hash is the whole hazard, stated out loud: it means the file was edited
  // after it had been applied somewhere, so the remote schema and this file already disagree. Freezing the new
  // contents would paper over that, so it is reported rather than done quietly.
  if (previous[tag] && previous[tag] !== hash) changed.push(tag);
}

if (changed.length) {
  console.error(`REFUSING to re-freeze: ${changed.join(", ")} already had a different hash recorded.`);
  console.error("That file was edited after it was applied to a database, so the remote schema is already behind it.");
  console.error("Restore the original contents (git) and put the change in a NEW numbered migration, then run this again.");
  process.exit(1);
}

writeFileSync(lock, `${JSON.stringify(frozen, null, 2)}\n`);
const added = Object.keys(frozen).filter((t) => !previous[t]);
console.log(`froze ${Object.keys(frozen).length} migration(s) in src/db/migrations/meta/_frozen.json${added.length ? ` (new: ${added.join(", ")})` : " (no change)"}`);
