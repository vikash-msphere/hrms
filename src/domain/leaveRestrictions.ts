// PURE leave-policy rules. No I/O - every fact the evaluator needs is handed to it, so the SAME function runs
// on the server (services/leaveRequests.ts, where it decides) and in the browser (RequestLeaveDialog, where it
// warns before the round trip). That is deliberate: `web/src/lib/leaveDays.ts` already imports domain/leave.ts
// straight into the bundle rather than mirroring it, and the comment there says why - two mirrors in this app
// have drifted from the server while promising they matched.
//
// WHAT THIS IS. A leave type used to carry accrual, probation, encashment and carry-forward policy, and every
// other rule a request was checked against was hard-coded in the create path. This is the rest of the policy an
// HR team actually writes down: notice requirements, frequency caps, sandwich counting, combinations with
// other types, exit-process limits, joining-month cutoffs, blackout windows.
//
// EVERYTHING IS OPTIONAL AND OFF BY DEFAULT. A null leaf is not "zero", it is "this org does not have that
// rule", and an org that configures nothing behaves exactly as it did before this file existed.
import { invalidArgument } from "../lib/errors";
import { daysByMonth, leaveDays, type JoiningRule, type SandwichMode, type SandwichRule } from "./leave";

const DAY_MS = 86_400_000;
const ymdUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayIndex = (ms: number) => Math.round(ms / DAY_MS);

export type NoticeTier = { up_to_days: number; notice_days: number };
export type AdvanceNotice = { tiers: NoticeTier[]; beyond_notice_days: number | null };
export type Blackout = { from: string; to: string; label?: string }; // YYYY-MM-DD, inclusive both ends
export type YearBasis = "calendar" | "fiscal" | "anniversary";

/**
 * The policy blob, held in TWO places with the same shape: `settings/leave_restrictions` is the org baseline
 * for the whole collection, and `leave_types.restrictions` is one type's overrides. See `mergeRestrictions`
 * for how the two combine.
 */
export type LeaveRestrictions = {
  eligibility: {
    min_tenure_days: number | null; // no requests until this much service
    max_occurrences_lifetime: number | null; // e.g. maternity twice
    max_lifetime_days: number | null;
  };
  request: {
    min_days: number | null;
    max_days: number | null;
    max_consecutive_days: number | null; // over the merged RUN of this type, not one row
    half_day_allowed: boolean | null;
    blocked_weekdays: number[] | null; // 0=Sun..6=Sat
    must_be_single_block: boolean | null;
    reason_required: boolean | null;
    reason_min_length: number | null;
    document_required_over_days: number | null;
    backdate_days: number | null; // per-type back-dating window; overrides settings/leave-requests
  };
  timing: {
    advance_notice: AdvanceNotice | null;
    max_advance_days: number | null;
    blackouts: Blackout[] | null;
    blackout_days_of_month: number[] | null; // recurring, e.g. [28,29,30,31] for a month-end close
    block_adjacent_to_holiday: boolean | null;
  };
  quota: {
    max_days_per_month: number | null;
    max_days_per_year: number | null;
    max_requests_per_month: number | null;
    max_requests_per_year: number | null;
    min_gap_days: number | null; // working days between one request of this type and the next
    year_basis: YearBasis | null; // default "calendar"
    fiscal_year_start_month: number | null; // 1..12, default 4 (April) - used only by year_basis "fiscal"
  };
  combinations: {
    no_combination_with: string[] | null; // "leave-types/<id>" refs
    gap_days: number | null; // 0 = may not abut; N = may not come within N working days
  };
  counting: { sandwich: SandwichRule | null };
  exit: {
    during_notice: "allowed" | "blocked" | "capped" | null;
    notice_cap_days: number | null;
  };
  accrual: { joining_rule: JoiningRule | null };
  /**
   * Rule codes that WARN instead of blocking. The request is created, the warnings are recorded on it and the
   * approver is shown them before deciding - which is how "emergency, at the manager's discretion" is said
   * without a second policy system beside this one.
   */
  soft_rules: string[] | null;
};

/** The sections of the blob - every top-level key but `soft_rules`, which is a leaf of its own. */
export type RestrictionGroup = Exclude<keyof LeaveRestrictions, "soft_rules">;

export const DEFAULT_LEAVE_RESTRICTIONS: LeaveRestrictions = {
  eligibility: { min_tenure_days: null, max_occurrences_lifetime: null, max_lifetime_days: null },
  request: {
    min_days: null, max_days: null, max_consecutive_days: null, half_day_allowed: null, blocked_weekdays: null,
    must_be_single_block: null, reason_required: null, reason_min_length: null, document_required_over_days: null,
    backdate_days: null,
  },
  timing: { advance_notice: null, max_advance_days: null, blackouts: null, blackout_days_of_month: null, block_adjacent_to_holiday: null },
  quota: {
    max_days_per_month: null, max_days_per_year: null, max_requests_per_month: null, max_requests_per_year: null,
    min_gap_days: null, year_basis: null, fiscal_year_start_month: null,
  },
  combinations: { no_combination_with: null, gap_days: null },
  counting: { sandwich: null },
  exit: { during_notice: null, notice_cap_days: null },
  accrual: { joining_rule: null },
  soft_rules: null,
};

/** Every rule code the evaluator can emit. `soft_rules` is validated against this, so a typo can't silently
 *  fail to waive anything (a waiver that does nothing reads on screen as a waiver that works). */
export const RESTRICTION_CODES = [
  "min_tenure", "max_occurrences", "max_lifetime_days",
  "min_days", "max_days", "max_consecutive", "half_day", "blocked_weekday", "single_block",
  "reason_required", "document_required", "backdated",
  "advance_notice", "max_advance", "blackout", "holiday_adjacent",
  "max_days_per_month", "max_days_per_year", "max_requests_per_month", "max_requests_per_year", "min_gap",
  "combination", "exit_notice", "joining_month",
] as const;
export type RestrictionCode = (typeof RESTRICTION_CODES)[number];

