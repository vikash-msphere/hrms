/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { orgYear } from "../src/services/orgDay";
import { encashedDaysThisYear } from "../src/services/leaveEncashments";

// The org-local calendar YEAR over columns that hold an INSTANT.
//
// Every other org-local decision in the app compares against a date-only column, which the schema anchors at
// UTC midnight - `orgToday` + `dayStartMs` answer those. `created_at` is not one of those: it is the moment
// the row was written, so "was this encashed this calendar year" is a question about where the org's year
// boundary falls in real time, and a UTC year answers it wrong on both sides of midnight.
//
// `orgYear` refuses to invert the timezone (that is DST-ambiguous). It hands back LOOSE bounds to narrow the
// SQL read and an exact `covers` test for the rows that come back. So the two properties worth pinning are:
// the bounds never exclude a row the local year contains (or the exact test never sees it), and `covers` puts
// each instant in the year the ORG was living in when it happened.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const CLEAR = [schema.leaveEncashments, schema.leaveTypes, schema.employees, schema.settings];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
});

const at = (ms: number): Deps => ({ ...deps, clock: { now: () => new Date(ms) } });
const setTz = (tz: string) => deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ timezone: tz }) });

// 1 Jan 2026, 02:00 in Kolkata (UTC+5:30) is still 31 Dec 2025, 20:30 in UTC.
const IST_NEW_YEAR_MORNING = Date.UTC(2025, 11, 31, 20, 30);
// 31 Dec 2025, 21:00 in New York (UTC-5) is already 1 Jan 2026 in UTC.
const NY_NEW_YEARS_EVE = Date.UTC(2026, 0, 1, 2, 0);

describe("orgYear: which calendar year an instant belongs to", () => {
  it("is the year the ORG is in, east of UTC, when UTC has not rolled over yet", async () => {
    await setTz("Asia/Kolkata");
    const oy = await orgYear(at(IST_NEW_YEAR_MORNING));
    expect(oy.year).toBe("2026"); // the UTC year here is still 2025
    expect(oy.covers(IST_NEW_YEAR_MORNING)).toBe(true);
  });

  it("is the year the ORG is in, west of UTC, when UTC has already rolled over", async () => {
    await setTz("America/New_York");
    const oy = await orgYear(at(NY_NEW_YEARS_EVE));
    expect(oy.year).toBe("2025"); // the UTC year here is already 2026
    expect(oy.covers(NY_NEW_YEARS_EVE)).toBe(true); // the org is still living in 2025, so this belongs to it
    // Five hours on, the org has crossed over too - and the same instant-by-instant test says so.
    expect(oy.covers(NY_NEW_YEARS_EVE + 5 * 3_600_000)).toBe(false);
  });

  it("the loose bounds contain every instant the local year contains, at both edges", async () => {
    for (const tz of ["Asia/Kolkata", "America/New_York", "Pacific/Kiritimati", "Etc/GMT+12"]) {
      await deps.db.delete(schema.settings);
      await setTz(tz);
      // Local midnight opening the year, and the last millisecond closing it, as instants - bracketed by a
      // full day either side so the loop covers whatever offset the zone actually has.
      const oy = await orgYear(at(Date.UTC(2026, 5, 1)));
      expect(oy.year).toBe("2026");
      for (let t = Date.UTC(2025, 11, 30); t <= Date.UTC(2027, 0, 2); t += 3_600_000) {
        // The invariant: anything `covers` accepts must be inside the bounds that narrow the read. A row the
        // bounds excluded would never reach `covers` at all, and would silently go uncounted.
        if (oy.covers(t)) expect(t >= +oy.from && t <= +oy.to, `${tz}: ${new Date(t).toISOString()} passed covers but fell outside the SQL bounds`).toBe(true);
      }
    }
  });

  it("puts a whole year in, and neither neighbour", async () => {
    await setTz("Asia/Kolkata");
    const oy = await orgYear(at(Date.UTC(2026, 5, 1)));
    let inYear = 0;
    for (let t = Date.UTC(2025, 11, 30); t <= Date.UTC(2027, 0, 2); t += 86_400_000) if (oy.covers(t)) inYear++;
    expect(inYear).toBe(365); // 2026 is not a leap year; the 2025 and 2027 days either side are excluded
  });
});

describe("the annual encashment cap counts by the org's year, not UTC's", () => {
  it("counts a payout raised in the first hours of the local new year against the NEW year", async () => {
    await setTz("Asia/Kolkata");
    const employeeId = genId();
    await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "e-1", firstName: "Asha", lastName: "R", workEmail: "asha@test.example", status: "active" });
    const leaveTypeId = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: leaveTypeId, code: "lt-1", name: "Earned", encashable: true });

    // Raised at 02:00 on 1 January IST. In UTC that instant is still 31 December - which is exactly how this
    // used to land in the PREVIOUS year's total, leaving the whole new-year cap free on top of it.
    await deps.db.insert(schema.leaveEncashments).values({
      uuid: genId(), code: "en-1", employeeId, leaveTypeId, days: 8, state: "APPROVED",
      ratePerDay: 3000, amount: 24000,
      createdAt: new Date(IST_NEW_YEAR_MORNING),
    });

    const nextDay = at(IST_NEW_YEAR_MORNING + 86_400_000);
    expect(await encashedDaysThisYear(nextDay, employeeId, await orgYear(nextDay))).toBe(8);

    // ...and the year it is NOT in still reads zero, so the days are counted once and in one place.
    const lastYear = at(Date.UTC(2025, 5, 1));
    expect(await encashedDaysThisYear(lastYear, employeeId, await orgYear(lastYear))).toBe(0);
  });
});
