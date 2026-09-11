import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listLoans, createLoan, updateLoan,
  approveLoan, rejectLoan, disburseLoan, recordLoanRepayment,
  type LoanInput,
} from "../services/loans";
import { toLoanResource } from "../http/serialize";

// `principal` and `installments` are BOUNDED, not merely typed.
//
// A bare `z.number()` accepts 1e9 installments, and the EMI is `principal / installments` put through
// `round2` - which is 0 for any realistic principal. `installmentAmount` then returns 0 every month, so
// payroll recovers nothing and the loan never closes: a payable that quietly never gets paid back, with no
// error at any point. The same holds for a principal large enough that the derived EMI stops being money.
// `.finite()` because `z.number()` admits Infinity (JSON cannot carry it, but a non-JSON caller can), and
// `.int()` on installments because a fractional count was silently rounded in the service.
//
// The ceilings are deliberately generous rather than policy: 30 years of monthly instalments, and a
// principal past which the figure is a typo rather than a loan. Real approval limits are HR's, not a schema's.
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["loan", "advance"]).optional(),
  principal: z.number().finite().positive().max(1_000_000_000).optional(),
  installments: z.number().int().min(1).max(360).optional(),
  reason: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
}).strict();

// `allow_duplicate` is the caller confirming that an identical repayment recorded moments ago is a SEPARATE
// one, not their own double-click - the service refuses that case rather than guessing (see
// recordLoanRepayment). Absent/false is the ordinary path.
const repaymentSchema = z.object({ amount: z.number().finite().positive().max(1_000_000_000), allow_duplicate: z.boolean().optional() }).strict();

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
  list: (c, page) => listLoans(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("status"), page.showDeleted),
  verbs: {
    approve: { run: (deps, user, id) => approveLoan(deps, user, id) },
    reject: { run: (deps, user, id) => rejectLoan(deps, user, id) },
    disburse: { run: (deps, user, id) => disburseLoan(deps, user, id) },
    recordRepayment: { schema: repaymentSchema, run: (deps, user, id, body) => recordLoanRepayment(deps, user, id, body.amount, body.allow_duplicate === true) },
  },
});
