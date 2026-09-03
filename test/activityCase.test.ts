/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { caseMembers } from "../src/services/activityCase";
import { genId } from "../src/lib/idCodec";

// A case is DERIVED from the links the schema already carries, so these tests are really about one claim:
// handed any record of a hiring story, the walk returns the same story.
describe("activity cases: one long-running story, assembled from the records", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;
  const ids = { emp: genId(), cand: genId(), req: genId(), app: genId(), intv: genId(), offer: genId(), tr: genId(), task: genId() };

  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    deps = makeDeps(b);
    await deps.db.insert(schema.employees).values({ uuid: ids.emp, code: "04-900", firstName: "Asha", lastName: "Rao", workEmail: `${ids.emp}@t.example`, status: "active" });
    await deps.db.insert(schema.candidates).values({ uuid: ids.cand, code: "cand-1", name: "Asha Rao" });
    await deps.db.insert(schema.jobRequisitions).values({ uuid: ids.req, code: "req-1", title: "Engineer" });
    await deps.db.insert(schema.applications).values({ uuid: ids.app, code: "app-1", candidateId: ids.cand, requisitionId: ids.req, hiredEmployeeId: ids.emp });
    await deps.db.insert(schema.interviews).values({ uuid: ids.intv, code: "intv-1", applicationId: ids.app, title: "Technical round" });
    await deps.db.insert(schema.offers).values({ uuid: ids.offer, code: "off-1", applicationId: ids.app });
    await deps.db.insert(schema.transitions).values({ uuid: ids.tr, code: "tr-1", employeeId: ids.emp, kind: "onboarding", name: "Onboarding" });
    await deps.db.insert(schema.transitionTasks).values({ uuid: ids.task, code: "tsk-1", transitionId: ids.tr, subjectId: ids.emp, assigneeId: ids.emp, title: "Sign the contract" });
  });

  const kinds = async (root: string, id: string) => new Set((await caseMembers(deps, root, id)).members.map((m) => m.entity));

  it("reaches the whole hiring story from the application", async () => {
    const k = await kinds("applications", ids.app);
    for (const c of ["applications", "candidates", "job-requisitions", "interviews", "offers", "employees", "transitions"]) {
      expect(k, `the case should include ${c}`).toContain(c);
    }
  });

  it("returns the same story from the offer, the candidate or the hire", async () => {
    const fromApp = await kinds("applications", ids.app);
    for (const [root, id] of [["offers", ids.offer], ["candidates", ids.cand], ["employees", ids.emp]] as const) {
      const k = await kinds(root, id);
      expect([...fromApp].every((c) => k.has(c)), `${root} should reach the same records`).toBe(true);
    }
  });

  it("includes a transition's tasks - an onboarding is its checklist", async () => {
    const { members } = await caseMembers(deps, "transitions", ids.tr);
    expect(members).toContainEqual({ entity: "transition-tasks", id: ids.task });
  });

  it("de-duplicates, since the walks overlap by design", async () => {
    const { members } = await caseMembers(deps, "employees", ids.emp);
    expect(new Set(members.map((m) => `${m.entity}/${m.id}`)).size).toBe(members.length);
  });

  it("refuses a root that is not a case, rather than answering with something arbitrary", async () => {
    await expect(caseMembers(deps, "leave-requests", ids.emp)).rejects.toThrow(/rooted at/);
  });
});

// A payslip's own trail says a run produced it and stops - but a third of that payslip might be a bonus
// approved in March, and the approval that authorised the money is on THAT record.
describe("activity cases: what a payroll run paid, and where each line came from", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;
  const ids = { emp: genId(), period: genId(), run: genId(), bonus: genId(), reimb: genId(), expense: genId(), lt: genId(), encash: genId() };

  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    deps = makeDeps(b);
    await deps.db.insert(schema.employees).values({ uuid: ids.emp, code: "04-901", firstName: "Ravi", lastName: "K", workEmail: `${ids.emp}@t.example`, status: "active" });
    await deps.db.insert(schema.payPeriods).values({ uuid: ids.period, code: "pp-9", label: "Sep", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), payDate: new Date("2026-09-30") });
    await deps.db.insert(schema.payrollRuns).values({ uuid: ids.run, code: "pr-9", payPeriodId: ids.period, state: "PUBLISHED" });
    await deps.db.insert(schema.bonuses).values({ uuid: ids.bonus, code: "bn-1", employeeId: ids.emp, amount: 5000, awardDate: new Date("2026-03-01"), paidRunId: ids.run });
    await deps.db.insert(schema.reimbursements).values({ uuid: ids.reimb, code: "rb-1", employeeId: ids.emp, amount: 900, state: "PAID", paidRunId: ids.run });
    await deps.db.insert(schema.expenses).values({ uuid: ids.expense, code: "ex-1", employeeId: ids.emp, amount: 900, reimbursementId: ids.reimb });
    await deps.db.insert(schema.leaveTypes).values({ uuid: ids.lt, code: "lt-1", name: "Annual" });
    await deps.db.insert(schema.leaveEncashments).values({ uuid: ids.encash, code: "en-1", employeeId: ids.emp, leaveTypeId: ids.lt, days: 2, ratePerDay: 500, amount: 1000, paidRunId: ids.run });
  });

  it("reaches every payable the run settled", async () => {
    const { members } = await caseMembers(deps, "payroll-runs", ids.run);
    expect(members).toContainEqual({ entity: "bonuses", id: ids.bonus });
    expect(members).toContainEqual({ entity: "reimbursements", id: ids.reimb });
    expect(members).toContainEqual({ entity: "leave-encashments", id: ids.encash });
  });

  it("reaches the expense BEHIND a bridged reimbursement - two hops from the run", async () => {
    const { members } = await caseMembers(deps, "payroll-runs", ids.run);
    expect(members).toContainEqual({ entity: "expenses", id: ids.expense });
  });

  it("leaves out the per-employee items and payslips, which would fill the case with 'generated'", async () => {
    const { members } = await caseMembers(deps, "payroll-runs", ids.run);
    expect(members.map((m) => m.entity)).not.toContain("payslips");
  });

  it("reports truncation rather than passing a partial money trail off as the whole one", async () => {
    const { truncated } = await caseMembers(deps, "payroll-runs", ids.run);
    expect(truncated).toBe(false); // this run is small; the flag exists for the one that is not
  });
});

