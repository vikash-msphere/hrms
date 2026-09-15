import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listReimbursements, getReimbursement, createReimbursement,
  approveReimbursement, rejectReimbursement, cancelReimbursement, payReimbursement,
  type ReimbursementInput,
} from "../services/reimbursements";
import { putAttachment, downloadAttachment, attachedObjectIds, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { toReimbursementResource } from "../http/serialize";

const COL = "reimbursements";
const RECEIPT = "receipt"; // the attachment slot for a claim's receipt

const createSchema = z
  .object({
    employee: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    amount: positiveMoney(),
    incurred_on: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .strict();

// Employee expense claims. A filed claim is answered, never edited or deleted (it is cancelled), and the table
// has no delete_time - so list, get, create and the six verbs are the whole surface.
export const reimbursements = collectionRoutes<ReimbursementInput, typeof schema.reimbursements>({
  table: schema.reimbursements,
  collection: COL,
  auditName: "reimbursement",
  notFound: "reimbursement not found",
  param: "reimbursement_id",
  createSchema,
  serialize: toReimbursementResource,
  // Whether the receipt is attached lives in the attachments table, so every single-row answer resolves it here.
  // One query for the whole page (bounded to it), not one per row - and the factory applies it to the
  // list, the item read and every write response alike, so the flag has a single implementation.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, RECEIPT, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasReceipt: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input) => createReimbursement(deps, actor, input),
  },
  list: (c, page) => listReimbursements(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("q")),
  verbs: {
    approve: { run: (deps, user, id) => approveReimbursement(deps, user, id) },
    reject: { run: (deps, user, id) => rejectReimbursement(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelReimbursement(deps, user, id) },
    pay: { run: (deps, user, id) => payReimbursement(deps, user, id) },
    // The receipt goes up as raw bytes; the answer is the claim itself, now carrying its receipt flag.
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: RECEIPT, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getReimbursement(deps, user, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, RECEIPT);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(att, "receipt") });
      },
    },
  },
});
