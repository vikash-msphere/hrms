// Chargeable leave days for a date range + sessions. This is a null-guard wrapper around the SERVER's rule,
// not a second copy of it: `leaveDays` in src/domain/leave.ts is pure (it imports only `round2`), takes the
// same arguments, and is imported straight into the bundle the way `leaveCover` is in lib/attendance.ts.
//
// It used to be a mirror, and the number it produces is what the employee is shown before they commit and
// what is compared against their balance - so a drift reads as "the app said 2 days, payroll charged 2.5" on
// a balance that is encashable for cash at exit. Two mirrors in this app have already diverged from the
// server while their comments promised they matched (`advanceRecurrence` in Expenses.tsx, the CTC solver in
// EmployeeCompensation.tsx), which is why this one calls the original instead.
//
// Sessions: 1 = first half (morning), 2 = second half (afternoon). null = incomplete/unparseable input.
import { leaveDays } from "../../../src/domain/leave";

export function chargeableDays(
  startStr: string,
  endStr: string,
  startSession: number,
  endSession: number,
  workDays: number[],
  holidays: Set<string>,
  halfDayHolidays: Set<string> = new Set(),
): number | null {
  if (!startStr || !endStr) return null;
  const s = Date.parse(startStr + "T00:00:00Z"), e = Date.parse(endStr + "T00:00:00Z");
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  return leaveDays(s, e, startSession, endSession, workDays, holidays, halfDayHolidays);
}
