import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";
import "../src/index"; // mounting every collection is what fills the registry below
import { declaredPurgeCascades } from "../src/http/collectionRoute";
import type { PurgeCascade } from "../src/services/softDelete";
import { BOARD_PURGE_CASCADE } from "../src/services/boards";
import { CARD_PURGE_CASCADE } from "../src/services/cards";
import { SPRINT_PURGE_CASCADE } from "../src/services/sprints";
import { SUGGESTION_PURGE_CASCADE } from "../src/services/suggestions";
import { TRANSITION_PURGE_CASCADE } from "../src/services/transitions";
import { REVIEW_CYCLE_PURGE_CASCADE } from "../src/services/reviewCycles";

// The hand-written purges. A collection whose purge is bespoke (it has grandchildren, or side effects) does
// not go through the factory spec, so it cannot register itself - it is listed here instead, and the source
// guard at the bottom is what stops the next one being written as an inline literal nothing checks.
const HAND_WRITTEN: { collection: string; table: unknown; cascade: PurgeCascade }[] = [
  { collection: "boards", table: schema.boards, cascade: BOARD_PURGE_CASCADE },
  { collection: "cards", table: schema.cards, cascade: CARD_PURGE_CASCADE },
  { collection: "sprints", table: schema.sprints, cascade: SPRINT_PURGE_CASCADE },
  { collection: "suggestions", table: schema.suggestions, cascade: SUGGESTION_PURGE_CASCADE },
  { collection: "transitions", table: schema.transitions, cascade: TRANSITION_PURGE_CASCADE },
  { collection: "review-cycles", table: schema.reviewCycles, cascade: REVIEW_CYCLE_PURGE_CASCADE },
];