export type Violation = { code: RestrictionCode; severity: "error" | "warning"; message: string };

// ---- Parse / validate / merge ---------------------------------------------------------------------------
//
// Lenient on the way in, strict on the way out - the same split domain/policyValidate.ts documents. A blob
// that has gone bad must not take down every leave request in the org (the READ path degrades to "no rules"),
// but a bad EDIT has to be refused, or the policy silently stops meaning what the screen says.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const SANDWICH_MODES = new Set<SandwichMode>(["exclude", "intervening", "flanking"]);
const mode = (v: unknown): SandwichMode | null => (typeof v === "string" && SANDWICH_MODES.has(v as SandwichMode) ? (v as SandwichMode) : null);
const numArray = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);
const strArray = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lenient read: anything unrecognised is dropped, so a half-written or hand-edited blob degrades to fewer
 *  rules rather than to an exception on the hot path. */
export function parseRestrictions(raw: unknown): LeaveRestrictions {
  const src: Record<string, unknown> = isObj(raw) ? raw : typeof raw === "string" ? safeJson(raw) : {};
  const g = (k: string): Record<string, unknown> => (isObj(src[k]) ? (src[k] as Record<string, unknown>) : {});
  const el = g("eligibility"), rq = g("request"), tm = g("timing"), qt = g("quota"), cb = g("combinations"), ct = g("counting"), ex = g("exit"), ac = g("accrual");
  const sandwich = isObj(ct.sandwich) ? { weekends: mode(ct.sandwich.weekends) ?? "exclude", holidays: mode(ct.sandwich.holidays) ?? "exclude" } : null;
  const notice = isObj(tm.advance_notice) ? parseNotice(tm.advance_notice) : null;
  return {
    eligibility: {
      min_tenure_days: num(el.min_tenure_days),
      max_occurrences_lifetime: num(el.max_occurrences_lifetime),
      max_lifetime_days: num(el.max_lifetime_days),
    },
    request: {
      min_days: num(rq.min_days), max_days: num(rq.max_days), max_consecutive_days: num(rq.max_consecutive_days),
      half_day_allowed: bool(rq.half_day_allowed), blocked_weekdays: numArray(rq.blocked_weekdays),
      must_be_single_block: bool(rq.must_be_single_block), reason_required: bool(rq.reason_required),
      reason_min_length: num(rq.reason_min_length), document_required_over_days: num(rq.document_required_over_days),
      backdate_days: num(rq.backdate_days),
    },
    timing: {
      advance_notice: notice,
      max_advance_days: num(tm.max_advance_days),
      blackouts: Array.isArray(tm.blackouts)
        ? tm.blackouts.filter((b): b is Blackout => isObj(b) && YMD_RE.test(String(b.from)) && YMD_RE.test(String(b.to)))
            .map((b) => ({ from: b.from, to: b.to, ...(b.label ? { label: String(b.label) } : {}) }))
        : null,
      blackout_days_of_month: numArray(tm.blackout_days_of_month),
      block_adjacent_to_holiday: bool(tm.block_adjacent_to_holiday),
    },
    quota: {
      max_days_per_month: num(qt.max_days_per_month), max_days_per_year: num(qt.max_days_per_year),
      max_requests_per_month: num(qt.max_requests_per_month), max_requests_per_year: num(qt.max_requests_per_year),
      min_gap_days: num(qt.min_gap_days),
      year_basis: qt.year_basis === "fiscal" || qt.year_basis === "anniversary" || qt.year_basis === "calendar" ? qt.year_basis : null,
      fiscal_year_start_month: num(qt.fiscal_year_start_month),
    },
    combinations: { no_combination_with: strArray(cb.no_combination_with), gap_days: num(cb.gap_days) },
    counting: { sandwich },
    exit: {
      during_notice: ex.during_notice === "blocked" || ex.during_notice === "capped" || ex.during_notice === "allowed" ? ex.during_notice : null,
      notice_cap_days: num(ex.notice_cap_days),
    },
    accrual: { joining_rule: isObj(ac.joining_rule) ? parseJoining(ac.joining_rule) : null },
    soft_rules: strArray(src.soft_rules),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function parseNotice(v: Record<string, unknown>): AdvanceNotice | null {
  const tiers = Array.isArray(v.tiers)
    ? v.tiers.filter((t): t is NoticeTier => isObj(t) && num(t.up_to_days) !== null && num(t.notice_days) !== null)
        .map((t) => ({ up_to_days: t.up_to_days, notice_days: t.notice_days }))
        .sort((a, b) => a.up_to_days - b.up_to_days)
    : [];
  const beyond = num(v.beyond_notice_days);
  return tiers.length || beyond !== null ? { tiers, beyond_notice_days: beyond } : null;
}

function parseJoining(v: Record<string, unknown>): JoiningRule | null {
  const cutoff = num(v.cutoff_day);
  if (cutoff === null) return null;
  return {
    cutoff_day: cutoff,
    if_on_or_before: v.if_on_or_before === "full" ? "full" : "prorate",
    if_after: v.if_after === "prorate" ? "prorate" : "none",
  };
}

/**
 * Strict write validation. Throws `invalidArgument`; returns the blob as it will be stored (unknown keys are
 * an error, not a silent drop - an admin who mistypes a rule name has to be told, because the alternative is
 * a policy screen that saves cleanly and enforces nothing).
 */
export function validateRestrictions(raw: unknown): LeaveRestrictions {
  if (raw == null) return DEFAULT_LEAVE_RESTRICTIONS;
  if (!isObj(raw)) throw invalidArgument("restrictions must be an object");
  const known: Record<string, Set<string>> = {
    eligibility: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.eligibility)),
    request: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.request)),
    timing: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.timing)),
    quota: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.quota)),
    combinations: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.combinations)),
    counting: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.counting)),
    exit: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.exit)),
    accrual: new Set(Object.keys(DEFAULT_LEAVE_RESTRICTIONS.accrual)),
  };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "soft_rules") {
      if (v === null) continue;
      const codes = strArray(v);
      if (!codes) throw invalidArgument("soft_rules must be an array of rule codes");
      for (const c of codes) if (!(RESTRICTION_CODES as readonly string[]).includes(c)) throw invalidArgument(`unknown rule code "${c}" in soft_rules`);
      continue;
    }
    if (!known[k]) throw invalidArgument(`unknown restrictions section "${k}"`);
    if (v === null) continue;
    if (!isObj(v)) throw invalidArgument(`restrictions.${k} must be an object`);
    for (const leaf of Object.keys(v)) if (!known[k]!.has(leaf)) throw invalidArgument(`unknown restriction "${k}.${leaf}"`);
  }
  const parsed = parseRestrictions(raw);
  // Shape is right; now the values have to be usable. Each of these is a number that would otherwise be
  // enforced literally - a cutoff of 0 bars every joiner, a negative cap refuses every request.
  const positive = (v: number | null, name: string) => { if (v !== null && v < 0) throw invalidArgument(`${name} cannot be negative`); };
  positive(parsed.eligibility.min_tenure_days, "min_tenure_days");
  positive(parsed.eligibility.max_occurrences_lifetime, "max_occurrences_lifetime");
  positive(parsed.eligibility.max_lifetime_days, "max_lifetime_days");
  positive(parsed.request.min_days, "min_days");
  positive(parsed.request.max_days, "max_days");
  positive(parsed.request.max_consecutive_days, "max_consecutive_days");
  positive(parsed.request.document_required_over_days, "document_required_over_days");
  positive(parsed.request.backdate_days, "backdate_days");
  positive(parsed.timing.max_advance_days, "max_advance_days");
  positive(parsed.quota.min_gap_days, "min_gap_days");
  positive(parsed.exit.notice_cap_days, "notice_cap_days");
  if (parsed.request.min_days !== null && parsed.request.max_days !== null && parsed.request.min_days > parsed.request.max_days) {
    throw invalidArgument("min_days cannot exceed max_days - no request could satisfy both");
  }
  for (const d of parsed.request.blocked_weekdays ?? []) if (d < 0 || d > 6) throw invalidArgument("blocked_weekdays are 0 (Sunday) to 6 (Saturday)");
  for (const d of parsed.timing.blackout_days_of_month ?? []) if (d < 1 || d > 31) throw invalidArgument("blackout_days_of_month are 1 to 31");
  for (const b of parsed.timing.blackouts ?? []) if (b.to < b.from) throw invalidArgument(`blackout "${b.label ?? b.from}" ends before it starts`);
  for (const t of parsed.timing.advance_notice?.tiers ?? []) {
    if (t.up_to_days <= 0) throw invalidArgument("an advance-notice tier covers requests UP TO a length, which must be positive");
    if (t.notice_days < 0) throw invalidArgument("advance-notice days cannot be negative");
  }
  const fy = parsed.quota.fiscal_year_start_month;
  if (fy !== null && (fy < 1 || fy > 12)) throw invalidArgument("fiscal_year_start_month is 1 to 12");
  const jr = parsed.accrual.joining_rule;
  // 28, not 31: a cutoff of the 30th would mean something different in February, and a rule whose meaning
  // moves with the month is not one anybody can reason about.
  if (jr && (jr.cutoff_day < 1 || jr.cutoff_day > 28)) throw invalidArgument("joining_rule.cutoff_day is 1 to 28");
  if (parsed.exit.during_notice === "capped" && parsed.exit.notice_cap_days === null) {
    throw invalidArgument("during_notice \"capped\" needs notice_cap_days");
  }
  return parsed;
}

