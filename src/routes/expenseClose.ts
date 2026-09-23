import { Hono } from "hono";
import type { AppEnv } from "../env";
import { monthEndClose } from "../services/expenses";

// Virtual collection: `GET /v1/expense-close` answers what is unfinished about the month - approved but
// unpaid, waiting on an approver, past its vendor's payment terms, missing a receipt its category demands, a
// recurring schedule that has not filed, and budgets over or forecast over.
//
// A TRANSPORT that owns no data and grants nothing, exactly like /v1/approvals-summary beside it. The
// middleware resolves a list verdict per collection (`closeScopes`) and the service only binds those to count
// queries, so a collection the caller may not list contributes nothing and a caller who may list neither gets
// an empty checklist rather than a refusal.
//
// Server-side because a list is capped at 100 rows: a checklist assembled from what a page happens to hold
// would be a statement about page one wearing the label of the collection.
export const expenseCloseRoute = new Hono<AppEnv>().get("/", async (c) => {
  const checks = await monthEndClose(c.get("deps"), c.get("closeScopes") ?? new Map());
  return c.json({ checks });
});
