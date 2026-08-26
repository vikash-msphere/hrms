// The leave calendar's arithmetic, kept out of the views so the month grid, the team rows and the quarter
// strip can't disagree about what a day, a bar or a thin day is. Everything here is pure: dates in, geometry
// and counts out.

import type { LeaveRequest } from "@/types";

export const DAY_MS = 86_400_000;
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);
export const parseYmd = (s: string) => Date.parse(s.slice(0, 10) + "T00:00:00Z");
/** The viewer's LOCAL calendar date (toISOString would flip to UTC's date around midnight). */
export const todayYmd = () => new Date().toLocaleDateString("en-CA");
export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const ymOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
export const addDays = (ymd: string, n: number) => ymdUtc(new Date(parseYmd(ymd) + n * DAY_MS));
export const daysApart = (a: string, b: string) => Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);
export const dmy = (s?: string) => { if (!s) return ""; const [y, m, d] = s.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
export const longDate = (ymd: string) =>
  new Date(parseYmd(ymd)).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const monthLabelOf = (d: Date) => d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
/** Every day of the month containing `d`, as YYYY-MM-DD. */
export const monthDaysOf = (d: Date) => {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => ymdUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i + 1))));
};
/** Inclusive day range, capped so one absurd row can't expand into a million cells. */
export const rangeDays = (from: string, to: string, cap = 400) => {
  const n = Math.min(Math.max(0, daysApart(from, to)), cap);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
};
/** The weekday numbers of a grid's columns, for a week starting on `weekStart` (0=Sun). */
export const weekdayOrder = (weekStart = 0) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
/** The 42-cell (6-week) grid covering the month of `cursor`, starting on the org's first weekday. */
export const gridCells = (cursor: Date, weekStart = 0) => {
  const first = monthStart(cursor);
  const start = +first - ((first.getUTCDay() - weekStart + 7) % 7) * DAY_MS;
  return Array.from({ length: 42 }, (_, i) => new Date(start + i * DAY_MS));
};

// One dated thing drawn as a bar. `kind` separates the two absences that answer different staffing questions:
// a person on leave is gone, a person working remotely is here but elsewhere.
export type CalEntry = {
  key: string;
  row: LeaveRequest;
  kind: "leave" | "remote";
  empId: string;
  name: string;
  short: string;
  photo?: string;
  deptId: string;
  start: string;
  end: string;
  startSession: number; // 1 = from the morning, 2 = from the afternoon
  endSession: number; // 1 = until midday, 2 = until end of day
  days: number;
  pending: boolean;
  mine: boolean;
  color: string;
  type: string;
  reason?: string;
};

/** "Ravi K." - enough to identify a person inside a one-line bar. */
export const shortName = (first?: string, last?: string) =>
  `${first ?? ""}${last ? ` ${last.slice(0, 1)}.` : ""}`.trim() || "Someone";

/** The half-day suffix a single-day leave carries, or "" for anything that spans full days. */
export const halfLabel = (e: Pick<CalEntry, "start" | "end" | "startSession" | "endSession">) =>
  e.start !== e.end ? "" : e.startSession === 1 && e.endSession === 1 ? "AM" : e.startSession === 2 && e.endSession === 2 ? "PM" : "";

/** Day -> the entries covering it. Built once per data change and read by every view. */
export function expandByDay(entries: CalEntry[]): Map<string, CalEntry[]> {
  const m = new Map<string, CalEntry[]>();
  for (const en of entries) {
    for (const k of rangeDays(en.start, en.end)) {
      const list = m.get(k);
      if (list) list.push(en);
      else m.set(k, [en]);
    }
  }
  return m;
}

/** Distinct people away per day - a person with two requests on one day is still one absence. */
export function awayPerDay(byDay: Map<string, CalEntry[]>, kind?: CalEntry["kind"]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, list] of byDay) {
    const people = new Set(list.filter((e) => !kind || e.kind === kind).map((e) => e.empId));
    if (people.size) m.set(k, people.size);
  }
  return m;
}

// How stretched cover is on a day, as one word every view and the legend agree on.
export type Cover = "none" | "some" | "heavy" | "critical";
export const HEAVY = 0.3;
export const CRITICAL = 0.5;
export const coverOf = (away: number, total: number): Cover =>
  !away || !total ? "none" : away / total >= CRITICAL ? "critical" : away / total >= HEAVY ? "heavy" : "some";
