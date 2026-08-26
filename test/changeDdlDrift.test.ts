/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { renderChangeDdl, CHANGE_DDL_MARKER } from "../src/db/changeDdl";
import { TABLES } from "../src/lib/authzResolve";

// The change stamps and their triggers are GENERATED from the authz collection->table registry and appended to
// the single migration by `npm run db:generate` (drizzle-kit emits no triggers). Nothing at runtime would fail
// if the two fell out of step, which is the danger: a collection whose trigger was never generated is reported
// as "unchanged" forever, so every client keeps serving whatever it had stored. That is a silent wrong answer,
// so it gets a gate.
const files = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(files).sort();
const migration = paths.length === 1 ? files[paths[0]!]! : "";

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

  it("emits one statement per trigger, none of them comment-only", () => {
    const statements = renderChangeDdl().split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(Object.keys(TABLES).length * 3);
    // A piece holding only comments is rejected by D1 ("SQL code did not contain a statement"), which is why
    // the header rides on the first trigger rather than standing alone.
    const commentOnly = statements.filter((s) => s.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("--")));
    expect(commentOnly).toEqual([]);
  });
});
