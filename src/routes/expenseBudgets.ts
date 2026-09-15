import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import { collectionRoutes } from "../http/collectionRoute";
import { expenseBudgetSpec, listExpenseBudgets } from "../services/expenseBudgets";
import { toExpenseBudgetResource } from "../http/serialize";

const writeSchema = z.object({
  department: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  period_type: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  period_key: z.string().min(1).optional(),
  amount: positiveMoney().optional(),
  recurring: z.boolean().optional(),
}).strict();

export const expenseBudgets = collectionRoutes({
  ...expenseBudgetSpec,
  param: "budget_id",
  // Period scoping and the derived risk filter run server-side: a year of monthly caps is far past one page,
  // so a client-side filter over page one would answer with a subset while reading as the whole collection.
  // The response also carries `summary` over the WHOLE filtered set (and `phase_counts` over that set with the
  // phase chips' own dimension left open), which is what the page's totals and chips read instead of summing
  // the rows that happened to arrive.
  list: (c, page) =>
    listExpenseBudgets(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, {
      period: c.req.query("period"),
      periodKey: c.req.query("period_key"),
      periodType: c.req.query("period_type"),
      year: c.req.query("year"),
      department: c.req.query("department"),
      category: c.req.query("category"),
      status: c.req.query("status"),
    }, undefined, page.deletedOnly),
  writeSchema,
  serialize: toExpenseBudgetResource,
  lifecycleName: "expense-budget",
});
