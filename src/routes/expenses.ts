import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listExpenses, getExpense, createExpense, updateExpense,
  submitExpense, approveExpense, rejectExpense, cancelExpense, payExpense,
  type ExpenseInput,
} from "../services/expenses";
import { putAttachment, downloadAttachment, attachedObjectIds } from "../services/attachments";
import { toExpenseResource } from "../http/serialize";

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

// Company expenses. An expense is only editable while a DRAFT and is never deleted (it is cancelled), and the
// table has no delete_time - so the factory mounts no DELETE and no `:restore`. Both writes stay the service's
// own: the create resolves vendor/category/budget, the update refuses anything past DRAFT.
export const expenses = collectionRoutes<ExpenseInput>({
  table: schema.expenses,
  collection: COL,
  auditName: "expense",
  notFound: "expense not found",
  param: "expense_id",
  createSchema: writeSchema,
  updateSchema: patchSchema,
  serialize: toExpenseResource,
  // Whether the invoice/receipt is attached lives in the attachments table, so every single-row answer (get,
  // create, update, and the verbs) resolves it here - one lookup, in one place.
  // One query for the whole page (bounded to it), not one per row - and the factory applies it to the
  // list, the item read and every write response alike, so the flag has a single implementation.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, INVOICE, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasInvoice: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input) => createExpense(deps, actor, input),
    update: (deps, actor, id, patch) => updateExpense(deps, actor, id, patch),
  },
  list: (c, page) =>
    listExpenses(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), c.req.query("department"), c.req.query("q")),
  verbs: {
    submit: { run: (deps, user, id) => submitExpense(deps, user, id) },
    approve: { run: (deps, user, id) => approveExpense(deps, user, id) },
    reject: { run: (deps, user, id) => rejectExpense(deps, user, id) },
    cancel: { run: (deps, user, id) => cancelExpense(deps, user, id) },
    // The payment details are optional and shaped by the service, so the body is taken as sent.
    pay: { run: async (deps, user, id, _body, c) => payExpense(deps, user, id, await c.req.json().catch(() => ({}))) },
    // The invoice goes up as raw bytes, but the answer is the expense itself (now carrying its invoice flag).
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: INVOICE, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getExpense(deps, user, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, INVOICE);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
      },
    },
  },
});
