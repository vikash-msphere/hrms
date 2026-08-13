// Pay periods: the payroll calendar. One run per period, so the ranges must never overlap.
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";

export type PayPeriodInput = {
  display_name?: string;
  period_start?: string;
  period_end?: string;
  pay_date?: string;
};

const parseDate = (s?: string) => {
  if (!s) return undefined;
  const ms = Date.parse(s + "T00:00:00Z");
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms);
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Reject a reversed range and any overlap with a live (non-deleted) period. Overlapping periods would each get
// their own run, and the one-committed-run-per-period guard is keyed on the period id (not the date range), so
// two approved runs over the overlap would pay salary twice for those days.
async function assertValidRange(deps: Deps, start: Date, end: Date, selfId?: string) {
  if (+end < +start) throw invalidArgument("period_end must be on or after period_start");
  const rows = (await deps.db.select().from(schema.payPeriods)).filter((p) => !p.deleteTime && p.uuid !== selfId);
  for (const p of rows) {
    const s = +new Date(p.periodStart), e = +new Date(p.periodEnd);
    if (+start <= e && +end >= s) throw invalidArgument(`this period overlaps "${p.label}" (${ymd(new Date(p.periodStart))} to ${ymd(new Date(p.periodEnd))})`);
  }
}

export const payPeriodSpec: CrudSpec<PayPeriodInput, typeof schema.payPeriods> = {
  table: schema.payPeriods,
  collection: "pay-periods",
  auditName: "pay_period",
  notFound: "pay period not found",
  insert: async (input, deps) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    const periodStart = parseDate(input.period_start);
    const periodEnd = parseDate(input.period_end);
    const payDate = parseDate(input.pay_date);
    if (!periodStart) throw invalidArgument("period_start is required (YYYY-MM-DD)");
    if (!periodEnd) throw invalidArgument("period_end is required (YYYY-MM-DD)");
    if (!payDate) throw invalidArgument("pay_date is required (YYYY-MM-DD)");
    await assertValidRange(deps, periodStart, periodEnd);
    return { label: input.display_name, periodStart, periodEnd, payDate };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.payPeriods> = {};
    if (has(patch, "display_name")) set.label = patch.display_name;
    if (has(patch, "period_start") && patch.period_start) set.periodStart = parseDate(patch.period_start);
    if (has(patch, "period_end") && patch.period_end) set.periodEnd = parseDate(patch.period_end);
    if (has(patch, "pay_date") && patch.pay_date) set.payDate = parseDate(patch.pay_date);
    // Check the range as it WILL be, and exclude this period from the overlap scan.
    const effStart = (set.periodStart as Date | undefined) ?? new Date(row.periodStart);
    const effEnd = (set.periodEnd as Date | undefined) ?? new Date(row.periodEnd);
    await assertValidRange(deps, effStart, effEnd, row.uuid);
    return set;
  },
};

export const {
  create: createPayPeriod,
} = crudService(payPeriodSpec);
