// Work patterns: the repeating shape of somebody's week, and what "a schedule" means to HR. A flat-coded
// catalog like `shifts` and `leave-types`; who is ON one is services/workPatternAssignments.ts, and what a
// pattern MEANS for a day is domain/workSchedule.ts.
import { isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

// A rotation longer than this is a calendar, not a pattern. Eight weeks is 56 cycle entries, which is still
// one small row and still something a person can read on a screen.
export const MAX_CYCLE_WEEKS = 8;

export type WorkPatternInput = {
  name?: string;
  cycle_weeks?: number;
  days?: (string | null)[];
  color?: string | null;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/**
 * The cycle, validated against the length it claims and stored as ids.
 *
 * LENGTH IS EXACT, not a minimum. A short array would resolve its missing days to rest days
 * (domain/workSchedule.ts reads a null entry as one), which reads as "this person does not work Thursdays"
 * and silently stops a day being owed - a pattern that pays less than it was meant to, with nothing on screen
 * saying so.
 */
async function cycleDays(deps: Deps, days: (string | null)[] | undefined, cycleWeeks: number): Promise<string> {
  if (!Array.isArray(days)) throw invalidArgument("days is required");
  const want = cycleWeeks * 7;
  if (days.length !== want) throw invalidArgument(`days must hold exactly ${want} entries for a ${cycleWeeks}-week cycle (one per day, null for a rest day)`);
  const ids = days.map((d) => (d == null || d === "" ? null : idFromPath(d) ?? null));
  // Every shift named has to exist and be live: a pattern pointing at a deleted one would resolve its days to
  // rest days, which is the same quiet underpayment the length check above exists to stop.
  const named = [...new Set(ids.filter((id): id is string => !!id))];
  if (named.length) {
    const live = new Set((await deps.db
      .select({ uuid: schema.shifts.uuid })
      .from(schema.shifts)
      .where(isNull(schema.shifts.deleteTime)))
      .map((s) => s.uuid));
    const missing = named.filter((id) => !live.has(id));
    if (missing.length) throw invalidArgument(`days names ${missing.length === 1 ? "a shift" : "shifts"} that no longer exist - pick from the shift catalog`);
  }
  return JSON.stringify(ids);
}

const cycleWeeksOf = (v: number | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > MAX_CYCLE_WEEKS) throw invalidArgument(`cycle_weeks must be a whole number from 1 to ${MAX_CYCLE_WEEKS}`);
  return v;
};

export const workPatternSpec: CrudSpec<WorkPatternInput, typeof schema.workPatterns> = {
  table: schema.workPatterns,
  collection: "work-patterns",
  auditName: "work-pattern",
  notFound: "work pattern not found",
  sort: (a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.uuid.localeCompare(b.uuid),
  insert: async (input, deps) => {
    if (!input.name?.trim()) throw invalidArgument("name is required");
    const cycleWeeks = cycleWeeksOf(input.cycle_weeks, 1);
    return {
      name: input.name.trim(),
      cycleWeeks,
      daysJson: await cycleDays(deps, input.days, cycleWeeks),
      color: input.color?.trim() || null,
    };
  },
  // `cycle_weeks` and `days` move TOGETHER, because the pair is what has to stay consistent: a patch that
  // widens the cycle without sending the longer array would leave a row whose `days` no longer matches its
  // own length, and domain/workSchedule.ts drops such a pattern rather than half-reading it - so the people
  // on it would silently fall back to the org's week.
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.workPatterns> = {};
    if (has(patch, "name")) {
      if (!patch.name?.trim()) throw invalidArgument("name is required");
      set.name = patch.name.trim();
    }
    if (has(patch, "cycle_weeks") || has(patch, "days")) {
      const cycleWeeks = cycleWeeksOf(has(patch, "cycle_weeks") ? patch.cycle_weeks : undefined, row.cycleWeeks);
      const days = has(patch, "days")
        ? patch.days
        : (JSON.parse(row.daysJson) as (string | null)[]);
      set.cycleWeeks = cycleWeeks;
      set.daysJson = await cycleDays(deps, days, cycleWeeks);
    }
    if (has(patch, "color")) set.color = patch.color?.trim() || null;
    return set;
  },
};

// RETIRING A PATTERN DOES NOT STOP IT RESOLVING, and there is deliberately no check here that would refuse
// it. A soft delete takes the pattern out of the catalog you can pick from and leaves every live assignment
// working, because `refWorkPatterns` reads deleted rows too - the same reading `refPayGrades` makes of a
// retired grade a signed revision was priced at. The alternative, dropping the people on it back onto the
// org's week, would change what they are owed by deleting a catalog row.
//
// Moving people off is a decision about those people. The editor counts who is still on one and says so
// before it retires anything (web/src/settings/WorkPatternsPanel.tsx), which is the honest version of the
// refusal this service could have made instead.
