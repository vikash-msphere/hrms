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
import { processReminderEmailJob } from "../src/cron";

// The nightly reminder mail resumes BY KEY, not by position.
//
// The list is re-derived on every pass (carrying every message body through the job payload would be far
// heavier), so an index into it is only stable while the list is. It is not: a document uploaded with an
// expiry inside the window, or one deleted, between two passes shifts every position after it - which skips
// one person's mail or sends another's twice. The keys are unique and the list is sorted by them.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
let sent: string[];
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
  for (const t of [schema.personalDocuments, schema.employees, schema.jobs, schema.settings]) await deps.db.delete(t);
  sent = [];
  deps.email = { send: async (to, subject) => { sent.push(`${to}|${subject}`); } };
  deps.clock = { now: () => new Date("2026-08-14T02:00:00.000Z") };
});

/** An employee with a personal document expiring inside the 30-day reminder window. */
async function seedExpiring(n: number, dayOffset = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    const uuid = genId();
    await deps.db.insert(schema.employees).values({
      uuid, code: `04-${String(i).padStart(3, "0")}`, firstName: "P", lastName: String(i),
      workEmail: `p${String(i).padStart(3, "0")}@test.example`, status: "active",
    });
    await deps.db.insert(schema.personalDocuments).values({
      uuid: genId(), code: `${uuid}-${String(i).padStart(3, "0")}`, employeeId: uuid,
      documentType: "OTHER", title: `Doc ${i}`, fileName: "d.pdf", r2Key: `k/${i}`,
      contentType: "application/pdf", sizeBytes: 1,
      expireTime: new Date(+deps.clock.now() + dayOffset * 86_400_000),
    });
  }
}

const DAY = "2026-08-14";

describe("nightly reminder mail resumes by key", () => {
  it("sends the batch after the given key and reports the key to resume from", async () => {
    await seedExpiring(5);

    const first = await processReminderEmailJob(deps, { day: DAY }, 2);
    expect(first.sent).toBe(2);
    expect(first.done).toBe(false);
    expect(first.after).toBeDefined();

    const second = await processReminderEmailJob(deps, { day: DAY, after: first.after }, 2);
    expect(second.sent).toBe(2);
    expect(second.done).toBe(false);

    const third = await processReminderEmailJob(deps, { day: DAY, after: second.after }, 2);
    expect(third.sent).toBe(1);
    expect(third.done).toBe(true);

    // Five people, five messages, nobody twice.
    expect(sent).toHaveLength(5);
    expect(new Set(sent).size).toBe(5);
  });

  it("skips nobody when the list grows between two passes", async () => {
    await seedExpiring(4);
    const first = await processReminderEmailJob(deps, { day: DAY }, 2);
    expect(first.sent).toBe(2);
    const afterFirst = [...sent];

    // A new document lands inside the window. Under an INDEX cursor this shifts the list and one of the
    // remaining people is stepped over; under a KEY cursor the rest are still "everything after this key".
    await deps.db.insert(schema.personalDocuments).values({
      uuid: genId(), code: `${genId()}-999`, employeeId: (await deps.db.select().from(schema.employees).limit(1))[0]!.uuid,
      documentType: "OTHER", title: "Late arrival", fileName: "d.pdf", r2Key: "k/late",
      contentType: "application/pdf", sizeBytes: 1,
      expireTime: new Date(+deps.clock.now() + 5 * 86_400_000),
    });

    let after = first.after;
    for (let pass = 0; pass < 10; pass++) {
      const res = await processReminderEmailJob(deps, { day: DAY, after }, 2);
      after = res.after;
      if (res.done) break;
    }

    // Everyone the first pass did not reach was still reached, and nobody was mailed twice.
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(afterFirst.every((m) => sent.filter((x) => x === m).length === 1)).toBe(true);
  });

  it("drops a backlog that outlived the day it was about", async () => {
    await seedExpiring(3);
    const res = await processReminderEmailJob(deps, { day: "2026-08-13" }, 2);
    expect(res).toMatchObject({ done: true, sent: 0 });
    expect(sent).toHaveLength(0);
  });
});