/**
 * The org baseline and one type's overrides, combined.
 *
 * PER LEAF, two levels deep: a leaf the type sets wins, a leaf it omits inherits the org's, and an explicit
 * `null` leaf means "no restriction for this type" - it BLOCKS inheritance rather than falling back to the
 * baseline, which is the only way a type can be exempted from an org-wide rule. Arrays are replaced whole,
 * never merged: a type that lists two blackout windows has two, not the org's plus its own.
 *
 * The caller passes the two blobs as they were STORED (undefined where nothing was set), not as parsed
 * defaults - parsing fills every leaf with null, and a null that came from a default would then read as a
 * deliberate exemption. `parseStored` below is the pair to this.
 */
export function mergeRestrictions(orgBaseline: unknown, typeOverride: unknown): LeaveRestrictions {
  const org = parseRestrictions(orgBaseline);
  const type = parseRestrictions(typeOverride);
  const setLeaves = storedLeaves(typeOverride);
  const out = { ...DEFAULT_LEAVE_RESTRICTIONS } as LeaveRestrictions;
  for (const group of Object.keys(DEFAULT_LEAVE_RESTRICTIONS) as (keyof LeaveRestrictions)[]) {
    if (group === "soft_rules") {
      out.soft_rules = setLeaves.has("soft_rules") ? type.soft_rules : org.soft_rules;
      continue;
    }
    const merged: Record<string, unknown> = {};
    for (const leaf of Object.keys(DEFAULT_LEAVE_RESTRICTIONS[group] as object)) {
      const key = `${group}.${leaf}`;
      merged[leaf] = setLeaves.has(key)
        ? (type[group] as Record<string, unknown>)[leaf]
        : (org[group] as Record<string, unknown>)[leaf];
    }
    (out as Record<string, unknown>)[group] = merged;
  }
  return out;
}

/** Which leaves the stored blob actually mentions - "group.leaf" keys, plus "soft_rules". A leaf mentioned
 *  with an explicit null is present (that is the exemption), a leaf never written is absent. */
