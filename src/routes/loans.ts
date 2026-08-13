import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listLoans, createLoan, updateLoan,
  approveLoan, rejectLoan, disburseLoan, recordLoanRepayment,
  type LoanInput,
} from "../services/loans";
import { toLoanResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["loan", "advance"]).optional(),
  principal: z.number().optional(),
  installments: z.number().optional(),
  reason: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
}).strict();

const repaymentSchema = z.object({ amount: z.number() }).strict();

// Employee loans and advances. Both writes stay the service's own: a loan can only be requested for yourself
// and only edited while PENDING (past that it is a payable that payroll recovers). Delete/restore are the
// shared soft-delete lane; the money movements are the four verbs.
export const loans = collectionRoutes<LoanInput>({
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
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listLoans(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("status"), c.req.query("show_deleted") === "true");
  },
  verbs: {
    approve: { run: (deps, user, id) => approveLoan(deps, user, id) },
    reject: { run: (deps, user, id) => rejectLoan(deps, user, id) },
    disburse: { run: (deps, user, id) => disburseLoan(deps, user, id) },
    recordRepayment: { schema: repaymentSchema, run: (deps, user, id, body) => recordLoanRepayment(deps, user, id, body.amount) },
  },
});
