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
import { runJob, runScheduled } from "../src/cron";
import { genId } from "../src/lib/idCodec";

// The job queue's failure contract: a job that throws is retried on a widening delay and only becomes a
// dead letter at the attempt cap, and a nightly subtask that throws turns its cron_runs row red instead of
// disappearing into the logs. Both are the difference between "a payslip run failed" being noticed and not.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

// A payload that is not JSON: every job kind parses its payload first, so this fails every kind identically
// and deterministically, without needing the work behind it to be reachable.
const BAD_PAYLOAD = "not-json";

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.notifications, schema.jobs, schema.cronRuns, schema.employees];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.clock = { now: () => new Date() };
});

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active",
  });
  return uuid;
}

async function seedJob(over: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.jobs).values({
    uuid, code: genId().slice(0, 6), kind: "automation.action", payload: BAD_PAYLOAD, status: "queued", ...over,
  });
  return uuid;
}

const jobRow = (id: string) => deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, id)).limit(1).then((r) => r[0]!);

describe("job queue: a failure retries before it becomes a dead letter", () => {
  it("puts a failed job back in the queue behind a delay", async () => {
    const at = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => at };
    const id = await seedJob();

    await runJob(deps, id);

    const job = await jobRow(id);
    expect(job.status).toBe("queued"); // retryable, not parked
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("JSON");
    // First retry waits a minute; the drain honours run_after, so this is what defers it.
    expect(+new Date(job.runAfter!)).toBe(+at + 60_000);
  });

  it("widens the delay with each attempt", async () => {
    const at = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => at };
    for (const [attemptsSoFar, expectedDelayMs] of [[0, 60_000], [1, 5 * 60_000], [2, 15 * 60_000], [3, 60 * 60_000]] as const) {
      const id = await seedJob({ attempts: attemptsSoFar });
      await runJob(deps, id);
      const job = await jobRow(id);
      expect(job.status).toBe("queued");
      expect(+new Date(job.runAfter!)).toBe(+at + expectedDelayMs);
    }
  });

  it("gives up at the attempt cap and stays error, so the row is a dead letter", async () => {
    const id = await seedJob({ attempts: 4 }); // one short of the cap

    await runJob(deps, id);

    const job = await jobRow(id);
    expect(job.status).toBe("error"); // terminal: the Operations page lists it with a Retry button
    expect(job.attempts).toBe(5);
    expect(job.runAfter).toBeNull(); // no further automatic pickup
  });

  it("leaves a backed-off job alone until its delay has passed", async () => {
    const id = await seedJob({ runAfter: new Date(Date.now() + 60 * 60_000) });

    await runScheduled("*/5 * * * *", deps); // drains the queue
    expect((await jobRow(id)).attempts).toBe(0); // not touched

    await deps.db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(schema.jobs.uuid, id));
    await runScheduled("*/5 * * * *", deps);
    expect((await jobRow(id)).attempts).toBe(1); // due now, so it ran and failed once
  });
});

describe("job queue: who hears about a dead letter", () => {
  const notificationsFor = (employeeId: string) =>
    deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, employeeId));

  it("tells the owner when a job they are waiting on gives up for good", async () => {
    const employeeId = await seedEmployee();
    const id = await seedJob({ kind: "payslip.generateRun", employeeId, attempts: 4 });

    await runJob(deps, id);

    const notes = await notificationsFor(employeeId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("system.jobFailed");
    expect(notes[0]!.subject).toBe(`operations/${id}`);
    expect(notes[0]!.priority).toBe("high");
  });

  it("says nothing while retries remain", async () => {
    const employeeId = await seedEmployee();
    const id = await seedJob({ kind: "payslip.generateRun", employeeId });

    await runJob(deps, id);

    expect(await notificationsFor(employeeId)).toHaveLength(0);
  });

  it("does not tell the employee an engine-internal job happened to be about", async () => {
    const employeeId = await seedEmployee();
    // `employeeId` on an automation job is the subject of the rule, not someone who can fix a broken rule.
    const id = await seedJob({ kind: "automation.action", employeeId, attempts: 4 });

    await runJob(deps, id);

    expect((await jobRow(id)).status).toBe("error");
    expect(await notificationsFor(employeeId)).toHaveLength(0);
  });
});

