// Indian financial year (Apr-Mar), formatted "YYYY-YY" - the label Form 16, tax declarations and the payroll
// year all key off. Local calendar on purpose: a UTC month would still call April "last FY" for the first few
// hours of the 1st in IST, which is exactly when someone files for the new year.

/** FY label ("2025-26") that the given date falls in. */
export function currentFy(d = new Date()): string {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return fyLabel(start);
}

/** FY label for a starting calendar year (2025 -> "2025-26"). */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The current FY first, then `back` earlier ones - a picker beats a free-text year nobody can format right. */
export function fyOptions(back = 4, from = new Date()): string[] {
  const start = Number(currentFy(from).slice(0, 4));
  return Array.from({ length: back + 1 }, (_, i) => fyLabel(start - i));
}

export const isFyLabel = (s: string) => /^\d{4}-\d{2}$/.test(s.trim());

/** "1 Apr 2025 to 31 Mar 2026" - spells out what a bare FY label covers. */
export function fySpan(fy: string): string {
  const start = Number(fy.slice(0, 4));
  if (!Number.isFinite(start)) return "";
  return `1 Apr ${start} to 31 Mar ${start + 1}`;
}
