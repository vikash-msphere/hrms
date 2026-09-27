// Shifts: the named time windows a roster assigns (start/end as HH:MM local, an unpaid break, a display colour).
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export type ShiftInput = {
  name?: string;
  start?: string;
  end?: string;
  break_minutes?: number;
  full_day_minutes?: number | null;
  half_day_minutes?: number | null;
  grace_minutes?: number | null;
  flexible_hours?: boolean | null;
  color?: string | null;
};

const validTime = (t?: string) => t === undefined || HHMM.test(t);

/**
 * A minutes field that may be left unset. Null and absent both mean DERIVE IT (domain/workSchedule.ts):
 * a full day is the shift's own span less its break, half a day is half of that, and grace comes from the
 * org. So null is stored rather than coerced to zero - a zero-minute full day would score every day as
 * complete, which is the opposite of unset.
 */
const optionalMinutes = (v: number | null | undefined, field: string): number | null => {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0 || v > 1440) throw invalidArgument(`${field} must be a whole number of minutes in [0, 1440]`);
  return v;
};

export const shiftSpec: CrudSpec<ShiftInput, typeof schema.shifts> = {
  table: schema.shifts,
  collection: "shifts",
  auditName: "shift",
  notFound: "shift not found",
  // The roster reads as a day: earliest shift first.
  sort: (a, b) =>
    (a.startTime ?? "").localeCompare(b.startTime ?? "") || +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  insert: (input) => {
    if (!input.name?.trim()) throw invalidArgument("name is required");
    if (!validTime(input.start) || !validTime(input.end)) throw invalidArgument("times must be HH:MM");
    const fullDayMinutes = optionalMinutes(input.full_day_minutes, "full_day_minutes");
    const halfDayMinutes = optionalMinutes(input.half_day_minutes, "half_day_minutes");
    assertLadder(fullDayMinutes, halfDayMinutes);
    return {
      name: input.name.trim(),
      startTime: input.start ?? "09:00",
      endTime: input.end ?? "18:00",
      breakMinutes: Math.max(0, input.break_minutes ?? 0),
      fullDayMinutes,
      halfDayMinutes,
      graceMinutes: optionalMinutes(input.grace_minutes, "grace_minutes"),
      flexibleHours: input.flexible_hours == null ? null : !!input.flexible_hours,
      color: input.color?.trim() || null,
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.shifts> = {};
    if (has(patch, "name")) {
      if (!patch.name?.trim()) throw invalidArgument("name is required");
      set.name = patch.name.trim();
    }
    if (has(patch, "start")) {
      if (!validTime(patch.start)) throw invalidArgument("start must be HH:MM");
      set.startTime = patch.start;
    }
    if (has(patch, "end")) {
      if (!validTime(patch.end)) throw invalidArgument("end must be HH:MM");
      set.endTime = patch.end;
    }
    if (has(patch, "break_minutes")) set.breakMinutes = Math.max(0, patch.break_minutes ?? 0);
    if (has(patch, "full_day_minutes")) set.fullDayMinutes = optionalMinutes(patch.full_day_minutes, "full_day_minutes");
    if (has(patch, "half_day_minutes")) set.halfDayMinutes = optionalMinutes(patch.half_day_minutes, "half_day_minutes");
    // Checked against what the row WILL hold, not only against what the patch sends: lowering the full day
    // alone can invert a ladder whose half day was already set.
    if (has(patch, "full_day_minutes") || has(patch, "half_day_minutes")) {
      assertLadder(
        has(patch, "full_day_minutes") ? set.fullDayMinutes as number | null : undefined,
        has(patch, "half_day_minutes") ? set.halfDayMinutes as number | null : undefined,
        row,
      );
    }
    if (has(patch, "grace_minutes")) set.graceMinutes = optionalMinutes(patch.grace_minutes, "grace_minutes");
    if (has(patch, "flexible_hours")) set.flexibleHours = patch.flexible_hours == null ? null : !!patch.flexible_hours;
    if (has(patch, "color")) set.color = patch.color?.trim() || null;
    return set;
  },
};

/**
 * A half day worth more than a full one inverts the ladder in `lopDayUnits`: the 0.5 branch becomes
 * unreachable and every short day is charged as a whole absence. The org-level pair is refused for the same
 * reason (routes/settings.ts#validateAttendance).
 *
 * Only checked where BOTH are set: either one on its own is derived from the shift's span, and a derived half
 * day is half a derived full one by construction.
 */
function assertLadder(full: number | null | undefined, half: number | null | undefined, row?: typeof schema.shifts.$inferSelect) {
  const f = full === undefined ? row?.fullDayMinutes ?? null : full;
  const h = half === undefined ? row?.halfDayMinutes ?? null : half;
  if (f != null && h != null && h > f) throw invalidArgument("half_day_minutes must not exceed full_day_minutes");
}