// A DECLARED TEARDOWN MUST BE COMPLETE.
//
// `purgeCascade` (services/softDelete.ts) says what a hard purge takes with it: `remove` for the rows that
// exist only as part of this one, `detach` for the columns that merely point at it. Declaring nothing is a
// legitimate choice - an employee with payslips is a row the org may not quietly erase, and the foreign key
// answering 409 is the intended behaviour. Declaring SOME of them is not a choice, it is a bug, because of
// the order the purge runs in: the listed children go first and the row itself last, so a foreign key nobody
// listed fails the final DELETE after the listed children are already gone. The caller is told "still
// referenced by other records and cannot be permanently deleted" - which reads as "nothing happened" - over
// a record whose children have been destroyed.
//
// That is not hypothetical. `goals` declared five of its seven references: `goals.blocked_by_id` (the goal
// this one blocks) and `projects.goal_id` were missing, so force-purging any goal that blocked another or
// that a project delivered destroyed its comments, watchers and contributors and then refused. The purge is
// batched now, so the refusal rolls the children back - but a cascade that has to be rolled back is one that
// was wrong, and rollback only covers the foreign key that ERRORS. This test is the half that keeps the
// declaration honest in the first place, and it fails the moment a new table points at an already-declared
// parent without being listed.
describe("purge cascades cover every foreign key that points at the row", () => {
  // Every FK in the schema, as (child table name, child column name, parent table object).
  const references = (() => {
    const out: { childName: string; childTable: unknown; column: string; parent: unknown }[] = [];
    for (const [name, table] of Object.entries(schema as Record<string, unknown>)) {
      if (!table || typeof table !== "object") continue;
      let cfg: ReturnType<typeof getTableConfig>;
      try {
        cfg = getTableConfig(table as never);
      } catch {
        continue; // not a table (an enum, a helper, a type)
      }
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        out.push({ childName: name, childTable: table, column: ref.columns[0]!.name, parent: ref.foreignTable });
      }
    }
    return out;
  })();

  it("finds the schema's foreign keys at all", () => {
    // A guard on the guard: if drizzle ever stops exposing inline `.references()` here, every assertion below
    // would pass vacuously and the drift this file exists to catch would go unnoticed.
    expect(references.length).toBeGreaterThan(100);
  });

  it("has a registry to check", () => {
    expect(declaredPurgeCascades().size).toBeGreaterThan(0);
  });

  const all = [...[...declaredPurgeCascades()].map(([collection, v]) => ({ collection, ...v })), ...HAND_WRITTEN];

  for (const { collection, table, cascade } of all) {
    it(`${collection}: every reference to it is either removed or detached`, () => {
      const covered = new Set<string>();
      for (const { table: t, column } of [...(cascade.remove ?? []), ...(cascade.detach ?? [])]) {
        covered.add(`${getTableConfig(t).name}.${column.name}`);
      }
      const missing = references
        .filter((r) => r.parent === table)
        .map((r) => `${getTableConfig(r.childTable as never).name}.${r.column}`)
        .filter((key) => !covered.has(key));
      expect(
        [...new Set(missing)],
        `these foreign keys point at ${collection} and the purge cascade does not name them - the purge deletes the children it DOES name before the row it then cannot delete, so an unlisted reference means data destroyed and a 409 anyway. Add each to \`remove\` (part of the row) or \`detach\` (a pointer from a record with its own life).`,
      ).toEqual([]);
    });
  }

  // THE POINTERS THAT ARE NOT FOREIGN KEYS, which is the blind spot in everything above.
  //
  // Every assertion so far reads the schema's own `.references()`, and a column that points at a row WITHOUT
  // one is invisible to all of it - SQLite never refuses the purge over such a pointer, so the DELETE succeeds
  // and nothing signals a problem. There are exactly two in the schema, and both were found the hard way:
  //
  //   `access_rules.match_code`  - the per-object ACL rules naming the purged row by its `code`. They outlived
  //                                their target silently, rendering in the ACL surface as an entry whose object
  //                                no longer resolves and deciding nothing.
  //   `attachments.object_id`    - the file behind the row, keyed `(collection, object_id)`. A hard purge left
  //                                the encrypted R2 object AND the metadata row carrying `file_name` behind -
  //                                and a resume's filename is routinely the person's name. Seven soft-deletable
  //                                collections write here, and `?force` is the operation reached for to honour
  //                                an erasure request, which made it the one operation that kept the document.
  //
  // Both are swept generically inside `purgeRow` (no per-collection declaration to get wrong). This test pins
  // that: it asserts the sweep exists for each, and - the part that catches the NEXT one - that the schema has
  // grown no third FK-less pointer at a purged row without somebody deciding what happens to it.
  it("sweeps the pointers that carry no foreign key, and knows of no third one", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const softDelete = Object.entries(sources).find(([p]) => p.endsWith("/softDelete.ts"))![1];

    // The access-rules sweep: exact rules in this collection's namespace naming the purged code.
    expect(softDelete).toMatch(/delete\(schema\.accessRules\)[\s\S]{0,200}?matchCode/);
    // The attachments sweep: the metadata rows in the batch, and the R2 objects they name after it commits.
    expect(softDelete).toMatch(/delete\(schema\.attachments\)[\s\S]{0,200}?objectId/);
    expect(softDelete).toMatch(/deps\.docs\.delete\(/);
    // ...including the two stored objects that hang off a COLUMN rather than off `attachments`.
    expect(softDelete).toMatch(/photoKey/);
    expect(softDelete).toMatch(/signatureKey/);

    // A third FK-less pointer would look like a column named `*_id` / `*_code` / `*_key` on a table that
    // declares no foreign key for it. Rather than re-deriving that (which would flag every legitimate scalar),
    // pin the two tables that are known to carry one: if a NEW table starts storing a `collection` +
    // `object_id` pair, it is the same shape and needs the same sweep.
    const objectPointerTables = Object.entries(schema as Record<string, unknown>).filter(([, table]) => {
      if (!table || typeof table !== "object") return false;
      let cfg: ReturnType<typeof getTableConfig>;
      try {
        cfg = getTableConfig(table as never);
      } catch {
        return false;
      }
      const names = new Set(cfg.columns.map((col) => col.name));
      const pointsAtAnyRow = names.has("object_id") || names.has("match_code");
      return pointsAtAnyRow && !cfg.foreignKeys.some((fk) => ["object_id", "match_code"].includes(fk.reference().columns[0]!.name));
    }).map(([name]) => name);

    expect(
      objectPointerTables.sort(),
      "these tables point at an arbitrary row without a foreign key, so SQLite will not refuse a purge over them and purgeCascade cannot express them - each needs a sweep inside purgeRow",
    ).toEqual(["accessRules", "attachments"]);
  });

  // A cascade written inline at the `purgeRow` call site is one this file cannot see, and every gap found so
  // far was in a teardown nobody was holding against the schema. So a bespoke purge must name its cascade,
  // export it, and add it to HAND_WRITTEN above - which is a line of work that buys a permanent check.
  it("has no purge cascade written as an inline literal", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const inline: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith("/softDelete.ts")) continue;
      // `purgeRow(...)` whose cascade argument opens an object literal carrying remove/detach, rather than
      // naming a constant. `{ ...NAME, first }` is fine - the spread names one.
      for (const m of src.matchAll(/purgeRow\([^;]*?,\s*\{\s*(?:first:[^;]*?)?(?:remove|detach):/gs)) {
        if (!/\{\s*\.\.\./.test(m[0])) inline.push(`${path.split("/").pop()}`);
      }
    }
    expect([...new Set(inline)], "name this cascade, export it, and list it in HAND_WRITTEN so it is checked against the schema's foreign keys").toEqual([]);
  });
});
