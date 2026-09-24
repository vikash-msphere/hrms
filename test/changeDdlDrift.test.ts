/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { renderChangeDdl, CHANGE_DDL_MARKER, EXTRA_STAMPS, SIDE_STAMPS, UNSTAMPED_TABLES, stampSlug } from "../src/db/changeDdl";
import * as dbSchema from "../src/db/schema";
import { TABLES } from "../src/lib/authzResolve";
import { CATALOG_COLLECTIONS, persistable } from "../web/src/lib/resourceStore";

// The change stamps and their triggers are GENERATED from the authz collection->table registry (drizzle-kit
// emits no triggers), and the block lives in migration 0000, which is applied to the live database and never
// rewritten - `npm run db:generate` only checks it (scripts/genChangeDdl.ts). Nothing at runtime would fail
// if the two fell out of step, which is the danger: a collection whose trigger was never generated is reported
// as "unchanged" forever, so every client keeps serving whatever it had stored. That is a silent wrong answer,
// so it gets a gate.
/** Every table `db/schema.ts` declares, by its SQL name. The module also exports enums and relations, hence
 *  the `unknown[]` widening - `Object.values` over it is a union that no type predicate narrows cleanly. */
function schemaTableNames(): string[] {
  return [
    ...new Set(
      (Object.values(dbSchema) as unknown[])
        .filter((v): v is SQLiteTable => v instanceof SQLiteTable)
        .map((t) => getTableConfig(t).name),
    ),
  ];
}

const files = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(files).sort();
const holders = paths.filter((p) => files[p]!.includes(CHANGE_DDL_MARKER));
const migration = holders.length === 1 ? files[holders[0]!]! : "";

