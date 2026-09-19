import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { contentDisposition } from "../http/contentDisposition";
import { listPayslips, downloadPayslip, previewPayslip } from "../services/payslips";
import { toPayslipResource } from "../http/serialize";

// Published payslips: a payroll run writes them, nobody edits them. Read-only (no insert, no patch) over a
// table with no delete_time, so the factory mounts list + get and the two document verbs, nothing else.
export const payslips = collectionRoutes({
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
