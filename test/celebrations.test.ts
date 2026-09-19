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
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { upcomingCelebrations } from "../src/services/celebrations";
import { orgToday } from "../src/services/orgDay";

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

describe("the celebrations feed names people who are still here", () => {
  it("names a live employee whose birthday is today", async () => {
    const live = await celebrant();
    const feed = await upcomingCelebrations(deps);
    expect(feed.map((c) => c.employee)).toEqual([`employees/${live}`]);
    expect(feed[0]).toMatchObject({ kind: "birthday", in_days: 0 });
  });

  it("does NOT broadcast a DISABLED employee's birthday - the column that was never checked", async () => {
    const live = await celebrant();
    await celebrant({ disabled: true });
    expect((await upcomingCelebrations(deps)).map((c) => c.employee)).toEqual([`employees/${live}`]);
  });

  it("excludes a leaver and a soft-deleted row, in SQL rather than after the read", async () => {
    const live = await celebrant();
    await celebrant({ status: "terminated" });
    await celebrant({ deleteTime: new Date() });
    expect((await upcomingCelebrations(deps)).map((c) => c.employee)).toEqual([`employees/${live}`]);
  });

  it("returns the day and month of a birthday and never the year, so no age is exposed", async () => {
    await celebrant();
    const feed = await upcomingCelebrations(deps);
    expect(Object.keys(feed[0]!)).not.toContain("year");
    expect(JSON.stringify(feed)).not.toContain("1990");
  });
});
