import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";

/**
 * A CASE: the records that together make up one long-running story.
 *
 * The correlation id groups one ACT - a request, a cron tick, the async job it spawned. A case is the other
 * axis: weeks, many actors, many acts. Hiring somebody is a requisition, then a candidate, an application, a
 * run of interviews and their feedback, an offer, and finally an employee - eight collections, and reading any
 * one of their trails tells you an eighth of what happened.
 *
 * DERIVED, not stored. The links are already in the schema (`applications.candidate_id`,
 * `offers.application_id`, `applications.hired_employee_id`), so a case id stamped at write time would be a
 * second source of truth for something the rows already say - and one that every service would have to
 * remember to pass, which is the failure mode this file exists to avoid. The cost is a handful of indexed
 * reads when somebody asks; the benefit is that a case cannot drift from the records that constitute it.
 *
 * Bounded on purpose. Each walk is a fixed number of queries over indexed foreign keys and returns at most
 * `MAX_CASE_RECORDS` members, because the audit query it feeds turns each member into an OR term.
 *
 * That bound is about READABILITY, not about the query's limits, and it is worth being clear which is which:
 * each member costs TWO bound parameters in the audit query, against D1's ceiling of 100 per statement, so
 * this cap and that ceiling used to be the same number read two different ways - and at 60 members the
 * statement bound 120 and threw `too many SQL variables`, precisely when the cap did its job. The audit query
 * now chunks its OR list and merges the pages (services/activity.ts ENTITY_PAIR_CHUNK), so this number is free
 * to be what its own comment says it is.
 */
export type CaseMember = { entity: string; id: string };

/** Enough to tell the story; past this the feed is not a story but a table. */
const MAX_CASE_RECORDS = 60;

/** The collections a case can be rooted at, and what each one means. Anything else is not a case. */
export const CASE_ROOTS = ["applications", "candidates", "offers", "transitions", "employees", "payroll-runs", "org-documents", "personal-documents"] as const;

/** A case, plus whether the cap cut it short - a truncated MONEY trail must not read as a complete one. */
export type CaseResult = { members: CaseMember[]; truncated: boolean };

/**
 * The hiring story, from whichever of its records the caller happened to have.
 *
 * Rooted at the APPLICATION, because that is the record the pipeline actually moves - a candidate may have
 * several applications and a requisition many, so rooting at either of those would merge unrelated stories.
 * A caller who hands us a candidate or an offer is resolved back to the application first.
 */
async function hiringCase(deps: Deps, applicationId: string): Promise<CaseMember[]> {
  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, applicationId)).limit(1))[0];
  if (!app) return [];
  const members: CaseMember[] = [{ entity: "applications", id: app.uuid }];
  members.push({ entity: "candidates", id: app.candidateId });
  members.push({ entity: "job-requisitions", id: app.requisitionId });
  if (app.referralId) members.push({ entity: "referrals", id: app.referralId });

  const interviews = await deps.db.select({ uuid: schema.interviews.uuid }).from(schema.interviews).where(eq(schema.interviews.applicationId, app.uuid));
  for (const i of interviews) members.push({ entity: "interviews", id: i.uuid });
  if (interviews.length) {
    const feedback = await deps.db
      .select({ uuid: schema.interviewFeedback.uuid })
      .from(schema.interviewFeedback)
      .where(inArray(schema.interviewFeedback.interviewId, interviews.map((i) => i.uuid)));
    for (const f of feedback) members.push({ entity: "interview-feedback", id: f.uuid });
  }

  const offers = await deps.db.select({ uuid: schema.offers.uuid }).from(schema.offers).where(eq(schema.offers.applicationId, app.uuid));
  for (const o of offers) members.push({ entity: "offers", id: o.uuid });

  // The hire is where a hiring case becomes an employment: their record, their first compensation, and the
  // onboarding it started. The story a reader wants does not stop at "offer accepted".
  if (app.hiredEmployeeId) {
    members.push({ entity: "employees", id: app.hiredEmployeeId });
    const comp = await deps.db.select({ uuid: schema.compensation.uuid }).from(schema.compensation).where(eq(schema.compensation.employeeId, app.hiredEmployeeId));
    for (const c of comp) members.push({ entity: "compensation", id: c.uuid });
    const trs = await deps.db.select({ uuid: schema.transitions.uuid }).from(schema.transitions).where(eq(schema.transitions.employeeId, app.hiredEmployeeId));
    for (const t of trs) members.push({ entity: "transitions", id: t.uuid });
  }
  return members;
}

