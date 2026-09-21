import { Hono } from "hono";
import { z } from "zod";
import { nonNegativeMoney } from "../http/moneyField";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { contentDisposition } from "../http/contentDisposition";
import { jsonBody } from "../http/jsonRequest";
import { listRuns, listRunItems, getRun, withStaleness, createRun, buildRunItems, transition, publishRun, deleteRun, previewRunItemPayslip, reconcileRun, runTimeline, runJournal, runVariance, recordPaymentResults } from "../services/payroll";
import { idFromPath } from "../services/documentsCommon";
import { buildBankFile } from "../services/bankFile";
import { buildStatutoryReport, buildPfEcr } from "../services/statutoryReport";
import { toPayrollRunResource, toOperationResource } from "../http/serialize";
import { unopenedPayslipCount } from "../services/payslips";
import { invalidArgument } from "../lib/errors";
import type { RunState } from "../domain/payroll";
import { narrateRun } from "../domain/payrollNarrate";

const createSchema = z.object({ pay_period: z.string() }).strict();
// A manual one-off line. Typed rather than `z.record(z.any())`, which is what this was: the build pushed
// whatever arrived straight into an employee's line array, so a caller could post a NEGATIVE deduction and
// make net exceed gross. `moneyFieldDrift` could not see it either - it greps for a bare `z.number()`, and a
// `z.any()` is not that, so the one money input with no bound at all was the one the drift test was blind to.
//
// AMOUNTS ARE NON-NEGATIVE, and the sign is the server's to decide. A manual loss of pay arrives as a
// POSITIVE deduction coded LOP and the build normalises it to a negative earning, because docked pay must
// leave gross rather than sit beside it - so a caller sending a negative amount is not expressing something
// the model cannot say, they are contradicting the one place that decides it.
const oneOffLine = z
  .object({
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(120),
    // Only what a one-off legitimately is. Employer contributions and perquisites are derived by the build
    // from components and policy; accepting them here would let a caller invent company cost.
    kind: z.enum(["earning", "deduction"]),
    amount: nonNegativeMoney(),
    taxable: z.boolean().optional(),
  })
  .strict();
const buildSchema = z.object({ one_offs: z.record(z.array(oneOffLine)).optional() }).strict();

// A payroll run: created for a pay period, built, reviewed, approved, published. Deleting one is a real
// removal and only legal while unpublished (the service refuses PUBLISHED), so there is no `:restore` and no
// `?force`. There is no PATCH either - a run changes through its state machine, not by editing fields.
const runs = collectionRoutes<{ pay_period: string }, typeof schema.payrollRuns>({
  table: schema.payrollRuns,
  collection: "payroll-runs",
  auditName: "payroll_run",
  notFound: "payroll run not found",
  param: "payroll_run_id",
  createSchema,
  serialize: (row) => ({ ...toPayrollRunResource(row), ...(row._staleness ?? {}), ...(row.timeline === undefined ? {} : { timeline: row.timeline }), ...(row.payslips_unopened === undefined ? {} : { payslips_unopened: row.payslips_unopened }) }),
  overrides: {
    // The detail read carries staleness so the run page can prompt a rebuild when inputs changed since the
    // build; a page does not (see withStaleness). `getRun` also resolves the submitter/approver names the list
    // already carried.
    get: async (deps, _actor, id) => {
      // Publishing writes payslips; whether anybody received one is a separate fact, and this is the surface
      // where somebody decides the month is finished. Only asked of a published run - on anything earlier
      // there are no slips to have been opened, and the count would read as "nobody has seen it" rather than
      // "it has not been sent".
      const run = await withStaleness(deps, await getRun(deps, id));
      // Where the month has got to, off the audit trail the transitions already write. One indexed read, and
      // it rides the detail because "where are we" is the first thing somebody opening a run wants.
      const timeline = await runTimeline(deps, run);
      if (run.state !== "PUBLISHED") return { ...run, timeline };
      return { ...run, timeline, payslips_unopened: await unopenedPayslipCount(deps, id) };
    },
    create: (deps, actor, input) => createRun(deps, actor, input.pay_period),
    remove: (deps, actor, id, ifMatch) => deleteRun(deps, actor, id, ifMatch),
  },
  list: (c, page) => listRuns(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken),
  verbs: {
    build: {
      run: async (deps, user, id, _body, c) => {
        const parsed = buildSchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw invalidArgument("invalid build body");
        return withStaleness(deps, await buildRunItems(deps, user, id, (parsed.data.one_offs ?? {}) as any, c.req.header("If-Match")));
      },
    },
    submit: { run: async (deps, user, id, _body, c) => withStaleness(deps, await transition(deps, user, id, "REVIEW" as RunState, c.req.header("If-Match"))) },
    approve: { run: async (deps, user, id, _body, c) => withStaleness(deps, await transition(deps, user, id, "APPROVED" as RunState, c.req.header("If-Match"))) },
    // Long-running: answers 202 + an Operation to poll, not the run.
    publish: {
      raw: async (c, id) => c.json(toOperationResource(await publishRun(c.get("deps"), c.get("user"), id, c.req.header("If-Match"))) as object, 202),
    },
    bankFile: {
      raw: async (c, id) => {
        // `acknowledge=1` confirms the payout findings the check refused on - a shared destination account,
        // or an account that changed since the last run that paid somebody. Deliberately a separate, explicit
        // parameter rather than a flag the SPA always sends: the whole value is that a person looked.
        const { bytes, fileName } = await buildBankFile(c.get("deps"), c.get("user"), id, c.req.query("bank") ?? "", c.req.query("acknowledge") === "1");
        return c.body(bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": contentDisposition("attachment", fileName),
        });
      },
    },
    // Pre-publish check: render ONE employee's payslip for this run inline, nothing persisted. Sensitive bytes
    // (another employee's full pay breakdown), so the authz middleware audits it as a sensitive read.
    previewPayslip: {
      raw: async (c, id) => {
        const body = await jsonBody<{ employee?: string }>(c);
        const employeeId = idFromPath(body.employee ?? c.req.query("employee"));
        if (!employeeId) throw invalidArgument("employee is required");
        const { bytes, fileName } = await previewRunItemPayslip(c.get("deps"), id, employeeId);
        const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return c.body(pdf, 200, { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", fileName) });
      },
    },
    // What the bank did with the payout file. A WRITE, so a custom method rather than a GET like the reads
    // beside it - it records per-person outcomes and tells anybody whose money did not arrive.
    //
    // The body is already-parsed rows, not the bank's file: every bank returns a different format exactly as
    // every bank takes a different one, so a new bank is a parser and not a change to how a payment is
    // reconciled. Until a per-issuer parser exists beside bankFormats.ts, the SPA reads the file.
    paymentResult: {
      schema: z.object({
        results: z.array(z.object({
          employee: z.string(),
          status: z.enum(["paid", "failed", "returned"]),
          reference: z.string().max(120).nullable().optional(),
          reason: z.string().max(500).nullable().optional(),
        }).strict()).min(1).max(2000),
      }).strict(),
      run: async (deps, user, id, body: { results: { employee: string; status: "paid" | "failed" | "returned"; reference?: string | null; reason?: string | null }[] }) =>
        recordPaymentResults(deps, user, id, body.results.map((r) => ({
          // The edge has already decoded the wire id, so this takes the id segment and does NOT decode again.
          employeeId: r.employee.split("/").pop()!,
          status: r.status,
          reference: r.reference ?? null,
          reason: r.reason ?? null,
        }))),
    },
    statutoryReport: {
      raw: async (c, id) => {
        const deps = c.get("deps");
        if (c.req.query("format") === "ecr") {
          const { text, fileName } = await buildPfEcr(deps, id);
          return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": contentDisposition("attachment", fileName) });
        }
        const { bytes, fileName } = await buildStatutoryReport(deps, id);
        return c.body(bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": contentDisposition("attachment", fileName),
        });
      },
    },
  },
});

