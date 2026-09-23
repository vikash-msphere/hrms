/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// Which run this one is reconciled AGAINST. The arithmetic is held in test/payrollReconcile.test.ts; the rule
// being pinned here is the choice of comparison, and it is the half with somewhere to hide a bug: runs are
// built out of order in practice, an off-cycle correction run for March can be created in July, and a draft
// somebody is still rebuilding must never become the baseline another month is judged against.
//
// Rows are inserted directly rather than priced through `buildRunItems`. The selection rule reads `state` and
// the period's `pay_date` and nothing else, so pricing real payroll here would add minutes of fixture for no
// extra coverage of the thing under test.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { reconcileRun, runTimeline, type RunMilestone } from "../src/services/payroll";
import type { Line } from "../src/domain/payroll";

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
  for (const t of [schema.payrollRunItems, schema.payrollRuns, schema.payPeriods, schema.employees]) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function employee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: short("04"), firstName: "T", lastName: "U", workEmail: `${uuid}@t.example`, status: "active" });
  return uuid;
}

/** A pay period whose pay date is `payDay` of `month` in 2026. */
async function period(month: number, payDay = 28): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payPeriods).values({
    uuid, code: short("pp"), label: `2026-${month}`,
    periodStart: new Date(Date.UTC(2026, month - 1, 1)),
    periodEnd: new Date(Date.UTC(2026, month, 0)),
    payDate: new Date(Date.UTC(2026, month - 1, payDay)),
  });
  return uuid;
}

/** A run in a given state, paying each (employee, gross) as a single BASIC earning. */
async function run(periodId: string, state: "DRAFT" | "REVIEW" | "APPROVED" | "PUBLISHED", pay: [string, number][]): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payrollRuns).values({ uuid, code: short("pr"), payPeriodId: periodId, state, itemsBuiltAt: new Date() });
  for (const [employeeId, gross] of pay) {
    const lines: Line[] = [{ code: "BASIC", name: "Basic", kind: "earning", amount: gross }];
    await deps.db.insert(schema.payrollRunItems).values({
      uuid: genId(), code: short("ri"), runId: uuid, employeeId,
      linesJson: JSON.stringify(lines), gross, taxableGross: gross, totalDeductions: 0, tax: 0, net: gross,
    });
  }
  return uuid;
}

