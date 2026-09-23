import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The spend breakdown - a hand-rolled proportional-bar visualization, not the shared `Chart` component
// `everyChart.spec.ts` walks (it never imports `@/components/common/Chart`, so that sweep's own registry scan
// correctly has nothing to say about it - this is the one place it is actually exercised). Top categories and
// top vendors, by committed spend (approved or paid; a draft is not spend), collapsed behind a toggle so a
// ledger page isn't a dashboard by default.
//
// Aggregate data in a shared org is not this spec's to total exactly - another run's committed spend lands in
// the same buckets - so what is provable is the SHAPE: once there is committed (uncategorised, vendor-less)
// spend, the categories list carries a real row - a proportional bar and a money-formatted total - rather
// than staying empty. The vendors list is left alone: this spend names no vendor, so THAT list staying on its
// own empty state is exactly as correct as the categories list leaving it.
test("committed spend replaces the breakdown's empty state with a real row", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");

  const made = await page.request.post("/v1/expenses", {
    headers: SPA_HEADERS,
    data: { amount: 5000, description: `E2E breakdown spend ${Date.now()}` },
  });
  expect(made.status(), await made.text()).toBe(200);
  const expense = (await made.json()) as { path: string };
  const submitted = await page.request.post(`/v1/${expense.path}:submit`, { headers: SPA_HEADERS });
  expect(submitted.status(), await submitted.text()).toBe(200);
  // Approved by somebody else - payroll holds `expenses.*.approve` - since nobody decides their own expense
  // (services/decisionGuard.ts).
  const approved = await (await as("payroll")).request.post(`/v1/${expense.path}:approve`, { headers: SPA_HEADERS });
  expect(approved.status(), await approved.text()).toBe(200);

  try {
    await gotoRoute(page, "expenses", "Expenses");
    // The breakdown belongs to the whole ledger, so it lives on "All" - the page opens on "Mine" for anyone
    // who is an employee, which everyone signing in here is.
    await page.getByRole("tab", { name: /^All/ }).click();
    await page.getByRole("button", { name: "Spend breakdown" }).click();

    // A real row: a label, a bar whose width is a real percentage of the category's peak, and a money total -
    // named by the row's own title (`label: amount`), which is the one place both live together as one
    // string. "Uncategorised" is what an expense with no category earns, so it is what this spend names.
    const row = page.locator('div[title^="Uncategorised: ₹"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const bar = row.locator("span.bg-primary");
    const width = await bar.evaluate((el) => (el as HTMLElement).style.width);
    expect(width, "the bar has no real width to show").toMatch(/^\d+%$/);
  } finally {
    await purge(page, expense.path);
  }
});
