/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { SEARCH_INDEX, TEXT_PINNED } from "../src/domain/searchIndex";
import { INDEXABLE } from "../src/domain/aiPolicy";
import { LIST_OWNER_COLUMNS, TABLES } from "../src/lib/authzResolve";

// The gate `domain/searchIndex.ts` names in its own header, and did not have.
//
// That file states its threat model in as many words: `scoping` MIRRORS the collection's real list service, so
// a search hit is exactly a row the caller's list of that collection would have returned - and "getting
// `scoping` wrong is the one way this file can leak, so it is checked against the services by
// test/searchIndex.test.ts". This file did not exist. The three suites that import SEARCH_INDEX
// (globalSearch, searchDdlDrift, activityCounts) check weaker things: that a declared column resolves, that a
// `scoped` entry's table has a `code` column, that every searchable collection has an entry. None of them
// compared `scoping` against what the collection's list actually binds, which is the one property the header
// calls load-bearing.
//
// Checking it mechanically found exactly one disagreement: `announcements` was `flat` while
// services/announcements.ts#visibleWhere binds the author column, so an `own`-breadth caller's board showed
// only their own posts while ⌘K returned the title and subtitle of every post in the org. Inert on the seeded
// policy (every role holds `announcements.**`), live the moment an admin narrows announcements through the ACL.
//
// The comparison is against `LIST_OWNER_COLUMNS` - the registry test/listOwnerColumns.test.ts already holds
// against the services' own `applyScope` bindings - so the chain is: services -> LIST_OWNER_COLUMNS ->
// SEARCH_INDEX, with a test on each link.

// Entries whose search scoping deliberately differs from the list registry, each with the reason. An exception
// is a claim that search is TIGHTER than the list, never looser; adding one is a decision, not a formality.
const EXEMPT: Record<string, string> = {
  // The service hard-pins every read to the caller's own recipient id regardless of grant, which is tighter
  // than any breadth the registry could express - so it is `self` here rather than `scoped`.
  notifications: "list hard-pins to the caller (self), which no owner column can express",
};

describe("search index scoping mirrors the list services", () => {
  it("every entry's scoping agrees with LIST_OWNER_COLUMNS", () => {
    const drift: string[] = [];
    for (const entry of SEARCH_INDEX) {
      if (EXEMPT[entry.collection]) continue;
      const owner = LIST_OWNER_COLUMNS[entry.collection];
      if (entry.scoping.kind === "flat") {
        // A flat catalogue's list binds no owner. `code` is the exception: a code-scoped list is a subtree
        // filter over the collection's own codes, which search applies through the same `code` column.
        if (owner && owner !== "code") {
          drift.push(`${entry.collection}: search says flat, list binds "${owner}"`);
        }
        continue;
      }
      if (entry.scoping.kind === "self") {
        drift.push(`${entry.collection}: declared self with no exemption - say why in EXEMPT`);
        continue;
      }
      if (!owner) {
        drift.push(`${entry.collection}: search scopes by "${entry.scoping.owner}", list binds no owner`);
        continue;
      }
      if (owner !== entry.scoping.owner) {
        drift.push(`${entry.collection}: search scopes by "${entry.scoping.owner}", list binds "${owner}"`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("every scoping owner is a real column on the entry's table", () => {
    const bad: string[] = [];
    for (const entry of SEARCH_INDEX) {
      if (entry.scoping.kind === "flat") continue;
      if (!entry.table[entry.scoping.owner]) bad.push(`${entry.collection}: no column "${entry.scoping.owner}"`);
    }
    expect(bad).toEqual([]);
  });

  it("every entry names a collection the authz registry knows, on that collection's table", () => {
    const bad: string[] = [];
    for (const entry of SEARCH_INDEX) {
      const table = TABLES[entry.collection];
      if (!table) bad.push(`${entry.collection}: not in TABLES`);
      else if (table !== entry.table) bad.push(`${entry.collection}: indexes a different table than the authz registry resolves`);
    }
    expect(bad).toEqual([]);
  });

  it("every exemption names a collection that is actually in the index", () => {
    const stale = Object.keys(EXEMPT).filter((c) => !SEARCH_INDEX.some((e) => e.collection === c));
    expect(stale).toEqual([]);
  });
});

// What the semantic index embeds. A noun on every indexable collection, because a bare title says nothing of
// what the row is - EXCEPT the text-pinned ones, whose stored vectors other features compare to each other
// against thresholds tuned on the bare text (see TEXT_PINNED). Adding a noun to one of those is a re-tuning of
// four duplicate thresholds, not a search tweak.
describe("search index embed text", () => {
  it("every indexable collection has a noun, and no text-pinned one does", () => {
    const bad: string[] = [];
    for (const collection of INDEXABLE) {
      const entry = SEARCH_INDEX.find((e) => e.collection === collection);
      if (!entry) bad.push(`${collection}: indexable but not in SEARCH_INDEX`);
      else if (TEXT_PINNED.has(collection) && (entry.noun || entry.embedSubtitle === false)) bad.push(`${collection}: text-pinned but changes its embed text`);
      else if (!TEXT_PINNED.has(collection) && !entry.noun) bad.push(`${collection}: no noun`);
    }
    expect(bad).toEqual([]);
  });

  it("every text-pinned collection is indexable", () => {
    expect([...TEXT_PINNED].filter((c) => !INDEXABLE.has(c))).toEqual([]);
  });
});
