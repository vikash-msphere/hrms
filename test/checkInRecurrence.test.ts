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
import { orgToday, dayStartMs } from "../src/services/orgDay";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
let todayMs = 0; // the org's today, as the epoch ms a date-only column stores it (set in beforeAll)
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as unknown as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as unknown as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
  // The fixtures below count days from the ORG's today, because that is what the code under test counts from
  // (services/orgDay.ts). Anchored on UTC midnight instead, "tomorrow's 1:1" was a different row from the one
  // `remindUpcomingCheckIns` looks for during the hours when the two calendars disagree - from 18:30 UTC for
  // an IST org - so this suite failed every night on code that was correct.
  todayMs = dayStartMs(await orgToday(deps));
});

const TABLES = [schema.checkIns, schema.notifications, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const dayMs = 86_400_000;
const daysFromToday = (n: number) => new Date(todayMs + n * dayMs);

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

/**
 * A `Deps` whose inserts INTO ONE TABLE fail, so the claim-release path can be tested for what it is: what
 * happens after the guarded claim has already committed and the write it was claimed for does not land.
 *
 * A Proxy rather than a spread copy: `deps.db` is a drizzle instance whose methods live on its prototype, so
 * `{...deps.db}` would lose all of them. Everything but the one insert passes straight through, which is what
 * lets the release write itself succeed - the whole point of the branch.
 */
function refuseInsertsTo(target: Deps, table: unknown): Deps {
  const db = new Proxy(target.db as unknown as Record<string | symbol, unknown>, {
    get(t, prop, recv) {
      if (prop === "insert") {
        return (tbl: unknown) => {
          if (tbl === table) throw new Error("insert refused (test)");
          return (Reflect.get(t, prop, recv) as (x: unknown) => unknown)(tbl);
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...target, db: db as unknown as Deps["db"] };
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

  it("rolls the rest of the org when one row's action items are unreadable", async () => {
    // The parse used to be bare, so ONE unreadable blob threw out of the whole subtask and every other
    // recurring 1:1 in the org went unrolled that night.
    const bad = await mkEmployee();
    const good = await mkEmployee();
    await mkCheckIn({ employeeId: bad, meetingDate: daysFromToday(-8), cadence: "weekly", actionItemsJson: "{not json" });
    await mkCheckIn({ employeeId: good, meetingDate: daysFromToday(-8), cadence: "weekly", actionItemsJson: JSON.stringify([{ text: "carry me", done: false }]) });

    expect(await rollRecurringCheckIns(deps)).toBe(2);
    const rows = await deps.db.select().from(schema.checkIns);
    expect(rows.length).toBe(4);
    // The bad row still rolled - carrying nothing forward, which is the outcome that loses least.
    const badNext = rows.find((r) => r.employeeId === bad && r.cadence === "weekly")!;
    expect(badNext.actionItemsJson).toBeNull();
    // And the good row carried its open item as it always did.
    const goodNext = rows.find((r) => r.employeeId === good && r.cadence === "weekly")!;
    expect(JSON.parse(goodNext.actionItemsJson!)).toEqual([{ text: "carry me", done: false }]);
  });

  it("puts the cadence AND the action items back when the successor cannot be written", async () => {
    // The claim commits before the create, so a create that throws used to END THE SERIES: the recurring 1:1
    // stopped existing with nothing anywhere saying so, and because the claim also marks the open action items
    // done, those went with it. Both halves have to come back for the next tick to retry.
    const emp = await mkEmployee();
    const items = [{ text: "still open", done: false }];
    const old = await mkCheckIn({ employeeId: emp, meetingDate: daysFromToday(-8), cadence: "weekly", actionItemsJson: JSON.stringify(items) });

    await expect(rollRecurringCheckIns(refuseInsertsTo(deps, schema.checkIns))).rejects.toThrow(/could not be rolled/);

    const rows = await deps.db.select().from(schema.checkIns);
    expect(rows.length).toBe(1); // no half-written successor
    expect(rows[0]!.uuid).toBe(old.uuid);
    expect(rows[0]!.cadence).toBe("weekly"); // the claim was released
    expect(JSON.parse(rows[0]!.actionItemsJson!)).toEqual(items); // and the open item is open again

    // The next tick, with writes working again, rolls it exactly once.
    expect(await rollRecurringCheckIns(deps)).toBe(1);
    expect((await deps.db.select().from(schema.checkIns)).length).toBe(2);
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
