/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// What a payroll budget counts as spent.
//
// Every assertion here is about a boundary where counting the obvious thing would be wrong:
//   - a DRAFT run is somebody mid-rebuild, so it must not move a budget while they work;
//   - a run belongs to the period its PAY DATE falls in, not the month it is built in;
//   - attribution is the department STAMPED on the run item, never the employee's department today, or a
//     transfer would silently rewrite what a closed period consumed;
//   - an org-wide cap (null department) counts everybody, including people with no department at all.
//
// The last is the one a reasonable implementation gets wrong: a join through `employees` to find the
// department reads perfectly well and is wrong only for people who have moved - which is exactly the case
// nobody has a fixture for in production.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { computePayrollSpendMany, openRecurringPayrollBudgets, payrollBudgetPhase } from "../src/services/payrollBudgets";
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
  for (const t of [schema.payrollBudgets, schema.payrollRunItems, schema.payrollRuns, schema.payPeriods, schema.employees, schema.departments]) {
    await deps.db.delete(t);
  }
  // The pay-period read is memoized per Deps (lib/refData), so a fresh one per test stops a period inserted
  // here from being invisible behind the previous test's cached list.
  deps = makeDeps(b);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function department(name: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.departments).values({ uuid, code: short("dp"), name });
  return uuid;
}

async function employee(departmentId?: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: short("04"), firstName: "T", lastName: "U", workEmail: `${uuid}@t.example`, status: "active", departmentId,
  });
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

/** A run paying each [employee, gross, stampedDepartment] as a single BASIC earning. */
async function run(
  periodId: string,
  state: "DRAFT" | "REVIEW" | "APPROVED" | "PUBLISHED",
  pay: [string, number, string | null][],
): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.payrollRuns).values({ uuid, code: short("pr"), payPeriodId: periodId, state, itemsBuiltAt: new Date() });
  for (const [employeeId, gross, departmentId] of pay) {
    const lines: Line[] = [{ code: "BASIC", name: "Basic", kind: "earning", amount: gross }];
    await deps.db.insert(schema.payrollRunItems).values({
      uuid: genId(), code: short("ri"), runId: uuid, employeeId, departmentId,
      linesJson: JSON.stringify(lines), gross, taxableGross: gross, totalDeductions: 0, tax: 0, net: gross,
    });
  }
  return uuid;
}

async function budget(periodKey: string, amount: number, departmentId: string | null, periodType: "monthly" | "quarterly" | "yearly" = "monthly") {
  return (await deps.db
    .insert(schema.payrollBudgets)
    .values({ uuid: genId(), code: short("pb"), departmentId, periodType, periodKey, amount })
    .returning())[0]!;
}

const spendOf = async (...caps: Awaited<ReturnType<typeof budget>>[]) => {
  const m = await computePayrollSpendMany(deps, caps);
  return caps.map((c) => m.get(c.uuid) ?? 0);
};

