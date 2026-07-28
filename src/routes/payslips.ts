import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listPayslips, getPayslip, downloadPayslip, previewPayslip } from "../services/payslips";
import { toPayslipResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

export const payslips = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listPayslips(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toPayslipResource(r), user, "payslips", r.code)), next_page_token: nextPageToken });
  })
  .get("/:payslip_id", async (c) => {
    const row = await getPayslip(c.get("deps"), c.get("user"), c.req.param("payslip_id")!);
    return c.json(toPayslipResource(row));
  })
  .post("/:payslip_id", async (c) => {
    const { id, verb } = customMethod(c);
    // :preview renders the slip inline in the app; :download hands over a copy to keep. Separate verbs so the
    // two can be granted (and scoped) independently - the middleware has already decided this one.
    if (verb === "preview") {
      const { bytes, fileName } = await previewPayslip(c.get("deps"), c.get("user"), id);
      return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"` });
    }
    if (verb !== "download") return c.notFound();
    const { bytes } = await downloadPayslip(c.get("deps"), c.get("user"), id);
    return c.body(bytes, 200, { "Content-Type": "application/octet-stream" });
  });
