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
 * Fields split on tab, pipe or comma; with none of those, the first whitespace-delimited token is the date,
 * any FLAG WORDS at the end of the line are read as flags, and what is left in between is the name. That last
 * part is what the third example needs and used not to have: the whitespace form collapsed everything after
 * the date into one field, so no flag could ever match it and the paste created a fixed holiday literally
 * named "Holi optional" - a closure where an elective day was meant. A location still needs a separator,
 * because "Republic Day Mumbai" cannot be split from the name without guessing.
 *
 * Blank lines and `#` comments are skipped. Later duplicates of a date already seen in the paste are reported
 * rather than silently created twice.
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
          // Peel the flag words off the END of the line; whatever is left is the name. Only the tail is
          // examined, so a holiday whose NAME contains one of these words ("Optional Holiday Fund day") keeps
          // it - it is only a flag where a flag can be written.
          let name = rest.join(" ");
          const flags: string[] = [];
          for (;;) {
            const m = /\s+(opt|optional|half|half[ -]?day)$/i.exec(name);
            if (!m) break;
            flags.unshift(m[1]!);
            name = name.slice(0, m.index);
          }
          return [first ?? "", name.trim(), ...flags];
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

/**
 * A draft written back as a line this parser reads whole. The inverse of `parseHolidayLines` for one draft,
 * used when a partly-failed bulk add rewrites the box to the rows that still have to be created: the comma
 * form is the one that carries flags AND a location, so nothing on the line is lost on the retry.
 */
export function toLine(d: HolidayDraft): string {
  return [d.date, d.name, ...(d.kind === "optional" ? ["optional"] : []), ...(d.half_day ? ["half day"] : []), ...(d.location ? [d.location] : [])].join(", ");
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
        location: h.location ?? "",
        sourceDate: h.date.slice(0, 10),
        landsOn,
        wasted: !workDays.includes(landsOn),
        duplicate: targetDates.has(date) || targetNames.has(h.name.trim().toLowerCase()),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
