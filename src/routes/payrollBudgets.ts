import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import { collectionRoutes } from "../http/collectionRoute";
import { payrollBudgetSpec, listPayrollBudgets } from "../services/payrollBudgets";
import { toPayrollBudgetResource } from "../http/serialize";

const writeSchema = z.object({
  department: z.string().nullable().optional(),
  period_type: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  period_key: z.string().min(1).optional(),
  amount: positiveMoney().optional(),
  recurring: z.boolean().optional(),
}).strict();

export const payrollBudgets = collectionRoutes({
  ...payrollBudgetSpec,
  param: "payroll_budget_id",
  // Period scoping runs server-side, and the response carries `summary` over the WHOLE filtered set: a year of
  // monthly caps across every cost centre is far past one page, so totals summed from the rows that happened
  // to arrive would describe page one while reading as the collection.
  list: (c, page) =>
    listPayrollBudgets(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, {
      period: c.req.query("period"),
      periodKey: c.req.query("period_key"),
      periodType: c.req.query("period_type"),
      year: c.req.query("year"),
      department: c.req.query("department"),
    }, undefined, page.deletedOnly),
  writeSchema,
  serialize: toPayrollBudgetResource,
  lifecycleName: "payroll-budget",
});
