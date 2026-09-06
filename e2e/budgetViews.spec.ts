import { gotoRoute, test, expect } from "./fixtures";

// One set of caps, read three ways.
//
// A budget page is not a table; it is the same rows answered to three different questions - what are the
// caps (the table), how is each scope doing against them (the rollup), and what does the year look like
// month by month (the grid). Each is composed in the browser from the rows already fetched, the rollup
// regroups on demand, and the year grid is a separate read that only happens once that view is asked for.
//
// `expenseBudgets` covers creating a cap and reading its utilisation; it never leaves the first view.
// `test/expenseBudgetRecurring.test.ts` owns the recurrence. What only a browser shows is that the other two
// views exist, draw their own thing, and are reachable both from the switcher and from the number that makes
// somebody want them.
test.describe("the budget views", () => {
  test("the switcher draws the caps, the rollup and the year", async ({ as }) => {
    test.setTimeout(120_000);
    // Budgets are an admin surface, and super is the role `expenseBudgets` uses for the same reason.
    const page = await as("super");
    await gotoRoute(page, "expense-budgets", "Budgets");

    // The caps view is where the page lands: the rollup's own heading is the thing that is NOT on it.
    await expect(page.getByRole("heading", { name: "Rollup" })).toHaveCount(0);

    await page.getByRole("button", { name: "Rollup" }).click();
    await expect(page.getByRole("heading", { name: "Rollup" })).toBeVisible({ timeout: 30_000 });

    // The rollup's whole point is the grouping, and changing it re-asks the question of the same rows: the
    // first column is the group, so its header is what says which question was asked.
    await expect(page.getByRole("columnheader", { name: "Cost centre" })).toBeVisible();
    await page.getByRole("combobox").filter({ hasText: "By cost centre" }).first().click();
    await page.getByRole("option", { name: "By category" }).click();
    await expect(page.getByRole("columnheader", { name: "Category" })).toBeVisible({ timeout: 30_000 });

    // The year grid is its own read, made only when this view is opened - so "it rendered" is also the proof
    // the lazy fetch happened.
    await page.getByRole("button", { name: "Year" }).click();
    await expect(page.getByRole("heading", { name: "Monthly caps by scope" })).toBeVisible({ timeout: 30_000 });

    // And back, so the switcher is a switcher rather than a one-way trip.
    // `exact`: a metric tile above the table is named "Budgeted ₹5,100,000 2 caps", which a substring match
    // on "Caps" also reaches.
    await page.getByRole("button", { name: "Caps", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Monthly caps by scope" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Rollup" })).toHaveCount(0);
  });

  test("the spend figure opens the view that explains it", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    await gotoRoute(page, "expense-budgets", "Budgets");

    // A metric that states a number and cannot be opened is a dead end: "Spent" is the question, the rollup
    // is the answer, and the tile is the way between them.
    await page.getByRole("button").filter({ hasText: "Spent" }).first().click();
    await expect(page.getByRole("heading", { name: "Rollup" })).toBeVisible({ timeout: 30_000 });
  });
});