describe("computePayrollSpendMany", () => {
  it("counts the committed run, and ignores drafts and reviews", async () => {
    // A draft's figures change on every rebuild. Counting one would make a department's budget move while a
    // colleague works, which is worse than showing nothing.
    //
    // ONE committed run, because a period can only ever have one - see the case below. An earlier version of
    // this test put an APPROVED and a PUBLISHED run in the same January and expected their sum, which is a
    // state the schema forbids and a figure that would have been the double-payment the index exists to
    // prevent. Had the implementation produced it, this test would have called the defect a pass.
    const e = await employee();
    const jan = await period(1);
    await run(jan, "DRAFT", [[e, 10_000, null]]);
    await run(jan, "REVIEW", [[e, 20_000, null]]);
    await run(jan, "PUBLISHED", [[e, 30_000, null]]);

    const cap = await budget("2026-01", 100_000, null);
    expect(await spendOf(cap)).toEqual([30_000]);
  });

  it("cannot be made to double-count, because a period admits only one committed run", async () => {
    // The invariant the case above rests on, asserted rather than assumed. `run_period_committed_idx` is a
    // partial unique index over `pay_period_id` where state is APPROVED or PUBLISHED: base salary and
    // recurring earnings carry no per-period paid marker, so a second committed run for one period would pay
    // the monthly salary twice. Spend is a plain sum over committed items, and it is safe ONLY because this
    // holds - so if the index is ever relaxed, this fails and the sum has to be reconsidered with it.
    const e = await employee();
    const jan = await period(1);
    await run(jan, "APPROVED", [[e, 40_000, null]]);
    await expect(run(jan, "PUBLISHED", [[e, 30_000, null]])).rejects.toThrow();

    const cap = await budget("2026-01", 100_000, null);
    expect(await spendOf(cap)).toEqual([40_000]);
  });

  it("counts a committed run in each period separately", async () => {
    // The legitimate version of two committed runs: different periods, and a yearly cap sees both.
    const e = await employee();
    await run(await period(1), "APPROVED", [[e, 40_000, null]]);
    await run(await period(2), "PUBLISHED", [[e, 30_000, null]]);

    const [year] = await spendOf(await budget("2026", 500_000, null, "yearly"));
    expect(year).toBe(70_000);
  });

  it("charges a run to the period its PAY DATE falls in", async () => {
    // A January period paid on 3 February is February's money. Charging it by period start would put it in a
    // month the cash never left.
    const e = await employee();
    const janPaidInFeb = await period(1, 34); // 2026-01-34 normalises to 3 Feb
    await run(janPaidInFeb, "PUBLISHED", [[e, 50_000, null]]);

    const [jan, feb] = await spendOf(await budget("2026-01", 100_000, null), await budget("2026-02", 100_000, null));
    expect(jan).toBe(0);
    expect(feb).toBe(50_000);
  });

  it("attributes to the department STAMPED on the run item, not the employee's department today", async () => {
    // The whole reason the stamp exists. The employee now sits in Sales; February's run recorded Engineering,
    // and February's budget must still say Engineering.
    const eng = await department("Engineering");
    const sales = await department("Sales");
    const mover = await employee(sales); // transferred since
    const feb = await period(2);
    await run(feb, "PUBLISHED", [[mover, 60_000, eng]]);

    const [engSpend, salesSpend] = await spendOf(await budget("2026-02", 100_000, eng), await budget("2026-02", 100_000, sales));
    expect(engSpend).toBe(60_000);
    expect(salesSpend).toBe(0);
  });

  it("counts everybody against an org-wide cap, including people with no department", async () => {
    // Dropping the unassigned would make the parts stop summing to the whole, which is the one thing a
    // breakdown must not do.
    const eng = await department("Engineering");
    const [a, c] = [await employee(eng), await employee()];
    const mar = await period(3);
    await run(mar, "PUBLISHED", [[a, 40_000, eng], [c, 25_000, null]]);

    const [org, engOnly] = await spendOf(await budget("2026-03", 200_000, null), await budget("2026-03", 100_000, eng));
    expect(org).toBe(65_000);
    expect(engOnly).toBe(40_000);
  });

  it("sums every month a quarterly cap covers, and nothing outside it", async () => {
    const e = await employee();
    for (const m of [1, 2, 3, 4]) await run(await period(m), "PUBLISHED", [[e, 10_000, null]]);

    const [q1] = await spendOf(await budget("2026-Q1", 100_000, null, "quarterly"));
    expect(q1).toBe(30_000); // April is Q2
  });

  it("answers one read for many caps without letting them bleed into each other", async () => {
    // The many-cap path widens one query to span every period on the page, so the risk it carries is a cap
    // picking up a month that belongs to its neighbour.
    const e = await employee();
    await run(await period(1), "PUBLISHED", [[e, 11_000, null]]);
    await run(await period(2), "PUBLISHED", [[e, 22_000, null]]);
    await run(await period(3), "PUBLISHED", [[e, 33_000, null]]);

    const caps = [await budget("2026-01", 100_000, null), await budget("2026-02", 100_000, null), await budget("2026-03", 100_000, null)];
    expect(await spendOf(...caps)).toEqual([11_000, 22_000, 33_000]);
  });

  it("charges nothing for a malformed period key rather than poisoning the span", async () => {
    // One bad row must not silently widen the window every other cap on the page is summed over.
    const e = await employee();
    await run(await period(1), "PUBLISHED", [[e, 10_000, null]]);

    const [bad, good] = await spendOf(await budget("not-a-key", 100_000, null), await budget("2026-01", 100_000, null));
    expect(bad).toBe(0);
    expect(good).toBe(10_000);
  });

  it("answers an empty list without reading anything", async () => {
    expect((await computePayrollSpendMany(deps, [])).size).toBe(0);
  });
});

