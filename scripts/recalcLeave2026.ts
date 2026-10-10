// One-off: recalculate every active employee's Paid leave balance for 2026, through the public API.
//
//   HRMS_URL=https://hrms.example.com HRMS_API_KEY=hrms_... node --import ./scripts/tsResolve.mjs scripts/recalcLeave2026.ts
//   ... add --apply to write. Without it the script only prints what it would do.
//
// The balance it sets is:
//   earned in 2026  - Paid leave approved in 2026 - Paid leave pending in 2026
// where "earned" is 1 day a month while on probation and 2 a month after, from 1 Jan 2026 (or the joining date,
// if later) through the period the nightly accrual has already credited. Nothing from 2025 carries over.
//
// "Earned" is priced by the app's own accrual walk (domain/leave.ts computeAccrual) against the leave type and
// settings as stored in production, so the months the nightly job credits from here on continue the same
// arithmetic: joining-month proration (or the joining-date rule), the probation-end month, the accrual
// frequency and the rounding are all the app's. The script refuses to run unless the Paid leave type is set to
// 12 days a year on probation and 24 after, so the two cannot disagree.
//
// Each balance moves by ONE ledger correction (POST /v1/leave-adjustments) carrying the arithmetic in its
// reason, so every change is audited and visible in the balance history. Leave requests are not touched.
//
// The API key needs read on employees, leave-types, leave-balances, leave-requests and settings, and write on
// leave-adjustments, and its owner must be able to see every employee's leave.

import { computeAccrual, roundToIncrement, type AccrualFrequency, type JoiningRule } from "../src/domain/leave";
import { round2 } from "../src/domain/money";

const YEAR = 2026;
const PROBATION_DAYS_PER_YEAR = 12; // 1 a month
const NORMAL_DAYS_PER_YEAR = 24; // 2 a month

const BASE = (process.env.HRMS_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.HRMS_API_KEY ?? "";
const APPLY = process.argv.includes("--apply");
if (!BASE || !KEY) {
  console.error("set HRMS_URL and HRMS_API_KEY");
  process.exit(2);
}

type Employee = { path: string; first_name: string; last_name: string; employee_number?: string; start_date?: string; probation_end_date?: string; end_date?: string; status?: string };
type LeaveType = { path: string; display_name: string; paid: boolean; disabled?: boolean; accrual_days_per_year?: number; probation_accrual_days_per_year: number; accrual_frequency: string; accrual_cap_days?: number; restrictions?: Record<string, unknown> };
type Balance = { path: string; employee: string; leave_type: string; balance_days: number };
type LeaveRequest = { path: string; employee: string; leave_type: string; start_date: string; end_date: string; days: number; state: string; source: string };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function listAll<T>(collection: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const qs = new URLSearchParams({ max_page_size: "100", ...(token ? { page_token: token } : {}) });
    const page = await api<{ results: T[]; next_page_token?: string }>("GET", `${collection}?${qs}`);
    out.push(...page.results);
    token = page.next_page_token || undefined;
  } while (token);
  return out;
}

async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    return (await api<{ value: T }>("GET", `settings/${key}`)).value ?? fallback;
  } catch (e) {
    if (String(e).includes("-> 404")) return fallback;
    throw e;
  }
}

// The joining-date rule for a type: its own `accrual.joining_rule` leaf when it sets one (null = exempt),
// otherwise the org's - the one leaf of domain/leaveRestrictions.ts mergeRestrictions that accrual reads.
// Inlined because that module cannot be loaded by node's type stripping (lib/errors.ts).
function joiningRuleOf(org: Record<string, unknown>, type: Record<string, unknown> | undefined): JoiningRule | null {
  const accrualOf = (blob: Record<string, unknown> | undefined) => blob?.accrual as Record<string, unknown> | null | undefined;
  const typeAccrual = accrualOf(type);
  const raw = typeAccrual === null ? null : typeAccrual && "joining_rule" in typeAccrual ? typeAccrual.joining_rule : accrualOf(org)?.joining_rule;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    cutoff_day: Number(r.cutoff_day),
    if_on_or_before: r.if_on_or_before === "full" ? "full" : "prorate",
    if_after: r.if_after === "none" ? "none" : "prorate",
  };
}

const dayMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const name = (e: Employee) => `${e.employee_number ?? "-"} ${e.first_name} ${e.last_name}`.trim();

