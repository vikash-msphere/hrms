// Seeding a year of holidays one dialog at a time is the worst hour of an HR admin's January, so the page
// takes a pasted list and a "copy last year" plan instead. Both are pure so the parsing rules and the
// weekday-drift warnings are testable without a browser.

export type HolidayDraft = {
  date: string; // YYYY-MM-DD
  name: string;
  kind: "fixed" | "optional";
  half_day: boolean;
  location: string | null;
};

/** One pasted line: either a draft to create, or a reason it can't be. */
export type ParsedLine = { line: number; raw: string; draft?: HolidayDraft; error?: string };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A date as the paste might carry it: ISO (2026-01-26), or day-first with `/`, `-` or `.`
 * (26/01/2026, 26-01-26). Day-first because that is what this app displays everywhere; a two-digit year is
 * read as 20xx. Returns null when it isn't a real calendar date, so 31/02 is rejected rather than rolled.
 */
export function parseLooseDate(s: string): string | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (iso) [, y, m, d] = iso.map(Number) as [number, number, number, number];
  else if (dmy) {
    const [, dd, mm, yy] = dmy.map(Number) as [number, number, number, number];
    [y, m, d] = [yy < 100 ? 2000 + yy : yy, mm, dd];
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const FLAG_OPTIONAL = /^opt(ional)?$/i;
const FLAG_HALF = /^half([ -]?day)?$/i;

/**
 * Parse a pasted holiday list. One holiday per line, date first, then the name, then any of the optional
 * flags in any order:
 *
 *     2026-01-26, Republic Day
 *     26/01/2026 | Republic Day | optional | half day | Mumbai
 *     2026-03-04  Holi  optional
 *
 * Fields split on tab, pipe or comma; with none of those, the first whitespace-delimited token is the date and
 * the rest is the name. Blank lines and `#` comments are skipped. Later duplicates of a date already seen in
 * the paste are reported rather than silently created twice.
 */
export function parseHolidayLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parts = /[\t|,]/.test(trimmed)
      ? trimmed.split(/\s*[\t|,]\s*/)
      : (() => {
          const [first, ...rest] = trimmed.split(/\s+/);
          return [first ?? "", rest.join(" ")];
        })();
    const date = parseLooseDate(parts[0] ?? "");
    if (!date) {
      out.push({ line, raw: trimmed, error: `couldn't read a date from "${parts[0] ?? ""}"` });
      return;
    }
    let kind: HolidayDraft["kind"] = "fixed";
    let half = false;
    const rest: string[] = [];
    for (const field of parts.slice(1).map((p) => p.trim()).filter(Boolean)) {
      if (FLAG_OPTIONAL.test(field)) kind = "optional";
      else if (FLAG_HALF.test(field)) half = true;
      else rest.push(field);
    }
    const name = rest.shift();
    if (!name) {
      out.push({ line, raw: trimmed, error: "no holiday name on this line" });
      return;
    }
    if (seen.has(date)) {
      out.push({ line, raw: trimmed, error: `${date} appears more than once in this list` });
      return;
    }
    seen.add(date);
    out.push({ line, raw: trimmed, draft: { date, name, kind, half_day: half, location: rest.join(", ") || null } });
  });
  return out;
}

/** One row of a year-copy plan. `landsOn` is the weekday (0=Sun) the copied date falls on. */
export type CopyRow = HolidayDraft & {
  sourceDate: string;
  landsOn: number;
  /** The copied date is not a working day, so the org gains nothing by declaring it - let the admin move it. */
  wasted: boolean;
  /** The target year already has a holiday on this date (or by this name), so it defaults to unchecked. */
  duplicate: boolean;
};

type ExistingHoliday = { date: string; name: string; kind?: string | null; half_day?: boolean; location?: string | null };

/**
 * Copy a year of holidays into another year, same month and day. Nothing is moved automatically: dates drift
 * to a different weekday each year and only a human knows whether Diwali or a bank holiday follows the date or
 * the calendar, so the plan flags what landed on a weekend and what already exists, and the admin decides.
 */
export function planYearCopy(
  holidays: ExistingHoliday[],
  fromYear: string,
  toYear: string,
  workDays: number[] = [1, 2, 3, 4, 5],
): CopyRow[] {
  const target = holidays.filter((h) => h.date.slice(0, 4) === toYear);
  const targetDates = new Set(target.map((h) => h.date.slice(0, 10)));
  const targetNames = new Set(target.map((h) => h.name.trim().toLowerCase()));
  const shift = Number(toYear) - Number(fromYear);
  return holidays
    .filter((h) => h.date.slice(0, 4) === fromYear)
    .map((h) => {
      const [y, m, d] = h.date.slice(0, 10).split("-").map(Number) as [number, number, number];
      // 29 Feb has no counterpart in a common year; SQLite would happily store 1 Mar, so clamp to 28 Feb and
      // let the admin see the date they are about to create.
      const targetY = y + shift;
      const day = m === 2 && d === 29 && new Date(Date.UTC(targetY, 1, 29)).getUTCDate() !== 29 ? 28 : d;
      const date = `${targetY}-${pad(m)}-${pad(day)}`;
      const landsOn = new Date(Date.parse(date + "T00:00:00Z")).getUTCDay();
      return {
        date,
        name: h.name,
        kind: h.kind === "optional" ? ("optional" as const) : ("fixed" as const),
        half_day: !!h.half_day,
        location: h.location ?? null,
        sourceDate: h.date.slice(0, 10),
        landsOn,
        wasted: !workDays.includes(landsOn),
        duplicate: targetDates.has(date) || targetNames.has(h.name.trim().toLowerCase()),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
