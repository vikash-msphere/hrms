import { describe, it, expect } from "vitest";
import { paginate } from "../src/http/pagination";

// `paginate` sorts a row set in memory and then SEEKS into it with a cursor. Those are two separate
// comparisons of the same tiebreaker key, and they must be the SAME comparison - which is the whole content of
// this file.
//
// They were not. The sort tiebroke with `uid(a).localeCompare(uid(b))` while the seek asked `uid(e) > cur.uid`.
// ICU collation is case-insensitive at its primary level and reorders around punctuation; byte comparison does
// neither. So wherever the two disagreed AND the timestamp tied, findIndex seeked PAST a row that had never
// been returned, and it vanished from the listing entirely - no error, no gap in the token chain, just a
// missing row.
//
// Timestamp ties are not exotic here: the live callers page rows written in one batch (roles by `name`,
// settings and policy by `key`), so every row in those tables shares a timestamp.

/** Page all the way through, one page at a time, the way a client following `next_page_token` does. */
async function pageThrough<T>(rows: T[], size: number, when: (r: T) => number, uid: (r: T) => string): Promise<T[]> {
  const seen: T[] = [];
  let token: string | undefined;
  // Bounded so a comparator that never converges fails as an assertion below rather than hanging the suite.
  for (let guard = 0; guard <= rows.length + 1; guard++) {
    const page = await paginate(rows, size, token, when, uid);
    seen.push(...page.items);
    if (!page.nextPageToken) return seen;
    token = page.nextPageToken;
  }
  throw new Error("pagination did not terminate");
}

describe("paginate: the sort and the cursor seek agree", () => {
  // The exact shape that lost a row: three roles seeded in one write, so all three share `createdAt`, and
  // "employee" vs "HR Admin" is where ICU and byte order disagree. Under localeCompare this paged out as
  // ["employee", "manager"] - "HR Admin" was silently dropped.
  it("returns every row when the tiebreaker mixes case at a shared timestamp", async () => {
    const rows = [
      { name: "HR Admin", at: 1000 },
      { name: "employee", at: 1000 },
      { name: "manager", at: 1000 },
    ];
    const seen = await pageThrough(rows, 1, (r) => r.at, (r) => r.name);
    expect(seen.map((r) => r.name).sort()).toEqual(["HR Admin", "employee", "manager"]);
  });

  // The same hazard one level subtler: '-' sorts before every letter in byte order, but ICU treats punctuation
  // as secondary, so "asset-tags" vs "assets" flips between the two comparisons. These are real setting keys.
  it("returns every row when the tiebreaker mixes hyphens at a shared timestamp", async () => {
    const rows = ["asset-tags", "assets", "employee-number", "employees", "organization"].map((key) => ({ key, at: 5 }));
    const seen = await pageThrough(rows, 1, (r) => r.at, (r) => r.key);
    expect(seen.map((r) => r.key).sort()).toEqual(["asset-tags", "assets", "employee-number", "employees", "organization"]);
  });

  // Page size 1 is the sharpest probe (every row is a boundary), but the invariant is about the comparators,
  // not about a size - so hold it across sizes and a mixed set.
  it("returns every row exactly once at every page size", async () => {
    const rows = [
      { k: "Zebra", at: 1 }, { k: "apple", at: 1 }, { k: "Apple-2", at: 1 }, { k: "apple2", at: 1 },
      { k: "beta", at: 1 }, { k: "BETA", at: 2 }, { k: "gamma-x", at: 2 }, { k: "gammax", at: 2 },
    ];
    const all = rows.map((r) => r.k).sort();
    for (const size of [1, 2, 3, 5, 8, 20]) {
      const seen = await pageThrough(rows, size, (r) => r.at, (r) => r.k);
      expect(seen.map((r) => r.k).sort(), `page size ${size}`).toEqual(all);
    }
  });

  it("orders pages consistently: paging through equals one big page", async () => {
    const rows = [
      { k: "b-1", at: 3 }, { k: "B2", at: 3 }, { k: "a", at: 1 }, { k: "A-", at: 1 }, { k: "c", at: 9 },
    ];
    const oneShot = (await paginate(rows, 100, undefined, (r) => r.at, (r) => r.k)).items.map((r) => r.k);
    const paged = (await pageThrough(rows, 2, (r) => r.at, (r) => r.k)).map((r) => r.k);
    expect(paged).toEqual(oneShot);
  });

  // The default direction is newest-first, and flipping the timestamp must not flip the tiebreaker with it -
  // that would be the same sort-vs-seek disagreement in the other direction.
  it("returns every row exactly once paging newest-first, ties included", async () => {
    const rows = [
      { k: "b-1", at: 3 }, { k: "B2", at: 3 }, { k: "a", at: 1 }, { k: "A-", at: 1 }, { k: "c", at: 9 },
    ];
    const oneShot = (await paginate(rows, 100, undefined, (r) => r.at, (r) => r.k, "desc")).items.map((r) => r.k);
    expect(oneShot[0], "the newest row leads").toBe("c");
    for (const size of [1, 2, 3, 5]) {
      const seen: string[] = [];
      let token: string | undefined;
      for (let guard = 0; guard <= rows.length; guard++) {
        const page = await paginate(rows, size, token, (r) => r.at, (r) => r.k, "desc");
        seen.push(...page.items.map((r) => r.k));
        token = page.nextPageToken;
        if (!token) break;
      }
      expect(seen, `page size ${size}`).toEqual(oneShot);
    }
  });

  // A junk cursor already read as "first page" rather than erroring; keep that, since it is what stops a forged
  // token from being a 500.
  it("treats an unreadable page token as the first page", async () => {
    const rows = [{ k: "a", at: 1 }, { k: "b", at: 2 }];
    expect((await paginate(rows, 10, "not-a-cursor", (r) => r.at, (r) => r.k)).items.length).toBe(2);
  });
});