// The per-employee breakdown for review (gross/deductions/tax/net + lines) is a sub-resource of a run, not a
// collection of its own: it rides the run's read gate. Chained onto the app the factory returns.
//
// `reconciliation` joins it on the same terms and for the same reason. It is a GET rather than a custom method
// because it changes nothing and derives everything from rows the run already has - a verb would need its own
// entry in ACCESS_VERBS and its own grant, to gate a read that is already gated by the run it is part of.
export const payrollRuns = new Hono<AppEnv>()
  .get("/:payroll_run_id/items", async (c) => c.json({ results: await listRunItems(c.get("deps"), c.req.param("payroll_run_id")) }))
  .get("/:payroll_run_id/reconciliation", async (c) => {
    // The one camelCase name in the answer, spelled for the wire here rather than in the domain, which has no
    // business knowing what the HTTP shape looks like.
    const id = c.req.param("payroll_run_id");
    const { headcountResidual, ...rest } = await reconcileRun(c.get("deps"), id);
    // The same decomposition, said in a sentence. Derived here rather than by the client so the prose and the
    // table can never disagree, and deterministic - no model, so no consented path (domain/payrollNarrate.ts
    // states why that is the design rather than a fallback).
    const narration = narrateRun({ headcountResidual, ...rest });
    return c.json({
      path: `payroll-runs/${id}/reconciliation`,
      ...rest,
      headcount_residual: headcountResidual,
      summary: narration.text,
      summary_compared: narration.compared,
    });
  })
  // The accounting handoff, on the same terms as `reconciliation`: a GET, derived from rows the run already
  // has, gated by the run it is part of. Refuses to answer with an entry that does not balance or that leaves
  // an unmapped component out - `domain/payrollJournal.ts` decides both, and the response carries the reason.
  // What to look at before approving: the rows whose pay moved against their own history, with the reason
  // each one moved, plus the pre-flight. Same terms as the two reads beside it - a GET, derived, gated by the
  // run. The BLOCKING half of the pre-flight is also enforced at :approve; this is where a reviewer sees all
  // of it, including the parts that are a judgement rather than a refusal.
  .get("/:payroll_run_id/variance", async (c) => {
    const id = c.req.param("payroll_run_id");
    const v = await runVariance(c.get("deps"), id);
    return c.json({ path: `payroll-runs/${id}/variance`, ...v });
  })
  .get("/:payroll_run_id/journal", async (c) => {
    const id = c.req.param("payroll_run_id");
    const { totalDebit, totalCredit, ...rest } = await runJournal(c.get("deps"), id);
    return c.json({ path: `payroll-runs/${id}/journal`, ...rest, total_debit: totalDebit, total_credit: totalCredit });
  })
  .route("/", runs);
