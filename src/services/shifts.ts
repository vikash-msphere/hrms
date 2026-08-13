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
  color?: string | null;
};

const validTime = (t?: string) => t === undefined || HHMM.test(t);

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
    return {
      name: input.name.trim(),
      startTime: input.start ?? "09:00",
      endTime: input.end ?? "18:00",
      breakMinutes: Math.max(0, input.break_minutes ?? 0),
      color: input.color?.trim() || null,
    };
  },
  patch: (patch) => {
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
    if (has(patch, "color")) set.color = patch.color?.trim() || null;
    return set;
  },
};

