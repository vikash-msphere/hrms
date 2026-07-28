// Pay periods: 12 monthly periods for the financial year FY_START_YEAR (Apr..Mar). period end + pay date =
// the last calendar day of the month.
import { Ctx, T0, DAY, FY_START_YEAR, q, code2, rows } from "../lib";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function payPeriods(ctx: Ctx): string {
  const periods = Array.from({ length: 12 }, (_, k) => {
    const year = FY_START_YEAR + Math.floor((3 + k) / 12); // start at April (month index 3)
    const month = (3 + k) % 12;
    const start = Date.UTC(year, month, 1);
    const end = Date.UTC(year, month + 1, 1) - DAY; // last calendar day of the month
    return { label: `${MONTH_ABBR[month]} ${year}`, start, end, payDate: end };
  });
  return rows(
    "INSERT INTO pay_periods (uuid,code,label,period_start,period_end,pay_date,created_at,updated_at) VALUES",
    periods.map((p, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(p.label)},${p.start},${p.end},${p.payDate},${T0},${T0})`,
    ),
  );
}
