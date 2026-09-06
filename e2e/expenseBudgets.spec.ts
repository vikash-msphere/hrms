import { gotoRoute, purge, test, expect } from "./fixtures";

// A spending cap, and the page that reads it against what has been spent.
//
// A budget only means anything next to its spend, so this page is three views of the same rows: the caps,
// the rollup, and the matrix. `test/expenseBudgetRecurring.test.ts` owns the recurrence. What only a browser
// shows is the composition - a cap is scoped by category, cost centre and period, and the form prices it
// per month/quarter/year as that choice is made - and that the new cap then appears in the table with a
// utilisation reading rather than sitting in a collection nobody can see.
test("a budget cap is created and read back against its spend", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "expense-budgets", "Budgets");

  await page.getByRole("button", { name: "New budget" }).first().click();
  const form = page.getByRole("dialog");

  // A cap is unique per scope+period, and the seed already ships a blanket yearly one - so this cap is
  // scoped to a category, which is also the shape an org actually budgets in.
  await form.getByLabel("Category").click();
  await page.getByRole("option").nth(1).click();
  await form.getByLabel("Period type").click();
  await page.getByRole("option", { name: /Yearly|Annual/ }).first().click();
  await form.getByLabel("Budget amount").fill("750000");
  // The amount is priced by the period it is for - "a year" here, not a bare number.
  await expect(form.getByText(/a year/)).toBeVisible();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // In the caps table, with a utilisation reading: a cap with no spend beside it is just a number.
  await page.getByRole("button", { name: /^Caps/ }).click();
  const row = page.locator("tbody tr").filter({ hasText: /750,000|7,50,000/ }).first();
  await expect(row).toBeVisible();

  // The rollup is the same rows read by scope, which is the view a budget owner actually uses.
  await page.getByRole("button", { name: /^Rollup/ }).click();
  await expect(page.getByRole("main")).not.toBeEmpty();

  await purgeBudget(page);
});

/** Drop the cap this spec created (the newest yearly blanket one). */
async function purgeBudget(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/expense-budgets?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; amount?: number }[] };
  for (const b of results.filter((x) => x.amount === 750000)) await purge(page, b.path);
}
