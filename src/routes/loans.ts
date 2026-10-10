import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listLoans, createLoan, updateLoan,
  approveLoan, rejectLoan, disburseLoan, recordLoanRepayment,
  type LoanInput,
} from "../services/loans";
import { toLoanResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

// `principal` and `installments` are BOUNDED, not merely typed.
//
// A bare `z.number()` accepts 1e9 installments, and the EMI is `principal / installments` put through
// `round2` - which is 0 for any realistic principal. `installmentAmount` then returns 0 every month, so
// payroll recovers nothing and the loan never closes: a payable that quietly never gets paid back, with no
// error at any point. The same holds for a principal large enough that the derived EMI stops being money.
// `.int()` on installments because a fractional count was silently rounded in the service.
//
// The money bound is `positiveMoney()` (http/moneyField.ts) rather than a local one: this file worked the
// hazard out first and every other money input in the app was left bare, so the reasoning is now in the
// shared helper and this is one of its callers. The installment ceiling stays here - 30 years of monthly
// payments is a fact about loans, not about money. Neither is policy: real approval limits are HR's.
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["loan", "advance"]).optional(),
  principal: positiveMoney().optional(),
  installments: z.number().int().min(1).max(360).optional(),
  reason: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
}).strict();

// `allow_duplicate` is the caller confirming that an identical repayment recorded moments ago is a SEPARATE
// one, not their own double-click - the service refuses that case rather than guessing (see
// recordLoanRepayment). Absent/false is the ordinary path.
const repaymentSchema = z.object({ amount: positiveMoney(), allow_duplicate: z.boolean().optional() }).strict();

// Employee loans and advances. Both writes stay the service's own: a loan can only be requested for yourself
// and only edited while PENDING (past that it is a payable that payroll recovers). Delete/restore are the
// shared soft-delete lane; the money movements are the four verbs.
export const loans = collectionRoutes<LoanInput, typeof schema.loans>({
  table: schema.loans,
  collection: "loans",
  auditName: "loan",
  notFound: "loan not found",
  param: "loan_id",
  writeSchema,
  serialize: toLoanResource,
  overrides: {
    create: (deps, actor, input, id) => createLoan(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateLoan(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listLoans(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("status"), page.showDeleted, page.deletedOnly),
  verbs: {
    // If-Match binds a decision to the version the decider looked at (services/decisionGuard.ts).
    approve: { run: (deps, user, id, _body, c) => approveLoan(deps, user, id, c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectLoan(deps, user, id, body.reason, c.req.header("If-Match")) },
    disburse: { run: (deps, user, id, _body, c) => disburseLoan(deps, user, id, c.req.header("If-Match")) },
    recordRepayment: { schema: repaymentSchema, run: (deps, user, id, body) => recordLoanRepayment(deps, user, id, body.amount, body.allow_duplicate === true) },
  },
});
