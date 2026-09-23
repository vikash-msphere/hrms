import { Hono } from "hono";
import type { AppEnv } from "../env";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { contentDisposition } from "../http/contentDisposition";
import { listPayslips, downloadPayslip, previewPayslip, explainPayslip } from "../services/payslips";
import { toPayslipResource } from "../http/serialize";

// Published payslips: a payroll run writes them, nobody edits them. Read-only (no insert, no patch) over a
// table with no delete_time, so the factory mounts list + get and the two document verbs, nothing else.
// Why this payslip differs from the one before it. A GET sub-resource on the slip, so it rides the payslip's
// own read gate - which for an employee is their own slip and nobody else's, exactly the access the question
// needs and no more. Not a custom method: it changes nothing, and a verb would need its own grant to gate a
// read that is already gated.
const payslipExplain = new Hono<AppEnv>().get("/:payslip_id/explain", async (c) => {
  const id = c.req.param("payslip_id");
  const e = await explainPayslip(c.get("deps"), id);
  // A first payslip has nothing to be different from. Answered as an empty explanation rather than a 404,
  // because "there is no previous slip" is a real answer to the question and not a missing resource.
  return c.json({
    path: `payslips/${id}/explain`,
    compared_to: e?.compared_to ?? null,
    changes: (e?.changes ?? []).map((ch) => ({ code: ch.code, name: ch.name, kind: ch.kind, before: ch.before, now: ch.now, delta: ch.delta })),
    reasons: e?.reasons ?? [],
    net_before: e?.netBefore ?? 0,
    net_now: e?.netNow ?? 0,
    net_delta: e?.netDelta ?? 0,
  });
});

const payslipsCollection = collectionRoutes({
  table: schema.payslips,
  collection: "payslips",
  auditName: "payslip",
  notFound: "payslip not found",
  param: "payslip_id",
  serialize: toPayslipResource,
  list: async (c, page) => {
    // Visibility (own / my-dept / org-wide) was decided in middleware; the service only binds it to columns.
    // Optional `?employee=employees/<token>` narrows to one person - what the Compensation tab of an employee
    // record asks for. The inbound edge (decodeWireIds) already decoded the query ref to its internal id, so
    // just take the id segment - do NOT decode again (that drops the filter).
    const emp = c.req.query("employee");
    return listPayslips(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, emp ? emp.split("/").pop()! : undefined);
  },
  // Both answer with PDF bytes rather than the resource, so they own their whole response (`raw`). Separate
  // verbs so the two can be granted independently: :preview renders the slip inline in the app, :download
  // hands over a copy to keep.
  verbs: {
    preview: {
      raw: async (c, id) => {
        const { bytes, fileName } = await previewPayslip(c.get("deps"), c.get("user"), id);
        return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", fileName) });
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, fileName } = await downloadPayslip(c.get("deps"), c.get("user"), id);
        return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("attachment", fileName) });
      },
    },
  },
});

// The explain read is chained ahead of the factory's own routes, the same shape payroll-runs uses for its
// sub-resources.
export const payslips = new Hono<AppEnv>().route("/", payslipExplain).route("/", payslipsCollection);
