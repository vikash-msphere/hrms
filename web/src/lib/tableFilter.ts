// The grammar behind a DataTable column filter.
//
// Every filter value a table holds is a STRING, and that is deliberate: filters travel in the URL query
// (`t.<table>={"f":{...}}`), in saved views and in the per-user prefs blob, and all three are string maps.
// Typing a column therefore cannot mean giving it a richer value - it means giving the string a grammar and
// reading it back here. A money column filtered by ">5000" and a date column filtered by "last30" are the
// same shape of state as a text column filtered by "smith".
//
// The grammars, one per filter kind:
//
//   text     substring, case-insensitive. A leading "!" negates ("!draft" = everything but drafts).
//   select   exact match. "!" negates. `is:blank` matches rows with no value, `!is:blank` rows with one.
//   number   ">n" ">=n" "<n" "<=n" "=n" "n..m" "n.." "..m", plus `is:blank` for rows carrying no number.
//   date     a named window (below), an explicit "from..to" (either end may be empty), or a single day.
//
// Named date windows resolve against the ORG's today (lib/orgDay), never the browser's: a table filtered to
// "today" in Mumbai and read in London has to mean the same rows on both screens.

import { addDaysYmd, todayStr } from "@/lib/orgDay";

export type FilterKind = "text" | "select" | "number" | "date" | "none";

/** Rows whose value is absent. Spelled with a colon so it cannot collide with a real cell value. */
export const BLANK = "is:blank";

export type DateWindow = { id: string; label: string; when: "past" | "future" | "any" };

// Offered by the date filter panel, in this order. `when` lets a column say which half it cares about
// (a "Created" column is answered by the past ones, a "Due" column by the future ones) without hiding
// the others - the reverse question gets asked often enough (leave that started last month, an invoice
// dated ahead of today) that removing them would cost more than the extra line of buttons.
export const DATE_WINDOWS: DateWindow[] = [
  { id: "today", label: "Today", when: "any" },
  { id: "yesterday", label: "Yesterday", when: "past" },
  { id: "last7", label: "Last 7 days", when: "past" },
  { id: "last30", label: "Last 30 days", when: "past" },
  { id: "thismonth", label: "This month", when: "any" },
  { id: "lastmonth", label: "Last month", when: "past" },
  { id: "thisyear", label: "This year", when: "any" },
  { id: "past", label: "Before today", when: "past" },
  { id: "tomorrow", label: "Tomorrow", when: "future" },
  { id: "next7", label: "Next 7 days", when: "future" },
  { id: "next30", label: "Next 30 days", when: "future" },
  { id: "nextmonth", label: "Next month", when: "future" },
  { id: "future", label: "After today", when: "future" },
];

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string) => addDaysYmd(monthStart(addDaysYmd(monthStart(ymd), 32)), -1);

/** The inclusive day range a named window covers, or null when the token names no window. */
export function dateWindowRange(token: string, today = todayStr()): { from?: string; to?: string } | null {
  switch (token) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDaysYmd(today, -1), to: addDaysYmd(today, -1) };
    case "tomorrow":
      return { from: addDaysYmd(today, 1), to: addDaysYmd(today, 1) };
    case "last7":
      return { from: addDaysYmd(today, -6), to: today };
    case "last30":
      return { from: addDaysYmd(today, -29), to: today };
    case "next7":
      return { from: today, to: addDaysYmd(today, 6) };
    case "next30":
      return { from: today, to: addDaysYmd(today, 29) };
    case "thismonth":
      return { from: monthStart(today), to: monthEnd(today) };
    case "lastmonth": {
      const prev = addDaysYmd(monthStart(today), -1);
      return { from: monthStart(prev), to: prev };
    }
    case "nextmonth": {
      const next = addDaysYmd(monthEnd(today), 1);
      return { from: next, to: monthEnd(next) };
    }
    case "thisyear":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case "past":
      return { to: addDaysYmd(today, -1) };
    case "future":
      return { from: addDaysYmd(today, 1) };
    default:
      return null;
  }
}

/** The day a cell's raw value falls on. Accepts a plain date or a timestamp; anything else is not a day. */
export function dayOf(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export type NumberFilter = { op: ">" | ">=" | "<" | "<=" | "="; n: number } | { from?: number; to?: number };

/** Read a number filter, or null when the string does not parse as one (a half-typed ">" is not a filter). */
export function parseNumberFilter(value: string): NumberFilter | null {
  const v = value.trim();
  if (!v) return null;
  const range = v.match(/^(-?[\d.]*)\.\.(-?[\d.]*)$/);
  if (range) {
    const from = range[1] === "" ? undefined : Number(range[1]);
    const to = range[2] === "" ? undefined : Number(range[2]);
    if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) return null;
    if (from === undefined && to === undefined) return null;
    return { from, to };
  }
  const cmp = v.match(/^(>=|<=|>|<|=)\s*(-?[\d.]+)$/);
  if (cmp) {
    const n = Number(cmp[2]);
    return Number.isFinite(n) ? { op: cmp[1] as ">" | ">=" | "<" | "<=" | "=", n } : null;
  }
  const bare = Number(v);
  return Number.isFinite(bare) ? { op: "=", n: bare } : null;
}

