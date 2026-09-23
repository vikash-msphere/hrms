import { useRoute, setQueryParam } from "@/router";

// Chart drill-through: clicking a bar, a point or a slice narrows the list under it to the rows that mark
// counted, and clicking it again clears.
//
// This is the same bargain `lib/kpiFocus.ts` makes for a metric tile, one dimension over: a picture that
// shows you where the work is, next to a list you then have to filter by hand, is asking you to translate.
// The two compose - a page can run `kf.apply()` and then `cf.apply()` - and they are separate hooks because
// they answer different questions. A KPI is a named predicate the page declares once ("late", "unassigned");
// a chart slice is one VALUE of a dimension, and which values exist is whatever the data had today.
//
// So a dimension is declared with the keys its chart was drawn from, parallel to that chart's labels, and a
// predicate that takes a row and one of those keys. `lib/chartTheme.ts`'s `topSlices` and `monthlyTotals`
// return exactly that array beside their labels.
//
// THE PICK LIVES IN THE URL (`?slice=<dimension>:<key>`), for the reasons kpiFocus gives for `?focus=`: a
// narrowed page is shareable, survives a reload, and closes with the back button. One pick at a time across
// all of a page's charts - picking in a second chart replaces the first - because two charts narrowing each
// other is a state no reader can see the shape of from two pictures.
//
// A CHART MUST NOT BE DRAWN FROM ROWS ITS OWN DIMENSION HAS ALREADY NARROWED. Do that and picking a slice
// collapses the chart to that one slice, and the reader is left holding a filter with nothing left to click
// to undo it. Draw it from the set before `apply()`, the way Directory builds its department chart from the
// whole directory.

export type ChartDim<T> = {
  /** The key behind each of the chart's labels, in the same order. `null` marks a slice that is not one
   *  value and so is not a filter - `topSlices`' pooled "Other", frappe's own "Rest". */
  keys: (string | null)[];
  /** Human phrase for the picked key, for the line that says what the list is showing. */
  label: (key: string) => string;
  match: (row: T, key: string) => boolean;
};

export function useChartFocus<T, K extends string>(dims: Record<K, ChartDim<T>>, param = "slice") {
  const route = useRoute();
  const raw = route.query[param] ?? null;
  // "<dimension>:<key>" on the FIRST colon only: a key is a wire id, a month or a category name, and several
  // of those carry colons of their own.
  const at = raw ? raw.indexOf(":") : -1;
  const dim = at > 0 ? (raw!.slice(0, at) as K) : null;
  const key = at > 0 ? raw!.slice(at + 1) : null;
  const picked = dim && key && Object.prototype.hasOwnProperty.call(dims, dim) ? { dim, key } : null;

  const pick = (d: K, k: string | null) =>
    setQueryParam(param, k === null || (picked?.dim === d && picked.key === k) ? null : `${d}:${k}`);

  return {
    picked,
    clear: () => setQueryParam(param, null),
    /** What the list is narrowed to, for a "showing …" line and an empty state. Null when it is not. */
    activeLabel: picked ? dims[picked.dim].label(picked.key) : null,
    /** Spread onto a `<Chart>`: `{...cf.chart("category")}`. Gives it the click and the picked mark. */
    chart: (d: K) => ({
      onSelect: (index: number) => {
        const k = dims[d].keys[index];
        if (k != null) pick(d, k);
      },
      // -1 back to null: the picked key can be absent from a chart that has since been redrawn from
      // narrower data, and "dim everything" is not what an unfindable mark means.
      selected: picked?.dim === d ? (dims[d].keys.indexOf(picked.key) >= 0 ? dims[d].keys.indexOf(picked.key) : null) : null,
    }),
    apply: (rows: T[]) => (picked ? rows.filter((r) => dims[picked.dim].match(r, picked.key)) : rows),
    /** How many of `rows` survive the pick: what any count shown beside the list should say. */
    count: (rows: T[]) => (picked ? rows.reduce((n, r) => n + (dims[picked.dim].match(r, picked.key) ? 1 : 0), 0) : rows.length),
  };
}
