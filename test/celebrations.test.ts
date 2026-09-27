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
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { upcomingCelebrations, celebrationLeadDays } from "../src/services/celebrations";
import { orgToday, orgDayFromToday } from "../src/services/orgDay";
import { bustRef } from "../src/lib/refData";

// The dashboard celebrations feed is a collection-level custom method on employees. It is company-wide (every
// signed-in role may read it), so the grant must allow `employees.upcomingCelebrations` for all five roles.
// grantFor reads the typed GRANTS seed; seedDrift.test.ts pins the DB seed to that same source.
const PATH = "/v1/employees:upcomingCelebrations";
const can = (role: string) => decide(grantFor(role), resolveRequest("GET", PATH), { employeeCode: "04-002-001" }).allow;

describe("celebrations feed authz", () => {
  it("resolves to the custom verb on the employees collection (the colon makes it custom, not a list read)", () => {
    const r = resolveRequest("GET", PATH);
    expect(r).toEqual({ kind: "custom", resource: "employees", verb: "upcomingCelebrations" });
  });

  it("every role may read it", () => {
    for (const role of ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"]) {
      expect(can(role)).toBe(true);
    }
  });

  it("an unknown role (deny-all) may not", () => {
    expect(can("intern_no_policy")).toBe(false);
  });
});

// ---- Who the feed actually names -----------------------------------------------------------------------
//
// The roster half of the same endpoint. It used to `select()` every column of every `status = "active"`
// employee, filter `delete_time` in the ISOLATE, and never check `disabled` at all - so a disabled employee's
// birthday was broadcast to the whole company on the dashboard card. services/notifications.ts names exactly
// that outcome when it states the rule ("an account switched off is not somebody to broadcast to either"), and
// the rule now lives in services/liveEmployee.ts where all three surfaces take it from.
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

beforeEach(async () => {
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.settings);
});

let n = 0;
/**
 * An employee whose birthday is today, so the feed always has a reason to name them.
 *
 * "Today" comes from `orgToday`, which is what the SERVICE asks - not `new Date().getUTCDate()`, which is
 * what this used to build the date of birth from. The two are the same date for most of the day and a
 * different one between org-local midnight and UTC midnight, so in an org ahead of UTC these four tests
 * failed for the first hours of every local day and passed for the rest of it. Same rule as everywhere else
 * in the app: the org's day is the only "today" there is (services/orgDay.ts).
 */
async function celebrant(over: Partial<typeof schema.employees.$inferInsert> = {}) {
  n += 1;
  const uuid = genId();
  const dob = `1990-${(await orgToday(deps)).slice(5)}`;
  await deps.db.insert(schema.employees).values({
    uuid,
    code: `04-002-${String(n).padStart(3, "0")}`,
    firstName: "Test",
    lastName: `Person${n}`,
    workEmail: `c${n}@example.com`,
    status: "active",
    personalDetailsEnc: await deps.encryptor.encrypt(JSON.stringify({ date_of_birth: dob })),
    ...over,
  });
  return uuid;
}

// Every celebrant above has a birthday TODAY, so a window of 0 is enough to name them; the window itself is
// pinned below.
describe("the celebrations feed names people who are still here", () => {
  it("names a live employee whose birthday is today", async () => {
    const live = await celebrant();
    const feed = await upcomingCelebrations(deps, 0);
    expect(feed.map((c) => c.employee)).toEqual([`employees/${live}`]);
    expect(feed[0]).toMatchObject({ kind: "birthday", in_days: 0 });
  });

  it("does NOT broadcast a DISABLED employee's birthday - the column that was never checked", async () => {
    const live = await celebrant();
    await celebrant({ disabled: true });
    expect((await upcomingCelebrations(deps, 0)).map((c) => c.employee)).toEqual([`employees/${live}`]);
  });

  it("excludes a leaver and a soft-deleted row, in SQL rather than after the read", async () => {
    const live = await celebrant();
    await celebrant({ status: "terminated" });
    await celebrant({ deleteTime: new Date() });
    expect((await upcomingCelebrations(deps, 0)).map((c) => c.employee)).toEqual([`employees/${live}`]);
  });

  it("returns the day and month of a birthday and never the year, so no age is exposed", async () => {
    await celebrant();
    const feed = await upcomingCelebrations(deps, 0);
    expect(Object.keys(feed[0]!)).not.toContain("year");
    expect(JSON.stringify(feed)).not.toContain("1990");
  });
});

// ---- How far ahead the feed looks ------------------------------------------------------------------------
//
// The dashboard used to show everything in the next 30 days, so a birthday was on screen weeks early. The
// window is now the org's `settings/celebrations.lead_days`, and a missing row is refused rather than
// replaced with a window the org never chose.
async function setLeadDays(value: unknown) {
  await deps.db.insert(schema.settings).values({ key: "celebrations", value: JSON.stringify(value), updatedAt: new Date() });
  bustRef(deps, "settings"); // `deps` outlives a request here, so its settings memo has to be dropped by hand
}
async function birthdayIn(days: number) {
  return celebrant({ personalDetailsEnc: await deps.encryptor.encrypt(JSON.stringify({ date_of_birth: `1990-${(await orgDayFromToday(deps, days)).slice(5)}` })) });
}

describe("the celebrations window is the org's lead time", () => {
  beforeEach(() => bustRef(deps, "settings"));

  it("shows a birthday inside the lead time and not one beyond it", async () => {
    await setLeadDays({ lead_days: 7 });
    const soon = await birthdayIn(7);
    await birthdayIn(8);
    expect((await upcomingCelebrations(deps)).map((c) => c.employee)).toEqual([`employees/${soon}`]);
  });

  it("0 means on the day only", async () => {
    await setLeadDays({ lead_days: 0 });
    const today = await birthdayIn(0);
    await birthdayIn(1);
    expect((await upcomingCelebrations(deps)).map((c) => c.employee)).toEqual([`employees/${today}`]);
  });

  it("an explicit window still wins, for the leave calendar's quarter", async () => {
    await setLeadDays({ lead_days: 0 });
    await birthdayIn(30);
    expect(await upcomingCelebrations(deps, 30)).toHaveLength(1);
  });

  it("refuses to guess when the row is missing or unusable", async () => {
    await expect(upcomingCelebrations(deps)).rejects.toMatchObject({ httpStatus: 503 });
    await setLeadDays({ lead_days: "7" });
    await expect(upcomingCelebrations(deps)).rejects.toMatchObject({ httpStatus: 503 });
  });

  // Found by what it says, not by which file holds it: unapplied migrations get concatenated before a release,
  // so the statement's filename is not stable.
  it("the migration writes a week into an existing database and keeps a value an admin already saved", async () => {
    const sql = /INSERT OR IGNORE INTO `settings`[^;]*'celebrations'[^;]*;/.exec(migrationSql)?.[0];
    expect(sql).toBeDefined();
    await b.DB.prepare(sql!).run();
    bustRef(deps, "settings");
    await expect(celebrationLeadDays(deps)).resolves.toBe(7);

    await deps.db.delete(schema.settings);
    await setLeadDays({ lead_days: 3 });
    await b.DB.prepare(sql!).run();
    bustRef(deps, "settings");
    await expect(celebrationLeadDays(deps)).resolves.toBe(3);
  });
});