function storedLeaves(raw: unknown): Set<string> {
  const src: Record<string, unknown> = isObj(raw) ? raw : typeof raw === "string" ? safeJson(raw) : {};
  const out = new Set<string>();
  for (const [group, v] of Object.entries(src)) {
    if (group === "soft_rules") { out.add("soft_rules"); continue; }
    // A whole group set to null exempts the type from ALL of that group's org rules - the same statement a
    // null leaf makes, said once for the section. Without this the API would accept `{"quota": null}` (the
    // route schema allows it) and then quietly inherit every quota rule anyway.
    if (v === null) {
      for (const leaf of Object.keys(DEFAULT_LEAVE_RESTRICTIONS[group as RestrictionGroup] ?? {})) out.add(`${group}.${leaf}`);
      continue;
    }
    if (!isObj(v)) continue;
    for (const leaf of Object.keys(v)) out.add(`${group}.${leaf}`);
  }
  return out;
}

/** Does this blob configure anything at all? Used to skip the whole evaluation - and the reads that feed it. */
export function hasAnyRestriction(r: LeaveRestrictions): boolean {
  for (const [group, v] of Object.entries(r)) {
    if (group === "soft_rules") continue; // waivers alone restrict nothing
    for (const leaf of Object.values(v as object)) if (leaf !== null) return true;
  }
  return false;
}

// ---- Derived helpers ------------------------------------------------------------------------------------

/** The notice a request of `days` needs: the shortest tier that COVERS it, else the beyond-tiers figure.
 *  Absent policy (or a request longer than every tier with no beyond figure) = no requirement. */
export function requiredNotice(notice: AdvanceNotice | null, days: number): number | null {
  if (!notice) return null;
  for (const t of [...notice.tiers].sort((a, b) => a.up_to_days - b.up_to_days)) {
    if (days <= t.up_to_days) return t.notice_days;
  }
  return notice.beyond_notice_days;
}

/** The sandwich rule to charge days with (absent policy = charge nothing for days off, as before). */
export function sandwichOf(r: LeaveRestrictions): SandwichRule {
  return r.counting.sandwich ?? { weekends: "exclude", holidays: "exclude" };
}

/**
 * The window of a person's leave history the configured rules actually need, or null when none of them needs
 * any - which is the point: an org that has set no quota, gap or combination rule pays for no extra read at
 * all, and this is the one place that decides so (D1 bills rows read).
 *
 * Lifetime rules are deliberately NOT expressed here: "ever" is not a window, and the caller answers those
 * with an aggregate instead (`needsLifetime`).
 */
export function historyWindow(
  r: LeaveRestrictions,
  startMs: number,
  endMs: number,
  employeeStartMs: number | null,
): { fromMs: number; toMs: number } | null {
  let from = startMs;
  let to = endMs;
  const widen = (f: number, t: number) => { from = Math.min(from, f); to = Math.max(to, t); };
  let needed = false;
  const pad = (days: number) => { needed = true; widen(startMs - days * DAY_MS, endMs + days * DAY_MS); };

  if (r.quota.max_days_per_month !== null || r.quota.max_requests_per_month !== null) {
    needed = true;
    widen(monthStart(startMs), monthEnd(endMs));
  }
  if (r.quota.max_days_per_year !== null || r.quota.max_requests_per_year !== null) {
    needed = true;
    const basis = r.quota.year_basis ?? "calendar";
    const fyStart = r.quota.fiscal_year_start_month ?? 4;
    widen(yearStart(startMs, basis, fyStart, employeeStartMs), yearEnd(endMs, basis, fyStart, employeeStartMs));
  }
  // A gap or adjacency rule only ever looks that far out; the merged-run and single-block rules need enough
  // room to find the neighbours that would join this request into one stretch, and a run can only be as long
  // as the cap it is measured against (plus the days off that bridge it).
  if (r.quota.min_gap_days !== null) pad(r.quota.min_gap_days + 1);
  if (r.combinations.no_combination_with?.length) pad((r.combinations.gap_days ?? 0) + 1);
  if (r.request.max_consecutive_days !== null) pad(r.request.max_consecutive_days + 7);
  if (r.request.must_be_single_block) pad(370); // "one block" is a claim about the whole entitlement year

  return needed ? { fromMs: from, toMs: to } : null;
}

/** Do any configured rules need this employee's whole history of this type (rather than a window)? */
export function needsLifetime(r: LeaveRestrictions): boolean {
  return r.eligibility.max_occurrences_lifetime !== null || r.eligibility.max_lifetime_days !== null;
}

const monthStart = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const monthEnd = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); };

/**
 * Which "year" a day belongs to, as an opaque key. Three bases, because the three are all in use: a calendar
 * year, a fiscal year starting in a configured month (April in India, the default), and the employee's own
 * joining anniversary.
 */
export function yearKeyOf(ms: number, basis: YearBasis, fiscalStartMonth: number, employeeStartMs: number | null): string {
  const d = new Date(ms);
  if (basis === "anniversary") {
    if (employeeStartMs == null) return String(d.getUTCFullYear()); // no start date: nothing to count from
    let n = d.getUTCFullYear() - new Date(employeeStartMs).getUTCFullYear();
    if (anniversaryMs(employeeStartMs, d.getUTCFullYear()) > ms) n -= 1;
    return `A${n}`;
  }
  if (basis === "fiscal") {
    const y = d.getUTCFullYear();
    return String(d.getUTCMonth() + 1 >= fiscalStartMonth ? y : y - 1);
  }
  return String(d.getUTCFullYear());
}

const anniversaryMs = (startMs: number, year: number) => {
  const s = new Date(startMs);
  return Date.UTC(year, s.getUTCMonth(), s.getUTCDate());
};

