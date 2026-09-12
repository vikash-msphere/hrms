/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { bustRef } from "../src/lib/refData";
import type { ListScope } from "../src/domain/access";
import { peopleAnalytics } from "../src/services/peopleAnalytics";
import { ANALYTICS_COLLECTIONS } from "../src/domain/peopleAnalytics";
import { advanceApplication } from "../src/services/ats";

// "TODAY" IS THE ORG'S DAY, on the two report/pipeline surfaces that still derived it from UTC.
//
// services/orgDay.ts states the rule and why: an instant's calendar day depends on the timezone it is read
// in, and UTC agrees with Asia/Kolkata for about eighteen and a half hours out of twenty-four - so a UTC
// reading produces the bugs that only appear at certain times of day, in certain timezones, and never in a
// test that does not pin both.
//
// Each case below pins one instant and asks TWO orgs about it, one either side of the UTC date line at that
// moment. That is the assertion that matters: it is not enough for the answer to be right for the default
// timezone, it has to MOVE with the org's.

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

const TABLES = [
  schema.attendanceSessions, schema.leaveRequests, schema.leaveTypes, schema.holidays,
  schema.eventLog, schema.auditLog, schema.notifications,
  schema.applications, schema.candidates, schema.jobRequisitions,
  schema.settings, schema.users, schema.employees, schema.departments, schema.roles, schema.codeSequences,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  deps.clock = { now: () => new Date() };
});

/** Point the org at a timezone. The settings read is memoized per-Deps, so drop the snapshot with it. */
async function setTimezone(tz: string) {
  const value = JSON.stringify({ timezone: tz });
  await deps.db
    .insert(schema.settings)
    .values({ key: "attendance", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  deps.refCache?.clear();
  bustRef(deps, "settings");
}

const day = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`));

// 2026-06-11T02:00:00Z. In Asia/Kolkata that is 07:30 on the 11th; in America/New_York it is 22:00 on the
// 10th. One instant, two different calendar days - which is the whole point.
const TICK = new Date("2026-06-11T02:00:00.000Z");

describe("the people report clamps its window at the ORG's today, not the Worker's", () => {
  // June 2026 opens on a Monday. Mon-Fri working days, so:
  //   1 Jun .. 10 Jun -> 1,2,3,4,5 + 8,9,10          = 8 working days
  //   1 Jun .. 11 Jun -> those, plus the 11th        = 9 working days
  // `expectedWorkingDays` closes the window at "today" because a day that has not arrived cannot be an
  // absence. Read in UTC, an org in the Americas therefore counted the not-yet-started local day as a working
  // day every evening - and since the absence count is `expected - present - leave`, that charged one
  // spurious absence to every person in the report.
  const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
  const allScopes = () => new Map<string, ListScope>(ANALYTICS_COLLECTIONS.map((c) => [c, all()]));
  const WINDOW = { from: "2026-06-01", to: "2026-06-30" }; // `to` runs past the tick, so the clamp decides

  async function seedOnePerson() {
    await deps.db.insert(schema.employees).values({
      uuid: genId(), code: "04-001-001", firstName: "Aya", lastName: "One",
      workEmail: "a@x.test", status: "active", startDate: day("2024-01-01"),
    });
  }

  it("stops at the 10th for an org whose local day is still 10 June", async () => {
    await setTimezone("America/New_York");
    await seedOnePerson();
    deps.clock = { now: () => TICK };

    const result = await peopleAnalytics(deps, allScopes(), WINDOW);

    expect(result.window.timezone).toBe("America/New_York");
    expect(result.window.working_days).toBe(8);
    // Nobody punched and nobody was on leave, so the absence count IS the expected-days figure. The 11th has
    // not begun in New York and must not be charged to anyone.
    expect(result.people[0]?.values.days_absent).toBe(8);
  });

  it("includes the 11th for an org already on it", async () => {
    await setTimezone("Asia/Kolkata");
    await seedOnePerson();
    deps.clock = { now: () => TICK };

    const result = await peopleAnalytics(deps, allScopes(), WINDOW);

    expect(result.window.working_days).toBe(9);
    expect(result.people[0]?.values.days_absent).toBe(9);
  });
});

describe("an offer's dates are stamped in the org's day", () => {
  // `offerDate` and the join/expiry dates it derives are what a rule templates into an offer and what a
  // recruiter reads off the pipeline. Derived from the UTC day, an offer raised in the early hours in IST
  // carried YESTERDAY's date - and the notice and validity windows counted from it shifted with it.
  const DEFAULT_JOIN_NOTICE_DAYS = 30;
  const DEFAULT_OFFER_VALIDITY_DAYS = 7;

  async function seedPipeline(): Promise<{ actor: AppUser; applicationId: string }> {
    await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
    const userId = genId();
    await deps.db.insert(schema.users).values({ uuid: userId, code: "u-1", email: "hr@x.test", role: "hr_admin" });

    const reqId = genId();
    await deps.db.insert(schema.jobRequisitions).values({ uuid: reqId, code: "req-1", title: "Engineer", status: "open", openings: 1 });
    const candId = genId();
    await deps.db.insert(schema.candidates).values({ uuid: candId, code: "cand-1", name: "Bo Two", email: "bo@x.test" });
    const appId = genId();
    await deps.db.insert(schema.applications).values({
      uuid: appId, code: "app-1", candidateId: candId, requisitionId: reqId, stage: "applied", status: "active",
    });

    return {
      actor: { uuid: userId, email: "hr@x.test", role: "hr_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser,
      applicationId: appId,
    };
  }

  /** The `application.advanced` payload the pipeline event carried. */
  async function advancedPayload(actor: AppUser, applicationId: string): Promise<Record<string, unknown>> {
    await advanceApplication(deps, actor, applicationId);
    const rows = await deps.db.select().from(schema.eventLog).where(eq(schema.eventLog.subject, `applications/${applicationId}`));
    const row = rows[0];
    expect(row, "the advance should have logged an event").toBeTruthy();
    return JSON.parse(row!.payloadJson ?? "{}") as Record<string, unknown>;
  }

  it("dates an offer on the org's day, and counts notice and validity from it", async () => {
    await setTimezone("Asia/Kolkata"); // TICK is 07:30 on the 11th here
    const { actor, applicationId } = await seedPipeline();
    deps.clock = { now: () => TICK };

    const payload = await advancedPayload(actor, applicationId);

    expect(payload.offerDate).toBe("2026-06-11");
    expect(payload.suggestedJoinDate).toBe("2026-07-11"); // +30 days
    expect(payload.suggestedExpiryDate).toBe("2026-06-18"); // +7 days
    // Stated so the arithmetic above is anchored to the config rather than to two magic numbers.
    expect(DEFAULT_JOIN_NOTICE_DAYS).toBe(30);
    expect(DEFAULT_OFFER_VALIDITY_DAYS).toBe(7);
  });

  it("dates the same instant a day earlier for an org that is still on the previous day", async () => {
    await setTimezone("America/New_York"); // TICK is 22:00 on the 10th here
    const { actor, applicationId } = await seedPipeline();
    deps.clock = { now: () => TICK };

    const payload = await advancedPayload(actor, applicationId);

    expect(payload.offerDate).toBe("2026-06-10");
    expect(payload.suggestedJoinDate).toBe("2026-07-10");
    expect(payload.suggestedExpiryDate).toBe("2026-06-17");
  });
});
