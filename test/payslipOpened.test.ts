/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// Whether a payslip reached the person it belongs to.
//
// The behaviour under test is as much about what is NOT recorded as what is. `domain/auditAccess.ts` refuses
// to write an audit row when somebody reads their own sensitive data, on the grounds that reading your own pay
// is expected rather than an abuse signal - so the stamp here has to answer "was it delivered" without
// becoming the reading history that principle exists to prevent. That is why it is written once, only by the
// owner, and never moved afterwards, and why each of those three properties has a test.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { downloadPayslip, previewPayslip, unopenedPayslipCount } from "../src/services/payslips";

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
  for (const t of [schema.payslips, schema.payrollRunItems, schema.payrollRuns, schema.payPeriods, schema.employees]) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const actorFor = (employeeId: string | null): AppUser =>
  ({ uuid: genId(), email: "t@t.example", role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser);

async function employee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: short("04"), firstName: "T", lastName: "U", workEmail: `${uuid}@t.example`, status: "active" });
  return uuid;
}

/** A published run with one payslip per employee, bytes in the doc store so the read can succeed. */
async function runWithSlips(employeeIds: string[]): Promise<{ runId: string; slips: string[] }> {
  const periodId = genId();
  await deps.db.insert(schema.payPeriods).values({
    uuid: periodId, code: short("pp"), label: "2026-06",
    periodStart: new Date(Date.UTC(2026, 5, 1)), periodEnd: new Date(Date.UTC(2026, 5, 30)), payDate: new Date(Date.UTC(2026, 5, 28)),
  });
  const runId = genId();
  await deps.db.insert(schema.payrollRuns).values({ uuid: runId, code: short("pr"), payPeriodId: periodId, state: "PUBLISHED" });
  const slips: string[] = [];
  for (const employeeId of employeeIds) {
    const itemId = genId();
    await deps.db.insert(schema.payrollRunItems).values({
      uuid: itemId, code: short("ri"), runId, employeeId,
      linesJson: "[]", gross: 1000, taxableGross: 1000, totalDeductions: 0, tax: 0, net: 1000,
    });
    const uuid = genId();
    const r2Key = `payslips/${uuid}.pdf`;
    await deps.docs.put(r2Key, new Uint8Array([1, 2, 3]), "application/pdf");
    await deps.db.insert(schema.payslips).values({ uuid, code: short("ps"), runId, runItemId: itemId, employeeId, r2Key, net: 1000 });
    slips.push(uuid);
  }
  return { runId, slips };
}

const stampOf = async (id: string) => (await deps.db.select().from(schema.payslips).where(eq(schema.payslips.uuid, id)))[0]!.firstOpenedAt;

describe("payslip delivery", () => {
  it("stamps the first time the employee opens their own slip", async () => {
    const emp = await employee();
    const { slips } = await runWithSlips([emp]);
    expect(await stampOf(slips[0]!)).toBeNull();

    await downloadPayslip(deps, actorFor(emp), slips[0]!);
    expect(await stampOf(slips[0]!)).not.toBeNull();
  });

  it("counts an in-app view as having seen it", async () => {
    // Most people never download; they look at it in the app. A delivery check that only counted downloads
    // would report that almost nobody received their payslip.
    const emp = await employee();
    const { slips } = await runWithSlips([emp]);
    await previewPayslip(deps, actorFor(emp), slips[0]!);
    expect(await stampOf(slips[0]!)).not.toBeNull();
  });

  it("never moves the stamp once it is set", async () => {
    // THE PRIVACY PROPERTY. One timestamp that only ever records the FIRST view cannot answer "when were they
    // last looking at their pay", which is the question this must not be able to answer.
    const emp = await employee();
    const { slips } = await runWithSlips([emp]);
    await downloadPayslip(deps, actorFor(emp), slips[0]!);
    const first = await stampOf(slips[0]!);

    await previewPayslip(deps, actorFor(emp), slips[0]!);
    await downloadPayslip(deps, actorFor(emp), slips[0]!);
    expect(+(await stampOf(slips[0]!))!).toBe(+first!);
  });

  it("is not marked opened when somebody else reads it", async () => {
    // HR or a manager reading an employee's slip is that reader's accountability event, and the audit trail
    // already records it. It says nothing about whether the employee received their payslip.
    const emp = await employee();
    const hr = await employee();
    const { slips } = await runWithSlips([emp]);
    await downloadPayslip(deps, actorFor(hr), slips[0]!);
    await previewPayslip(deps, actorFor(null), slips[0]!); // an actor with no employee record at all
    expect(await stampOf(slips[0]!)).toBeNull();
  });

  it("counts what the run still has undelivered", async () => {
    const [a, c, d] = [await employee(), await employee(), await employee()];
    const { runId, slips } = await runWithSlips([a, c, d]);
    expect(await unopenedPayslipCount(deps, runId)).toBe(3);

    await downloadPayslip(deps, actorFor(a), slips[0]!);
    expect(await unopenedPayslipCount(deps, runId)).toBe(2);

    await previewPayslip(deps, actorFor(c), slips[1]!);
    expect(await unopenedPayslipCount(deps, runId)).toBe(1);
  });
});
