import type { CSSProperties } from "react";

// Balanced metric rows: how a row of tiles divides when the count does not divide the row.
//
// The problem this exists for: a fixed column count leaves an orphan row. Seven KPI tiles in a four-column
// grid draw four, then three against a hole - and the hole is what the eye reads first, because it is the
// only asymmetry on the page. Assets has exactly seven; several strips grow a segment only when there is
// something to say ("No invoice attached", "Unassigned"), so the count is not knowable from the source at all.
//
// The fix is to stop asking "how many columns" and ask "how do these split into rows". A count is split as
// evenly as the row cap allows (7 with a cap of 4 is 4+3, never 4+3-and-a-gap; 9 with a cap of 4 is 3+3+3,
// not 4+4+1), and every row is then stretched to the full width. Rows differ in cell width, which reads as
// deliberate; a hole does not.
//
// Two decisions worth knowing about:
//
// * The cap comes from the CONTAINER's width, not the viewport's (`.stat-row` is a CSS container; see
//   index.css). A page sits beside a 16rem sidebar, so a `xl:` viewport rule was sizing cells against ~300px
//   of chrome it does not have - and the same row inside a dialog or a half-width panel was sized as though
//   it had the whole screen. A container query asks the only question that matters: how much room is there.
//
// * Layout is a wrapping flex row, not a grid, because the row size is per ITEM (an item's flex-basis is one
//   share of ITS row). Each line's bases then add up to the full width, leaving no room for the next item, so
//   the browser breaks the lines exactly where the split says. A grid takes one column count for the whole
//   track, which cannot express "four, then three".

// The container widths the caps are chosen at. Fixed here because CSS has to name them literally
// (index.css); the caps that ride on them are the caller's.
export const STAT_ROW_LADDER = [0, 480, 720, 1000, 1240] as const;

// Items per row, one entry per rung of the ladder above: `[2, 3, 4, 5, 7]` is "two across under 480px, three
// from 480, four from 720, five from 1000, seven from 1240". A short list simply stops - the rungs above it
// keep the last cap given.
export type StatRowCaps = readonly number[];

// The gap between tiles. It has to be known here as well as in the CSS: an item's share of its row is
// `(100% - (size - 1) * gap) / size`, so the basis cannot be computed without it.
export type StatRowGap = {
  base: string;
  sm?: string;
};

// Split `count` into rows of at most `max`, as evenly as possible: the row count is forced by the cap, and the
// items are then spread over those rows rather than packed into the first ones. 7 over a cap of 3 is 3+2+2.
export function balancedRows(count: number, max: number): number[] {
  if (count <= 0) return [];
  const cap = Math.max(1, max);
  const rows = Math.ceil(count / cap);
  const base = Math.floor(count / rows);
  const wide = count % rows; // the first `wide` rows carry one extra
  return Array.from({ length: rows }, (_, i) => base + (i < wide ? 1 : 0));
}

// The row size each item belongs to, per index.
function sizePerItem(count: number, max: number): number[] {
  const out: number[] = [];
  for (const size of balancedRows(count, max)) for (let i = 0; i < size; i++) out.push(size);
  return out;
}

export type StatRowLayout = {
  /** Container style: the gap, which the cells' basis calc also reads. Pair it with `className="stat-row"`. */
  style: CSSProperties;
  /** Per-item style. Hand it to the i-th child, which must forward `style` to its root element. */
  cell: (index: number) => CSSProperties;
};

export function statRow(count: number, caps: StatRowCaps, gap?: StatRowGap): StatRowLayout {
  // One split per rung, so an item can be told its row size at every width. A rung whose split matches the
  // one below it adds nothing - the CSS falls through - so it is left out. The comparison is on the SPLIT and
  // not the cap: four cards under a cap of three and under a cap of two are both 2+2.
  const rungs: { rung: number; sizes: number[] }[] = [];
  let previous = "";
  caps.slice(0, STAT_ROW_LADDER.length).forEach((cap, rung) => {
    const sizes = sizePerItem(count, cap);
    const key = sizes.join(",");
    if (key === previous) return;
    previous = key;
    rungs.push({ rung, sizes });
  });
  return {
    style: {
      ...(gap ? { "--stat-gap": gap.base } : {}),
      ...(gap?.sm ? { "--stat-gap-sm": gap.sm } : {}),
    } as CSSProperties,
    cell: (index: number) => {
      const style: Record<string, string> = {};
      for (const { rung, sizes } of rungs) {
        const size = sizes[index];
        if (size != null) style[`--per-${rung}`] = String(size);
      }
      return style as CSSProperties;
    },
  };
}

// The shapes in the app, by how narrow the thing can be read at.
/** Segmented strip: short label over a big number, legible at ~160px, so it runs up to seven across. */
export const STRIP_CAPS: StatRowCaps = [2, 3, 4, 5, 7];
/** Full StatCard: a 40px icon and a 30px number want ~230px, which caps it at four. */
export const CARD_CAPS: StatRowCaps = [2, 2, 3, 4];
/** A tile with a few lines of content in it (the dashboard's My day). One per row on a narrow phone. */
export const TILE_CAPS: StatRowCaps = [1, 2, 3, 4];
/** A labelled action button - wide enough to read the label, and no wider than it needs. */
export const ACTION_CAPS: StatRowCaps = [1, 2, 2, 3];
