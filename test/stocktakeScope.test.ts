/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { COUNTABLE_STATUSES, inScope, missingRow, normalizeScope, parseFound, parseScope, scoreStocktake, sightedIn } from "../src/domain/stocktake";
import { SCOPE_PRESETS, inScopeWire, inventoryConfidence, lastClosed, missingPaths, presetOf, reconcileMissing, scopeStatuses, sightedIn as sightedInWeb } from "../web/src/lib/stocktake";

// The scope presets live in the WEB bundle (they are labels), while the count stores the resolved status list
// and the server filters on that. These pin the two halves together: a preset that named a status the server
// would drop, or a browser that disagreed about what "sighted" means, would make a walk and its report
// describe different sets.

const at = (iso: string) => new Date(iso);
const START = at("2026-08-21T09:00:00.000Z");

describe("scope presets stay compatible with the server's filter", () => {
  it("every preset names only statuses the server keeps", () => {
    for (const p of SCOPE_PRESETS) {
      if (!p.statuses) continue;
      expect(normalizeScope({ statuses: p.statuses }).statuses).toEqual(p.statuses);
      for (const s of p.statuses) expect(COUNTABLE_STATUSES as string[]).toContain(s);
    }
  });

  it("the default preset is the walkable one: stock, awaiting check-in, repair - and no assigned kit", () => {
    expect(scopeStatuses("office")).toEqual(["in_stock", "pending_verification", "repair"]);
    expect(scopeStatuses("office")).not.toContain("assigned");
    expect(scopeStatuses("all")).toBeUndefined(); // no filter at all = the whole inventory
  });

  it("a stored scope reads back as the preset that produced it", () => {
    for (const p of SCOPE_PRESETS) {
      const stored = parseScope(JSON.stringify({ ...(p.statuses ? { statuses: p.statuses } : {}) }));
      expect(presetOf(stored)).toBe(p.label);
    }
    expect(presetOf({ statuses: ["repair"] })).toBe("Custom scope");
    expect(presetOf({ statuses: ["in_stock", "pending_verification", "repair"], categories: ["asset-categories/x"] })).toBe("In the office, one category");
  });

  it("unknown statuses are dropped rather than stored, and junk parses to no filter", () => {
    expect(normalizeScope({ statuses: ["in_stock", "teleported"] })).toEqual({ statuses: ["in_stock"] });
    expect(normalizeScope({ statuses: ["teleported"] })).toEqual({});
    expect(parseScope("not json")).toEqual({});
    expect(parseScope(null)).toEqual({});
    expect(parseFound("{}")).toEqual([]);
  });
});

describe("sighted means sighted during the count, in both halves", () => {
  const cases = [
    { label: "scanned after the count began", verifiedAt: at("2026-08-21T10:00:00.000Z"), expected: true },
    { label: "scanned at the exact instant it began", verifiedAt: START, expected: true },
    { label: "last seen before it began", verifiedAt: at("2026-08-01T10:00:00.000Z"), expected: false },
    { label: "never seen", verifiedAt: null, expected: false },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const asset = { uuid: "a1", name: "Laptop", status: "in_stock", verifiedAt: c.verifiedAt };
      expect(sightedIn({ startedAt: START }, asset)).toBe(c.expected);
      // The browser reads the same question off the wire fields it already has.
      expect(
        sightedInWeb({ start_time: START.toISOString() }, { last_verified_time: c.verifiedAt?.toISOString() }),
      ).toBe(c.expected);
    });
  }
});

describe("scoring a count", () => {
  const asset = (over: Partial<Parameters<typeof inScope>[1]> & { uuid: string }) =>
    ({ name: "Thing", status: "in_stock", ...over }) as Parameters<typeof inScope>[1];

  it("splits the scope into sighted and missing, and counts how well each sighting was proved", () => {
    const rows = [
      asset({ uuid: "seen-scanned", verifiedAt: at("2026-08-21T10:00:00.000Z"), verifiedScanned: true }),
      asset({ uuid: "seen-by-hand", verifiedAt: at("2026-08-21T10:05:00.000Z"), verifiedScanned: false }),
      asset({ uuid: "seen-damaged", verifiedAt: at("2026-08-21T10:06:00.000Z"), verifiedScanned: true, custodyState: "damaged" }),
      asset({ uuid: "missing" }),
      asset({ uuid: "out-of-scope", status: "retired" }),
      asset({ uuid: "deleted", deleteTime: at("2026-08-01T00:00:00.000Z") }),
    ];
    const { missing, counts } = scoreStocktake({ startedAt: START, scope: { statuses: ["in_stock"] } }, rows, [{ scan_time: "2026-08-21T10:07:00.000Z" }]);
    expect(counts).toEqual({ scope_total: 4, sighted: 3, scanned: 2, unscanned: 1, flagged: 1, missing: 1, found: 1 });
    expect(missing.map((m) => m.uuid)).toEqual(["missing"]);
  });

  it("a missing row is snapshotted with refs, not names, so the report survives a rename", () => {
    const row = missingRow(asset({ uuid: "a1", assetTag: "MS-LAP-014", categoryId: "c1", assignedTo: "e1", verifiedAt: at("2026-08-01T10:00:00.000Z") }));
    expect(row).toEqual({
      asset: "assets/a1",
      asset_tag: "MS-LAP-014",
      name: "Thing",
      category: "asset-categories/c1",
      status: "in_stock",
      assigned_to: "employees/e1",
      last_verified_time: "2026-08-01T10:00:00.000Z",
    });
  });
});

