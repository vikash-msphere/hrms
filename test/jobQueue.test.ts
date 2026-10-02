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
import { AI_CRON, FAST_CRON, KNOWN_CRONS, runJob, runScheduled } from "../src/cron";
import { genId } from "../src/lib/idCodec";

// The job queue's failure contract: a job that throws is retried on a widening delay and only becomes a
// dead letter at the attempt cap, and a nightly subtask that throws turns its cron_runs row red instead of
// disappearing into the logs. Both are the difference between "a payslip run failed" being noticed and not.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

// A payload that is READABLE but not runnable: valid JSON carrying none of the fields the work needs, so every
// kind throws on it identically and deterministically without the work behind it being reachable.
//
// Deliberately not "not-json". An unparseable payload is a PERMANENT failure and the queue treats it as one
// (src/cron.ts parses before the try), so it never reaches the retry ladder most of these tests are about -
// see the case that pins exactly that.
const FAILING_PAYLOAD = JSON.stringify({ deliberately: "unrunnable" });
const UNPARSEABLE_PAYLOAD = "not-json";

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.notifications, schema.jobs, schema.cronRuns, schema.employees, schema.searchVectors];
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
    uuid, code: genId().slice(0, 6), kind: "automation.action", payload: FAILING_PAYLOAD, status: "queued", ...over,
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
    expect(job.lastError).toBeTruthy();
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

  it("does not retry a payload it cannot read - that failure is permanent", async () => {
    // The retry ladder is for failures that can clear: a vendor blip, a contended write. A payload that is not
    // JSON will not become JSON on the fourth attempt, and walking the full ladder for it burned four drain
    // slots and held the dead letter back by over an hour for no possible gain.
    const id = await seedJob({ payload: UNPARSEABLE_PAYLOAD });

    await runJob(deps, id);

    const job = await jobRow(id);
    expect(job.status).toBe("error"); // terminal on the FIRST attempt, not the fifth
    expect(job.attempts).toBe(1);
    expect(job.runAfter).toBeNull();
    expect(job.lastError).toContain("JSON");
  });

  it("marks a run killed mid-tick as an error instead of leaving it running", async () => {
    // What a tick stopped at the CPU limit leaves behind: a `running` row nothing will ever finish.
    const stuck = genId();
    const live = genId();
    await deps.db.insert(schema.cronRuns).values([
      { uuid: stuck, code: genId().slice(0, 6), cron: "*/5 * * * *", status: "running", startedAt: new Date(Date.now() - 2 * 60 * 60_000) },
      { uuid: live, code: genId().slice(0, 6), cron: "0 2 * * *", status: "running", startedAt: new Date(Date.now() - 5 * 60_000) },
    ]);

    await runScheduled("*/5 * * * *", deps);

    const row = async (uuid: string) => (await deps.db.select().from(schema.cronRuns).where(eq(schema.cronRuns.uuid, uuid)))[0]!;
    expect((await row(stuck)).status).toBe("error");
    expect((await row(stuck)).error).toContain("CPU limit");
    // A run that may still be going is left alone.
    expect((await row(live)).status).toBe("running");
  });

  it("runs the AI drains on their own trigger, not the fast tick", async () => {
    const summaryOf = async (cron: string) => {
      const id = await runScheduled(cron, deps);
      expect(id, cron).not.toBeNull();
      const run = (await deps.db.select().from(schema.cronRuns).where(eq(schema.cronRuns.uuid, id!)))[0]!;
      expect(run.status).toBe("done");
      return Object.keys(JSON.parse(run.summaryJson!)).sort();
    };
    await seedJob(); // work for the fast tick, which records itself only when it has some
    expect(await summaryOf(FAST_CRON)).toEqual(["announcementsPublished", "cronRunsReclaimed", "drained"]);
  });

  it("records nothing for a five-minute tick with nothing to do", async () => {
    // Most ticks find nothing, and a recorded one writes its row, the row's index entries, a code and two change
    // stamps to say so. The AI tick finds out by running (no AI binding here, so both drains do nothing).
    expect(await runScheduled(FAST_CRON, deps)).toBeNull();
    expect(await runScheduled(AI_CRON, deps)).toBeNull();
    expect(await deps.db.select().from(schema.cronRuns)).toEqual([]);
  });

  // An instant on the embed drain's turn (cron.ts: `floor(now / 5min) % 2 === 0`).
  const embedTurn = () => new Date(600_000 * Math.floor(Date.now() / 600_000));

  it("records an AI tick that lost a subtask as one finished row, never a running one", async () => {
    // An orphaned vector the embed drain must remove, and an index that refuses the removal.
    await deps.db.insert(schema.searchVectors).values({
      collection: "employees", recordId: genId(), textHash: "x", model: "m", embeddedAt: new Date(), checkedAt: new Date(),
    });
    deps.clock = { now: embedTurn };
    deps.ai = {} as NonNullable<Deps["ai"]>;
    deps.vectors = { remove: async () => { throw new Error("index unavailable"); } } as unknown as NonNullable<Deps["vectors"]>;
    try {
      const id = await runScheduled(AI_CRON, deps);
      expect(id).not.toBeNull();
      const runs = await deps.db.select().from(schema.cronRuns);
      expect(runs.map((r) => r.uuid)).toEqual([id]);
      expect(runs[0]!.status).toBe("error");
      expect(runs[0]!.error).toContain("drainSearchEmbeddings");
      expect(runs[0]!.finishedAt).not.toBeNull();
      expect(Object.keys(JSON.parse(runs[0]!.summaryJson!)).sort()).toEqual(["embedded", "moderated"]);
    } finally {
      deps.ai = undefined;
      deps.vectors = undefined;
    }
  });

  it("records an AI tick that threw as an error row, and rethrows", async () => {
    // The tick reads the clock to start, then the AI dispatch reads it to pick a turn: fail that second read.
    let reads = 0;
    deps.clock = { now: () => { if (++reads === 2) throw new Error("clock broke"); return new Date(); } };
    await expect(runScheduled(AI_CRON, deps)).rejects.toThrow("clock broke");
    const runs = await deps.db.select().from(schema.cronRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error).toContain("clock broke");
  });

  it("dispatches exactly the triggers every wrangler config registers", () => {
    // A trigger registered but not dispatched runs nothing, silently; one dispatched but not registered never fires.
    const configs = import.meta.glob("../wrangler*.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [file, toml] of Object.entries(configs)) {
      const line = toml.split("\n").find((l) => l.startsWith("crons = "));
      expect(JSON.parse(line!.slice("crons = ".length)), file).toEqual([...KNOWN_CRONS]);
    }
  });

  it("leaves a backed-off job alone until its delay has passed", async () => {
    const id = await seedJob({ runAfter: new Date(Date.now() + 60 * 60_000) });

    await runScheduled("*/5 * * * *", deps); // nothing is due, so the tick finds nothing to do
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
  // matches nothing, so it declines instead of running work the winner already owns.
  it("declines a job the drain finds in any state but queued", async () => {
    for (const status of ["running", "done", "error"] as const) {
      const id = await seedJob({ status });
      // A due job beside it, so the tick has work and really drains: a tick with nothing to do never reads the queue.
      await seedJob();

      await runScheduled("*/5 * * * *", deps); // a whole drain, which selects only `queued` rows

      const job = await jobRow(id);
      // The seeded payload cannot run, so ANY claim would have spent an attempt and left an error behind.
      expect(job.attempts, status).toBe(0);
      expect(job.lastError, status).toBeNull();
      expect(job.status, status).toBe(status);
    }
  });

  // ...but a HUMAN pressing Retry is the exception the terminal state exists for. `runJob` therefore re-queues
  // the row (guarded on the state it read, so it still cannot race a drain) and then claims it. Handing an
  // `error` row straight to the claim matched nothing and the button did nothing at all - it returned the
  // unchanged row, so the page re-rendered the same failure as though it had just run and failed again.
  it("revives a dead letter when a human asks it to run", async () => {
    const id = await seedJob({ status: "error", attempts: 5, lastError: "the old failure" });

    await runJob(deps, id);

    const job = await jobRow(id);
    // It really ran: the payload failed it again, spending the attempt a human bought it. Back to terminal
    // rather than quietly earning itself another five automatic rounds.
    expect(job.attempts).toBe(6);
    expect(job.status).toBe("error");
    expect(job.lastError).not.toBe("the old failure");
  });

  it("revives an orphan a human asks for, but never one still in flight", async () => {
    const now = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => now };

    const orphaned = await seedJob({ status: "running" });
    const inFlight = await seedJob({ status: "running" });
    await deps.db.update(schema.jobs).set({ updatedAt: new Date(+now - 30 * 60_000) }).where(eq(schema.jobs.uuid, orphaned));
    await deps.db.update(schema.jobs).set({ updatedAt: new Date(+now - 60_000) }).where(eq(schema.jobs.uuid, inFlight));

    await runJob(deps, orphaned);
    await runJob(deps, inFlight);

    // Past the orphan cutoff its runner is gone, so this is the manual version of the reclaim. Before it, the
    // row is somebody's live work and re-queueing it would put two runners on one job.
    expect((await jobRow(orphaned)).attempts).toBe(1);
    expect((await jobRow(inFlight)).status).toBe("running");
    expect((await jobRow(inFlight)).attempts).toBe(0);
  });

  // The other half of the same cap: `processOneJob` decides "terminal" from a THROWN error, which a job whose
  // invocation was KILLED (the CPU ceiling) never produces. Without the cap here it was reclaimed forever.
  it("dead-letters an orphan that has no attempts left instead of reclaiming it again", async () => {
    const now = new Date("2026-08-14T02:00:00.000Z");
    deps.clock = { now: () => now };
    const id = await seedJob({ status: "running", attempts: 4 }); // one short of the cap
    await deps.db.update(schema.jobs).set({ updatedAt: new Date(+now - 30 * 60_000) }).where(eq(schema.jobs.uuid, id));

    await runScheduled("*/5 * * * *", deps);

    const job = await jobRow(id);
    expect(job.status).toBe("error"); // terminal, not back in the queue for another five-minute loop
    expect(job.attempts).toBe(5);
    expect(job.lastError).toContain("orphaned");
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