function yearStart(ms: number, basis: YearBasis, fiscalStartMonth: number, employeeStartMs: number | null): number {
  const d = new Date(ms);
  if (basis === "anniversary" && employeeStartMs != null) {
    const thisYear = anniversaryMs(employeeStartMs, d.getUTCFullYear());
    return thisYear <= ms ? thisYear : anniversaryMs(employeeStartMs, d.getUTCFullYear() - 1);
  }
  if (basis === "fiscal") {
    const y = d.getUTCMonth() + 1 >= fiscalStartMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return Date.UTC(y, fiscalStartMonth - 1, 1);
  }
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

function yearEnd(ms: number, basis: YearBasis, fiscalStartMonth: number, employeeStartMs: number | null): number {
  return yearStart(ms, basis, fiscalStartMonth, employeeStartMs) + 366 * DAY_MS; // a generous upper bound; the key comparison is what decides
}

// ---- The evaluator --------------------------------------------------------------------------------------

/** One of the employee's other live (pending/approved) leave requests, as the evaluator needs to see it. */
export type LeaveNeighbour = {
  uuid: string;
  leaveTypeId: string;
  leaveTypeName?: string;
  startMs: number;
  endMs: number;
  startSession: number;
  endSession: number;
  /** That type's OWN exclusion list, so a combination rule holds whichever of the two types declares it. */
  noCombinationWith?: readonly string[] | null;
};

export type RestrictionFacts = {
  rules: LeaveRestrictions;
  leaveTypeId: string; // internal id, matched against `no_combination_with` refs by their trailing id
  leaveTypeName: string;
  startMs: number;
  endMs: number;
  startSession: number;
  endSession: number;
  days: number; // this request's chargeable days, sandwich already applied
  todayMs: number; // the ORG's today, at UTC midnight (services/orgDay.ts)
  employeeStartMs: number | null;
  onBehalf: boolean; // HR filing for somebody else - the planning courtesies don't apply
  /** Whether a supporting document is attached, or null for "cannot be known yet" - at create time the row
   *  has to exist before bytes can hang off it, so the document rule is checked on approval instead. */
  hasDocument: boolean | null;
  reason: string | null;
  workDays: readonly number[];
  holidays: ReadonlySet<string>;
  halfDayHolidays: ReadonlySet<string>;
  neighbours: readonly LeaveNeighbour[]; // live leave inside historyWindow(); [] when no rule needed it
  lifetime: { requests: number; days: number } | null; // this type, all time, excluding this request
  exitWindow: { fromMs: number; toMs: number } | null; // serving notice period / known last working day
  exitDaysUsed: number; // days of this type already booked inside that window
};

/**
 * Every configured rule, evaluated against the facts. Returns ONE violation per rule, in the order they are
 * written above, so the message a caller leads with is the most specific thing wrong rather than whichever
 * check happened to run first.
 */
export function checkLeaveRestrictions(f: RestrictionFacts): Violation[] {
  const r = f.rules;
  const out: Violation[] = [];
  const soft = new Set(r.soft_rules ?? []);
  const add = (code: RestrictionCode, message: string) => {
    out.push({ code, severity: soft.has(code) ? "warning" : "error", message });
  };
  const type = f.leaveTypeName;
  const plural = (n: number, one = "day", many = "days") => `${fmt(n)} ${n === 1 ? one : many}`;
  const sandwich = sandwichOf(r);
  const chargeable = (startMs: number, endMs: number, ss: number, es: number) =>
    leaveDays(startMs, endMs, ss, es, f.workDays, f.holidays, f.halfDayHolidays, sandwich);
  const sameType = f.neighbours.filter((n) => n.leaveTypeId === f.leaveTypeId);

  // ---- eligibility ----
  const tenure = r.eligibility.min_tenure_days;
  if (tenure !== null && f.employeeStartMs != null && f.startMs < f.employeeStartMs + tenure * DAY_MS) {
    // Measured against the leave's START, not against today: booking ahead for a date you will be eligible on
    // is exactly what a waiting period allows, and refusing it would make the rule stricter than it reads.
    const eligibleFrom = ymdUtc(f.employeeStartMs + tenure * DAY_MS);
    add("min_tenure", `${type} needs ${plural(tenure)} of service - you're eligible from ${eligibleFrom}.`);
  }
  if (r.eligibility.max_occurrences_lifetime !== null && f.lifetime && f.lifetime.requests + 1 > r.eligibility.max_occurrences_lifetime) {
    add("max_occurrences", `${type} may be taken ${plural(r.eligibility.max_occurrences_lifetime, "time", "times")} in total, and you have already taken it ${plural(f.lifetime.requests, "time", "times")}.`);
  }
  if (r.eligibility.max_lifetime_days !== null && f.lifetime && f.lifetime.days + f.days > r.eligibility.max_lifetime_days + 1e-9) {
    add("max_lifetime_days", `${type} is capped at ${plural(r.eligibility.max_lifetime_days)} in total; ${plural(f.lifetime.days)} already used.`);
  }

  // ---- the shape of one request ----
  if (r.request.min_days !== null && f.days < r.request.min_days - 1e-9) {
    add("min_days", `${type} must be taken ${plural(r.request.min_days)} at a time - this is ${plural(f.days)}.`);
  }
  if (r.request.max_days !== null && f.days > r.request.max_days + 1e-9) {
    add("max_days", `${type} allows at most ${plural(r.request.max_days)} in one request - this is ${plural(f.days)}.`);
  }
  if (r.request.half_day_allowed === false && (f.startSession !== 1 || f.endSession !== 2)) {
    add("half_day", `${type} is taken in whole days.`);
  }
  const blockedDows = r.request.blocked_weekdays;
  if (blockedDows?.length && !f.onBehalf) {
    const hit = chargedDays(f).find((ms) => blockedDows.includes(new Date(ms).getUTCDay()));
    if (hit !== undefined) add("blocked_weekday", `${type} can't be taken on a ${WEEKDAYS[new Date(hit).getUTCDay()]} (${ymdUtc(hit)}).`);
  }
  if (r.request.reason_required && (f.reason ?? "").trim().length < Math.max(1, r.request.reason_min_length ?? 1)) {
    const min = r.request.reason_min_length;
    add("reason_required", min && min > 1 ? `${type} needs a reason of at least ${min} characters.` : `${type} needs a reason.`);
  }
  if (r.request.document_required_over_days !== null && f.days > r.request.document_required_over_days + 1e-9 && f.hasDocument === false) {
    add("document_required", `${type} over ${plural(r.request.document_required_over_days)} needs a supporting document.`);
  }
  if (r.request.backdate_days !== null && !f.onBehalf && f.startMs < f.todayMs - r.request.backdate_days * DAY_MS) {
    add("backdated", r.request.backdate_days === 0
      ? `${type} can't be back-dated.`
      : `${type} can only be back-dated ${plural(r.request.backdate_days)}.`);
  }

  // ---- the merged run: consecutive cap + single block ----
  // Both rules are about the STRETCH this request lands in, not about the row. Splitting a fortnight into two
  // requests is the obvious way around a per-request cap, so the run is what gets measured: neighbours of the
  // same type join it when only days off separate them (Friday and Monday are consecutive leave).
  const run = mergedRun(f, sameType);
  if (r.request.max_consecutive_days !== null) {
    const runDays = chargeable(run.startMs, run.endMs, run.startSession, run.endSession);
    if (runDays > r.request.max_consecutive_days + 1e-9) {
      const joined = run.joined > 0 ? ` (together with leave you have already booked either side, ${plural(runDays)} in a row)` : "";
      add("max_consecutive", `${type} allows at most ${plural(r.request.max_consecutive_days)} in a row${joined}.`);
    }
  }
  if (r.request.must_be_single_block && sameType.some((n) => !run.members.has(n.uuid))) {
    add("single_block", `${type} has to be taken as one unbroken block.`);
  }

  // ---- timing ----
  const noticeGiven = dayIndex(f.startMs) - dayIndex(f.todayMs);
  const needNotice = requiredNotice(r.timing.advance_notice, f.days);
  if (needNotice !== null && !f.onBehalf && noticeGiven < needNotice) {
    add("advance_notice", `${plural(f.days)} of ${type} needs ${plural(needNotice)}' notice; this starts ${noticeGiven <= 0 ? "today" : `in ${plural(noticeGiven)}`}.`);
  }
  if (r.timing.max_advance_days !== null && !f.onBehalf && noticeGiven > r.timing.max_advance_days) {
    add("max_advance", `${type} can't be booked more than ${plural(r.timing.max_advance_days)} ahead.`);
  }
  if (!f.onBehalf) {
    const charged = chargedDays(f);
    const window = (r.timing.blackouts ?? []).find((b) => charged.some((ms) => { const d = ymdUtc(ms); return d >= b.from && d <= b.to; }));
    if (window) add("blackout", `${type} is closed from ${window.from} to ${window.to}${window.label ? ` (${window.label})` : ""}.`);
    const dom = r.timing.blackout_days_of_month;
    if (dom?.length) {
      const hit = charged.find((ms) => dom.includes(new Date(ms).getUTCDate()));
      if (hit !== undefined) add("blackout", `${type} can't be taken on the ${dom.map(ordinal).join(", ")} of a month (${ymdUtc(hit)}).`);
    }
  }
  if (r.timing.block_adjacent_to_holiday) {
    // Bridging: a holiday touching either end of the block. Checked against the calendar days on each side of
    // the REQUESTED range, which is where an employee would put the leave to extend a holiday.
    const before = ymdUtc(f.startMs - DAY_MS);
    const after = ymdUtc(f.endMs + DAY_MS);
    const isHoliday = (d: string) => f.holidays.has(d) || f.halfDayHolidays.has(d);
    if (isHoliday(before) || isHoliday(after)) add("holiday_adjacent", `${type} can't be taken next to a public holiday.`);
  }

  // ---- quota ----
  const basis = r.quota.year_basis ?? "calendar";
  const fyStart = r.quota.fiscal_year_start_month ?? 4;
  const mineByMonth = daysByMonth(f.startMs, f.endMs, f.startSession, f.endSession, f.workDays, f.holidays, f.halfDayHolidays, sandwich);
  if (r.quota.max_days_per_month !== null) {
    const used = monthTotals(f, sameType, sandwich);
    for (const [ym, mine] of Object.entries(mineByMonth)) {
      const total = mine + (used[ym] ?? 0);
      if (total > r.quota.max_days_per_month + 1e-9) {
        add("max_days_per_month", `${type} is capped at ${plural(r.quota.max_days_per_month)} in ${monthLabel(ym)}; this would make ${plural(total)}.`);
        break;
      }
    }
  }
  if (r.quota.max_days_per_year !== null) {
    const used = monthTotals(f, sameType, sandwich);
    const byYear = (m: Record<string, number>) => {
      const o: Record<string, number> = {};
      for (const [ym, v] of Object.entries(m)) {
        const key = yearKeyOf(Date.parse(`${ym}-01T00:00:00Z`), basis, fyStart, f.employeeStartMs);
        o[key] = (o[key] ?? 0) + v;
      }
      return o;
    };
    // Grouped from each month's FIRST day, so on the anniversary basis a month straddling the joining
    // anniversary counts wholly in the year it began in. Deliberate: the alternative is splitting a month's
    // total across two entitlement years, and the day-level answer is not one a reader of the cap could
    // predict either. Calendar and fiscal years always begin on the 1st, so neither is affected.
    const usedByYear = byYear(used);
    for (const [key, mine] of Object.entries(byYear(mineByMonth))) {
      const total = mine + (usedByYear[key] ?? 0);
      if (total > r.quota.max_days_per_year + 1e-9) {
        add("max_days_per_year", `${type} is capped at ${plural(r.quota.max_days_per_year)} a year; this would make ${plural(total)}.`);
        break;
      }
    }
  }
  if (r.quota.max_requests_per_month !== null) {
    // A request counts in the period its START falls in - one rule, whatever the range does afterwards.
    const ym = ymdUtc(f.startMs).slice(0, 7);
    const count = sameType.filter((n) => ymdUtc(n.startMs).slice(0, 7) === ym).length + 1;
    if (count > r.quota.max_requests_per_month) {
      add("max_requests_per_month", `${type} can be taken ${plural(r.quota.max_requests_per_month, "time", "times")} in ${monthLabel(ym)}.`);
    }
  }
  if (r.quota.max_requests_per_year !== null) {
    const key = yearKeyOf(f.startMs, basis, fyStart, f.employeeStartMs);
    const count = sameType.filter((n) => yearKeyOf(n.startMs, basis, fyStart, f.employeeStartMs) === key).length + 1;
    if (count > r.quota.max_requests_per_year) {
      add("max_requests_per_year", `${type} can be taken ${plural(r.quota.max_requests_per_year, "time", "times")} a year.`);
    }
  }
  if (r.quota.min_gap_days !== null) {
    const tooClose = sameType
      .map((n) => ({ n, gap: workingGap(f, n) }))
      .filter((x) => x.gap !== null && x.gap < r.quota.min_gap_days!)
      .sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0))[0];
    if (tooClose) {
      add("min_gap", `${type} needs ${plural(r.quota.min_gap_days)} between requests; your leave on ${ymdUtc(tooClose.n.startMs)} is ${plural(tooClose.gap ?? 0)} away.`);
    }
  }

  // ---- combinations ----
  const mine = new Set((r.combinations.no_combination_with ?? []).map(idOfRef));
  const gapLimit = r.combinations.gap_days ?? 0;
  const clash = f.neighbours.find((n) => {
    if (n.leaveTypeId === f.leaveTypeId) return false;
    const theirs = new Set((n.noCombinationWith ?? []).map(idOfRef));
    if (!mine.has(n.leaveTypeId) && !theirs.has(f.leaveTypeId)) return false;
    const gap = workingGap(f, n);
    return gap !== null && gap <= gapLimit;
  });
  if (clash) {
    add("combination", gapLimit === 0
      ? `${type} can't be taken back to back with ${clash.leaveTypeName ?? "that leave type"} (${ymdUtc(clash.startMs)}).`
      : `${type} can't be taken within ${plural(gapLimit)} of ${clash.leaveTypeName ?? "that leave type"} (${ymdUtc(clash.startMs)}).`);
  }

  // ---- exit process ----
  if (f.exitWindow && r.exit.during_notice && r.exit.during_notice !== "allowed") {
    const overlaps = f.startMs <= f.exitWindow.toMs && f.endMs >= f.exitWindow.fromMs;
    if (overlaps && r.exit.during_notice === "blocked") {
      add("exit_notice", `${type} can't be taken while you're serving notice.`);
    } else if (overlaps && r.exit.during_notice === "capped" && r.exit.notice_cap_days !== null) {
      const total = f.exitDaysUsed + f.days;
      if (total > r.exit.notice_cap_days + 1e-9) {
        add("exit_notice", `${type} is limited to ${plural(r.exit.notice_cap_days)} during your notice period; this would make ${plural(total)}.`);
      }
    }
  }

  // ---- the joining month ----
  const jr = r.accrual.joining_rule;
  if (jr && jr.if_after === "none" && f.employeeStartMs != null) {
    const s = new Date(f.employeeStartMs);
    const start = new Date(f.startMs);
    const sameMonth = s.getUTCFullYear() === start.getUTCFullYear() && s.getUTCMonth() === start.getUTCMonth();
    if (sameMonth && s.getUTCDate() > jr.cutoff_day) {
      add("joining_month", `${type} doesn't accrue in your joining month because you joined after the ${ordinal(jr.cutoff_day)}, so it can't be taken in ${monthLabel(ymdUtc(f.startMs).slice(0, 7))}.`);
    }
  }

  return out;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
