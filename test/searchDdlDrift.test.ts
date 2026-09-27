/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { appliedSearchTriggers, FTS_TABLE_DDL, renderSearchDdl, searchDdlDelta, searchTriggersIn, SEARCH_DDL_MARKER } from "../src/db/searchDdl";
import { SEARCH_INDEX } from "../src/domain/searchIndex";
import { STATE_VISIBILITY } from "../bootstrap/authz/policy";

// The FTS index and its sync triggers are GENERATED from SEARCH_INDEX (drizzle-kit emits neither virtual tables
// nor triggers). Nothing at runtime would fail if the two fell out of step - search would just quietly stop
// covering a renamed column, or index a stale expression - so this gate makes that impossible. The full block
// lives in 0000, which the live database has applied; later changes ship as DELTAS in newer migrations, so the
// question is what every migration leaves in place, applied in order (src/db/searchDdl.ts).
const files = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(files).sort();
const applied = appliedSearchTriggers(paths.map((p) => files[p]!));

describe("generated search DDL matches the migrations", () => {
  it("leaves exactly the generator's triggers in place once every migration has applied", () => {
    expect(
      searchDdlDelta(applied, STATE_VISIBILITY),
      "search triggers drifted - run `node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts --write` on a new migration",
    ).toEqual([]);
  });

  it("creates the FTS table exactly as the generator describes it, once", () => {
    // The table is not part of the delta: changing its columns is a rebuild of every trigger and every row.
    expect(paths.filter((p) => files[p]!.includes(FTS_TABLE_DDL))).toHaveLength(1);
    expect(paths.filter((p) => files[p]!.includes(SEARCH_DDL_MARKER))).toHaveLength(1);
  });

  it("backfills a collection in the migration that first indexes it", () => {
    // A collection whose triggers arrive after 0000 has rows already; without its backfill they are never found.
    const missing: string[] = [];
    for (const [i, p] of paths.entries()) {
      if (i === 0) continue;
      const before = appliedSearchTriggers(paths.slice(0, i).map((q) => files[q]!));
      for (const name of searchTriggersIn(files[p]!).keys()) {
        const m = name.match(/^search_ai_(.+)$/);
        if (!m || before.has(name)) continue;
        const collection = SEARCH_INDEX.find((e) => e.collection.replace(/-/g, "_") === m[1])?.collection;
        if (collection && !new RegExp(`INSERT OR IGNORE INTO "search_docs" \\([^)]*\\) SELECT '${collection}'`).test(files[p]!)) missing.push(`${p}: ${collection}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every searchable collection with insert, update and delete triggers", () => {
    const ddl = renderSearchDdl(STATE_VISIBILITY);
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

  // Over EVERY migration, not just the one carrying the generated block: a hand-written migration goes through
  // the same splitter at deploy time.
  it.each(paths)("splits %s the way wrangler will, into statements D1 will accept", (path) => {
    const sql = files[path]!;
    const statements = wranglerSplit(sql);
    // Every statement must be comfortably under D1's ~100KB per-statement ceiling.
    const oversized = statements.filter((s) => Buffer.byteLength(s) > 90_000).map((s) => `${Buffer.byteLength(s)}B: ${s.slice(0, 80)}…`);
    expect(oversized, "wrangler would send an oversized statement - SQLITE_TOOBIG").toEqual([]);
    // And it must find as many statements as the file declares breakpoints: a splitter that swallowed
    // separators collapses hundreds of statements into a handful, which is exactly the failure above.
    const declared = sql.split("--> statement-breakpoint").filter((s) => wranglerSplit(s).length > 0).length;
    expect(statements.length).toBe(declared);
  });

  // Case-SENSITIVE on purpose: the generator emits SQL keywords uppercase, and wrangler strips comments before
  // splitting, so the English word "case" in a comment is harmless and must not fail this.
  it("uses no bare CASE in the generated DDL (wrangler's splitter cannot close it)", () => {
    expect(renderSearchDdl(STATE_VISIBILITY)).not.toMatch(/\sCASE\s/);
  });

  it("indexes every column the registry says it matches on", () => {
    const ddl = renderSearchDdl(STATE_VISIBILITY);
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
