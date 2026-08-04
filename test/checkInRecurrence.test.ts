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
import { rollRecurringCheckIns, remindUpcomingCheckIns } from "../src/cron";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as unknown as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as unknown as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.checkIns, schema.notifications, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const dayMs = 86_400_000;
const utcMidnight = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return +d;
};
const daysFromToday = (n: number) => new Date(utcMidnight() + n * dayMs);

async function mkEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid,
    code: short("04"),
    firstName: "T",
    lastName: uuid.slice(0, 4),
    workEmail: `${uuid}@t.example`,
    status: "active",
  });
  return uuid;
}

async function mkCheckIn(v: Partial<typeof schema.checkIns.$inferInsert> & { employeeId: string }) {
  return (await deps.db.insert(schema.checkIns).values({ code: short("05"), ...v }).returning())[0]!;
}

describe("rollRecurringCheckIns", () => {
  it("creates the next occurrence on the cadence grid, carries open items, and moves the cadence", async () => {
    const emp = await mkEmployee();
    const mgr = await mkEmployee();
    const old = await mkCheckIn({
      employeeId: emp,
      counterpartId: mgr,
      meetingDate: daysFromToday(-8),
      cadence: "weekly",
      actionItemsJson: JSON.stringify([{ text: "ship the doc", done: false }, { text: "done thing", done: true }]),
    });

    expect(await rollRecurringCheckIns(deps)).toBe(1);

    const rows = await deps.db.select().from(schema.checkIns);
    expect(rows.length).toBe(2);
    const oldRow = rows.find((r) => r.uuid === old.uuid)!;
    const next = rows.find((r) => r.uuid !== old.uuid)!;
    // The cadence moved: exactly the new row carries it, and the old row's open items were retired.
    expect(oldRow.cadence).toBeNull();
    expect((JSON.parse(oldRow.actionItemsJson!) as { done: boolean }[]).every((i) => i.done)).toBe(true);
    expect(next.cadence).toBe("weekly");
    expect(next.employeeId).toBe(emp);
    expect(next.counterpartId).toBe(mgr);
    // -8d stepping by 7 lands on -1d (still past), so the grid's next future slot is +6d.
    expect(+new Date(next.meetingDate!)).toBe(+daysFromToday(6));
    // Only the open item came forward, reset to open.
    expect(JSON.parse(next.actionItemsJson!)).toEqual([{ text: "ship the doc", done: false }]);
    // Both attendees were told.
    const notifs = await deps.db.select().from(schema.notifications);
    expect(notifs.filter((n) => n.type === "checkin.scheduled").map((n) => n.recipientId).sort()).toEqual([emp, mgr].sort());
  });

  it("is idempotent: a re-run mints nothing new", async () => {
    const emp = await mkEmployee();
    await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(-1), cadence: "biweekly" });
    expect(await rollRecurringCheckIns(deps)).toBe(1);
    expect(await rollRecurringCheckIns(deps)).toBe(0);
    expect((await deps.db.select().from(schema.checkIns)).length).toBe(2);
  });

  it("ignores non-recurring, future-dated, and deleted 1:1s", async () => {
    const emp = await mkEmployee();
    await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(-3) }); // no cadence
    await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(3), cadence: "weekly" }); // future
    await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(-3), cadence: "weekly", deleteTime: new Date() }); // deleted
    expect(await rollRecurringCheckIns(deps)).toBe(0);
  });
});

describe("remindUpcomingCheckIns", () => {
  it("nudges both attendees of tomorrow's 1:1s, and only tomorrow's", async () => {
    const emp = await mkEmployee();
    const mgr = await mkEmployee();
    await mkCheckIn({ employeeId: emp, counterpartId: mgr, meetingDate: daysFromToday(1) });
    await mkCheckIn({ employeeId: emp, counterpartId: mgr, meetingDate: daysFromToday(2) }); // not yet
    await mkCheckIn({ employeeId: emp, counterpartId: mgr, meetingDate: daysFromToday(0) }); // today, not tomorrow
    expect(await remindUpcomingCheckIns(deps)).toBe(2);
    const notifs = (await deps.db.select().from(schema.notifications)).filter((n) => n.type === "checkin.reminder");
    expect(notifs.map((n) => n.recipientId).sort()).toEqual([emp, mgr].sort());
  });

  it("handles a missing counterpart (single nudge)", async () => {
    const emp = await mkEmployee();
    await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(1) });
    expect(await remindUpcomingCheckIns(deps)).toBe(1);
  });
});