async function main() {
  // Today as a calendar day on this machine (run it from the org's timezone), anchored at UTC midnight the
  // way services/orgDay.ts dayStartMs does for the nightly job.
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const todayYmd = new Date(today).toISOString().slice(0, 10);
  if (now.getFullYear() !== YEAR) throw new Error(`this script is for ${YEAR}; today is ${todayYmd}`);

  const [types, employees, balances, requests] = await Promise.all([
    listAll<LeaveType>("leave-types"),
    listAll<Employee>("employees"),
    listAll<Balance>("leave-balances"),
    listAll<LeaveRequest>("leave-requests"),
  ]);
  const orgRestrictions = await setting<Record<string, unknown>>("leave_restrictions", {});
  const rounding = (await setting<{ rounding?: string }>("leave_accrual", {})).rounding ?? "half";
  const inc = ({ none: 0, half: 0.5, day: 1 } as Record<string, number>)[rounding] ?? 0.5;

  // ---- The leave types ----
  const live = types.filter((t) => !t.disabled);
  console.log(`leave types: ${live.map((t) => `${t.display_name} (${t.paid ? "paid" : "unpaid"})`).join(", ")}`);
  const paidTypes = live.filter((t) => t.paid);
  if (paidTypes.length !== 1) throw new Error(`expected exactly one paid leave type, found ${paidTypes.length}: ${paidTypes.map((t) => t.display_name).join(", ")}`);
  const paid = paidTypes[0]!;
  if (paid.accrual_days_per_year !== NORMAL_DAYS_PER_YEAR || paid.probation_accrual_days_per_year !== PROBATION_DAYS_PER_YEAR) {
    throw new Error(
      `${paid.display_name} accrues ${paid.accrual_days_per_year ?? 0}/year (${paid.probation_accrual_days_per_year}/year on probation); ` +
        `set it to ${NORMAL_DAYS_PER_YEAR} and ${PROBATION_DAYS_PER_YEAR} on the Leave types page first, so the nightly accrual continues the same rule`,
    );
  }
  const frequency: AccrualFrequency = paid.accrual_frequency === "semi_monthly" ? "semi_monthly" : "monthly";
  const joiningRule = joiningRuleOf(orgRestrictions, paid.restrictions);
  console.log(`${paid.display_name}: ${frequency}, rounding ${rounding}, joining rule ${joiningRule ? JSON.stringify(joiningRule) : "prorate the joining month"}${paid.accrual_cap_days != null ? `, accrual cap ${paid.accrual_cap_days} (ignored here)` : ""}`);

  // The nightly job credits a period on its first day (1st, and 16th when semi-monthly), at 02:00 UTC. On that
  // day the balance may or may not hold the new period yet, so the figure this computes may be one period off.
  const dom = now.getDate();
  if (dom === 1 || (frequency === "semi_monthly" && dom === 16)) throw new Error("today starts an accrual period; run it tomorrow");

  // ---- Leave held against 2026 ----
  const yearStart = `${YEAR}-01-01`;
  const yearEnd = `${YEAR}-12-31`;
  const held = new Map<string, { approved: number; pending: number; n: number }>();
  const warnings: string[] = [];
  for (const r of requests) {
    if (r.leave_type !== paid.path || (r.state !== "APPROVED" && r.state !== "PENDING")) continue;
    if (r.start_date > yearEnd || r.end_date < yearStart) continue; // another year
    if (r.start_date < yearStart || r.end_date > yearEnd) warnings.push(`${r.path} (${r.start_date}..${r.end_date}, ${r.days}d) crosses the year boundary - counted in full`);
    const cur = held.get(r.employee) ?? { approved: 0, pending: 0, n: 0 };
    if (r.state === "APPROVED") cur.approved = round2(cur.approved + r.days);
    else cur.pending = round2(cur.pending + r.days);
    cur.n++;
    held.set(r.employee, cur);
  }

  // ---- Per employee ----
  const balByEmp = new Map(balances.filter((b) => b.leave_type === paid.path).map((b) => [b.employee, b]));
  // The period before 2026 starts, as an accrual marker: the walk then prices only 2026's periods, from the
  // later of 1 Jan and the joining date, through today's period.
  const before2026 = frequency === "semi_monthly" ? `${YEAR - 1}-12-H2` : `${YEAR - 1}-12`;
  type Row = { emp: Employee; through: string; earned: number; approved: number; pending: number; target: number; current: number; delta: number; error?: string };
  const rows: Row[] = [];
  const skipped: string[] = [];
  for (const emp of employees.sort((a, b) => (a.employee_number ?? "").localeCompare(b.employee_number ?? ""))) {
    if (emp.status && emp.status !== "active") { skipped.push(`${name(emp)}: ${emp.status}${emp.end_date ? ` (left ${emp.end_date})` : ""}`); continue; }
    if (!emp.start_date) { skipped.push(`${name(emp)}: no start date`); continue; }
    const startMs = dayMs(emp.start_date);
    if (startMs > today) { skipped.push(`${name(emp)}: starts ${emp.start_date}`); continue; }
    const endMs = emp.end_date ? dayMs(emp.end_date) : null;
    const accrual = computeAccrual({
      accrualDaysPerYear: NORMAL_DAYS_PER_YEAR,
      probationAccrualDaysPerYear: PROBATION_DAYS_PER_YEAR,
      startMs,
      endMs,
      probationEndMs: emp.probation_end_date ? dayMs(emp.probation_end_date) : null,
      lastAccrualYm: before2026,
      currentMs: today,
      frequency,
      joiningRule,
      // The window as it reads now, so the walk prices 2026 forward and corrects nothing behind it.
      pricedStartMs: startMs,
      pricedEndMs: endMs,
      floorMs: null,
    });
    const earned = roundToIncrement(accrual.add, inc);
    const h = held.get(emp.path) ?? { approved: 0, pending: 0, n: 0 };
    const target = round2(earned - h.approved - h.pending);
    const current = balByEmp.get(emp.path)?.balance_days ?? 0;
    const row: Row = { emp, through: accrual.newLastYm ?? "-", earned, approved: h.approved, pending: h.pending, target, current, delta: round2(target - current) };
    if (target < 0) row.error = `more leave held (${round2(h.approved + h.pending)}) than earned (${earned}) - not changed`;
    rows.push(row);
  }

  // ---- Report ----
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lpad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`\n2026 ${paid.display_name}, as of ${todayYmd}${APPLY ? "" : "  (dry run - add --apply to write)"}\n`);
  console.log(`${pad("employee", 30)}${pad("joined", 12)}${pad("probation", 12)}${pad("through", 12)}${lpad("earned", 7)}${lpad("taken", 7)}${lpad("pending", 8)}${lpad("new", 7)}${lpad("now", 7)}${lpad("change", 8)}`);
  for (const r of rows) {
    console.log(
      `${pad(name(r.emp).slice(0, 29), 30)}${pad(r.emp.start_date ?? "", 12)}${pad(r.emp.probation_end_date ?? "-", 12)}${pad(r.through, 12)}` +
        `${lpad(r.earned, 7)}${lpad(r.approved, 7)}${lpad(r.pending, 8)}${lpad(r.target, 7)}${lpad(r.current, 7)}${lpad(r.delta > 0 ? `+${r.delta}` : r.delta, 8)}` +
        (r.error ? `  ! ${r.error}` : ""),
    );
  }
  if (skipped.length) console.log(`\nskipped:\n  ${skipped.join("\n  ")}`);
  if (warnings.length) console.log(`\nwarnings:\n  ${warnings.join("\n  ")}`);
  const todo = rows.filter((r) => !r.error && r.delta !== 0);
  console.log(`\n${todo.length} balance(s) to change, ${rows.filter((r) => r.error).length} refused, ${rows.length - todo.length - rows.filter((r) => r.error).length} already right`);
  if (!APPLY || !todo.length) return;

  // ---- Apply ----
  let failed = 0;
  for (const r of todo) {
    const reason =
      `2026 recalculation: earned ${r.earned} (joined ${r.emp.start_date}, probation to ${r.emp.probation_end_date ?? "none"}, ` +
      `1/month on probation, 2/month after, through ${r.through}) - taken ${r.approved} - pending ${r.pending} = ${r.target}`;
    try {
      await api("POST", "leave-adjustments", { employee: r.emp.path, leave_type: paid.path, days: r.delta, reason });
      console.log(`  ${name(r.emp)}: ${r.current} -> ${r.target}`);
    } catch (e) {
      failed++;
      console.error(`  ${name(r.emp)}: FAILED ${(e as Error).message}`);
    }
  }
  // Read back what landed.
  const after = new Map((await listAll<Balance>("leave-balances")).filter((b) => b.leave_type === paid.path).map((b) => [b.employee, b.balance_days]));
  const off = todo.filter((r) => after.get(r.emp.path) !== r.target);
  for (const r of off) console.error(`  ${name(r.emp)}: expected ${r.target}, balance is ${after.get(r.emp.path)}`);
  console.log(`\napplied ${todo.length - failed}, failed ${failed}, ${off.length} balance(s) not at the expected figure`);
  if (failed || off.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
