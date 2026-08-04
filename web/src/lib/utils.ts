import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extract the trailing id from an AEP `path` like "employees/abc123" → "abc123". */
export function idOf(path: string): string {
  return path.split("/").pop() ?? path;
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

export function formatDate(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

// Format an amount in a currency. `decimals` sets the shown precision (both min and max fraction digits) so
// the currency's configured minor-unit count is honoured everywhere - e.g. INR at 0 renders ₹1,800, not
// ₹1,800.00. Omit `decimals` to fall back to the currency's Intl default. Money is stored full-precision;
// this only controls DISPLAY, so the value is rounded to `decimals` places here.
export function formatMoney(value: number, currency = "INR", decimals?: number): string {
  const dp = decimals == null ? undefined : Math.min(4, Math.max(0, Math.trunc(decimals)));
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      ...(dp == null ? {} : { minimumFractionDigits: dp, maximumFractionDigits: dp }),
    }).format(value);
  } catch {
    return value.toFixed(dp ?? 2);
  }
}

/** Deterministic pastel-ish accent color from a string, for avatars. */
export function colorFromString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = input.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 45%)`;
}