/** A `no_combination_with` entry is a resource ref ("leave-types/<id>"); neighbours carry the bare id. */
const idOfRef = (ref: string) => ref.split("/").pop() ?? ref;

/** The days inside the requested range that are actually charged - the ones a weekday, blackout or holiday
 *  rule has anything to say about (a blackout that only covers the weekend inside a range blocks nothing). */
function chargedDays(f: RestrictionFacts): number[] {
  const out: number[] = [];
  for (let d = f.startMs; d <= f.endMs; d += DAY_MS) {
    const ymd = ymdUtc(d);
    if (!f.workDays.includes(new Date(d).getUTCDay()) || f.holidays.has(ymd)) continue;
    out.push(d);
  }
  return out;
}

/** Working days strictly between two leave ranges, or null when they overlap. Friday→Monday is 0: they are
 *  consecutive leave, whatever the calendar says. */
function workingGap(f: RestrictionFacts, n: { startMs: number; endMs: number }): number | null {
  const [earlierEnd, laterStart] = n.endMs < f.startMs ? [n.endMs, f.startMs] : f.endMs < n.startMs ? [f.endMs, n.startMs] : [0, 0];
  if (!laterStart) return null; // overlapping - the overlap check has already refused it
  let gap = 0;
  for (let d = earlierEnd + DAY_MS; d < laterStart; d += DAY_MS) {
    const ymd = ymdUtc(d);
    if (f.workDays.includes(new Date(d).getUTCDay()) && !f.holidays.has(ymd)) gap++;
  }
  return gap;
}

