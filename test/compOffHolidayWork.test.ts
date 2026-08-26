/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { creditHolidayCompOff } from "../src/services/compOff";

// Working on a day the company was shut earns the day back. The two things that must hold: the credit is
// idempotent (the nightly tick can re-run, and a manual trigger can overlap it), and a regional holiday only
// pays back the people whose office actually closed.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY = 86_400_000;
let deps: Deps;
const b = env as unknown as Bindings;

// "Yesterday" from the clock the service reads, as the UTC day the fixtures are written on.
const NOW = Date.UTC(2026, 0, 27, 6, 0, 0); // 27 Jan -> yesterday = 26 Jan (Republic Day)
const YESTERDAY = Date.UTC(2026, 0, 26);

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = { ...makeDeps(b), clock: { now: () => new Date(NOW) } };
});

let mumbai: string; // worked the holiday, Mumbai office
let delhi: string; // worked the same day, Delhi office (the holiday was Mumbai-only in one test)
let leaveTypeId: string;
let holidayId: string;

const CLEAR = [schema.notifications, schema.compOffCredits, schema.leaveBalances, schema.attendanceSessions, schema.holidays, schema.positions, schema.employees, schema.leaveTypes, schema.settings];

async function employee(email: string, location: string, code: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code, firstName: "A", lastName: email, workEmail: email, status: "active" });
  await deps.db.insert(schema.positions).values({ uuid: genId(), code: `${code}-001`, employeeId: uuid, location, effectiveFrom: new Date(0) });
  return uuid;
}
/** A pair of punches on yesterday, `minutes` long. */
async function worked(employeeId: string, minutes: number, code: string) {
  await deps.db.insert(schema.attendanceSessions).values({
    uuid: genId(), code, employeeId, clockIn: new Date(YESTERDAY + 4 * 3600_000), clockOut: new Date(YESTERDAY + 4 * 3600_000 + minutes * 60_000),
  });
}
const setting = (key: string, value: unknown) =>
  deps.db.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
const balanceOf = async (employeeId: string) =>
  (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0]?.balanceDays ?? 0;

beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  leaveTypeId = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: leaveTypeId, code: "0z", name: "Compensatory Off", accrualDaysPerYear: 0, paid: true });
  holidayId = genId();
  await deps.db.insert(schema.holidays).values({ uuid: holidayId, code: "h1", name: "Republic Day", date: new Date(YESTERDAY), kind: "fixed" });
  mumbai = await employee("mumbai@example.com", "Mumbai", "04-001");
  delhi = await employee("delhi@example.com", "Delhi", "04-002");
  // Timezone UTC keeps the fixture's punches on the day they were written.
  await setting("attendance", { timezone: "UTC", full_day_minutes: 480, half_day_minutes: 240 });
});

describe("creditHolidayCompOff", () => {
  it("does nothing unless the org opted in", async () => {
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(0);
    expect(await balanceOf(mumbai)).toBe(0);
  });

  it("credits a full day for a full day worked, and half for half", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await worked(mumbai, 500, "s1"); // > full_day_minutes
    await worked(delhi, 300, "s2"); // between half and full
    expect(await creditHolidayCompOff(deps)).toBe(2);
    expect(await balanceOf(mumbai)).toBe(1);
    expect(await balanceOf(delhi)).toBe(0.5);
  });

  it("ignores a stint too short to count, and superseded punches", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await worked(mumbai, 90, "s1"); // under half_day_minutes
    expect(await creditHolidayCompOff(deps)).toBe(0);
    expect(await balanceOf(mumbai)).toBe(0);
  });

  it("is idempotent: a second run credits nobody twice", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(1);
    expect(await creditHolidayCompOff(deps)).toBe(0);
    expect(await balanceOf(mumbai)).toBe(1);
    expect((await deps.db.select().from(schema.compOffCredits)).length).toBe(1);
  });

  it("only pays back the office the holiday actually closed", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await deps.db.update(schema.holidays).set({ location: "Mumbai" }).where(eq(schema.holidays.uuid, holidayId));
    await worked(mumbai, 500, "s1");
    await worked(delhi, 500, "s2"); // an ordinary working day in Delhi -> overtime's business, not comp-off's
    expect(await creditHolidayCompOff(deps)).toBe(1);
    expect(await balanceOf(mumbai)).toBe(1);
    expect(await balanceOf(delhi)).toBe(0);
  });

  // Two holidays can land on one date: a company-wide half day plus a full day only one office got. Whoever
  // worked the office that was fully shut is owed the whole day, so the full-day match has to win rather than
  // whichever row the query happened to return first.
  it("owes back the whole day when a full-day holiday shares the date with a half-day one", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await deps.db.update(schema.holidays).set({ halfDay: true }).where(eq(schema.holidays.uuid, holidayId));
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h2", name: "Founders' Day", date: new Date(YESTERDAY), kind: "fixed", location: "Mumbai" });
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(1);
    expect(await balanceOf(mumbai)).toBe(1);
  });

  it("owes back only half a day for a half-day holiday", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await deps.db.update(schema.holidays).set({ halfDay: true }).where(eq(schema.holidays.uuid, holidayId));
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(1);
    expect(await balanceOf(mumbai)).toBe(0.5);
  });

  it("credits nothing when the org has no compensatory-off leave type", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await deps.db.delete(schema.leaveTypes);
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(0);
    expect((await deps.db.select().from(schema.compOffCredits)).length).toBe(0);
  });

  it("skips a day that wasn't a holiday at all", async () => {
    await setting("holidays", { comp_off_on_holiday_work: true });
    await deps.db.delete(schema.holidays);
    await worked(mumbai, 500, "s1");
    expect(await creditHolidayCompOff(deps)).toBe(0);
  });
});
