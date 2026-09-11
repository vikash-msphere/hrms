/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Money is stored in `real` columns - IEEE-754 doubles - not integer paise. That is a deliberate, recorded
// choice (see docs/architecture-decisions.md): converting a live schema to paise is a large, regression-prone
// change to arithmetic that is currently correct, and no test demonstrates a defect it would fix. What the
// choice COSTS is that correctness rests on discipline instead of on the type: every stored money value must
// be pinned to two decimals by `round2` (or `sum2`, which is round2 over a sum) before it lands in a column.
// Miss one and 0.1 + 0.2 reaches a payslip as 0.30000000000000004, and every total downstream inherits it.
//
// This is the tripwire for that discipline. It reads the schema for the money columns, then reads every
// service and domain module for writes to them, and fails on an arithmetic expression that was never routed
// through round2/sum2. It is the alternative that shipped instead of the paise conversion, so it is the only
// thing standing where a type would otherwise stand - keep it strict.
//
// It also fails when a NEW `real` column appears that neither list below classifies. That is the point: the
// author of the next money column has to say whether it is money, here, rather than have it default into
// being unchecked.

const rawSchema = import.meta.glob("../src/db/schema.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const schemaSrc = Object.values(rawSchema)[0]!;
const rawSources = import.meta.glob(["../src/services/**/*.ts", "../src/domain/**/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// ---- 1. What the schema says ------------------------------------------------------------------------

// Every `<prop>: real("<col>")` in schema.ts, qualified by the table it sits in.
function realColumns(src: string): { table: string; prop: string }[] {
  const out: { table: string; prop: string }[] = [];
  let table = "?";
  for (const line of src.split("\n")) {
    const t = line.match(/^export const ([A-Za-z0-9_]+) = sqliteTable\(/);
    if (t) table = t[1]!;
    const c = line.match(/^\s+([A-Za-z0-9_]+): real\("[a-z0-9_]+"\)/);
    if (c) out.push({ table, prop: c[1]! });
  }
  return out;
}

// Currency amounts. A write to one of these must be round2/sum2-pinned.
const MONEY = new Set([
  "benefitPlans.employeeCost", "benefitPlans.employerCost",
  "bonuses.amount",
  "compensation.arrearsAmount", "compensation.arrearsBaseAmount", "compensation.basePay",
  "compensation.ctcAnnual", "compensation.specialAllowance", "compensation.variablePayTarget",
  "expenseBudgets.amount", "expenses.amount", "expenses.taxAmount",
  "leaveEncashments.amount", "leaveEncashments.ratePerDay",
  "loanRepayments.amount", "loans.monthlyAmount", "loans.principal", "loans.repaid",
  "offers.baseComp",
  "payComponents.cap", // a ceiling in rupees (payComponents.rate is a percentage - see below)
  "payGrades.bandMax", "payGrades.bandMid", "payGrades.bandMin",
  "payrollRunItems.gross", "payrollRunItems.net", "payrollRunItems.tax",
  "payrollRunItems.taxableGross", "payrollRunItems.totalDeductions",
  "payslips.gross", "payslips.net", "payslips.tax", "payslips.taxableGross", "payslips.totalDeductions",
  "referrals.bonusAmount", "reimbursements.amount",
  "settlements.net", "settlements.taxableEarnings", "settlements.tds",
  "settlements.totalDeductions", "settlements.totalEarnings",
  "taxDeclarations.declaredAmount", "taxDeclarations.verifiedAmount",
]);

// `real` columns that are NOT currency, each with the reason it is exempt. Fractional by nature and rounded
// (where they are rounded at all) on their own terms, so the money rule would be noise on them.
const NOT_MONEY: Record<string, string> = {
  "cards.rank": "lexicographic ordering key - a float precisely so a card can be dropped between two others",
  "compOffCredits.days": "leave days (half-days are legitimate)",
  "goals.baselineValue": "arbitrary goal metric, unit chosen per goal",
  "goalTemplates.baselineValue": "the same arbitrary metric, held as a blueprint",
  "goalTemplates.targetValue": "the same arbitrary metric, held as a blueprint",
  "goals.currentValue": "arbitrary goal metric, unit chosen per goal",
  "goals.targetValue": "arbitrary goal metric, unit chosen per goal",
  "leaveBalances.balanceDays": "leave days; rounded SQL-side where it is incremented",
  "leaveEncashments.days": "leave days",
  "leaveRequests.days": "leave days",
  "leaveTypes.accrualDaysPerYear": "leave policy, in days",
  "leaveTypes.carryForwardCapDays": "leave policy, in days",
  "leaveTypes.encashmentCapDaysPerYear": "leave policy, in days",
  "leaveTypes.minBalanceRetainedDays": "leave policy, in days",
  "leaveTypes.probationAccrualDaysPerYear": "leave policy, in days",
  "leaveTypes.probationCapDays": "leave policy, in days",
  "payComponents.rate": "a percentage or per-unit rate, not an amount",
  "settlements.leaveDays": "leave days",
  "settlements.noticeShortfallDays": "notice period, in days",
  "timeEntries.hours": "duration in hours",
};

// ---- 2. Is a written expression pinned? -------------------------------------------------------------

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

// Arithmetic that is not inside a string/template literal. `-` counts: a subtraction drifts exactly as a sum
// does, and a deduction is the commonest money subtraction in the codebase.
const hasArithmetic = (s: string) =>
  /[+\-*/]/.test(s.replace(/`[^`]*`/g, "``").replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"));

// Split on top-level commas only, so `Math.max(0, f(a, b))` yields two arguments, not three. A backtick is a
// TOGGLE, not a bracket: counting it as an opener (it appears in both bracket sets) leaves depth permanently
// positive after the first `sql` fragment, and every later separator then reads as nested.
function topLevelParts(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, tpl = false, cur = "";
  for (const ch of s) {
    if (ch === "`") tpl = !tpl;
    else if (!tpl && "([{".includes(ch)) depth++;
    else if (!tpl && ")]}".includes(ch)) depth--;
    if (ch === sep && depth === 0 && !tpl) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Is this written expression safe to store in a money column?
 *
 * Safe means: whatever arithmetic it contains ends up inside round2/sum2. The recursion exists because the
 * real code legitimately wraps a rounded value in a clamp (`Math.max(0, round2(x))`) or picks between two
 * rounded values (a ternary, an object of rounded fields) - refusing those would push authors to disable the
 * rule rather than obey it. The list of wrappers is deliberately short: anything not on it must round.
 */
function isPinned(expr: string): boolean {
  const e = expr.trim();
  if (!e) return true;
  // Drizzle `sql` fragments compute in SQLite, where round2 cannot reach. Allowed only for clamping/rounding
  // (min/max/case/round) - arithmetic that adds or scales must be done in TS, through round2, or written as
  // SQLite's own `round(x * 100) / 100`, which is what round2 does. Judged FIRST: `hasArithmetic` blanks
  // template literals, so a `sql` fragment reaching the check below would read as arithmetic-free.
  const tpl = e.match(/^sql`([\s\S]*)`$/);
  if (tpl) return !hasArithmetic(tpl[1]!.replace(/round\s*\([\s\S]*?\)\s*\/\s*100/g, "R").replace(/\$\{[^}]*\}/g, "V"));
  if (!hasArithmetic(e)) return true; // a literal, an identifier, a call result - nothing to drift
  if (/^(round2|sum2|Math\.round)\s*\(/.test(e)) return true; // the pin itself
  // Clamps applied to already-rounded values: rounding then bounding cannot reintroduce a third decimal.
  const clamp = e.match(/^Math\.(max|min)\s*\(([\s\S]*)\)$/);
  if (clamp) return topLevelParts(clamp[2]!).every(isPinned);
  // A parenthesized sub-expression.
  if (/^\([\s\S]*\)$/.test(e)) return isPinned(e.slice(1, -1));
  // Both branches of a ternary must be pinned; so must an object literal's every value.
  const q = topLevelParts(e, "?");
  if (q.length === 2) return topLevelParts(q[1]!, ":").every(isPinned);
  if (/^\{[\s\S]*\}$/.test(e)) {
    return topLevelParts(e.slice(1, -1)).every((f) => isPinned(f.slice(f.indexOf(":") + 1)));
  }
  return false;
}

// Every write of `<prop>: <expr>` in the services/domain sources, for the given property names.
function writes(props: Set<string>): { where: string; prop: string; expr: string }[] {
  const TS_TYPE = /^(number|string|boolean|Date|null|undefined|any|unknown)\b/;
  const re = new RegExp(String.raw`\b(${[...props].join("|")})\s*:\s*`, "g");
  const out: { where: string; prop: string; expr: string }[] = [];
  for (const [path, raw] of Object.entries(rawSources)) {
    const src = strip(raw);
    for (const m of src.matchAll(re)) {
      let i = m.index! + m[0].length, depth = 0, tpl = false, expr = "";
      for (; i < src.length; i++) {
        const ch = src[i]!;
        if (ch === "`") tpl = !tpl; // toggle, not a bracket - see topLevelParts
        else if (tpl) { /* inside a template: brackets and separators are text */ }
        else if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
        else if ((ch === "," || ch === ";" || ch === "\n") && depth === 0) break;
        expr += ch;
      }
      if (TS_TYPE.test(expr.trim())) continue; // a type annotation, not a value
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ where: `${path.replace("../", "")}:${line}`, prop: m[1]!, expr: expr.trim().replace(/\s+/g, " ") });
    }
  }
  return out;
}

// ---- 3. The gates -----------------------------------------------------------------------------------

describe("money drift - every stored money value is round2/sum2-pinned", () => {
  const columns = realColumns(schemaSrc);

  it("finds the schema's real columns (guards against the parser silently matching nothing)", () => {
    expect(columns.length).toBeGreaterThan(50);
  });

  it("classifies every real column as money or not", () => {
    const unclassified = columns
      .map((c) => `${c.table}.${c.prop}`)
      .filter((k) => !MONEY.has(k) && !(k in NOT_MONEY));
    // A new `real` column lands here. Decide: currency -> add it to MONEY and satisfy the rule below;
    // days/hours/rates/metrics -> add it to NOT_MONEY with the reason.
    expect(unclassified).toEqual([]);
  });

  it("keeps both lists honest (no entry for a column that no longer exists)", () => {
    const live = new Set(columns.map((c) => `${c.table}.${c.prop}`));
    expect([...MONEY, ...Object.keys(NOT_MONEY)].filter((k) => !live.has(k))).toEqual([]);
  });

  const moneyProps = new Set([...MONEY].map((k) => k.split(".")[1]!));

  it("finds the money writes (guards against the scanner silently matching nothing)", () => {
    expect(writes(moneyProps).length).toBeGreaterThan(50);
  });

  // If this fires: wrap the expression in `round2(...)` (or `sum2([...])` for a total). The match is by
  // PROPERTY NAME, so it also catches an intermediate object field that happens to be called `net` or
  // `amount` - that is intended, not a false positive. Money that is computed in steps should be rounded at
  // the step that produces a storable figure; if a genuinely internal value needs a different treatment,
  // give it a name that is not a money column's.
  it("routes every arithmetic money write through round2 or sum2", () => {
    const unpinned = writes(moneyProps)
      .filter((w) => !isPinned(w.expr))
      .map((w) => `${w.where}  ${w.prop}: ${w.expr.slice(0, 100)}`);
    expect(unpinned).toEqual([]);
  });

  // The rule is only worth anything if it would actually catch the mistake it exists for.
  it("would flag an unpinned write", () => {
    expect(isPinned("a + b")).toBe(false);
    expect(isPinned("basic * 0.12")).toBe(false);
    expect(isPinned("gross - deductions")).toBe(false);
    expect(isPinned("lines.reduce((a, l) => a + l.amount, 0)")).toBe(false);
    expect(isPinned("sql`${schema.loans.repaid} + ${amount}`")).toBe(false);
  });

  it("accepts the pinned forms the codebase actually uses", () => {
    expect(isPinned("0")).toBe(true);
    expect(isPinned("input.amount")).toBe(true);
    expect(isPinned("round2(a + b)")).toBe(true);
    expect(isPinned("sum2(lines.map((l) => l.amount))")).toBe(true);
    expect(isPinned("Math.max(0, round2((newGross - oldGross) * paidMonths))")).toBe(true);
    expect(isPinned("paid > 0 ? round2(a - b) : 0")).toBe(true);
    expect(isPinned("sql`min(${schema.loans.principal}, ${moved})`")).toBe(true);
    expect(isPinned("sql`round((${col} + ${delta}) * 100) / 100`")).toBe(true);
  });
});
