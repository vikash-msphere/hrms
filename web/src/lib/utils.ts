import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { dateFormat, numberFormat } from "./intl";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extract the trailing id from an AEP `path` like "employees/abc123" → "abc123". */
export function idOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The name of the person a resource ref points at, given whatever slice of the directory the caller can read.
 *
 * The FALLBACK is the point of this helper. Every page that shows "whose request is this" reads `employees`
 * under its own access, so a ref to somebody outside that slice resolves to nothing - an ordinary employee
 * cannot read their own manager's row, for one. Six pages each open-coded this and each fell back to the raw
 * internal id, which put a 26-character uuid on screen in place of a name ("Goes to 5q5an4xdav8t… for
 * approval"): meaningless to the reader, and an internal identifier leaked into the UI.
 *
 * So an unresolvable ref reads as `unknown` - which callers set to whatever their sentence needs ("your
 * manager", "-") - and an absent ref is empty, because there is no person to name at all.
 */
export function personName(
  people: { path: string; first_name?: string | null; last_name?: string | null }[],
  ref?: string | null,
  unknown = "Someone",
): string {
  if (!ref) return "";
  const person = people.find((p) => idOf(p.path) === idOf(ref));
  if (!person) return unknown;
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || unknown;
}

/** Title-case a SCREAMING_SNAKE or kebab/snake token for display. */
export function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const INITIALS_RE = /\b(\w)/g;
export function initials(name: string): string {
  const matches = name.match(INITIALS_RE);
  if (!matches) return "?";
  return matches.slice(0, 2).join("").toUpperCase();
}

// `dateFormat(...).format(d)` rather than `d.toLocaleDateString(...)`: the two produce identical output for
// the same options, but the method builds a formatter per call. This is the most-called formatter in the app
// (207 call sites), and a table re-renders all of them on every keystroke in a column filter.
const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
// Pinned, not the viewer's locale. The SERVER renders the same dates day-first ("4 Aug 2026" - see
// domain/activityLabel.ts and the PDF engines), and those strings arrive already formatted: with the browser
// left to its own locale, a US-configured reader saw "Aug 4, 2026" in the table and "4 Aug 2026" in the
// letter, activity line and payslip beside it. One organization reads one date format.
const DATE_LOCALE = "en-GB";

export function formatDate(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return dateFormat(DATE_LOCALE, DATE_OPTS).format(d);
}

/** A file size a person can read: "812 B", "44 KB", "2.1 MB". Null for nothing/zero, so callers can skip it. */
export function formatBytes(n?: number): string | null {
  if (!n) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact phrase for a moment still to come: "in 20m", "in 3h", "in 5d", then "on 4 Aug 2026". */
export function relativeFuture(iso: string): string {
  const min = Math.round((+new Date(iso) - Date.now()) / 60000);
  if (min < 1) return "any moment";
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return `on ${formatDate(iso)}`;
}

/** "Joined Mar 2023 · 2y 4m" - tenure at a glance for profile headers. */
export function tenureLabel(startDate: string): string {
  const start = new Date(startDate);
  if (isNaN(+start)) return "";
  const joined = start.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const now = new Date();
  const months = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth());
  const dur = months < 1 ? "new joiner" : months < 12 ? `${months}m` : `${Math.floor(months / 12)}y ${months % 12}m`;
  return `Joined ${joined} · ${dur}`;
}

/** "On probation · 12d left" (or "· ends today") for an end date that's today or later; "" once past. */
export function probationLabel(endDate: string): string {
  const days = Math.ceil((Date.parse(endDate) - Date.now()) / 86400000);
  if (isNaN(days) || days < 0) return "";
  return days === 0 ? "On probation · ends today" : `On probation · ${days}d left`;
}

// Round to 2 decimal places (paise), decimal-half-correct - the browser-side twin of the server's one rounding
// helper (src/domain/money.ts). `Math.round(n * 100) / 100` multiplies in float, so a decimal half-case rounds
// the WRONG way (`1.005 * 100` is `100.4999…` → 1.00 instead of 1.01); scaling through the decimal string makes
// the parser produce the nearest double to the intended decimal, so the half-case rounds as a human expects.
// Every mirrored money computation in the UI (the CTC breakdown, the top-down split preview) goes through this,
// so a previewed figure can't disagree with the server's by a paise.
export function round2(n: number): number {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-6) return 0;
  return Number(`${Math.round(Number(`${n}e2`))}e-2`);
}

// Format an amount in a currency. `decimals` sets the shown precision (both min and max fraction digits) so
// the currency's configured minor-unit count is honoured everywhere - e.g. INR at 0 renders ₹1,800, not
// ₹1,800.00. Omit `decimals` to fall back to the currency's Intl default. Money is stored full-precision;
// this only controls DISPLAY, so the value is rounded to `decimals` places here.
export function formatMoney(value: number, currency = "INR", decimals?: number): string {
  const dp = decimals == null ? undefined : Math.min(4, Math.max(0, Math.trunc(decimals)));
  try {
    // The catch still guards CONSTRUCTION: an unrecognised currency code throws inside `numberFormat`, and a
    // failed construction is never cached, so a bad code falls through to `toFixed` on every call as before.
    return numberFormat(undefined, {
      style: "currency",
      currency,
      ...(dp == null ? {} : { minimumFractionDigits: dp, maximumFractionDigits: dp }),
    }).format(value);
  } catch {
    return value.toFixed(dp ?? 2);
  }
}

/** Deterministic pastel-ish accent color from a string, for avatars. `alpha` (0-1) returns the SAME
 *  hue translucent, for tints drawn from a person's colour (the profile header's avatar ring). */
export function colorFromString(input: string, alpha?: number): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = input.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return alpha === undefined ? `hsl(${hue} 65% 45%)` : `hsl(${hue} 65% 45% / ${alpha})`;
}
