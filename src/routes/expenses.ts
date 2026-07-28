import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listExpenses, getExpense, createExpense, updateExpense,
  submitExpense, approveExpense, rejectExpense, cancelExpense, payExpense,
} from "../services/expenses";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toExpenseResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "expenses";
const INVOICE = "invoice"; // the attachment slot for an expense's invoice/receipt

const paymentMethod = z.enum(["bank", "card", "cash", "upi", "cheque"]);
const writeSchema = z
  .object({
    employee: z.string().nullable().optional(),
    vendor: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    amount: z.number().positive(),
    tax_amount: z.number().nonnegative().nullable().optional(),
    incurred_on: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    invoice_number: z.string().nullable().optional(),
    payment_method: paymentMethod.nullable().optional(),
    reimbursable: z.boolean().optional(),
    recurring: z.boolean().optional(),
    recurrence_rule: z.enum(["monthly", "quarterly", "yearly"]).nullable().optional(),
    next_occurrence_on: z.string().nullable().optional(),
  })
  .strict();
// PATCH allows the same fields but with amount optional (partial edit of a draft).
const patchSchema = writeSchema.partial();

export const expenses = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listExpenses(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("state"), c.req.query("department"), c.req.query("q"));
    const user = c.get("user");
    const withInvoice = await attachedObjectIds(c.get("deps"), COL, INVOICE); // one query for the page's invoice flags
    return c.json({ results: items.map((r) => withAccess(toExpenseResource({ ...r, hasInvoice: withInvoice.has(r.uuid) }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:expense_id", async (c) => {
    const row = await getExpense(c.get("deps"), c.get("user"), c.req.param("expense_id"));
    const hasInvoice = !!(await getAttachment(c.get("deps"), COL, row.uuid, INVOICE));
    return c.json(withAccess(toExpenseResource({ ...row, hasInvoice }), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createExpense(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toExpenseResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:expense_id", zValidator("json", patchSchema), async (c) => {
    const row = await updateExpense(c.get("deps"), c.get("user"), c.req.param("expense_id"), c.req.valid("json"));
    return c.json(withAccess(toExpenseResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:expense_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toExpenseResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "submit") return c.json(hint(await submitExpense(deps, user, id)));
    if (verb === "approve") return c.json(hint(await approveExpense(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectExpense(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelExpense(deps, user, id)));
    if (verb === "pay") {
      const body = await c.req.json().catch(() => ({}));
      return c.json(hint(await payExpense(deps, user, id, body)));
    }
    if (verb === "upload") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await putAttachment(deps, user, { collection: COL, objectId: id, slot: INVOICE, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      const row = await getExpense(deps, user, id);
      return c.json(hint({ ...row, hasInvoice: true }));
    }
    if (verb === "download") {
      const { bytes, row: att } = await downloadAttachment(deps, COL, id, INVOICE);
      return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
    }
    return c.notFound();
  });