/** This request plus every same-type neighbour it runs into, as one stretch. `joined` counts the neighbours
 *  that merged; `members` names them, so the single-block rule can ask which did not. */
function mergedRun(f: RestrictionFacts, sameType: readonly LeaveNeighbour[]) {
  let startMs = f.startMs, endMs = f.endMs, startSession = f.startSession, endSession = f.endSession;
  const members = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of sameType) {
      if (members.has(n.uuid)) continue;
      const gap = workingGap({ ...f, startMs, endMs }, n);
      if (gap === null || gap > 0) continue; // overlapping (impossible) or separated by a working day
      members.add(n.uuid);
      if (n.startMs < startMs) { startMs = n.startMs; startSession = n.startSession; }
      if (n.endMs > endMs) { endMs = n.endMs; endSession = n.endSession; }
      grew = true;
    }
  }
  return { startMs, endMs, startSession, endSession, joined: members.size, members };
}

/** Days of this type already booked, per calendar month, recomputed on the SAME counting rule as the request
 *  being checked - a stored total can't answer "how much of it fell in June". */
function monthTotals(f: RestrictionFacts, sameType: readonly LeaveNeighbour[], sandwich: SandwichRule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of sameType) {
    for (const [ym, v] of Object.entries(daysByMonth(n.startMs, n.endMs, n.startSession, n.endSession, f.workDays, f.holidays, f.halfDayHolidays, sandwich))) {
      out[ym] = (out[ym] ?? 0) + v;
    }
  }
  return out;
}