// The two derivations the Stocktakes page is built on. Both read the assets that are already loaded, so they
// have to be right rather than cheap: one decides whether it is time to walk again, the other decides whether
// an old count's missing list is still something to act on.
describe("inventory confidence", () => {
  const day = 86400000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();

  it("scores the live inventory against the org's own staleness window, and ignores retired kit", () => {
    const c = inventoryConfidence(
      [
        { status: "in_stock", last_verified_time: ago(3), last_verified_scanned: true },
        { status: "assigned", last_verified_time: ago(30), last_verified_scanned: false }, // sighted, but not proved
        { status: "in_stock", last_verified_time: ago(400) }, // stale
        { status: "in_stock" }, // never
        { status: "retired", last_verified_time: ago(999) }, // deliberately out of the inventory
      ],
      180,
    );
    expect(c).toEqual({ total: 4, fresh: 2, stale: 1, never: 1, scanned: 1, freshPct: 50, proofPct: 50 });
  });

  it("an empty inventory scores zero rather than dividing by it", () => {
    expect(inventoryConfidence([], 180)).toMatchObject({ total: 0, freshPct: 0, proofPct: 0 });
  });

  it("the window is the org's: widen it and yesterday's stale asset is fresh", () => {
    const assets = [{ status: "in_stock", last_verified_time: ago(200), last_verified_scanned: true }];
    expect(inventoryConfidence(assets, 180).stale).toBe(1);
    expect(inventoryConfidence(assets, 365).fresh).toBe(1);
  });
});

describe("reconciling a closed count against today", () => {
  const count = {
    status: "closed",
    closed_time: "2026-08-01T12:00:00.000Z",
    result: { missing: [{ asset: "assets/a1", name: "Turned up" }, { asset: "assets/a2", name: "Still gone" }, { asset: "assets/a3", name: "Purged" }] },
  };
  const assets = [
    { path: "assets/a1", last_verified_time: "2026-08-05T09:00:00.000Z" }, // sighted AFTER the count closed
    { path: "assets/a2", last_verified_time: "2026-07-01T09:00:00.000Z" }, // the same stale date the row already carries
  ];

  it("splits the frozen list into what turned up and what is still unaccounted for", () => {
    const rec = reconcileMissing(count, assets);
    expect(rec.turnedUp).toBe(1);
    expect(rec.stillMissing).toBe(2); // a2 (never re-sighted) and a3 (no asset row to answer for it)
    expect(rec.rows[0]).toMatchObject({ stillMissing: false, sightedAt: "2026-08-05T09:00:00.000Z" });
    expect(rec.rows[1]).toMatchObject({ stillMissing: true });
    expect(rec.rows[2]).toMatchObject({ stillMissing: true });
  });

  it("a sighting BEFORE the count closed is not a resolution", () => {
    const rec = reconcileMissing(count, [{ path: "assets/a2", last_verified_time: "2026-07-31T09:00:00.000Z" }]);
    expect(rec.turnedUp).toBe(0);
  });

  it("an open count has nothing to reconcile yet", () => {
    expect(reconcileMissing({ result: undefined }, assets)).toEqual({ rows: [], turnedUp: 0, stillMissing: 0 });
  });

  it("the count a follow-up walk compares against is the most recently closed one", () => {
    const counts = [
      { status: "closed", closed_time: "2026-05-01T00:00:00.000Z", result: { missing: [{ asset: "assets/old" }] } },
      { status: "open", closed_time: undefined },
      { status: "closed", closed_time: "2026-08-01T00:00:00.000Z", result: { missing: [{ asset: "assets/a2" }] } },
    ];
    expect(lastClosed(counts)?.closed_time).toBe("2026-08-01T00:00:00.000Z");
    expect(missingPaths(lastClosed(counts))).toEqual(new Set(["assets/a2"]));
    expect(missingPaths(undefined).size).toBe(0);
  });
});

describe("the browser's scope filter matches the server's", () => {
  const rows = [
    { status: "in_stock", category: "asset-categories/lap" },
    { status: "assigned", category: "asset-categories/lap" },
    { status: "in_stock", category: "asset-categories/phn" },
  ];
  it("filters by status and category the same way inScope does", () => {
    const scope = { statuses: ["in_stock"], categories: ["asset-categories/lap"] };
    expect(rows.filter((r) => inScopeWire(scope, r))).toHaveLength(1);
    // No filter on an axis means that axis is unrestricted, on both sides.
    expect(rows.filter((r) => inScopeWire({ statuses: ["in_stock"] }, r))).toHaveLength(2);
    expect(rows.filter((r) => inScopeWire(undefined, r))).toHaveLength(3);
    for (const r of rows) {
      expect(inScopeWire({ statuses: ["in_stock"] }, r)).toBe(inScope({ statuses: ["in_stock"] }, { uuid: "x", name: "n", status: r.status }));
    }
  });
});
