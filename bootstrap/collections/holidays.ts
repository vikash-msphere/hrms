// Public holidays (India, calendar year HOLIDAY_YEAR). kind "fixed" = company-wide closed; "optional" =
// restricted/floating holiday the employee may elect. Festival dates are India-specific and shift yearly, so
// the list is hand-dated - bump HOLIDAY_YEAR (in lib.ts) and the dates once a year.
import { type Ctx, T0, HOLIDAY_YEAR, q, code2, rows } from "../lib";

type HolidaySeed = { name: string; kind: "fixed" | "optional"; month: number; day: number };

/**
 * Exported because a date is only a WORKING day if it is neither a weekend nor one of these: the browser specs
 * pick days to file leave on, and every one of these dates is priced at zero. Both kinds count - the leave
 * forms charge against every holiday the org has not disabled, not just the company-wide ones.
 */
export const HOLIDAYS: HolidaySeed[] = [
  { name: "New Year's Day", kind: "optional", month: 1, day: 1 },
  { name: "Makar Sankranti / Pongal", kind: "optional", month: 1, day: 14 },
  { name: "Republic Day", kind: "fixed", month: 1, day: 26 },
  { name: "Holi", kind: "fixed", month: 3, day: 4 },
  { name: "Eid al-Fitr", kind: "optional", month: 3, day: 21 },
  { name: "Good Friday", kind: "optional", month: 4, day: 3 },
  { name: "Independence Day", kind: "fixed", month: 8, day: 15 },
  { name: "Ganesh Chaturthi", kind: "optional", month: 9, day: 15 },
  { name: "Gandhi Jayanti", kind: "fixed", month: 10, day: 2 },
  { name: "Dussehra", kind: "optional", month: 10, day: 20 },
  { name: "Diwali", kind: "fixed", month: 11, day: 8 },
  { name: "Govardhan Puja", kind: "optional", month: 11, day: 9 },
  { name: "Guru Nanak Jayanti", kind: "optional", month: 11, day: 24 },
  { name: "Christmas", kind: "fixed", month: 12, day: 25 },
];

export function holidays(ctx: Ctx): string {
  return rows(
    "INSERT INTO holidays (uuid,code,date,name,kind,created_at,updated_at) VALUES",
    HOLIDAYS.map((h, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${Date.UTC(HOLIDAY_YEAR, h.month - 1, h.day)},${q(h.name)},${q(h.kind)},${T0},${T0})`,
    ),
  );
}
