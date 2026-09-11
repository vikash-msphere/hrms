import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Opening next month's cap from this month's, rather than typing it in from nothing.
//
// `expenseBudgets.spec.ts` and `budgetViews.spec.ts` own the caps table and the three ways to read it. Roll
// forward is a fourth surface entirely: sizing a NEW period's cap off what the current one already says,
// with an uplift applied across every line the sheet holds and totalled before anything is committed - the
// same shape `PayrollBonuses`'s confirm-before-a-batch-write already needed, for a reason worth restating: a
// cap typed wrong here is next month's spending limit, not a preview.
test("a cap is rolled forward with an uplift, and the total says what changed", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const thisMonth = new Date().toISOString().slice(0, 7); // "2026-09"

  // The whole flow, retried from a fresh category rather than a single shot: a generated id colliding with
  // another writer's in the same instant is a real, if rare, occurrence under this suite's own concurrency
  // (fileLeave's own comment in fixtures.ts documents the same class of thing for leave requests) - if this
  // category's own id were ever reused, its "next period" budget could read back as whichever OTHER test's
  // row landed on the same path, which is a wrong amount this test did not itself produce, not a real defect.
  let category: { path: string } | undefined;
  let budget: { path: string } | undefined;
  let nextBudgetPath: string | undefined;
  try {
    await expect(async () => {
      if (category) await purge(page, category.path).catch(() => undefined); // a prior attempt's own leftovers
      const catName = `E2E roll category ${Date.now()}`;
      // `display_name` is the wire field (services/expenseCategories.ts); `name` is the column behind it, and
      // the request schema refuses keys it does not know rather than dropping them silently.
      const madeCat = await page.request.post("/v1/expense-categories", { headers: SPA_HEADERS, data: { display_name: catName } });
      expect(madeCat.status(), await madeCat.text()).toBe(200);
      category = (await madeCat.json()) as { path: string };

      const madeBudget = await page.request.post("/v1/expense-budgets", {
        headers: SPA_HEADERS,
        data: { category: category.path, department: "", period_type: "monthly", period_key: thisMonth, amount: 100000, recurring: false },
      });
      expect(madeBudget.status(), await madeBudget.text()).toBe(200);
      budget = (await madeBudget.json()) as { path: string };

      // RELOADED, not navigated. Every pass of the outer retry makes a brand-new category and cap, and this
      // is the read that has to see them - but a `gotoRoute` to the route the browser is already on is a
      // same-hash navigation: nothing remounts and nothing re-reads, so pass two onwards would keep looking
      // at pass one's rows (whose category has just been purged) and could never find the new one.
      await gotoRoute(page, "expense-budgets", "Budgets");
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible({ timeout: 30_000 });
      // The caps table's row. `tbody tr` alone also catches the chart's own numbers: every Chart emits its
      // data as an sr-only table for anyone who cannot see the picture, and this category is one of its bars.
      const row = page.locator("tbody tr").filter({ hasText: catName }).filter({ has: page.getByRole("button", { name: "Actions" }) });
      // This page has no category filter, so the row is found only by being on a loaded page - and it sorts
      // newest-first among ALL "current"-period budgets in scope, org-wide. If enough other specs' caps land
      // after this one, "Load more" is how it is reached.
      await expect(async () => {
        if (await row.count()) return;
        const more = page.getByRole("button", { name: "Load more" });
        if (!(await more.count())) throw new Error("expense budgets: category row not on any loaded page");
        await more.click();
        await expect(row.or(more)).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 30_000 });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Duplicate to next period" }).click();

      const dialog = page.getByRole("dialog").filter({ hasText: "Roll forward to the next period" });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      const line = dialog.locator("tbody tr").filter({ hasText: catName });
      const newCap = line.locator('input[type="number"]');
      // Unedited, the new cap repeats this period's exactly - the sheet opens on "same as today", not blank.
      await expect(newCap).toHaveValue("100000");

      // The uplift field, not label-bound (it shares its Field with the Apply/Match-spend buttons) - picked
      // out by its own step, distinct from the per-line "new cap" inputs (step 0.01).
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
      const created = results.find((b) => b.category === category!.path && b.period_key !== thisMonth);
      expect(created, "the rolled-forward budget is not in the collection").toBeTruthy();
      if (created!.amount !== 110000) await purge(page, created!.path); // not this test's own row - dropped before retrying
      expect(created!.amount).toBe(110000);
      nextBudgetPath = created!.path;
    }).toPass({ timeout: 150_000 });
  } finally {
    if (budget) await purge(page, budget.path);
    if (nextBudgetPath) await purge(page, nextBudgetPath);
    if (category) await purge(page, category.path);
  }
});
