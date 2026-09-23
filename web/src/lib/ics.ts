// iCalendar (RFC 5545) export. Leave is an ALL-DAY event: no times, no timezone maths, and DTEND is the day
// AFTER the last day because the spec's end is exclusive - an off-by-one here shows up as a leave that ends a
// day early in someone's Outlook, which is exactly the kind of quiet wrong this app can't afford.

import { saveBytes } from "./download";
export type IcsEvent = {
  uid: string;
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive (converted to the exclusive DTEND on the way out)
  summary: string;
  description?: string;
  /** TENTATIVE marks a request still awaiting approval, so a subscriber can tell plan from fact. */
  tentative?: boolean;
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (ymd: string) => ymd.slice(0, 10).replace(/-/g, "");
const nextDay = (ymd: string) => new Date(Date.parse(ymd.slice(0, 10) + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
// Escape per RFC 5545 §3.3.11: backslash first, then the delimiters, then newlines.
//
// EVERY NEWLINE FORM, which `\r?\n` was not: a LONE CARRIAGE RETURN passed through untouched. ICS content
// lines are CRLF-delimited and parsers in the wild accept a bare CR as a line break, so a value carrying one
// injected whole properties into the VEVENT - `Diwali\rDESCRIPTION:...\rX-EVIL:1` escaped to itself. The value
// that reaches SUMMARY here is a holiday name, and routes/holidayFeed.ts publishes it on an unauthenticated,
// long-lived URL people paste into Google Calendar and Outlook; the same escape carries interview summaries
// and locations into candidate invitation mail. One alternation, so CRLF folds to a single `\n` and the two
// bare forms cannot be the case somebody forgets.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/([;,])/g, "\\$1").replace(/\r\n|[\r\n]/g, "\\n");
// Content lines are folded at 75 OCTETS (RFC 5545 §3.1); a continuation begins with one space. Measured in
// octets, not characters: a name in Devanagari is three bytes per character, so 75 characters is 225 octets and
// a strict parser may reject the line. Mirrors src/lib/ics.ts exactly - the two must agree, since the same
// calendar can arrive from either.
const enc = new TextEncoder();
const fold = (line: string) => {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let budget = 75; // 75 on the first line, 74 after (the leading space is one of the continuation's 75)
  for (const ch of line) {
    const w = enc.encode(ch).length;
    if (bytes + w > budget) {
      out.push(cur);
      cur = "";
      bytes = 0;
      budget = 74;
    }
    cur += ch;
    bytes += w;
  }
  if (cur) out.push(cur);
  return out.map((p, i) => (i === 0 ? p : " " + p)).join("\r\n");
};

export function buildIcs(events: IcsEvent[], calendarName: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HRMS//Leave calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${esc(e.uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${dateOnly(e.start)}`,
      `DTEND;VALUE=DATE:${dateOnly(nextDay(e.end))}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      `STATUS:${e.tentative ? "TENTATIVE" : "CONFIRMED"}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Hand the built calendar to the browser as a .ics download. */
export function downloadIcs(filename: string, ics: string) {
  saveBytes(ics, filename.endsWith(".ics") ? filename : `${filename}.ics`, "text/calendar;charset=utf-8");
}

// ── Timed events ────────────────────────────────────────────────────────────────────────────────────────────
//
// Leave and holidays are all-day; an interview is an hour on a Tuesday. Same escaping and folding, but with
// UTC instants (DTSTART/DTEND in Z form, which every client reads correctly whatever its own timezone) and a
// location line, so "add to calendar" produces something a panelist can actually be reminded by.
export type IcsTimedEvent = {
  uid: string;
  /** ISO instants. */
  start: string;
  end: string;
  summary: string;
  description?: string;
  location?: string;
};

const stampUtc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildTimedIcs(events: IcsTimedEvent[], calendarName: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HRMS//Interviews//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${esc(e.uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stampUtc(e.start)}`,
      `DTEND:${stampUtc(e.end)}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      "STATUS:CONFIRMED",
      // Opaque, unlike leave: an interview is time somebody is genuinely busy.
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
