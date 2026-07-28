/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { renderSearchDdl, SEARCH_DDL_MARKER } from "../src/db/searchDdl";
import { SEARCH_INDEX } from "../src/domain/searchIndex";

// The FTS index and its sync triggers are GENERATED from SEARCH_INDEX and appended to the single migration by
// `npm run db:generate` (drizzle-kit emits neither virtual tables nor triggers). Nothing at runtime would fail
// if the two fell out of step - search would just quietly stop covering a renamed column, or index a stale
// expression - so this gate makes that impossible: change the registry or the schema, re-run db:generate.
const files = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(files).sort();
const migration = paths.length === 1 ? files[paths[0]!]! : "";

describe("generated search DDL matches the migration", () => {
  it("keeps exactly one squashed migration", () => {
    expect(paths.length, `expected one migration, found: ${paths.join(", ")}`).toBe(1);
  });

  it("has the generated block, byte-identical to the generator's output", () => {
    const cut = migration.indexOf(SEARCH_DDL_MARKER);
    expect(cut, "no generated search DDL in the migration - run `npm run db:generate`").toBeGreaterThan(0);
    expect(migration.slice(cut).trim(), "search DDL is stale - run `npm run db:generate`").toBe(renderSearchDdl().trim());
  });

  it("covers every searchable collection with insert, update and delete triggers", () => {
    const ddl = renderSearchDdl();
    const missing = SEARCH_INDEX.flatMap((e) => {
      const slug = e.collection.replace(/-/g, "_");
      return (["ai", "au", "ad"] as const)
        .filter((kind) => !ddl.includes(`CREATE TRIGGER "search_${kind}_${slug}"`))
        .map((kind) => `${e.collection}:${kind}`);
    });
    expect(missing).toEqual([]);
  });

  // The vitest harness applies migrations by splitting on `--> statement-breakpoint`, but WRANGLER ignores
  // those comments and re-parses the SQL itself. So a file that every test applies happily can still fail
  // `wrangler d1 migrations apply`. This replays wrangler's own splitter rules (src/d1/splitter.ts) to catch
  // that here instead of at deploy time. It bit once already: `CASE ... END,` inside an expression list opens
  // a compound statement that never closes (END must be followed by `;` or whitespace), so every subsequent
  // `;` is swallowed and the remainder of the file is sent as ONE statement -> "statement too long: SQLITE_TOOBIG".
  const isCompoundStart = (s: string) => /\s(BEGIN|CASE)\s$/i.test(s);
  const isCompoundEnd = (s: string) => /\sEND[;\s]$/.test(s);
  function wranglerSplit(sql: string): string[] {
    const out: string[] = [];
    let str = "";
    let depth = 0;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i]!;
      if (depth > 0 && isCompoundEnd(str + ch)) depth--;
      if (ch === "'" || ch === '"' || ch === "`") {
        let j = i + 1;
        while (j < sql.length && sql[j] !== ch) j++;
        str += sql.slice(i, j + 1);
        i = j;
      } else if (ch === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        i = nl < 0 ? sql.length : nl;
        str += "\n";
      } else if (ch === ";" && depth === 0) {
        out.push(str);
        str = "";
      } else {
        str += ch;
      }
      if (isCompoundStart(str)) depth++;
    }
    out.push(str);
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  it("splits the way wrangler will, into statements D1 will accept", () => {
    const statements = wranglerSplit(migration);
    // Every statement must be comfortably under D1's ~100KB per-statement ceiling.
    const oversized = statements.filter((s) => Buffer.byteLength(s) > 90_000).map((s) => `${Buffer.byteLength(s)}B: ${s.slice(0, 80)}…`);
    expect(oversized, "wrangler would send an oversized statement - SQLITE_TOOBIG").toEqual([]);
    // And it must find as many statements as the file declares breakpoints: a splitter that swallowed
    // separators collapses hundreds of statements into a handful, which is exactly the failure above.
    const declared = migration.split("--> statement-breakpoint").filter((s) => s.trim()).length;
    expect(statements.length).toBe(declared);
  });

  // Case-SENSITIVE on purpose: the generator emits SQL keywords uppercase, and wrangler strips comments before
  // splitting, so the English word "case" in a comment is harmless and must not fail this.
  it("uses no bare CASE in the generated DDL (wrangler's splitter cannot close it)", () => {
    expect(renderSearchDdl()).not.toMatch(/\sCASE\s/);
  });

  it("indexes every column the registry says it matches on", () => {
    const ddl = renderSearchDdl();
    const missing: string[] = [];
    for (const e of SEARCH_INDEX) {
      for (const prop of e.match) {
        const sqlName = (e.table as Record<string, { name?: string }>)[prop]?.name;
        if (!sqlName) missing.push(`${e.collection}.${prop} (no such column)`);
        else if (!ddl.includes(`new."${sqlName}"`)) missing.push(`${e.collection}.${sqlName} (not in any trigger)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
