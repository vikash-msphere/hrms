import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { listRuns, listRunItems, createRun, buildRunItems, transition, publishRun, deleteRun, runStaleness, previewRunItemPayslip } from "../services/payroll";
import { idFromPath } from "../services/documentsCommon";
import { buildBankFile } from "../services/bankFile";
import { buildStatutoryReport, buildPfEcr } from "../services/statutoryReport";
import { toPayrollRunResource, toOperationResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";
import { invalidArgument } from "../lib/errors";
import type { RunState } from "../domain/payroll";

const createSchema = z.object({ pay_period: z.string() }).strict();
const buildSchema = z.object({ one_offs: z.record(z.any()).optional() }).strict();

// A payroll run: created for a pay period, built, reviewed, approved, published. Deleting one is a real
// removal and only legal while unpublished (the service refuses PUBLISHED), so there is no `:restore` and no
// `?force`. There is no PATCH either - a run changes through its state machine, not by editing fields.
const runs = collectionRoutes<{ pay_period: string }>({
  table: schema.payrollRuns,
  collection: "payroll-runs",
  auditName: "payroll_run",
  notFound: "payroll run not found",
  param: "payroll_run_id",
  createSchema,
  // The detail view carries staleness so the run page can prompt a rebuild when inputs changed since the
  // build. `decorate` attaches it to a single-row read; a page does not carry it (it is a per-run query).
  decorate: async (deps, _actor, rows) => Promise.all(rows.map(async (r) => ({ ...r, _staleness: await runStaleness(deps, r) }))),
  serialize: (row) => ({ ...toPayrollRunResource(row), ...(row._staleness ?? {}) }),
  overrides: {
    create: (deps, actor, input) => createRun(deps, actor, input.pay_period),
    remove: (deps, actor, id, ifMatch) => deleteRun(deps, actor, id, ifMatch),
  },
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listRuns(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"));
  },
  verbs: {
    build: {
      run: async (deps, user, id, _body, c) => {
        const parsed = buildSchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) throw invalidArgument("invalid build body");
        return buildRunItems(deps, user, id, (parsed.data.one_offs ?? {}) as any, c.req.header("If-Match"));
      },
    },
    submit: { run: (deps, user, id, _body, c) => transition(deps, user, id, "REVIEW" as RunState, c.req.header("If-Match")) },
    approve: { run: (deps, user, id, _body, c) => transition(deps, user, id, "APPROVED" as RunState, c.req.header("If-Match")) },
    // Long-running: answers 202 + an Operation to poll, not the run.
    publish: {
      raw: async (c, id) => c.json(toOperationResource(await publishRun(c.get("deps"), c.get("user"), id, c.req.header("If-Match"))) as object, 202),
    },
    bankFile: {
      raw: async (c, id) => {
        const { bytes, fileName } = await buildBankFile(c.get("deps"), id, c.req.query("bank") ?? "");
        return c.body(bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        });
      },
    },
    // Pre-publish check: render ONE employee's payslip for this run inline, nothing persisted. Sensitive bytes
    // (another employee's full pay breakdown), so the authz middleware audits it as a sensitive read.
    previewPayslip: {
      raw: async (c, id) => {
        const body = (await c.req.json().catch(() => ({}))) as { employee?: string };
        const employeeId = idFromPath(body.employee ?? c.req.query("employee"));
        if (!employeeId) throw invalidArgument("employee is required");
        const { bytes, fileName } = await previewRunItemPayslip(c.get("deps"), id, employeeId);
        const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return c.body(pdf, 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"` });
      },
    },
    statutoryReport: {
      raw: async (c, id) => {
        const deps = c.get("deps");
        if (c.req.query("format") === "ecr") {
          const { text, fileName } = await buildPfEcr(deps, id);
          return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${fileName}"` });
        }
        const { bytes, fileName } = await buildStatutoryReport(deps, id);
        return c.body(bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        });
      },
    },
  },
});

// The per-employee breakdown for review (gross/deductions/tax/net + lines) is a sub-resource of a run, not a
// collection of its own: it rides the run's read gate. Chained onto the app the factory returns.
export const payrollRuns = new Hono<AppEnv>()
  .get("/:payroll_run_id/items", async (c) => c.json({ results: await listRunItems(c.get("deps"), c.req.param("payroll_run_id")) }))
  .route("/", runs);