describe("job queue: at most one runner per job", () => {
  // The queue is drained by more than one thing: `cron-runs:run` fires a tick on demand (routes/cronTrigger.ts)
  // with no lock against the five-minute schedule. Two drains therefore select the same `queued` rows before
  // either writes, and a bare `set({status:"running"})` let both proceed - running the same automation actions
  // (duplicate email and notifications) or the same payslip batch twice. The claim is guarded on `queued`, so
  // exactly one drain owns the job.

  // Only a `queued` row is claimable, and that predicate is the whole mechanism: the losing drain's UPDATE
  // matches nothing, so it declines instead of running work the winner already owns. `runJob` re-reads the row
  // and hands it to the same claim, so it exercises exactly the write the drain performs.
  it("declines a job that is no longer queued, whatever state it moved to", async () => {
    for (const status of ["running", "done", "error"] as const) {
      const id = await seedJob({ status });

      await runJob(deps, id);

      const job = await jobRow(id);
      // The seeded payload is unparseable, so ANY claim would have spent an attempt and left an error behind.
      expect(job.attempts, status).toBe(0);
      expect(job.lastError, status).toBeNull();
      expect(job.status, status).toBe(status);
    }
  });

  it("spends exactly one attempt when the drain reaches the same job twice", async () => {
    const id = await seedJob({ attempts: 3 }); // one failure short of the dead-letter cap

    await runJob(deps, id); // claims, runs, fails, requeues behind a backoff
    expect((await jobRow(id)).attempts).toBe(4);

    // The losing drain arrives while the winner still holds it.
    await deps.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.uuid, id));
    await runJob(deps, id);

    // Still four. Unguarded, the second pass reached five and the job became a dead letter in one drain.
    expect((await jobRow(id)).attempts).toBe(4);
  });

  it("stamps updated_at on the claim, so an in-flight job does not read as orphaned", async () => {
    // The stale-reclaim cutoff (STALE_RUNNING_MS) compares `updated_at` against now. The column had no
    // $onUpdate and no job write set it, so it held the row's CREATION time forever and every `running` job
    // older than the cutoff looked abandoned - which is what let one tick yank another tick's work back into
    // the queue while it was still executing.
    const created = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => created };
    const id = await seedJob();
    await deps.db.update(schema.jobs).set({ createdAt: created, updatedAt: created }).where(eq(schema.jobs.uuid, id));

    const later = new Date(+created + 60 * 60_000); // an hour on, well past the 10-minute cutoff
    deps.clock = { now: () => later };
    await runJob(deps, id);

    expect(+new Date((await jobRow(id)).updatedAt)).toBeGreaterThan(+created);
  });

  it("reclaims a job left running past the cutoff, and leaves a fresh one alone", async () => {
    const now = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => now };

    const orphaned = await seedJob({ status: "running" });
    const inFlight = await seedJob({ status: "running" });
    await deps.db.update(schema.jobs).set({ updatedAt: new Date(+now - 30 * 60_000) }).where(eq(schema.jobs.uuid, orphaned));
    await deps.db.update(schema.jobs).set({ updatedAt: new Date(+now - 60_000) }).where(eq(schema.jobs.uuid, inFlight));

    await runScheduled("*/5 * * * *", deps);

    // The orphan was reclaimed and then retried in the same drain (its payload fails), so it is queued again
    // with an attempt spent. The minute-old one was never touched.
    expect((await jobRow(orphaned)).attempts).toBeGreaterThan(0);
    expect((await jobRow(inFlight)).status).toBe("running");
    expect((await jobRow(inFlight)).attempts).toBe(0);
  });
});

describe("nightly tick: a lost subtask is visible", () => {
  // Drops a table the tick reads, which is the only way to make a real subtask throw from the outside. Runs
  // last in the file: the table stays dropped for whatever follows in this worker's storage.
  it("turns the run red naming what failed, and still runs the rest", async () => {
    await b.DB.prepare("DROP TABLE compliance_rules").run();

    await runScheduled("0 2 * * *", deps);

    const run = (await deps.db.select().from(schema.cronRuns).where(eq(schema.cronRuns.cron, "0 2 * * *")).limit(1))[0]!;
    expect(run.status).toBe("error"); // NOT "done" with a silent zero
    expect(run.error).toContain("generateComplianceOccurrences");
    // The tick carried on: a subtask that runs after the failed one still reported a count.
    expect(JSON.parse(run.summaryJson!)).toHaveProperty("accessRulesExpired");
  });
});