// ---- Description ----------------------------------------------------------------------------------------

/**
 * The policy as sentences, for the leave-type editor's summary and the request dialog's hints. One list, so
 * the screen and the enforcement cannot describe different rules.
 */
export function describeRestrictions(r: LeaveRestrictions): string[] {
  const out: string[] = [];
  const d = (n: number) => `${fmt(n)} day${n === 1 ? "" : "s"}`;
  const e = r.eligibility, q = r.quota, t = r.timing, rq = r.request;
  if (e.min_tenure_days !== null) out.push(`available after ${d(e.min_tenure_days)} of service`);
  if (e.max_occurrences_lifetime !== null) out.push(`at most ${e.max_occurrences_lifetime} time${e.max_occurrences_lifetime === 1 ? "" : "s"} in total`);
  if (e.max_lifetime_days !== null) out.push(`at most ${d(e.max_lifetime_days)} in total`);
  if (rq.min_days !== null) out.push(`at least ${d(rq.min_days)} at a time`);
  if (rq.max_days !== null) out.push(`at most ${d(rq.max_days)} per request`);
  if (rq.max_consecutive_days !== null) out.push(`at most ${d(rq.max_consecutive_days)} in a row`);
  if (rq.half_day_allowed === false) out.push("whole days only");
  if (rq.must_be_single_block) out.push("taken as one block");
  if (rq.blocked_weekdays?.length) out.push(`not on a ${rq.blocked_weekdays.map((n) => WEEKDAYS[n]).join(" or ")}`);
  if (rq.reason_required) out.push("a reason is required");
  if (rq.document_required_over_days !== null) out.push(`a document is required over ${d(rq.document_required_over_days)}`);
  if (rq.backdate_days !== null) out.push(rq.backdate_days === 0 ? "no back-dating" : `back-dated up to ${d(rq.backdate_days)}`);
  const tiers = t.advance_notice;
  if (tiers) {
    const parts = tiers.tiers.map((x) => `${d(x.notice_days)} for up to ${d(x.up_to_days)}`);
    if (tiers.beyond_notice_days !== null) parts.push(`${d(tiers.beyond_notice_days)} beyond that`);
    if (parts.length) out.push(`notice: ${parts.join(", ")}`);
  }
  if (t.max_advance_days !== null) out.push(`booked at most ${d(t.max_advance_days)} ahead`);
  if (t.blackouts?.length) out.push(`closed ${t.blackouts.map((b) => b.label || `${b.from}-${b.to}`).join(", ")}`);
  if (t.blackout_days_of_month?.length) out.push(`not on the ${t.blackout_days_of_month.map(ordinal).join(", ")} of a month`);
  if (t.block_adjacent_to_holiday) out.push("not next to a public holiday");
  if (q.max_days_per_month !== null) out.push(`at most ${d(q.max_days_per_month)} a month`);
  if (q.max_days_per_year !== null) out.push(`at most ${d(q.max_days_per_year)} a ${q.year_basis === "anniversary" ? "year from your joining date" : q.year_basis === "fiscal" ? "financial year" : "calendar year"}`);
  if (q.max_requests_per_month !== null) out.push(`at most ${q.max_requests_per_month} request${q.max_requests_per_month === 1 ? "" : "s"} a month`);
  if (q.max_requests_per_year !== null) out.push(`at most ${q.max_requests_per_year} request${q.max_requests_per_year === 1 ? "" : "s"} a year`);
  if (q.min_gap_days !== null) out.push(`${d(q.min_gap_days)} between requests`);
  if (r.combinations.no_combination_with?.length) {
    out.push(`not combined with ${r.combinations.no_combination_with.length} other type${r.combinations.no_combination_with.length === 1 ? "" : "s"}`);
  }
  const s = r.counting.sandwich;
  if (s && (s.weekends !== "exclude" || s.holidays !== "exclude")) {
    const parts: string[] = [];
    if (s.weekends !== "exclude") parts.push(`weekends (${s.weekends})`);
    if (s.holidays !== "exclude") parts.push(`holidays (${s.holidays})`);
    out.push(`sandwich rule charges ${parts.join(" and ")}`);
  }
  if (r.exit.during_notice === "blocked") out.push("not during notice period");
  if (r.exit.during_notice === "capped" && r.exit.notice_cap_days !== null) out.push(`at most ${d(r.exit.notice_cap_days)} during notice period`);
  const jr = r.accrual.joining_rule;
  if (jr) {
    out.push(`joining month: ${jr.if_on_or_before === "full" ? "credited in full" : "prorated"} if joined by the ${ordinal(jr.cutoff_day)}, ${jr.if_after === "none" ? "not credited" : "prorated"} after`);
  }
  if (r.soft_rules?.length) out.push(`${r.soft_rules.length} rule${r.soft_rules.length === 1 ? "" : "s"} warn instead of blocking`);
  return out;
}
