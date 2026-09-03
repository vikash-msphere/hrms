// Assembles the LetterContext for an HR letter from DB + settings, with NO per-generation input - everything
// is pulled from the employee record, current/previous compensation, recurring pay components, and the org
// settings (incl. the "letter_defaults" block). The pure letter wording lives in src/domain/letters.ts.
import { and, eq, desc, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound } from "../lib/errors";
import { getSettingValue } from "./settings";
import { applyStructure, ctcLines, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import type { LetterContext, LetterDefaults } from "../domain/letters";

type OrgSettings = { name?: string; legal_name?: string; logo?: string; address?: string; letter_defaults?: LetterDefaults };

import { round2 } from "../domain/money";
import { refDepartments, refPayComponents } from "../lib/refData";

export async function assembleLetterContext(deps: Deps, employeeId: string): Promise<LetterContext> {
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

  const org = await getSettingValue<OrgSettings>(deps, "organization", {});

  // Department + manager names (lookups; degrade to undefined when absent).
  let department: string | undefined;
  if (emp.departmentId) {
    const d = (await deps.db.select().from(schema.departments).where(eq(schema.departments.uuid, emp.departmentId)).limit(1))[0];
    department = d?.name;
  }
  let managerName: string | undefined;
  if (emp.managerId) {
    const m = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp.managerId)).limit(1))[0];
    if (m) managerName = `${m.firstName} ${m.lastName}`;
  }

  // Compensation: current row for CTC; the two newest rows for the increment (old -> new).
  const comps = await deps.db
    .select()
    .from(schema.compensation)
    .where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.deleteTime)))
    .orderBy(desc(schema.compensation.effectiveFrom));
  const current = comps.find((c) => c.effectiveTo === null) ?? comps[0];
  const components = await refPayComponents(deps);

  const epfEnrolled = !!emp.epfEnrolled;
  // PF wages follow the org's configured basis (settings/ctc), so the annexure states the same employer PF the
  // payroll run will actually cost.
  const pfBasis = (await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG)).pf_wage_basis ?? "basic";
  // Each comp row may carry its own salary structure; the CTC breakdown uses that row's effective earnings.
  const effFor = async (row: typeof current) => applyStructure(components, await structureLinesById(deps, row?.structureId));
  // The headline CTC is the stored authoritative figure (the promise the employee agreed to), not the sum of
  // the annexure lines: splitCtc converges to within a rupee, so the reconstructed sum can drift a few rupees
  // from the promise. The line breakdown still comes from ctcLines. Fall back to the reconstructed sum only for
  // a row with no stored ctcAnnual.
  const annualOf = (row: { ctcAnnual: number }, ctcMonthly: number) => (row.ctcAnnual > 0 ? round2(row.ctcAnnual) : round2(ctcMonthly * 12));
  let comp: LetterContext["comp"];
  if (current) {
    const { lines, ctcMonthly } = ctcLines(current.basePay, await effFor(current), epfEnrolled, current.specialAllowance, pfBasis);
    comp = { lines, ctcMonthly, ctcAnnual: annualOf(current, ctcMonthly) };
  }

  // Increment: full annual CTC at the two newest comp levels (stored authoritative figures), so the letter
  // states the CTCs the employee was promised rather than bare base pay or a reconstructed sum.
  let increment: LetterContext["increment"];
  if (comps.length >= 2 && comps[0] && comps[1]) {
    const [next, prev] = comps;
    increment = {
      oldAnnual: annualOf(prev, ctcLines(prev.basePay, await effFor(prev), epfEnrolled, prev.specialAllowance, pfBasis).ctcMonthly),
      newAnnual: annualOf(next, ctcLines(next.basePay, await effFor(next), epfEnrolled, next.specialAllowance, pfBasis).ctcMonthly),
      effectiveDate: next.effectiveFrom,
    };
  }

  // Role history: the two newest position rows give old -> new for promotion/transfer letters.
  const posRows = await deps.db
    .select()
    .from(schema.positions)
    .where(eq(schema.positions.employeeId, employeeId))
    .orderBy(desc(schema.positions.effectiveFrom));
  let roleChange: LetterContext["roleChange"];
  if (posRows.length >= 2 && posRows[0] && posRows[1]) {
    const [next, prev] = posRows;
    const deptIds = [next.departmentId, prev.departmentId].filter(Boolean) as string[];
    const deptNames = new Map<string, string>();
    if (deptIds.length) {
      for (const d of await refDepartments(deps)) if (deptIds.includes(d.uuid)) deptNames.set(d.uuid, d.name);
    }
    roleChange = {
      oldTitle: prev.jobTitle ?? undefined,
      newTitle: next.jobTitle ?? undefined,
      oldDepartment: prev.departmentId ? deptNames.get(prev.departmentId) : undefined,
      newDepartment: next.departmentId ? deptNames.get(next.departmentId) : undefined,
      oldLocation: prev.location ?? undefined,
      newLocation: next.location ?? undefined,
      effectiveDate: next.effectiveFrom,
      titleChanged: (prev.jobTitle ?? null) !== (next.jobTitle ?? null),
      departmentChanged: (prev.departmentId ?? null) !== (next.departmentId ?? null),
      locationChanged: (prev.location ?? null) !== (next.location ?? null),
    };
  }

  // Most recent one-off award, for the bonus/incentive letter.
  const bonusRow = (await deps.db.select().from(schema.bonuses).where(eq(schema.bonuses.employeeId, employeeId)).orderBy(desc(schema.bonuses.awardDate)).limit(1))[0];
  const bonus = bonusRow ? { amount: bonusRow.amount, currency: bonusRow.currency, kind: bonusRow.kind ?? undefined, reason: bonusRow.reason ?? undefined, date: bonusRow.awardDate } : undefined;

  // Most recent full-and-final settlement snapshot, for the FnF letter.
  const settleRow = (await deps.db.select().from(schema.settlements).where(eq(schema.settlements.employeeId, employeeId)).orderBy(desc(schema.settlements.settlementDate)).limit(1))[0];
  const settlement = settleRow ? { lines: JSON.parse(settleRow.linesJson) as { name: string; kind: "earning" | "deduction"; amount: number }[], net: settleRow.net, date: settleRow.settlementDate } : undefined;

  return {
    org: { name: org.name || "", address: org.address, logo: org.logo, legalName: org.legal_name || undefined },
    defaults: org.letter_defaults ?? {},
    today: deps.clock.now(),
    employee: {
      fullName: `${emp.firstName} ${emp.lastName}`,
      firstName: emp.firstName,
      legalName: emp.legalName ?? undefined,
      employeeNumber: emp.employeeNumber ?? undefined,
      designation: emp.jobTitle ?? undefined,
      department,
      managerName,
      startDate: emp.startDate ?? null,
      probationEndDate: emp.probationEndDate ?? null,
      endDate: emp.endDate ?? null,
    },
    comp,
    increment,
    roleChange,
    bonus,
    settlement,
  };
}
