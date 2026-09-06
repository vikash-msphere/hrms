import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Opening next month's cap from this month's, rather than typing it in from nothing.
//
// `expenseBudgets.spec.ts` and `budgetViews.spec.ts` own the caps table and the three ways to read it. Roll
// forward is a fourth surface entirely: sizing a NEW period's cap off what the current one already says,
// with an uplift applied across every line the sheet holds and totalled before anything is committed - the
// same shape `PayrollBonuses`'s confirm-before-a-batch-write already needed, for a reason worth restating: a
// cap typed wrong here is next month's spending limit, not a preview.
test("a cap is rolled forward with an uplift, and the total says what changed", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const catName = `E2E roll category ${Date.now()}`;

  // `display_name` is the wire field (services/expenseCategories.ts); `name` is the column behind it, and the
  // request schema refuses keys it does not know rather than dropping them silently.
  const madeCat = await page.request.post("/v1/expense-categories", { headers: SPA_HEADERS, data: { display_name: catName } });
  expect(madeCat.status(), await madeCat.text()).toBe(200);
  const category = (await madeCat.json()) as { path: string };

  const thisMonth = new Date().toISOString().slice(0, 7); // "2026-09"
  const madeBudget = await page.request.post("/v1/expense-budgets", {
    headers: SPA_HEADERS,
    data: { category: category.path, department: "", period_type: "monthly", period_key: thisMonth, amount: 100000, recurring: false },
  });
  expect(madeBudget.status(), await madeBudget.text()).toBe(200);
  const budget = (await madeBudget.json()) as { path: string };
  let nextBudgetPath: string | undefined;

  try {
    await gotoRoute(page, "expense-budgets", "Budgets");
    // The caps table's row. `tbody tr` alone also catches the chart's own numbers: every Chart emits its data
    // as an sr-only table for anyone who cannot see the picture, and this category is one of its bars.
    const row = page.locator("tbody tr").filter({ hasText: catName }).filter({ has: page.getByRole("button", { name: "Actions" }) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate to next period" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Roll forward to the next period" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const line = dialog.locator("tbody tr").filter({ hasText: catName });
    const newCap = line.locator('input[type="number"]');
    // Unedited, the new cap repeats this period's exactly - the sheet opens on "same as today", not blank.
    await expect(newCap).toHaveValue("100000");

    // The uplift field, not label-bound (it shares its Field with the Apply/Match-spend buttons) - picked out
    // by its own step, distinct from the per-line "new cap" inputs (step 0.01).
    await dialog.locator('input[type="number"][step="0.5"]').fill("10");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(newCap).toHaveValue("110000");
    await expect(dialog.getByText(/Opening .*110,000.* of new caps against .*100,000.* today - \+10%\./)).toBeVisible();

    await dialog.getByRole("button", { name: "Create 1 budget", exact: true }).click();
    await expect(toast(page, "Budget rolled forward")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The new period's own row, at the uplifted amount - not still sitting in the dialog's local state.
    const nextRes = await page.request.get(`/v1/expense-budgets?page_size=200`);
    const { results = [] } = (await nextRes.json()) as { results?: { path: string; category?: string; period_key?: string; amount?: number }[] };
    const created = results.find((b) => b.category === category.path && b.period_key !== thisMonth);
    expect(created, "the rolled-forward budget is not in the collection").toBeTruthy();
    expect(created!.amount).toBe(110000);
    nextBudgetPath = created!.path;
  } finally {
    await purge(page, budget.path);
    if (nextBudgetPath) await purge(page, nextBudgetPath);
    await purge(page, category.path);
  }
});
