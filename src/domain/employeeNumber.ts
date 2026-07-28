// Human-facing employee ID (e.g. EMP-0042 / ACME-2026-017). HR-configurable via the `settings/employee-number`
// blob; this is only the default scheme used when no config exists. Distinct from the internal `code` (an authz
// scoping key bound to the department tree) and the opaque wire token - a stable, displayable company number.
// Pure data + helpers, no I/O. New numbers are auto-assigned as max(existing sequence)+1, HR-overridable.
export type EmployeeNumberConfig = {
  prefix: string; // leading label, e.g. "EMP" (may be blank)
  separator: string; // joins prefix / year / sequence, e.g. "-" (may be blank)
  width: number; // zero-pad width of the sequence, e.g. 4 -> "0042"
  include_year: boolean; // prepend the joining year
  year_format: "YYYY" | "YY"; // 2026 vs 26
  start: number; // first sequence number when there are no employees yet
};

export const DEFAULT_EMPLOYEE_NUMBER_CONFIG: EmployeeNumberConfig = {
  prefix: "EMP",
  separator: "-",
  width: 4,
  include_year: false,
  year_format: "YYYY",
  start: 1,
};

// Normalize a stored/partial config to a complete one (tolerates missing keys from an older/partial blob).
export function normalizeConfig(cfg?: Partial<EmployeeNumberConfig> | null): EmployeeNumberConfig {
  const d = DEFAULT_EMPLOYEE_NUMBER_CONFIG;
  return {
    prefix: cfg?.prefix ?? d.prefix,
    separator: cfg?.separator ?? d.separator,
    width: Math.max(1, Math.min(12, Math.trunc(cfg?.width ?? d.width))),
    include_year: cfg?.include_year ?? d.include_year,
    year_format: cfg?.year_format === "YY" ? "YY" : "YYYY",
    start: Math.max(0, Math.trunc(cfg?.start ?? d.start)),
  };
}

// Compose a number from a config + sequence + year.
export function formatEmployeeNumber(cfg: EmployeeNumberConfig, seq: number, year: number): string {
  const c = normalizeConfig(cfg);
  const parts: string[] = [];
  if (c.prefix) parts.push(c.prefix);
  if (c.include_year) parts.push(c.year_format === "YY" ? String(year).slice(-2) : String(year));
  parts.push(String(seq).padStart(c.width, "0"));
  return parts.join(c.separator ?? "");
}

// The trailing integer sequence of a formatted number (ignoring prefix/year), for max+1 allocation. Null when
// the value has no trailing digit run (e.g. a fully custom override) - such values simply don't move the max.
export function seqOf(num: string | null | undefined): number | null {
  if (!num) return null;
  const m = /(\d+)\s*$/.exec(num);
  return m ? parseInt(m[1]!, 10) : null;
}

// The next sequence for a set of existing numbers: one past the highest trailing sequence, or the config start
// when none parse. Pure so it's unit-testable; the service supplies the current numbers.
export function nextSeq(cfg: EmployeeNumberConfig, existing: (string | null | undefined)[]): number {
  const c = normalizeConfig(cfg);
  let max = c.start - 1;
  for (const n of existing) {
    const s = seqOf(n);
    if (s !== null && s > max) max = s;
  }
  return max + 1;
}
