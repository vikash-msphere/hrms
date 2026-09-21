// What payroll is already committed to over the next year.
//
// The number somebody asks for every time headcount is discussed, and the app answers it today by exporting
// to a spreadsheet. Everything it needs is held: who is employed and until when, what each of them is paid
// from which date, and what the employer's own contributions cost on top.
//
// COMMITTED, NOT PREDICTED, and the distinction is the whole honesty of the figure. This projects salary
// ALREADY AGREED - current compensation, future-dated revisions somebody has entered, joiners with a start
// date, leavers with a notice end. It does not guess at hiring nobody has approved, raises nobody has
// awarded, or attrition. A forecast that mixed the two would be a plan wearing the clothes of a commitment,
// and the person reading it could not tell which parts they had actually signed up to.
//
// So the right reading of a month here is "this is the floor", and anything above it is a decision somebody
// has yet to make.

/** One stretch of an employee's pay: what a full month costs while it is in force. Half-open, like the
 *  compensation timeline it comes from - `toMs` null means "still current". */
export type CostSegment = { fromMs: number; toMs: number | null; monthlyCost: number };

/** One person, over the horizon. `startMs`/`endMs` bound employment itself, which is separate from what they
 *  are paid: somebody can have a compensation row that outlives their notice period, and only the overlap is
 *  committed cost. */
export type ForecastPerson = {
  employeeId: string;
  departmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  segments: CostSegment[];
};

export type ForecastMonth = {
  /** YYYY-MM. */
  month: string;
  cost: number;
  people: number;
  /** Cost split by cost centre, so the answer survives the follow-up question. Keyed by department id, with
   *  "" for people who have none - dropping them would make the parts stop summing to the whole. */
  byDepartment: Record<string, number>;
};

export type PayrollForecast = { months: ForecastMonth[]; total: number };

const monthKey = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;

/** Whole rupees. A twelve-month projection carrying paise implies a precision it does not have - the inputs
 *  are a salary and a calendar, not a priced run. */
const whole = (n: number) => Math.round(n);

/**
 * Committed monthly cost for `horizonMonths` starting with the month `fromMs` falls in.
 *
 * A month counts somebody when they are employed on its FIRST day, and prices them at the segment in force
 * then. That is deliberately coarse: this is a planning figure, not a payroll run, and prorating a
 * mid-month joiner here would imply the rest of the number is precise to the day when it is not. A joiner
 * mid-month therefore first appears in the following month, which understates by part of one month per
 * joiner and never overstates - the safe direction for a floor.
 */
export function forecastPayroll(people: readonly ForecastPerson[], fromMs: number, horizonMonths: number): PayrollForecast {
  const start = new Date(fromMs);
  const months: ForecastMonth[] = [];

  for (let i = 0; i < Math.max(0, horizonMonths); i++) {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth() + i;
    const at = Date.UTC(y, m, 1);
    const key = monthKey(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth());

    let cost = 0;
    let headcount = 0;
    const byDepartment: Record<string, number> = {};
    for (const p of people) {
      // Employed on the first of the month. `endMs` is the last day they are employed, so a notice period
      // ending mid-month still counts that month - they are paid for part of it, and the coarse rule above
      // rounds that up rather than dropping it.
      if (p.startMs != null && at < p.startMs) continue;
      if (p.endMs != null && at > p.endMs) continue;
      const segment = p.segments.find((s) => at >= s.fromMs && (s.toMs == null || at < s.toMs));
      if (!segment) continue; // employed but with no compensation in force: nothing committed to price
      headcount++;
      cost += segment.monthlyCost;
      const dept = p.departmentId ?? "";
      byDepartment[dept] = (byDepartment[dept] ?? 0) + segment.monthlyCost;
    }

    months.push({
      month: key,
      cost: whole(cost),
      people: headcount,
      byDepartment: Object.fromEntries(Object.entries(byDepartment).map(([k, v]) => [k, whole(v)])),
    });
  }

  // Summed from the ROUNDED months, which is what a reader adds up on screen. Totalling the unrounded figures
  // and rounding once would print a total that does not match its own column.
  return { months, total: whole(months.reduce((s, x) => s + x.cost, 0)) };
}