/** An onboarding or offboarding: the transition and every task under it. */
async function transitionCase(deps: Deps, transitionId: string): Promise<CaseMember[]> {
  const tr = (await deps.db.select().from(schema.transitions).where(eq(schema.transitions.uuid, transitionId)).limit(1))[0];
  if (!tr) return [];
  const members: CaseMember[] = [{ entity: "transitions", id: tr.uuid }, { entity: "employees", id: tr.employeeId }];
  const tasks = await deps.db.select({ uuid: schema.transitionTasks.uuid }).from(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, tr.uuid));
  for (const t of tasks) members.push({ entity: "transition-tasks", id: t.uuid });
  // An offboarding's notice period is part of the same departure, and it is a record of its own.
  const notice = await deps.db.select({ uuid: schema.noticePeriods.uuid }).from(schema.noticePeriods).where(eq(schema.noticePeriods.employeeId, tr.employeeId));
  for (const n of notice) members.push({ entity: "notice-periods", id: n.uuid });
  return members;
}

/**
 * What a payroll run PAID, and where each line came from.
 *
 * A payslip's own trail says a run produced it and stops - but a third of that payslip might be a bonus
 * somebody approved in March, and the approval that authorised the money is on THAT record. Every payable
 * carries the run that settled it (`paid_run_id`, and `arrears_paid_run_id` on compensation), each indexed, so
 * the whole settlement is a handful of seeks.
 *
 * The run's ITEMS and PAYSLIPS are deliberately left out: there is one of each per employee, so for any real
 * company they would fill the cap with rows whose trail says only "generated", and bury the payables - which
 * are the part with a decision behind them.
 */
async function payrollRunCase(deps: Deps, runId: string): Promise<CaseMember[]> {
  const run = (await deps.db.select({ uuid: schema.payrollRuns.uuid }).from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)).limit(1))[0];
  if (!run) return [];
  const members: CaseMember[] = [{ entity: "payroll-runs", id: run.uuid }];
  const settled = async (entity: string, table: { uuid: unknown; paidRunId: unknown }) => {
    const rows = await deps.db.select({ uuid: table.uuid as never }).from(table as never).where(eq(table.paidRunId as never, runId));
    for (const r of rows as { uuid: string }[]) members.push({ entity, id: r.uuid });
  };
  await settled("bonuses", schema.bonuses);
  await settled("leave-encashments", schema.leaveEncashments);
  await settled("overtime-requests", schema.overtimeRequests);
  await settled("reimbursements", schema.reimbursements);
  // Retro arrears from a backdated pay revision: the compensation row is where the raise was decided.
  const arrears = await deps.db.select({ uuid: schema.compensation.uuid }).from(schema.compensation).where(eq(schema.compensation.arrearsPaidRunId, runId));
  for (const a of arrears) members.push({ entity: "compensation", id: a.uuid });
  // A loan repayment is not an audited record of its own; the LOAN it repaid is, and that is where the
  // approval and the disbursement sit.
  const repayments = await deps.db.select({ loanId: schema.loanRepayments.loanId }).from(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId));
  for (const r of repayments) members.push({ entity: "loans", id: r.loanId });
  // An expense paid to an employee is bridged through a reimbursement, so the expense that started it is two
  // hops from the run and invisible to anyone reading the run alone.
  const reimbIds = members.filter((m) => m.entity === "reimbursements").map((m) => m.id);
  if (reimbIds.length) {
    const expenses = await deps.db.select({ uuid: schema.expenses.uuid }).from(schema.expenses).where(inArray(schema.expenses.reimbursementId, reimbIds));
    for (const e of expenses) members.push({ entity: "expenses", id: e.uuid });
  }
  return members;
}

/**
 * A document from issue to acknowledgement: the policy, everyone's acknowledgement of it, and the signed copy
 * each one produced.
 *
 * Three records and three trails for what a person thinks of as one thing - "was this policy signed, by whom,
 * and when". Rooted at either end: an org-document reaches its acknowledgements, and a personal document (a
 * signed copy, or a generated letter) reaches back to the policy it came from.
 */
