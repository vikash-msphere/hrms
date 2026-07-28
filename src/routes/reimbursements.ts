import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listReimbursements, getReimbursement, createReimbursement,
  approveReimbursement, rejectReimbursement, cancelReimbursement, payReimbursement,
} from "../services/reimbursements";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toReimbursementResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "reimbursements";
const RECEIPT = "receipt"; // the attachment slot for a claim's receipt

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    amount: z.number().positive(),
    incurred_on: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .strict();

export const reimbursements = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReimbursements(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("q"));
    const user = c.get("user");
    const withReceipt = await attachedObjectIds(c.get("deps"), COL, RECEIPT); // one query for the page's receipt flags
    return c.json({ results: items.map((r) => withAccess(toReimbursementResource({ ...r, hasReceipt: withReceipt.has(r.uuid) }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:reimbursement_id", async (c) => {
    const row = await getReimbursement(c.get("deps"), c.get("user"), c.req.param("reimbursement_id"));
    const hasReceipt = !!(await getAttachment(c.get("deps"), COL, row.uuid, RECEIPT));
    return c.json(withAccess(toReimbursementResource({ ...row, hasReceipt }), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createReimbursement(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toReimbursementResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:reimbursement_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toReimbursementResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveReimbursement(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectReimbursement(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelReimbursement(deps, user, id)));
    if (verb === "pay") return c.json(hint(await payReimbursement(deps, user, id)));
    if (verb === "upload") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await putAttachment(deps, user, { collection: COL, objectId: id, slot: RECEIPT, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      const row = await getReimbursement(deps, user, id);
      return c.json(hint({ ...row, hasReceipt: true }));
    }
    if (verb === "download") {
      const { bytes, row: att } = await downloadAttachment(deps, COL, id, RECEIPT);
      return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
    }
    return c.notFound();
  });