describe("generated change-stamp DDL matches the migration", () => {
  it("has the generated block, byte-identical to the generator's output", () => {
    const cut = migration.indexOf(CHANGE_DDL_MARKER);
    expect(cut, "no generated change DDL in migration - run `npm run db:generate`").toBeGreaterThan(0);
    expect(migration.slice(cut).trim(), "change DDL stale - run `npm run db:generate`").toBe(renderChangeDdl().trim());
  });

  it("stamps EVERY collection authz knows about, on insert, update and delete", () => {
    const ddl = renderChangeDdl();
    const missing = Object.keys(TABLES).flatMap((collection) => {
      const slug = collection.replace(/-/g, "_");
      return (["i", "u", "d"] as const)
        .filter((kind) => !ddl.includes(`CREATE TRIGGER "chg_${kind}_${slug}"`))
        .map((kind) => `${collection}:${kind}`);
    });
    expect(missing, "a collection with no stamp trigger is reported as never changing").toEqual([]);
  });

  it("writes the stamp into the table the service reads", () => {
    // Both halves name `collection_versions`; a rename on one side alone would leave the feed permanently quiet.
    expect(renderChangeDdl()).toContain('INSERT INTO "collection_versions"');
    expect(renderChangeDdl()).toContain('ON CONFLICT("collection") DO UPDATE');
  });

  // Same trap the search DDL documents: wrangler's splitter treats a bare CASE as opening a compound statement
  // and only closes it on `END` followed by whitespace, so an expression's `END` swallows the rest of the file.
  it("uses no bare CASE in the generated DDL", () => {
    expect(renderChangeDdl()).not.toMatch(/\sCASE\s/);
  });

  it("stamps the tables the client caches from that are not collections", () => {
    // `settings` is the org config snapshot the SPA holds; the policy tables are read by the access UI. None is
    // in the collection registry, so without these the same silent wrong answer applies to them - which is
    // exactly what happened to the settings snapshot: it could not be told it was out of date at all.
    const ddl = renderChangeDdl();
    const missing = EXTRA_STAMPS.flatMap((collection) =>
      (["i", "u", "d"] as const)
        .filter((kind) => !ddl.includes(`CREATE TRIGGER "chg_${kind}_${stampSlug(collection)}"`))
        .map((kind) => `${collection}:${kind}`),
    );
    expect(missing, "a cached table with no stamp trigger is reported as never changing").toEqual([]);
  });

  it("stamps the extra tables under their COLLECTION name, not their table name", () => {
    // `GET /v1/changes` filters its answer to the collections the caller may list, which are named in kebab
    // (`access-rules`). A stamp written as `access_rules` matches nothing there, so the collection could never
    // be reported however often it was written to - a stamp that exists and is unreachable.
    const ddl = renderChangeDdl();
    const wrong = EXTRA_STAMPS.filter((collection) => !ddl.includes(`VALUES ('${collection}',`));
    expect(wrong, "an extra stamp named after its table can never be reported to a client").toEqual([]);
  });

  it("stamps every collection the SPA is allowed to store on disk", () => {
    // The client trusts a stored copy until the feed says otherwise (lib/resourceStore.ts), so a persistable
    // collection with no stamp is stale FOREVER - the one combination that cannot be recovered from. Anything
    // unstamped has to be either stamped or marked memory-only.
    const ddl = renderChangeDdl();
    const unstamped = [...CATALOG_COLLECTIONS].filter((c) => persistable(c) && !ddl.includes(`CREATE TRIGGER "chg_i_${stampSlug(c)}"`));
    expect(unstamped, "persisted on disk but never reported as changed - stamp it, or add it to MEMORY_ONLY").toEqual([]);
  });

  it("stamps the PARENT collection when a side table is written", () => {
    // A row in `event_responses` is not a row anybody lists - it moves the going count on the EVENT. Stamping
    // only what was written would leave every count, reaction and reply the client stores frozen at the value
    // it first read, with the feed insisting nothing had changed.
    const ddl = renderChangeDdl();
    const wrong = SIDE_STAMPS.flatMap(([table, collection]) =>
      (["i", "u", "d"] as const)
        .filter((kind) => !new RegExp(`CREATE TRIGGER "chg_${kind}_${table}" AFTER \\w+ ON "${table}" BEGIN\\s+INSERT INTO "collection_versions" \\("collection", "at"\\) VALUES \\('${collection}'`).test(ddl))
        .map((kind) => `${table}:${kind}`),
    );
    expect(wrong, "a side table that does not stamp its parent collection leaves the parent stale forever").toEqual([]);
  });

  // THE CHECK THAT LOOKS THE OTHER WAY.
  //
  // Every assertion above starts from something we DECLARED - the registry, EXTRA_STAMPS, SIDE_STAMPS - and
  // asks whether the generator honoured it. All of them pass for a table nobody declared anywhere, because it
  // is in none of the lists being iterated. That is not a hypothetical: `goal_watchers`, `goal_contributors`
  // and `card_watchers` each back a field the parent resource ships (`watching`, `watcher_count`,
  // `contributors`), each is written by a verb that touches nothing else, and all three sat unstamped through
  // every test in this file - so `:watch` reported no change to `goals`, and a stored copy kept the old state.
  //
  // Starting from `db/schema.ts` instead closes that direction: a new table is stamped, mapped to the parent
  // it changes, or explained in UNSTAMPED_TABLES. The failure message is the decision to make.
  it("every table in the schema is stamped, mapped to a parent, or declared unstamped", () => {
    const ddl = renderChangeDdl();
    const declared = new Set([...SIDE_STAMPS.map(([t]) => t), ...Object.keys(UNSTAMPED_TABLES)]);
    const missing = schemaTableNames()
      .filter((name) => !declared.has(name) && !ddl.includes(`ON "${name}" BEGIN`))
      .sort();
    expect(
      missing,
      "unstamped and unexplained: a write here is invisible to GET /v1/changes and to the list validator - " +
        "add it to SIDE_TABLES with the collection it changes, or to UNSTAMPED_TABLES with the reason it changes none",
    ).toEqual([]);
  });

  // The other half of the same pair: an entry in UNSTAMPED_TABLES that no longer names a real table is a
  // waiver for nothing, and it would go on silencing the check above if the table were ever re-added.
  it("declares no waiver for a table that does not exist", () => {
    const live = new Set(schemaTableNames());
    expect(Object.keys(UNSTAMPED_TABLES).filter((t) => !live.has(t)), "stale waiver in UNSTAMPED_TABLES").toEqual([]);
  });

  it("emits one statement per trigger, none of them comment-only", () => {
    const statements = renderChangeDdl().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    // + 1 for `attachments`, whose three triggers read the parent collection off the row instead of being
    // generated per mapped collection (see the polymorphic block in db/changeDdl.ts).
    expect(statements).toHaveLength((Object.keys(TABLES).length + EXTRA_STAMPS.length + SIDE_STAMPS.length + 1) * 3);
    // A piece holding only comments is rejected by D1 ("SQL code did not contain a statement"), which is why
    // the header rides on the first trigger rather than standing alone.
    const commentOnly = statements.filter((s) => s.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("--")));
    expect(commentOnly).toEqual([]);
  });
});
