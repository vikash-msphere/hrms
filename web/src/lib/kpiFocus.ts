import { useRoute, setQueryParam } from "@/router";

// KPI drill-through. A metric the user can click is worth more than one they have to translate into a filter
// by hand: clicking narrows the list below to exactly the rows the number counted, clicking again clears it.
//
// The focus lives in the URL query (`?focus=<key>`) rather than component state, so a narrowed page is
// shareable, survives a reload and closes with the back button. Pages declare one spec per clickable metric
// (a label for empty states plus the predicate that produced the number), spread `kpi("key")` onto the
// SummaryStrip item, and run their rows through `apply()` before handing them to the table.
//
// Anything ELSE on the page that filters those same rows and shows a count - tab labels, quick-filter chips -
// counts through `count()` (or over an `apply()`ed set), so the numbers on the filters describe what picking
// one would actually show rather than the whole unnarrowed collection.
export type FocusSpec<T> = {
  // Human phrase for the narrowed scope, used in the empty state ("No <label>").
  label: string;
  match: (row: T) => boolean;
};

export function useKpiFocus<T, K extends string>(specs: Record<K, FocusSpec<T>>, param = "focus") {
  const route = useRoute();
  const raw = route.query[param] ?? null;
  const focus = raw && Object.prototype.hasOwnProperty.call(specs, raw) ? (raw as K) : null;
  const setFocus = (key: K | null) => setQueryParam(param, key);
  return {
    focus,
    setFocus,
    clear: () => setFocus(null),
    // Label of the metric currently narrowing the list, or null when the list is unnarrowed.
    activeLabel: focus ? specs[focus].label : null,
    // Spread onto a SummaryStrip / StatCard item: `...kpi("late")`.
    kpi: (key: K) => ({ onClick: () => setFocus(focus === key ? null : key), active: focus === key }),
    apply: (rows: T[]) => (focus ? rows.filter(specs[focus].match) : rows),
    // How many of `rows` survive the active metric: what a filter that selects them would show.
    count: (rows: T[]) => (focus ? rows.reduce((n, r) => n + (specs[focus].match(r) ? 1 : 0), 0) : rows.length),
  };
}
