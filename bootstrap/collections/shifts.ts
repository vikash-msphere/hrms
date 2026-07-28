// Shift patterns. Times are wall-clock "HH:MM" in the org timezone; a roster assignment puts a shift on a
// date for an employee. Night rolls past midnight (end < start).
import { Ctx, T0, q, code2, rows } from "../lib";

type ShiftSeed = { name: string; start: string; end: string; breakMinutes: number; color: string };

const SHIFTS: ShiftSeed[] = [
  { name: "General", start: "09:00", end: "18:00", breakMinutes: 60, color: "#3b82f6" },
  { name: "Morning", start: "06:00", end: "14:00", breakMinutes: 30, color: "#f59e0b" },
  { name: "Evening", start: "14:00", end: "22:00", breakMinutes: 30, color: "#8b5cf6" },
  { name: "Night", start: "22:00", end: "06:00", breakMinutes: 30, color: "#1f2937" },
];

export function shifts(ctx: Ctx): string {
  return rows(
    "INSERT INTO shifts (uuid,code,name,start_time,end_time,break_minutes,color,created_at,updated_at) VALUES",
    SHIFTS.map((s, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(s.name)},${q(s.start)},${q(s.end)},${s.breakMinutes},${q(s.color)},${T0},${T0})`,
    ),
  );
}
