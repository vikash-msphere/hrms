import { z } from "zod";
import { positiveMoney, nonNegativeMoney } from "../http/moneyField";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { extractReceipt, MAX_RECEIPT_CHARS } from "../services/receiptExtract";
import { invalidArgument } from "../lib/errors";
import {
  listExpenses, getExpense, createExpense, updateExpense,
  submitExpense, approveExpense, rejectExpense, cancelExpense, payExpense, seriesDriftFor, paymentDueFor, allocationsFor, expenseTriageFor,
  settledExpenseIds,
  type ExpenseInput,
} from "../services/expenses";
import { putAttachment, downloadAttachment, attachedObjectIds, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { toExpenseResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

const COL = "expenses";
const INVOICE = "invoice"; // the attachment slot for an expense's invoice/receipt

const paymentMethod = z.enum(["bank", "card", "cash", "upi", "cheque"]);
const receiptSchema = z.object({ text: z.string().min(1).max(MAX_RECEIPT_CHARS) }).strict();

const writeSchema = z
  .object({
    employee: z.string().nullable().optional(),
    vendor: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    amount: positiveMoney(),
    // NOT nullable: `expenses.tax_amount` is NOT NULL defaulting to 0, and the serializer emits it on every
    // response. "No tax" is 0, not null.
    tax_amount: nonNegativeMoney().optional(),
    incurred_on: z.string().nullable().optional(),
    // Kilometres or days on a rated category. The SERVER multiplies by the rate and overwrites `amount`, so a
    // client sending both is sending a preview, not an instruction.
    quantity: z.number().nullable().optional(),
    // A split across cost centres. Omitted leaves any existing split alone; [] clears it; a list replaces it
    // whole and must sum to the expense (the service checks against the STORED amount).
    allocations: z.array(z.object({
      department: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      amount: positiveMoney(),
    }).strict()).optional(),
    description: z.string().nullable().optional(),
    invoice_number: z.string().nullable().optional(),
    payment_method: paymentMethod.nullable().optional(),
    reimbursable: z.boolean().optional(),
    recurring: z.boolean().optional(),
    recurrence_rule: z.enum(["monthly", "quarterly", "yearly"]).nullable().optional(),
    next_occurrence_on: z.string().nullable().optional(),
    paused: z.boolean().optional(),
  })
  .strict();
// PATCH allows the same fields but with amount optional (partial edit of a draft).
const patchSchema = writeSchema.partial();

// Company expenses. An expense is only editable while a DRAFT and is never deleted (it is cancelled), and the
// table has no delete_time - so the factory mounts no DELETE and no `:restore`. Both writes stay the service's
// own: the create resolves vendor/category/budget, the update refuses anything past DRAFT.
export const expenses = collectionRoutes<ExpenseInput, typeof schema.expenses>({
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
  // Drift rides along for the same reason: a generated occurrence that does not cost what its series usually
  // costs is only useful where somebody is already looking at it, and deriving it per row would be a query an
  // expense. Both lookups are bounded to the page.
  decorate: async (deps, _actor, rows) => {
    const [attached, drift, due, split, triage, settled] = await Promise.all([
      attachedObjectIds(deps, COL, INVOICE, rows.map((r) => r.uuid)),
      seriesDriftFor(deps, rows),
      paymentDueFor(deps, rows),
      allocationsFor(deps, rows.map((r) => r.uuid)),
      // Only does any work when the page holds claims actually awaiting a decision; a ledger page of paid rows
      // returns an empty map without a read.
      expenseTriageFor(deps, rows),
      // Whether an approved row's money has already moved, which is what refuses `:cancel` on it.
      settledExpenseIds(deps, rows),
    ]);
    return rows.map((r) => ({
      ...r,
      settled: settled.has(r.uuid),
      hasInvoice: attached.has(r.uuid),
      seriesDrift: drift.get(r.uuid) ?? null,
      dueOn: due.get(r.uuid) ?? null,
      allocations: split.get(r.uuid) ?? null,
      signals: triage.get(r.uuid) ?? null,
    }));
  },
  overrides: {
    create: (deps, actor, input) => createExpense(deps, actor, input),
    update: (deps, actor, id, patch) => updateExpense(deps, actor, id, patch),
  },
  list: (c, page) =>
    listExpenses(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      state: c.req.query("state"),
      department: c.req.query("department"),
      category: c.req.query("category"),
      vendor: c.req.query("vendor"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      q: c.req.query("q"),
    }),
  verbs: {
    submit: { run: (deps, user, id) => submitExpense(deps, user, id) },
    approve: { run: (deps, user, id, _body, c) => approveExpense(deps, user, id, c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectExpense(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelExpense(deps, user, id) },
    // Fill a DRAFT claim's fields from its receipt. The TEXT is posted by the client because the Worker
    // cannot read a PDF - the SPA already runs pdfjs for the viewer - which also keeps a PDF parser out of
    // the Worker and a large parse off its CPU budget. That is why this reads invoices and not photographs;
    // see services/receiptExtract.ts for why a vision model was refused rather than postponed.
    //
    // `raw`, because the answer is a set of SUGGESTED values, not an expense resource. Nothing is written to
    // the claim here: accepting a field is the ordinary PATCH, with its ordinary audit row.
    extractReceipt: {
      raw: async (c, id) => {
        const parsed = receiptSchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw invalidArgument("body must be { text }");
        const out = await extractReceipt(c.get("deps"), c.get("user"), id, parsed.data.text);
        return c.json({ fields: out.fields, cached: out.cached });
      },
    },
    // The payment details are optional and shaped by the service, so the body is taken as sent.
    pay: { run: async (deps, user, id, _body, c) => payExpense(deps, user, id, await jsonBody(c), c.req.header("If-Match")) },
    // The invoice goes up as raw bytes, but the answer is the expense itself (now carrying its invoice flag).
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: INVOICE, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getExpense(deps, user, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, INVOICE);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(att, "invoice") });
      },
    },
  },
});