describe("reconcileRun picks the run to compare against", () => {
  it("compares with the previous period's finalized run", async () => {
    const [a, c] = [await employee(), await employee()];
    const jan = await period(1);
    const feb = await period(2);
    await run(jan, "PUBLISHED", [[a, 50_000], [c, 30_000]]);
    const current = await run(feb, "DRAFT", [[a, 55_000]]);

    const r = await reconcileRun(deps, current);
    expect(r.opening).toEqual({ employees: 2, gross: 80_000 });
    expect(r.closing).toEqual({ employees: 1, gross: 55_000 });
    expect(r.movements.find((m) => m.key === "recurring")!.amount).toBe(5_000);
    expect(r.movements.find((m) => m.key === "leavers")!.amount).toBe(-30_000);
    expect(r.residual).toBe(0);
    expect(r.headcountResidual).toBe(0);
  });

  it("ignores a run that is still being worked on", async () => {
    // A DRAFT or REVIEW run is somebody's working copy. Comparing against one would make this month's
    // statement change whenever a colleague rebuilds theirs, which is the opposite of a reconciliation.
    const a = await employee();
    const jan = await period(1);
    const feb = await period(2);
    const mar = await period(3);
    await run(jan, "PUBLISHED", [[a, 50_000]]);
    await run(feb, "REVIEW", [[a, 90_000]]); // in flight, and deliberately a very different number
    const current = await run(mar, "DRAFT", [[a, 50_000]]);

    const r = await reconcileRun(deps, current);
    expect(r.opening.gross).toBe(50_000); // January's, not February's
    for (const m of r.movements) expect(m.amount).toBe(0);
  });

  it("orders by pay date, not by when the run was created", async () => {
    // THE OUT-OF-ORDER CASE. An off-cycle run for an EARLIER period, created after everything else, must not
    // become "the previous run" for a period that already had one.
    const a = await employee();
    const jan = await period(1);
    const feb = await period(2);
    const mar = await period(3);
    await run(jan, "PUBLISHED", [[a, 10_000]]);
    const current = await run(mar, "DRAFT", [[a, 50_000]]);
    // Created last, but its pay date sits between January and March, so it IS the immediately prior run.
    await run(feb, "PUBLISHED", [[a, 40_000]]);

    const r = await reconcileRun(deps, current);
    expect(r.opening.gross).toBe(40_000); // February's, the nearest earlier pay date
    expect(r.movements.find((m) => m.key === "recurring")!.amount).toBe(10_000);
    expect(r.residual).toBe(0);
  });

  it("treats the first run an organisation builds as all joiners", async () => {
    const a = await employee();
    const jan = await period(1);
    const current = await run(jan, "DRAFT", [[a, 50_000]]);

    const r = await reconcileRun(deps, current);
    expect(r.compared_to).toBeNull();
    expect(r.opening).toEqual({ employees: 0, gross: 0 });
    expect(r.movements.find((m) => m.key === "joiners")!.amount).toBe(50_000);
    expect(r.residual).toBe(0);
    expect(r.headcountResidual).toBe(0);
  });

  it("names the run it compared against", async () => {
    const a = await employee();
    const jan = await period(1);
    const feb = await period(2);
    const prior = await run(jan, "APPROVED", [[a, 50_000]]);
    const current = await run(feb, "DRAFT", [[a, 50_000]]);

    const r = await reconcileRun(deps, current);
    expect(r.compared_to).toBe(`payroll-runs/${prior}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The run's timeline. Assembled from the audit trail rather than from the run row, because the run records who
// did each thing and not when - so what is pinned here is that the read finds those rows, and the two ordering
// rules that are easy to get backwards.
// ---------------------------------------------------------------------------------------------------------

async function auditRow(runId: string, action: string, at: Date, actorName: string) {
  await deps.db.insert(schema.auditLog).values({
    uuid: genId(), code: short("au"), actorEmail: "t@t.example", actorName,
    action, entity: "payroll-runs", entityId: runId, at,
  });
}

describe("runTimeline", () => {
  beforeEach(async () => { await deps.db.delete(schema.auditLog); });

  const at = (key: string, ms: readonly RunMilestone[]) => ms.find((m) => m.key === key)!;

  it("reads each step off the audit trail, with who did it", async () => {
    const periodId = await period(6);
    const runId = await run(periodId, "PUBLISHED", []);
    await auditRow(runId, "payroll.create", new Date(Date.UTC(2026, 5, 1)), "Asha");
    await auditRow(runId, "payroll.review", new Date(Date.UTC(2026, 5, 20)), "Asha");
    await auditRow(runId, "payroll.approved", new Date(Date.UTC(2026, 5, 24)), "Ravi");
    await auditRow(runId, "payroll.published", new Date(Date.UTC(2026, 5, 27)), "Ravi");

    const row = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)))[0]!;
    const ms = await runTimeline(deps, row);

    expect(ms.map((m) => m.key)).toEqual(["created", "built", "submitted", "approved", "bank_file", "published", "pay_date"]);
    expect(at("submitted", ms).actor).toBe("Asha");
    expect(at("approved", ms).actor).toBe("Ravi");
    expect(at("approved", ms).at_time).toBe(new Date(Date.UTC(2026, 5, 24)).toISOString());
    // The planned entry, off the period rather than off anything that happened.
    expect(at("pay_date", ms).at_time).toBe(new Date(Date.UTC(2026, 5, 28)).toISOString());
  });

  it("reports the EARLIEST timestamp for a step that happened twice", async () => {
    // A run sent back and re-approved has two approval rows. The question the timeline answers is when the
    // month reached that step, so the later one would make a returned run look freshly approved.
    const periodId = await period(6);
    const runId = await run(periodId, "APPROVED", []);
    await auditRow(runId, "payroll.approved", new Date(Date.UTC(2026, 5, 24)), "Ravi");
    await auditRow(runId, "payroll.approved", new Date(Date.UTC(2026, 5, 26)), "Ravi");

    const row = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)))[0]!;
    expect(at("approved", await runTimeline(deps, row)).at_time).toBe(new Date(Date.UTC(2026, 5, 24)).toISOString());
  });

  it("leaves a step that has not happened empty", async () => {
    const periodId = await period(6);
    const runId = await run(periodId, "DRAFT", []);
    await auditRow(runId, "payroll.create", new Date(Date.UTC(2026, 5, 1)), "Asha");

    const row = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)))[0]!;
    const ms = await runTimeline(deps, row);
    expect(at("created", ms).at_time).not.toBeNull();
    for (const key of ["submitted", "approved", "bank_file", "published"]) {
      expect(at(key, ms).at_time).toBeNull();
    }
  });

  it("does not read another run's trail", async () => {
    const periodId = await period(6);
    const mine = await run(periodId, "DRAFT", []);
    const theirs = await run(await period(7), "PUBLISHED", []);
    await auditRow(theirs, "payroll.published", new Date(Date.UTC(2026, 6, 27)), "Ravi");

    const row = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, mine)))[0]!;
    expect(at("published", await runTimeline(deps, row)).at_time).toBeNull();
  });
});
