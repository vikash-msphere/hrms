import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { Wire } from "../http/wire";
import { photoMarker } from "../http/serialize";
import { daysInMonthUtc } from "../domain/calendar";
import { orgToday, dayStartMs } from "./orgDay";

// Company-wide "who's celebrating soon" feed for the dashboard. Birthdays come from the ENCRYPTED personal
// details blob (date_of_birth) and are returned as day+month ONLY - never the year, so no age is exposed.
// Work anniversaries come from the (non-encrypted) start_date. Both are org-wide by design: this is the
// celebratory widget every employee sees. The route is gated by the authz middleware like any other.
// Shape comes from the contract (openapi.yaml `celebration`), like every other wire type - this feed has no
// serializer in src/http/serialize.ts, so annotating here is what keeps it checked against the spec.
export type Celebration = Wire<"celebration">;

const DAY_MS = 86_400_000;

// Days from `todayMs` (the org's calendar day, anchored at UTC midnight) to the next occurrence of
// (month, day); 0 = today.
//
// A 29 February anchor in a common year CLAMPS to the 28th. It used to roll to 1 March on `Date.UTC`'s own
// overflow, which is a defensible fallback in isolation and the wrong one here: the cron's anniversary email
// and event fire on the clamped day (domain/calendar.ts `isAnniversaryOf`, which is the house rule this whole
// module was written to enforce), so the widget counted down to a day one later than the day the greeting
// actually arrived. One rule, applied on both surfaces, matters more than which of the two days it picks.
function daysUntil(todayMs: number, month: number, day: number): number {
  const y = new Date(todayMs).getUTCFullYear();
  const at = (year: number) => Date.UTC(year, month - 1, Math.min(day, daysInMonthUtc(year, month - 1)));
  const occ = at(y) < todayMs ? at(y + 1) : at(y);
  return Math.round((occ - todayMs) / DAY_MS);
}

// month/day (1-based) parsed from a stored date_of_birth string ("YYYY-MM-DD"); null if absent/malformed.
function monthDay(s: string | undefined): { month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((s ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

async function readDob(deps: Deps, enc: string | null): Promise<string | undefined> {
  if (!enc) return undefined;
  try {
    return (JSON.parse(await deps.encryptor.decrypt(enc)) as { date_of_birth?: string }).date_of_birth;
  } catch {
    return undefined; // a blob we can't read just contributes no birthday
  }
}

export async function upcomingCelebrations(deps: Deps, withinDays = 30): Promise<Celebration[]> {
  // The ORG's today. This widget has to agree with the cron that sends the greeting (`isAnniversaryOf`, run
  // off the same org day), and a UTC-derived one disagrees with it for part of every day: east of UTC the
  // card still read "in 1 day" on the morning the mail went out, west of UTC it read "today" the evening
  // before. Same reasoning as the 29 February clamp above - one rule on both surfaces. See orgDay.ts.
  const todayMs = dayStartMs(await orgToday(deps));

  const rows = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
  const out: Celebration[] = [];
  for (const e of rows) {
    if (e.deleteTime) continue;
    const name = `${e.firstName} ${e.lastName}`.trim();
    const ref = `employees/${e.uuid}`;
    // The same marker every other surface serves, version and all (http/serialize.ts). Built by hand here it
    // had no `?v=`, so these avatars keyed the face cache on the bare employee id - a key nothing outside the
    // uploading tab invalidates, which left the card showing last year's picture.
    const photo = photoMarker(e);

    // Birthday (day + month only).
    const md = monthDay(await readDob(deps, e.personalDetailsEnc));
    if (md) {
      const inDays = daysUntil(todayMs, md.month, md.day);
      if (inDays <= withinDays) out.push({ employee: ref, name, photo, kind: "birthday", month: md.month, day: md.day, in_days: inDays });
    }

    // Work anniversary (from start_date; skip the join day itself and future joiners). `years` is the count
    // completed on the upcoming occurrence; within a <=90-day window this is always >= 1.
    if (e.startDate) {
      const start = new Date(e.startDate);
      const month = start.getUTCMonth() + 1;
      const day = start.getUTCDate();
      const inDays = daysUntil(todayMs, month, day);
      const years = new Date(todayMs + inDays * DAY_MS).getUTCFullYear() - start.getUTCFullYear();
      if (inDays <= withinDays && years >= 1) out.push({ employee: ref, name, photo, kind: "anniversary", month, day, in_days: inDays, years });
    }
  }
  out.sort((a, b) => a.in_days - b.in_days || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  return out;
}
