/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { balancedRows, statRow, CARD_CAPS, STRIP_CAPS, STAT_ROW_LADDER } from "../web/src/lib/statRows";

// The arithmetic behind every metric row in the app (SummaryStrip, the dashboard KPI wall, My-day). It is a
// pure function precisely so the thing that used to go wrong - an orphan row: four tiles, then three against
// a hole - can be asserted instead of eyeballed at five container widths.

// What the browser resolves for one item at one rung: a rung is written only when it changes the split, and
// the CSS falls back down the ladder for the rest (index.css, `.stat-row > *`).
const perAt = (cell: (i: number) => object, index: number, rung: number): number => {
  const vars = cell(index) as unknown as Record<string, string>;
  for (let r = rung; r >= 0; r--) if (vars[`--per-${r}`] != null) return Number(vars[`--per-${r}`]);
  return 1;
};

describe("balancedRows", () => {
  it("splits as evenly as the cap allows, rather than packing the first rows full", () => {
    expect(balancedRows(7, 4)).toEqual([4, 3]); // the case that started this: assets' seven KPIs
    expect(balancedRows(9, 4)).toEqual([3, 3, 3]); // NOT 4+4+1
    expect(balancedRows(6, 4)).toEqual([3, 3]); // NOT 4+2
    expect(balancedRows(11, 4)).toEqual([4, 4, 3]);
    expect(balancedRows(7, 3)).toEqual([3, 2, 2]); // NOT 3+3+1
    expect(balancedRows(7, 2)).toEqual([2, 2, 2, 1]);
  });

  it("keeps one row whenever the count fits in one", () => {
    expect(balancedRows(5, 6)).toEqual([5]);
    expect(balancedRows(6, 6)).toEqual([6]);
    expect(balancedRows(1, 4)).toEqual([1]);
  });

  it("every split accounts for every item, and no row exceeds the cap", () => {
    for (let n = 1; n <= 24; n++) {
      for (const cap of [1, 2, 3, 4, 5, 6, 7]) {
        const rows = balancedRows(n, cap);
        expect(rows.reduce((s, r) => s + r, 0)).toBe(n);
        expect(Math.max(...rows)).toBeLessThanOrEqual(cap);
        // "Balanced" means no two rows differ by more than one item - that is what keeps the shape readable.
        expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("has nothing to split when there is nothing to show", () => {
    expect(balancedRows(0, 4)).toEqual([]);
  });
});

describe("statRow", () => {
  it("gives each item the size of the row it lands in, at every rung of the ladder", () => {
    const { cell } = statRow(7, STRIP_CAPS); // caps 2, 3, 4, 5, 7, 9 by container width
    const all = [0, 1, 2, 3, 4, 5, 6];
    const row = (rung: number) => all.map((i) => perAt(cell, i, rung));
    // narrowest: 2+2+2+1 - the last item is alone on its row, so it takes the whole width.
    expect(row(0)).toEqual([2, 2, 2, 2, 2, 2, 1]);
    expect(row(1)).toEqual([3, 3, 3, 2, 2, 2, 2]);
    // the fix for the ragged /assets strip: four then three, both full width
    expect(row(2)).toEqual([4, 4, 4, 4, 3, 3, 3]);
    expect(row(3)).toEqual([4, 4, 4, 4, 3, 3, 3]); // a cap of 5 still splits seven as 4+3
    expect(row(4)).toEqual([7, 7, 7, 7, 7, 7, 7]); // room for one row
    expect(row(5)).toEqual([7, 7, 7, 7, 7, 7, 7]); // a cap of 9 changes nothing for seven, so it writes no rung
  });

  it("the wide rung (1600px) fits more per row, and the rung a 1440 screen can reach keeps its split", () => {
    expect(STAT_ROW_LADDER).toEqual([0, 480, 720, 1000, 1240, 1600]);
    // Twelve KPI cards: three rows of four up to 1600, two rows of six from it.
    const cards = statRow(12, CARD_CAPS);
    expect(Array.from({ length: 12 }, (_, i) => perAt(cards.cell, i, 4))).toEqual(Array(12).fill(4));
    expect(Array.from({ length: 12 }, (_, i) => perAt(cards.cell, i, 5))).toEqual(Array(12).fill(6));
    // A nine-segment strip: 5 + 4 from 1000 (a cap of seven still splits nine as 5 + 4), one row from 1600.
    const strip = statRow(9, STRIP_CAPS);
    expect(Array.from({ length: 9 }, (_, i) => perAt(strip.cell, i, 4))).toEqual([5, 5, 5, 5, 5, 4, 4, 4, 4]);
    expect(Array.from({ length: 9 }, (_, i) => perAt(strip.cell, i, 5))).toEqual(Array(9).fill(9));
  });

  it("writes a rung only when it changes the split, so the CSS falls through", () => {
    const { cell } = statRow(4, CARD_CAPS); // caps 2, 2, 3, 4
    const vars = cell(0) as unknown as Record<string, string>;
    // 2+2 all the way up to the rung whose cap is 4, where it becomes one row: the caps of 2 and 3 in between
    // split four cards identically, so they write nothing and the CSS falls through to --per-0.
    expect(Object.keys(vars).sort()).toEqual(["--per-0", "--per-3"]);
    expect(perAt(cell, 0, 2)).toBe(2);
    expect(perAt(cell, 0, 3)).toBe(4);
  });

  it("passes the gap through, because a share is (100% - (size - 1) * gap) / size", () => {
    const { style } = statRow(3, CARD_CAPS, { base: "0.75rem", sm: "1rem" });
    expect(style as unknown as Record<string, string>).toEqual({ "--stat-gap": "0.75rem", "--stat-gap-sm": "1rem" });
    expect(statRow(3, CARD_CAPS).style).toEqual({}); // a bordered strip has no gap at all
  });

  it("fills every row of the dashboard's card wall at every width", () => {
    for (let n = 1; n <= 16; n++) {
      const { cell } = statRow(n, CARD_CAPS);
      for (let rung = 0; rung < STAT_ROW_LADDER.length; rung++) {
        // Walk the items in order: each row must be exactly as long as the size its members claim.
        let i = 0;
        while (i < n) {
          const size = perAt(cell, i, rung);
          for (let k = 0; k < size; k++) expect(perAt(cell, i + k, rung)).toBe(size);
          i += size;
        }
        expect(i).toBe(n); // no row runs past the end, so no row is left half-empty
      }
    }
  });
});
