// Chargeable leave days for a date range + sessions (mirrors the server's domain/leave.ts). Counts only the
// configured working days, excludes holidays; a PM start / AM end shaves half a working day. null = incomplete.
// Sessions: 1 = first half (morning), 2 = second half (afternoon).
export function chargeableDays(
  startStr: string,
  endStr: string,
  startSession: number,
  endSession: number,
  workDays: number[],
  holidays: Set<string>,
): number | null {
  if (!startStr || !endStr) return null;
  const s = Date.parse(startStr + "T00:00:00Z"), e = Date.parse(endStr + "T00:00:00Z");
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  const isWork = (ms: number) => workDays.includes(new Date(ms).getUTCDay()) && !holidays.has(new Date(ms).toISOString().slice(0, 10));
  let full = 0;
  for (let d = s; d <= e; d += 86400000) if (isWork(d)) full++;
  if (full === 0) return 0;
  let days = full;
  if (startSession === 2 && isWork(s)) days -= 0.5;
  if (endSession === 1 && isWork(e)) days -= 0.5;
  return Math.round(days * 2) / 2;
}
