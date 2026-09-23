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
import { rollRepeatingEvents } from "../src/cron";

// `rollRepeatingEvents` had no test at all, which is how it kept the defect its sibling (recurring cards) had
// already had fixed: the guarded claim commits, and a create that then throws ends the series outright - a
// weekly all-hands that stops appearing on the calendar with nothing saying why. The release path is the point
// of this file; the happy path and idempotency are here because they are what the release must not break.
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

const TABLES = [schema.events, schema.notifications, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const dayMs = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * dayMs);

async function mkEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: short("04"), firstName: "T", lastName: uuid.slice(0, 4), workEmail: `${uuid}@t.example`, status: "active",
  });
  return uuid;
}

async function mkEvent(v: Partial<typeof schema.events.$inferInsert> & { startTime: Date; endTime: Date }) {
  return (await deps.db.insert(schema.events).values({ code: short("42"), title: "All hands", ...v }).returning())[0]!;
}

/** See test/checkInRecurrence.test.ts - a Deps whose inserts into one table fail, so the post-claim failure
 *  path can be exercised while the release write itself still works. */
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

describe("rollRepeatingEvents", () => {
  it("creates the next occurrence, moves the repeat onto it, and tells the named attendees", async () => {
    const emp = await mkEmployee();
    const old = await mkEvent({
      startTime: daysFromNow(-8),
      endTime: daysFromNow(-8),
      repeat: "weekly",
      attendeeIds: JSON.stringify([emp]),
      description: "the weekly one",
    });

    expect(await rollRepeatingEvents(deps)).toBe(1);

    const rows = await deps.db.select().from(schema.events);
    expect(rows.length).toBe(2);
    const oldRow = rows.find((r) => r.uuid === old.uuid)!;
    const next = rows.find((r) => r.uuid !== old.uuid)!;
    // Exactly one row of the series carries the repeat, and it is the new one.
    expect(oldRow.repeat).toBeNull();
    expect(next.repeat).toBe("weekly");
    expect(next.title).toBe(old.title);
    expect(next.description).toBe("the weekly one");
    expect(+new Date(next.startTime)).toBeGreaterThan(Date.now());
    const notifs = (await deps.db.select().from(schema.notifications)).filter((n) => n.type === "event.scheduled");
    expect(notifs.map((n) => n.recipientId)).toEqual([emp]);
  });

  it("is idempotent: a re-run mints nothing new", async () => {
    await mkEvent({ startTime: daysFromNow(-2), endTime: daysFromNow(-2), repeat: "weekly" });
    expect(await rollRepeatingEvents(deps)).toBe(1);
    expect(await rollRepeatingEvents(deps)).toBe(0);
    expect((await deps.db.select().from(schema.events)).length).toBe(2);
  });

  it("ignores non-repeating, unfinished and deleted events", async () => {
    await mkEvent({ startTime: daysFromNow(-3), endTime: daysFromNow(-3) }); // no repeat
    await mkEvent({ startTime: daysFromNow(1), endTime: daysFromNow(2), repeat: "weekly" }); // not finished
    await mkEvent({ startTime: daysFromNow(-3), endTime: daysFromNow(-3), repeat: "weekly", deleteTime: new Date() }); // deleted
    expect(await rollRepeatingEvents(deps)).toBe(0);
  });

  it("rolls the series even when the attendee list is unreadable", async () => {
    await mkEvent({ startTime: daysFromNow(-8), endTime: daysFromNow(-8), repeat: "weekly", attendeeIds: "{not json" });
    expect(await rollRepeatingEvents(deps)).toBe(1);
    expect((await deps.db.select().from(schema.notifications)).length).toBe(0);
  });

  it("puts the repeat back when the successor cannot be written", async () => {
    const old = await mkEvent({ startTime: daysFromNow(-8), endTime: daysFromNow(-8), repeat: "weekly" });

    await expect(rollRepeatingEvents(refuseInsertsTo(deps, schema.events))).rejects.toThrow(/could not be rolled/);

    const rows = await deps.db.select().from(schema.events);
    expect(rows.length).toBe(1); // nothing half-written
    expect(rows[0]!.uuid).toBe(old.uuid);
    expect(rows[0]!.repeat).toBe("weekly"); // the claim was released, so the next tick retries

    expect(await rollRepeatingEvents(deps)).toBe(1);
    expect((await deps.db.select().from(schema.events)).length).toBe(2);
  });
});
