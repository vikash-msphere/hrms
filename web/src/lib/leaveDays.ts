// Chargeable leave days for a date range + sessions (mirrors the server's domain/leave.ts). Counts only the
// configured working days; a full holiday is worth 0 and a half-day holiday 0.5, and a PM start / AM end shaves
// half of whatever the boundary day is worth. null = incomplete.
// Sessions: 1 = first half (morning), 2 = second half (afternoon).
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
  const valueOf = (ms: number) => {
    const ymd = new Date(ms).toISOString().slice(0, 10);
    if (!workDays.includes(new Date(ms).getUTCDay()) || holidays.has(ymd)) return 0;
    return halfDayHolidays.has(ymd) ? 0.5 : 1;
  };
  let days = 0;
  for (let d = s; d <= e; d += 86400000) days += valueOf(d);
  if (days === 0) return 0;
  if (startSession === 2) days -= Math.min(0.5, valueOf(s));
  if (endSession === 1) days -= Math.min(0.5, valueOf(e));
  return Math.round(days * 2) / 2;
}
