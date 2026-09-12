// iCalendar (RFC 5545) output for the subscribable holiday feed. Mirrors web/src/lib/ics.ts (the client's
// one-shot download) - same folding, same escaping, and the same all-day rule: DTEND is the day AFTER the last
// day because the spec's end is exclusive, so an off-by-one here shows up as a holiday ending a day early in
// someone's Outlook.

export type IcsEvent = {
  uid: string;
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive (converted to the exclusive DTEND on the way out)
  summary: string;
  description?: string;
};

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
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
// Content lines fold at 75 OCTETS (RFC 5545 §3.1), a continuation beginning with one space.
//
// Measured in octets, not characters: a holiday or candidate name in Devanagari is three bytes per character,
// so 75 characters is 225 octets and every strict parser is entitled to reject the line. Character counting was
// the permissive direction, not the conservative one. Splitting still happens on code-point boundaries (never
// mid-character), and an escape pair like `\n` survives being split because unfolding removes the CRLF+space
// and rejoins the halves.
const enc = new TextEncoder();
const fold = (line: string) => {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  // 75 octets on the first line; 74 on each continuation, because the leading space is one of its 75.
  let budget = 75;
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

/** A published calendar. `refreshMinutes` is the polling hint clients honour (Google/Outlook, loosely). */
export function buildIcs(events: IcsEvent[], calendarName: string, nowMs: number, refreshMinutes = 720): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HRMS//Holiday calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
    `X-PUBLISHED-TTL:PT${refreshMinutes}M`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`,
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${esc(e.uid)}`,
      `DTSTAMP:${stamp(nowMs)}`,
      `DTSTART;VALUE=DATE:${dateOnly(e.start)}`,
      `DTEND;VALUE=DATE:${dateOnly(nextDay(e.end))}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      "STATUS:CONFIRMED",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ── Timed events ────────────────────────────────────────────────────────────────────────────────────────────
//
// Holidays and leave are all-day; an interview is an hour on a Tuesday. Same folding and escaping, with UTC
// instants (the Z form every client reads correctly whatever its own timezone) and a location line. Mirrors
// web/src/lib/ics.ts#buildTimedIcs - the client hands the panel a download, this one rides on the candidate's
// invitation email.
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

export function buildTimedIcs(events: IcsTimedEvent[], calendarName: string, nowMs: number): string {
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
      `DTSTAMP:${stamp(nowMs)}`,
      `DTSTART:${stampUtc(e.start)}`,
      `DTEND:${stampUtc(e.end)}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
