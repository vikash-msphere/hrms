import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { invalidArgument } from "../lib/errors";
import { narrateBudgets } from "../services/budgetNarrate";
import type { PeriodType } from "../domain/expenses";
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

const budgets = collectionRoutes({
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

// How this period's budgets moved against the previous one, in a sentence. A GET on the collection rather
// than a custom method: it changes nothing, derives everything from caps the caller can already list, and a
// verb would need its own ACCESS_VERBS entry and grant to gate a read the collection already gates.
//
// `/narration` is registered BEFORE the factory so it is not read as a budget id. Ids are opaque wire tokens,
// so the word can never collide with one.
export const expenseBudgets = new Hono<AppEnv>()
  .get("/narration", async (c) => {
    const type = (c.req.query("period_type") ?? "monthly") as PeriodType;
    if (type !== "monthly" && type !== "quarterly" && type !== "yearly") throw invalidArgument("period_type must be monthly, quarterly, or yearly");
    const n = await narrateBudgets(c.get("deps"), c.get("user"), type, c.req.query("period_key") ?? undefined);
    // camelCase is the domain's spelling; the wire's is snake_case, and the conversion belongs here rather
    // than in a pure module that has no business knowing what HTTP looks like.
    return c.json({
      path: "expense-budgets/narration",
      text: n.text,
      source: n.source,
      cached: n.cached,
      period_key: n.period_key,
      compared_to: n.compared_to,
      findings: n.findings.map((f) => ({
        key: f.key, label: f.label, unit: f.unit, direction: f.direction,
        previous: f.previous, current: f.current, change_pct: f.changePct, movement: f.movement,
      })),
    });
  })
  .route("/", budgets);
