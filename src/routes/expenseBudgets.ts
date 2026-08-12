import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { expenseBudgetSpec } from "../services/expenseBudgets";
import { toExpenseBudgetResource } from "../http/serialize";

const writeSchema = z.object({
  department: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  period_type: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  period_key: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
}).strict();

export const expenseBudgets = collectionRoutes({
  ...expenseBudgetSpec,
  param: "budget_id",
  writeSchema,
  serialize: toExpenseBudgetResource,
  lifecycleName: "expense-budget",
});