async function documentCase(deps: Deps, orgDocId: string): Promise<CaseMember[]> {
  const members: CaseMember[] = [{ entity: "org-documents", id: orgDocId }];
  const acks = await deps.db
    .select({ uuid: schema.documentAcknowledgements.uuid, signedDocId: schema.documentAcknowledgements.signedDocId })
    .from(schema.documentAcknowledgements)
    .where(eq(schema.documentAcknowledgements.documentId, orgDocId));
  for (const a of acks) {
    members.push({ entity: "document-acknowledgements", id: a.uuid });
    if (a.signedDocId) members.push({ entity: "personal-documents", id: a.signedDocId });
  }
  // Signed copies filed straight against the source policy, with no acknowledgement row of their own.
  const copies = await deps.db.select({ uuid: schema.personalDocuments.uuid }).from(schema.personalDocuments).where(eq(schema.personalDocuments.sourceDocId, orgDocId));
  for (const c of copies) members.push({ entity: "personal-documents", id: c.uuid });
  return members;
}

/**
 * The records forming the case rooted at `collection/id`.
 *
 * A candidate or an offer resolves to its application first, so the caller can hand us whichever record of the
 * story they were looking at and get the same case back.
 */
export async function caseMembers(deps: Deps, collection: string, id: string): Promise<CaseResult> {
  if (!(CASE_ROOTS as readonly string[]).includes(collection)) {
    throw invalidArgument(`a case can be rooted at ${CASE_ROOTS.join(", ")} - not ${collection}`);
  }
  let members: CaseMember[] = [];
  if (collection === "applications") members = await hiringCase(deps, id);
  else if (collection === "transitions") members = await transitionCase(deps, id);
  else if (collection === "offers") {
    const o = (await deps.db.select({ applicationId: schema.offers.applicationId }).from(schema.offers).where(eq(schema.offers.uuid, id)).limit(1))[0];
    members = o ? await hiringCase(deps, o.applicationId) : [];
  } else if (collection === "candidates") {
    // Every application this candidate made: two applications to two roles are two stories, and a reader who
    // asked about the PERSON means both.
    const apps = await deps.db.select({ uuid: schema.applications.uuid }).from(schema.applications).where(eq(schema.applications.candidateId, id));
    members = (await Promise.all(apps.map((a) => hiringCase(deps, a.uuid)))).flat();
    if (!apps.length) members = [{ entity: "candidates", id }];
  } else if (collection === "payroll-runs") members = await payrollRunCase(deps, id);
  else if (collection === "org-documents") members = await documentCase(deps, id);
  else if (collection === "personal-documents") {
    // A signed copy or a generated letter: walk back to the policy it came from, then forward over everyone
    // else's copy of it. A personal document with no source is a case of one - a letter nobody acknowledged.
    const doc = (await deps.db.select({ sourceDocId: schema.personalDocuments.sourceDocId }).from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0];
    members = doc?.sourceDocId ? await documentCase(deps, doc.sourceDocId) : [{ entity: "personal-documents", id }];
  } else if (collection === "employees") {
    // An employee's employment story: how they were hired, and every transition since. Distinct from
    // `?subject`, which answers "what happened to this person" from the audit meta - this answers "which
    // RECORDS are theirs", and catches the ones no entry named them on.
    members = [{ entity: "employees", id }];
    const app = (await deps.db.select({ uuid: schema.applications.uuid }).from(schema.applications).where(eq(schema.applications.hiredEmployeeId, id)).limit(1))[0];
    if (app) members.push(...(await hiringCase(deps, app.uuid)));
    const trs = await deps.db.select({ uuid: schema.transitions.uuid }).from(schema.transitions).where(eq(schema.transitions.employeeId, id));
    for (const t of trs) members.push(...(await transitionCase(deps, t.uuid)));
  }
  // De-duplicate: the walks overlap by design (a hire reaches the employee, the employee reaches the hire).
  const seen = new Set<string>();
  const out: CaseMember[] = [];
  let truncated = false;
  for (const m of members) {
    const key = `${m.entity}/${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= MAX_CASE_RECORDS) { truncated = true; break; }
    out.push(m);
  }
  // Reported, not swallowed. A payroll run settling two hundred payables is a case the cap cuts short, and a
  // truncated money trail that presents itself as the whole one is worse than no trail: the reader concludes
  // the run paid what they can see.
  return { members: out, truncated };
}