export const COVER_BAR: Record<Cover, string> = { none: "", some: "bg-primary/50", heavy: "bg-warning", critical: "bg-destructive" };

// A bar as drawn inside a strip of `units` days: which entry, where it starts, how wide, and whether it was
// cut by the strip's edge (a cut end is square and keeps no half-day inset - the leave continues off-screen).
export type Seg = {
  en: CalEntry;
  i: number; // first day index within the strip
  span: number; // whole days covered inside the strip
  cutL: boolean;
  cutR: boolean;
  lane: number;
};

/** The segments of `entries` that fall inside [from, to], packed into lanes so no two overlap in a lane. */
export function layoutStrip(entries: CalEntry[], from: string, to: string): Seg[] {
  const segs = entries
    .filter((en) => en.end >= from && en.start <= to)
    .map((en) => {
      const s = en.start < from ? from : en.start;
      const e = en.end > to ? to : en.end;
      const i = daysApart(from, s);
      return { en, i, span: daysApart(s, e) + 1, cutL: en.start < from, cutR: en.end > to, lane: 0 };
    })
    .sort((a, b) => a.i - b.i || b.span - a.span || a.en.name.localeCompare(b.en.name));

  const laneEnd: number[] = [];
  for (const s of segs) {
    let lane = laneEnd.findIndex((end) => end < s.i);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(-1); }
    laneEnd[lane] = s.i + s.span - 1;
    s.lane = lane;
  }
  return segs;
}

/** Per-day count of segments a view chose not to draw (lane past its budget), for the "+N more" roll-up. */
export function hiddenPerDay(segs: Seg[], from: string, maxLanes: number): Map<string, number> {
  const hidden = new Map<string, number>();
  for (const s of segs) {
    if (s.lane < maxLanes) continue;
    for (let k = 0; k < s.span; k++) {
      const key = addDays(from, s.i + k);
      hidden.set(key, (hidden.get(key) ?? 0) + 1);
    }
  }
  return hidden;
}

/** Where a bar sits inside a strip of `units` columns, as percentages - half-days inset by half a column so a
 *  morning leave visibly covers half its day. A cut edge keeps its full width: the leave runs past the strip. */
export function barGeometry(s: Seg, units: number) {
  const insetL = !s.cutL && s.en.startSession === 2 ? 0.5 : 0;
  const insetR = !s.cutR && s.en.endSession === 1 ? 0.5 : 0;
  const left = ((s.i + insetL) / units) * 100;
  const width = ((s.span - insetL - insetR) / units) * 100;
  return { left, width: Math.max(width, (0.35 / units) * 100) };
}

/** A leave type's colour as a background wash, so bar text stays readable while the hue still identifies it. */
export const wash = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}24` : hex);

/** Working days whose cover crossed the warning line, worst first - the calendar's own alert list. A day
 *  nobody was scheduled to work isn't thin, it's closed, so weekends and holidays are excluded. */
export function thinDays(days: string[], awayOn: (ymd: string) => number, total: number, workDays: number[], holidays: Set<string>) {
  if (!total) return [];
  return days
    .filter((ymd) => workDays.includes(new Date(parseYmd(ymd)).getUTCDay()) && !holidays.has(ymd) && awayOn(ymd) / total >= HEAVY)
    .map((ymd) => ({ ymd, away: awayOn(ymd), share: awayOn(ymd) / total }))
    .sort((a, b) => b.share - a.share || a.ymd.localeCompare(b.ymd));
}

/** Thin days merged into runs (gaps of up to a weekend bridged), so a bad week reads as one line, not five. */
export function groupRuns(days: { ymd: string; away: number }[]) {
  const runs: { from: string; to: string; peak: number }[] = [];
  for (const d of [...days].sort((a, b) => a.ymd.localeCompare(b.ymd))) {
    const last = runs[runs.length - 1];
    if (last && daysApart(last.to, d.ymd) <= 3) {
      last.to = d.ymd;
      last.peak = Math.max(last.peak, d.away);
    } else runs.push({ from: d.ymd, to: d.ymd, peak: d.away });
  }
  return runs;
}

/** Working days actually consumed by a date range (weekends and holidays excluded), for a drag preview. */
export function workingDaysIn(from: string, to: string, workDays: number[], holidays: Set<string>): number {
  let n = 0;
  for (const ymd of rangeDays(from, to)) {
    const wd = new Date(parseYmd(ymd)).getUTCDay();
    if (workDays.includes(wd) && !holidays.has(ymd)) n++;
  }
  return n;
}
