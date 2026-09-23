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
  input_cutoff_on?: string | null;
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

/**
 * A cutoff only means anything between the period opening and the money going out.
 *
 * Before the period starts there is nothing yet to freeze, and after the pay date the freeze is moot - the run
 * is built and paid. Both mistakes are silent: a cutoff outside the window would sit on the calendar looking
 * like a deadline while never being one, which is worse than having no cutoff at all, because people would
 * work to it.
 *
 * The pay date itself is allowed, at the far edge: a same-day cutoff is a real (if tight) policy, and refusing
 * it would be this file inventing a rule the org did not ask for.
 */
function assertCutoffSane(cutoff: Date | null, periodStart: Date, payDate: Date): void {
  if (!cutoff) return;
  if (+cutoff < +periodStart) throw invalidArgument("input_cutoff_on cannot be before the period starts");
  if (+cutoff > +payDate) throw invalidArgument("input_cutoff_on cannot be after the pay date - inputs are already paid by then");
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
    const inputCutoffOn = parseDate(input.input_cutoff_on ?? undefined) ?? null;
    assertCutoffSane(inputCutoffOn, periodStart, payDate);
    return { label: input.display_name, periodStart, periodEnd, payDate, inputCutoffOn };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.payPeriods> = {};
    if (has(patch, "display_name")) set.label = patch.display_name;
    if (has(patch, "period_start") && patch.period_start) set.periodStart = parseDate(patch.period_start);
    if (has(patch, "period_end") && patch.period_end) set.periodEnd = parseDate(patch.period_end);
    if (has(patch, "pay_date") && patch.pay_date) set.payDate = parseDate(patch.pay_date);
    // Clearable: an org that adopted a cutoff and changed its mind sends null, which is a different thing from
    // omitting the field. `has` is what separates the two, so a patch that touches only the label leaves it be.
    if (has(patch, "input_cutoff_on")) set.inputCutoffOn = parseDate(patch.input_cutoff_on ?? undefined) ?? null;
    // Check the range as it WILL be, and exclude this period from the overlap scan.
    const effStart = (set.periodStart as Date | undefined) ?? new Date(row.periodStart);
    const effEnd = (set.periodEnd as Date | undefined) ?? new Date(row.periodEnd);
    await assertValidRange(deps, effStart, effEnd, row.uuid);
    // Against the period as it WILL be, for the same reason the range check is: moving the pay date earlier
    // than an existing cutoff has to fail, and it is the pay date that moved.
    const effCutoff = has(patch, "input_cutoff_on") ? (set.inputCutoffOn as Date | null) : (row.inputCutoffOn ? new Date(row.inputCutoffOn) : null);
    assertCutoffSane(effCutoff, effStart, (set.payDate as Date | undefined) ?? new Date(row.payDate));
    return set;
  },
};

export const {
  create: createPayPeriod,
} = crudService(payPeriodSpec);