describe("payrollBudgetPhase", () => {
  const at = Date.UTC(2026, 5, 15); // mid-June 2026
  it("places a period relative to now, per its own type", () => {
    expect(payrollBudgetPhase({ periodType: "monthly", periodKey: "2026-06" }, at)).toBe("current");
    expect(payrollBudgetPhase({ periodType: "monthly", periodKey: "2026-05" }, at)).toBe("past");
    expect(payrollBudgetPhase({ periodType: "monthly", periodKey: "2026-07" }, at)).toBe("upcoming");
    expect(payrollBudgetPhase({ periodType: "quarterly", periodKey: "2026-Q2" }, at)).toBe("current");
    expect(payrollBudgetPhase({ periodType: "yearly", periodKey: "2026" }, at)).toBe("current");
  });

  it("never hides an unparseable key behind a phase filter", () => {
    // A data problem to fix, not a row to disappear.
    expect(payrollBudgetPhase({ periodType: "monthly", periodKey: "garbage" }, at)).toBe("current");
  });
});

describe("openRecurringPayrollBudgets", () => {
  const afterJan = new Date(Date.UTC(2026, 1, 5));

  it("opens the next period at the same cap, once", async () => {
    await budget("2026-01", 500_000, null);
    await deps.db.update(schema.payrollBudgets).set({ recurring: true });

    expect(await openRecurringPayrollBudgets(deps, afterJan)).toBe(1);
    const rows = await deps.db.select().from(schema.payrollBudgets);
    expect(rows.map((r) => r.periodKey).sort()).toEqual(["2026-01", "2026-02"]);
    expect(rows.find((r) => r.periodKey === "2026-02")!.amount).toBe(500_000);
    // The successor is itself recurring, so the chain continues at ITS rollover rather than this tick opening
    // the rest of the decade.
    expect(rows.find((r) => r.periodKey === "2026-02")!.recurring).toBe(true);
    expect(await openRecurringPayrollBudgets(deps, afterJan)).toBe(0);
  });

  it("carries the cap, never the unspent remainder", async () => {
    // A rolling remainder quietly turns a monthly cap into an annual one.
    const e = await employee();
    await run(await period(1), "PUBLISHED", [[e, 100_000, null]]);
    await budget("2026-01", 500_000, null);
    await deps.db.update(schema.payrollBudgets).set({ recurring: true });

    await openRecurringPayrollBudgets(deps, afterJan);
    const next = (await deps.db.select().from(schema.payrollBudgets)).find((r) => r.periodKey === "2026-02")!;
    expect(next.amount).toBe(500_000);
  });

  it("does not resurrect a period somebody deleted", async () => {
    // Deleting the next period is how a human says "not this one", and a cron that reopens it is a cron
    // nobody can overrule.
    await budget("2026-01", 500_000, null);
    const feb = await budget("2026-02", 500_000, null);
    await deps.db.update(schema.payrollBudgets).set({ recurring: true });
    await deps.db.update(schema.payrollBudgets).set({ deleteTime: new Date() }).where(eq(schema.payrollBudgets.uuid, feb.uuid));

    expect(await openRecurringPayrollBudgets(deps, afterJan)).toBe(0);
    // Still exactly the two rows, and February still deleted - no duplicate opened beside it.
    const rows = await deps.db.select().from(schema.payrollBudgets);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.periodKey === "2026-02")!.deleteTime).not.toBeNull();
  });

  it("leaves a still-live period alone", async () => {
    await budget("2026-02", 500_000, null);
    await deps.db.update(schema.payrollBudgets).set({ recurring: true });
    expect(await openRecurringPayrollBudgets(deps, afterJan)).toBe(0);
  });

  it("ignores a cap that is not recurring", async () => {
    await budget("2026-01", 500_000, null);
    expect(await openRecurringPayrollBudgets(deps, afterJan)).toBe(0);
  });
});
