import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listRuns, listRunItems, getRun, createRun, buildRunItems, transition, publishRun, deleteRun, runStaleness, previewRunItemPayslip } from "../services/payroll";
import { idFromPath } from "../services/documentsCommon";
import { buildBankFile } from "../services/bankFile";
import { buildStatutoryReport, buildPfEcr } from "../services/statutoryReport";
import { toPayrollRunResource, toOperationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { customMethod } from "../http/customMethod";
import { clampPageSize } from "../http/pagination";
import { invalidArgument } from "../lib/errors";
import type { RunState } from "../domain/payroll";

const createSchema = z.object({ pay_period: z.string() }).strict();
const buildSchema = z.object({ one_offs: z.record(z.any()).optional() }).strict();

export const payrollRuns = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listRuns(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toPayrollRunResource(r), user, "payroll-runs", r.code)), next_page_token: nextPageToken });
  })
  .get("/:payroll_run_id", async (c) => {
    const deps = c.get("deps");
    const row = await getRun(deps, c.req.param("payroll_run_id"));
    // Detail view carries staleness so the run page can prompt a rebuild when inputs changed since the build.
    // It also carries the per-object access hint (like the list does) - the review dialog replaces its list row
    // with this detail, and without the hint every gated action in that dialog would look unavailable.
    const staleness = await runStaleness(deps, row);
    return c.json({ ...withAccess(toPayrollRunResource(row), c.get("user"), "payroll-runs", row.code, c.get("objectGrant")), ...staleness });
  })
  // Per-employee breakdown for review (gross/deductions/tax/net + lines). Rides the run's read gate.
  .get("/:payroll_run_id/items", async (c) => {
    return c.json({ results: await listRunItems(c.get("deps"), c.req.param("payroll_run_id")) });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createRun(c.get("deps"), c.get("user"), c.req.valid("json").pay_period);
    return c.json(toPayrollRunResource(row));
  })
  // Delete an unpublished run (the service rejects PUBLISHED). Optional If-Match.
  .delete("/:payroll_run_id", async (c) => {
    await deleteRun(c.get("deps"), c.get("user"), c.req.param("payroll_run_id"), c.req.header("If-Match"));
    return c.body(null, 204);
  })
  // Custom methods (state machine). The wire path is the :verb form; dispatch on verb.
  // :publish is long-running → returns 202 + an Operation. Poll GET /v1/operations/{operation}.
  .post("/:payroll_run_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const ifMatch = c.req.header("If-Match");
    if (verb === "build") {
      const parsed = buildSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) throw invalidArgument("invalid build body");
      const row = await buildRunItems(deps, user, id, (parsed.data.one_offs ?? {}) as any, ifMatch);
      return c.json(toPayrollRunResource(row));
    }
    const target: Record<string, RunState> = { submit: "REVIEW", approve: "APPROVED" };
    if (target[verb]) {
      const row = await transition(deps, user, id, target[verb]!, ifMatch);
      return c.json(toPayrollRunResource(row));
    }
    if (verb === "publish") {
      const job = await publishRun(deps, user, id, ifMatch);
      return c.json(toOperationResource(job), 202);
    }
    if (verb === "bankFile") {
      const { bytes, fileName } = await buildBankFile(deps, id, c.req.query("bank") ?? "");
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      });
    }
    // Pre-publish check: render ONE employee's payslip for this run inline, nothing persisted. Sensitive
    // bytes (another employee's full pay breakdown), so the authz middleware audits it as a sensitive read.
    if (verb === "previewPayslip") {
      const body = (await c.req.json().catch(() => ({}))) as { employee?: string };
      const employeeId = idFromPath(body.employee ?? c.req.query("employee"));
      if (!employeeId) throw invalidArgument("employee is required");
      const { bytes, fileName } = await previewRunItemPayslip(deps, id, employeeId);
      const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return c.body(pdf, 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"` });
    }
    if (verb === "statutoryReport") {
      if (c.req.query("format") === "ecr") {
        const { text, fileName } = await buildPfEcr(deps, id);
        return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${fileName}"` });
      }
      const { bytes, fileName } = await buildStatutoryReport(deps, id);
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      });
    }
    return c.notFound();
  });