// The cursor is a RESPONSE FIELD, so its uid half is on the wire. keysetPage always encoded its half through
// the codec; this one did not, and published the internal primary key of every in-memory-paged collection.
// These pin both halves of the fix: what the token carries, and that a round trip through it still pages.
describe("paginate: the cursor's uid half is a wire token, not an internal id", () => {
  // A stand-in for lib/idCodec: reversible and collection-bound, and - the property this file is actually
  // about - its token does not CONTAIN the id it stands for. A stub that embedded the id would pass the
  // round-trip test while making the leak assertion below meaningless, which is the trap the real defect set.
  const table: Record<string, Record<string, string>> = {
    "check-ins": { "0abc1def2ghj3": "wwwwwwwwwwwwwwwwwwwwwwwww1", "0abc1def2ghj4": "wwwwwwwwwwwwwwwwwwwwwwwww2", "0abc1def2ghj5": "wwwwwwwwwwwwwwwwwwwwwwwww3" },
    boards: { "0abc1def2ghj3": "bbbbbbbbbbbbbbbbbbbbbbbbb1" },
  };
  const codec = {
    encode: async (collection: string, id: string) => table[collection]![id]!,
    decode: async (collection: string, token: string) =>
      Object.entries(table[collection] ?? {}).find(([, t]) => t === token)?.[0] ?? null,
  };
  const rows = [
    { uuid: "0abc1def2ghj3", at: 3 }, { uuid: "0abc1def2ghj4", at: 2 }, { uuid: "0abc1def2ghj5", at: 1 },
  ];
  const wire = { codec, collection: "check-ins" };
  const uidOf = (t: string) => Buffer.from(t, "base64url").toString().split("|")[1]!;

  it("never puts the internal id in next_page_token", async () => {
    const page = await paginate(rows, 1, undefined, (r) => r.at, (r) => r.uuid, "desc", wire);
    expect(page.nextPageToken).toBeDefined();
    expect(uidOf(page.nextPageToken!)).toBe("wwwwwwwwwwwwwwwwwwwwwwwww1");
    // The base64url is an encoding, not a wrapper - assert on the decoded text, which is what a client sees.
    expect(Buffer.from(page.nextPageToken!, "base64url").toString()).not.toContain("0abc1def2ghj3");
  });

  it("round-trips: an encoded cursor seeks to the right place", async () => {
    const seen: string[] = [];
    let token: string | undefined;
    for (let guard = 0; guard <= rows.length; guard++) {
      const page = await paginate(rows, 1, token, (r) => r.at, (r) => r.uuid, "desc", wire);
      seen.push(...page.items.map((r) => r.uuid));
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(seen).toEqual(["0abc1def2ghj3", "0abc1def2ghj4", "0abc1def2ghj5"]);
  });

  it("falls back to a timestamp-only bound when the token does not decode", async () => {
    // A cursor minted under another collection (or forged) must not error and must not skip rows - the same
    // fail-safe direction services/keysetPage.ts takes.
    const forged = Buffer.from(`3|bbbbbbbbbbbbbbbbbbbbbbbbb1`).toString("base64url");
    const page = await paginate(rows, 10, forged, (r) => r.at, (r) => r.uuid, "desc", wire);
    expect(page.items.map((r) => r.uuid)).toEqual(["0abc1def2ghj4", "0abc1def2ghj5"]);
  });
});
