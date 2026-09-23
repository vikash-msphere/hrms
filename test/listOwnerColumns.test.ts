/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import * as schema from "../src/db/schema";
import { LIST_OWNER_COLUMNS, TABLES, listOwnerColumn } from "../src/lib/authzResolve";

// The owner column a list binds is written down in ONE place, and this is what keeps it true.
//
// WHY THIS EXISTS. `applyScope(scope, code, owner)` is how every list turns the middleware's breadth verdict
// into a WHERE, and the owner column was only ever passed inline at each call site. That was enough while a
// collection's own list service was the only thing scoping its table. The table builder scopes ~50 of them
// (services/tableRun.ts) plus every link target it follows, and it cannot read a call site - so it guessed
// `table.employeeId` for all of them. Right for the thirty-odd employee-owned collections; wrong for
// `employees` (`uuid`), `assets` (`assignedTo`), `referrals` (`referrerId`), `suggestions` (`submitterId`),
// `transition-tasks` (`assigneeId`), `approval-delegations` (`delegatorId`). A guess that misses is
// `undefined`, `applyScope` fails CLOSED on that, and an own-breadth caller got an empty grid - and through
// the link lane a blank employee column on grids that otherwise worked. Nothing leaked; it was just wrong,
// silently, for the callers least likely to be the ones testing it.
//
// So the map exists, and a second copy of a rule is a rule that drifts. This reads the services back and
// fails when one of them binds a column the map does not name. It is a SOURCE scan on purpose: the binding
// is an argument at a call site, so there is no runtime value to assert against.
const modules = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// `applyScope(<scope>, <ns>.<table>.code, <ns>.<table>.<owner>)` on one line, which is how every hand-written
// list binds it. `<ns>` is `schema` or the `t` alias the summary services import it under. A call whose owner
// is `undefined` or a local variable is not matched - those are the collection factory's generic list
// (services/crud.ts) and documentService's owned/org branch, both accounted for in the map's own comment.
const BINDING = /applyScope\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*(?:schema|t)\.([A-Za-z0-9_]+)\.code\s*,\s*(?:schema|t)\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\)/g;

/** Drizzle export name -> wire collection, by identity against the authz registry. */
const collectionOf = new Map<string, string>();
for (const [prop, table] of Object.entries(schema)) {
  const hit = Object.entries(TABLES).find(([, t]) => t === table);
  if (hit) collectionOf.set(prop, hit[0]);
}

describe("list owner columns", () => {
  it("every applyScope binding in the services agrees with LIST_OWNER_COLUMNS", () => {
    const drift: string[] = [];
    for (const [path, src] of Object.entries(modules)) {
      src.split("\n").forEach((raw, i) => {
        const line = raw.replace(/\/\/.*$/, "");
        if (/^\s*(\*|\/\*)/.test(raw)) return; // prose, not code
        for (const m of line.matchAll(BINDING)) {
          const [, codeProp, ownerProp, owner] = m as unknown as [string, string, string, string];
          // A binding whose code and owner come off different tables is a join predicate, not a self-scope.
          if (codeProp !== ownerProp) continue;
          const collection = collectionOf.get(codeProp);
          if (!collection) continue; // an internal table with no wire collection (search_docs)
          const mapped = LIST_OWNER_COLUMNS[collection];
          if (mapped !== owner) {
            drift.push(`${path.replace("../", "")}:${i + 1} ${collection} binds "${owner}", map says ${mapped ? `"${mapped}"` : "(absent)"}`);
          }
        }
      });
    }
    expect(drift).toEqual([]);
  });

  it("every mapped collection is a real collection whose table carries the named column", () => {
    const bad: string[] = [];
    for (const [collection, prop] of Object.entries(LIST_OWNER_COLUMNS)) {
      const table = TABLES[collection];
      if (!table) bad.push(`${collection}: not in TABLES`);
      else if (!table[prop]) bad.push(`${collection}: no column "${prop}"`);
    }
    expect(bad).toEqual([]);
  });

  it("resolves the column, and answers undefined rather than guessing for an unmapped or unknown collection", () => {
    expect(listOwnerColumn("employees")).toBe(schema.employees.uuid);
    expect(listOwnerColumn("assets")).toBe(schema.assets.assignedTo);
    expect(listOwnerColumn("leave-requests")).toBe(schema.leaveRequests.employeeId);
    // A flat catalogue: its list binds no owner, so neither does this - `applyScope` reads undefined as
    // "an own breadth matches nothing here", which is exactly what the catalogue's own list does.
    expect(listOwnerColumn("leave-types")).toBeUndefined();
    expect(listOwnerColumn("not-a-collection")).toBeUndefined();
  });
});
