/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { EMAIL_FANOUT_BATCH, EMAIL_FANOUT_JOB, fanOutEmail, processEmailFanOutJob, type EmailFanOutPayload } from "../src/services/emailFanOut";
import { runJob } from "../src/cron";

// One message to many people has to survive running out of invocation.
//
// Every send is an outbound fetch off the same per-invocation subrequest budget as the D1 calls around it, so
// a blast to a whole roster used to run the budget out part way down the list. Both callers (the announcement
// email and the workflow `emailAudience` action) had already marked their work done by then, so the people
// past the cut-off were never mailed and nothing anywhere said so.

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
  for (const t of [schema.jobs, schema.employees]) await deps.db.delete(t);
  sent = [];
  seq = 0;
  deps.email = { send: async (to) => { sent.push(to); } };
});

/** `n` active employees with distinct codes and addresses. The counter is per test (reset in beforeEach), so
 *  a second call inside one test adds people rather than colliding with the first call's. */
let seq = 0;
async function seedRoster(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = seq++;
    const uuid = genId();
    await deps.db.insert(schema.employees).values({
      uuid, code: `04-${String(k).padStart(3, "0")}`, firstName: "P", lastName: String(k),
      workEmail: `p${String(k).padStart(3, "0")}@test.example`, status: "active",
    });
    ids.push(uuid);
  }
  return ids;
}

const fanOutJobs = () => deps.db.select().from(schema.jobs).where(eq(schema.jobs.kind, EMAIL_FANOUT_JOB));

describe("email fan-out", () => {
  it("sends the whole audience inline when it fits in one batch, and queues nothing", async () => {
    const ids = await seedRoster(3);
    const n = await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });

    expect(n).toBe(3);
    expect(sent).toHaveLength(3);
    expect(await fanOutJobs()).toHaveLength(0);
  });

  it("stops at the batch and hands the remainder to the queue rather than dropping it", async () => {
    const ids = await seedRoster(EMAIL_FANOUT_BATCH + 5);
    const n = await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });

    // The inline half is exactly one batch - and it REPORTS one batch, not the whole audience: a partial
    // blast that claimed to be complete is the bug this replaces.
    expect(n).toBe(EMAIL_FANOUT_BATCH);
    expect(sent).toHaveLength(EMAIL_FANOUT_BATCH);

    const [job] = await fanOutJobs();
    expect(job).toBeDefined();
    const payload = JSON.parse(job!.payload) as EmailFanOutPayload;
    expect(payload.cursor).toBe(EMAIL_FANOUT_BATCH);
    expect(payload.recipients).toHaveLength(EMAIL_FANOUT_BATCH + 5);
  });

  it("drains to completion across passes, mailing every person exactly once", async () => {
    const ids = await seedRoster(EMAIL_FANOUT_BATCH * 2 + 3);
    await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });

    // Drive the queued continuation the way the drain does, until it stops asking to come back.
    const [job] = await fanOutJobs();
    for (let pass = 0; pass < 10; pass++) {
      const row = (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, job!.uuid)).limit(1))[0]!;
      if (row.status === "done") break;
      await runJob(deps, job!.uuid);
    }

    expect(sent).toHaveLength(ids.length);
    expect(new Set(sent).size).toBe(ids.length); // nobody twice
    const row = (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, job!.uuid)).limit(1))[0]!;
    expect(row.status).toBe("done");
  });

  it("carries the recipient list in the payload, so a roster change mid-blast cannot shift the cursor", async () => {
    const ids = await seedRoster(EMAIL_FANOUT_BATCH + 2);
    await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });
    const first = [...sent];

    // Somebody joins between the two passes. A cursor into a RE-DERIVED audience would now point one place
    // to the left and skip a person; an index into the frozen list is unmoved.
    await seedRoster(1);

    const [job] = await fanOutJobs();
    await runJob(deps, job!.uuid);

    const rest = sent.slice(first.length);
    expect(new Set(sent).size).toBe(ids.length); // the newcomer is not mailed, and nobody is mailed twice
    expect(rest.every((to) => !first.includes(to))).toBe(true);
  });

  it("moves past a recipient the vendor rejects instead of re-sending the batch to everyone before them", async () => {
    const ids = await seedRoster(3);
    deps.email = {
      send: async (to) => {
        if (to === "p001@test.example") throw new Error("bad address");
        sent.push(to);
      },
    };

    const n = await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });

    expect(n).toBe(3); // all three ATTEMPTED - the rejection advances the cursor like any other
    // Order is by employee id (the fan-out sorts, so the cursor means one thing across passes), not by seed
    // order - so this is a set comparison.
    expect(new Set(sent)).toEqual(new Set(["p000@test.example", "p002@test.example"]));
    expect(await fanOutJobs()).toHaveLength(0); // nothing left owing
  });

  it("hands the whole audience to the queue when the first batch itself fails", async () => {
    const ids = await seedRoster(3);
    // NOT a per-recipient rejection - those are swallowed inside the batch and the cursor moves past them.
    // This is the batch dying whole, which is what a failed address read looks like. The announcement caller
    // has already taken its `emailed_at` claim by this point, so losing it here would mean a post that says
    // it was mailed and never was.
    const realDb = deps.db;
    let broke = false;
    deps.db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "select" && !broke) {
          broke = true;
          return () => { throw new Error("address read failed"); };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof realDb;

    const n = await fanOutEmail(deps, { recipients: ids, subject: "Hi", html: "<p>Hi</p>", label: "test" });
    deps.db = realDb;

    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
    // The whole audience is owned by a job, from the start, rather than lost behind the caller's claim.
    const [job] = await fanOutJobs();
    expect(job).toBeDefined();
    const payload = JSON.parse(job!.payload) as EmailFanOutPayload;
    expect(payload.cursor).toBe(0);
    expect(payload.recipients).toHaveLength(3);
  });

  it("reports done for an audience it has already finished", async () => {
    const ids = await seedRoster(2);
    const payload: EmailFanOutPayload = { recipients: ids, subject: "Hi", html: "<p>Hi</p>", cursor: 2, label: "test" };
    const res = await processEmailFanOutJob(deps, payload);
    expect(res).toMatchObject({ done: true, sent: 0 });
    expect(sent).toHaveLength(0);
  });
});
