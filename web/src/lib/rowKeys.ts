// Stable React keys for an editable list of plain objects held in component state.
//
// WHY. A list editor keyed by `key={i}` keeps the right VALUE under each index - controlled inputs see to that -
// but React reuses the same DOM node for a position, so everything the DOM node owns and React does not stays
// behind when a row is removed or moved: focus, caret position, text selection, IME composition state. Press ↑
// beside a focused stage name and the caret is left on the row that slid into that slot; delete the third
// checklist item while typing in the fourth and the caret jumps up a row mid-word.
//
// HOW. The lists these editors hold have no ids of their own - they are settings blobs, saved as plain arrays -
// so identity has to be minted here and carried across renders. Every one of these editors updates state the
// same idiomatic way: `.map((x, j) => (j === i ? { ...x, ...patch } : x))` to edit, `.filter` to remove, a
// destructuring swap to move, a spread to append. All three of the latter PRESERVE the object references of the
// rows they did not touch, and an edit replaces exactly one object at its own position. So:
//
//   1. match rows to last render's keys by object identity - this covers remove, move and every untouched row;
//   2. hand the keys left over to the still-unmatched rows in position order - an edited row is a new object at
//      the position its old one occupied, so it inherits that row's key;
//   3. anything still unkeyed is genuinely new, and gets a fresh one.
//
// Pure with respect to its output: given the same list it returns the same keys, so StrictMode's deliberate
// double render is a no-op on the second pass.
import * as React from "react";

let counter = 0;
const mint = () => `row-${++counter}`;

/** Keys parallel to `list`, stable across edits, removals and reorders. */
export function useRowKeys(list: readonly unknown[]): string[] {
  const prev = React.useRef<{ obj: unknown; key: string }[]>([]);
  const next: { obj: unknown; key: string | null }[] = list.map((obj) => ({ obj, key: null }));
  const taken = new Set<number>();

  for (const entry of next) {
    const at = prev.current.findIndex((p, i) => !taken.has(i) && p.obj === entry.obj);
    if (at >= 0) {
      taken.add(at);
      entry.key = prev.current[at]!.key;
    }
  }
  const spare = prev.current.filter((_, i) => !taken.has(i)).map((p) => p.key);
  let s = 0;
  for (const entry of next) {
    if (entry.key === null && s < spare.length) entry.key = spare[s++]!;
  }
  for (const entry of next) entry.key ??= mint();

  prev.current = next as { obj: unknown; key: string }[];
  return next.map((e) => e.key!);
}