/** Read a date filter into an inclusive day range. Null when the string says nothing usable. */
export function parseDateFilter(value: string, today = todayStr()): { from?: string; to?: string } | null {
  const v = value.trim();
  if (!v) return null;
  const named = dateWindowRange(v, today);
  if (named) return named;
  const range = v.match(/^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/);
  if (range) {
    if (!range[1] && !range[2]) return null;
    return { from: range[1] || undefined, to: range[2] || undefined };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { from: v, to: v };
  // A month ("2026-03") is what a `<input type="month">` and a hand-typed filter both produce.
  if (/^\d{4}-\d{2}$/.test(v)) return { from: `${v}-01`, to: monthEnd(`${v}-01`) };
  return null;
}

/**
 * Does one row's value pass one column filter?
 *
 * A filter the grammar cannot read matches EVERYTHING rather than nothing. These strings are typed into an
 * input a character at a time, and a half-finished ">" or "2026-" that emptied the table would take the rows
 * away exactly while the reader is still saying which ones they want.
 */
export function matchesFilter(kind: FilterKind, filter: string, raw: unknown, today = todayStr()): boolean {
  const value = filter.trim();
  if (!value) return true;
  const negated = value.startsWith("!");
  const body = negated ? value.slice(1) : value;
  const has = raw != null && String(raw) !== "";
  if (body === BLANK) return negated ? has : !has;
  const pass = matchesPositive(kind, body, raw, has, today);
  return negated ? !pass : pass;
}

function matchesPositive(kind: FilterKind, body: string, raw: unknown, has: boolean, today: string): boolean {
  if (kind === "number") {
    const f = parseNumberFilter(body);
    if (!f) return true;
    if (!has) return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    if ("op" in f) {
      return f.op === ">" ? n > f.n : f.op === ">=" ? n >= f.n : f.op === "<" ? n < f.n : f.op === "<=" ? n <= f.n : n === f.n;
    }
    return (f.from === undefined || n >= f.from) && (f.to === undefined || n <= f.to);
  }
  if (kind === "date") {
    const r = parseDateFilter(body, today);
    if (!r) return true;
    const day = dayOf(raw);
    if (!day) return false;
    return (!r.from || day >= r.from) && (!r.to || day <= r.to);
  }
  if (kind === "select") return String(raw ?? "") === body;
  return String(raw ?? "").toLowerCase().includes(body.toLowerCase());
}

const humanDay = (ymd: string) => {
  const w = DATE_WINDOWS.find((x) => dateWindowRange(x.id)?.from === ymd && dateWindowRange(x.id)?.to === ymd);
  return w ? w.label.toLowerCase() : ymd;
};

/** How a filter reads on its chip. The chips are the only place a filter is visible once its popover closes. */
export function filterChipLabel(kind: FilterKind, filter: string, fmt?: (n: number) => string): string {
  const value = filter.trim();
  const negated = value.startsWith("!");
  const body = negated ? value.slice(1) : value;
  const not = negated ? "not " : "";
  if (body === BLANK) return negated ? "has a value" : "blank";
  if (kind === "number") {
    const f = parseNumberFilter(body);
    if (!f) return value;
    const n = (x: number) => (fmt ? fmt(x) : String(x));
    if ("op" in f) return `${not}${f.op === "=" ? "" : f.op} ${n(f.n)}`.trim();
    if (f.from !== undefined && f.to !== undefined) return `${not}${n(f.from)} - ${n(f.to)}`;
    return f.from !== undefined ? `${not}≥ ${n(f.from)}` : `${not}≤ ${n(f.to!)}`;
  }
  if (kind === "date") {
    const named = DATE_WINDOWS.find((w) => w.id === body);
    if (named) return `${not}${named.label.toLowerCase()}`;
    const r = parseDateFilter(body);
    if (!r) return value;
    if (r.from && r.to) return r.from === r.to ? `${not}${humanDay(r.from)}` : `${not}${r.from} - ${r.to}`;
    return r.from ? `${not}from ${r.from}` : `${not}until ${r.to}`;
  }
  return `${not}${body}`;
}

export type NumberStats = { count: number; min: number; max: number; sum: number; avg: number; median: number };

/** What a numeric column actually holds, for the filter panel to show before anyone filters by it. */
export function numberStats(values: number[]): NumberStats | null {
  const ns = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (ns.length === 0) return null;
  const sum = ns.reduce((a, b) => a + b, 0);
  const mid = ns.length >> 1;
  return {
    count: ns.length,
    min: ns[0]!,
    max: ns[ns.length - 1]!,
    sum,
    avg: sum / ns.length,
    median: ns.length % 2 ? ns[mid]! : (ns[mid - 1]! + ns[mid]!) / 2,
  };
}
