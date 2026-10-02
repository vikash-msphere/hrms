import { apiPost, confirmDelete, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Deleting a budget cap - `expenseBudgets.spec.ts` creates one and reads it back across all three views
// (caps, rollup, matrix) but never removes it, cleaning up through the API instead. Shares the generic
// `useSoftDelete` mechanism `undo.spec.ts` proves once (on vendors); this is this page's own copy.
test("a budget cap is deleted from the caps table", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const amount = "830000"; // a figure distinctive enough that nothing else in the seed shares it

  // A category of the spec's own, picked by name. The org's list is mostly other specs' fixtures, and each of
  // those specs clears the caps on its own category when it finishes - a cap made on one of theirs is deleted
  // under this spec (the UI's delete then answers 404). A fresh category also keeps the scope+period unique, so
  // no leftover of an earlier run can make the form refuse the create.
  const catName = `E2E budget delete category ${Date.now()}-${test.info().parallelIndex}`;
  const madeCat = await apiPost(page, "expense-categories", { display_name: catName });
  expect(madeCat.status(), await madeCat.text()).toBe(200);
  const category = (await madeCat.json()) as { path: string };
  try {
    await gotoRoute(page, "expense-budgets", "Budgets");
    await page.getByRole("button", { name: "New budget" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Category").click();
    await page.getByRole("option", { name: catName, exact: true }).click();
    await form.getByLabel("Period type").click();
    await page.getByRole("option", { name: /Quarterly/ }).first().click();
    await form.getByLabel("Budget amount").fill(amount);
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    await page.getByRole("button", { name: /^Caps/ }).click();
    // The cap's row is the one in this spec's own category (the Scope column names it); the amount alone is
    // shared with any other copy of this spec running at once. Rendered through formatMoney (INR grouping).
    const ours = page.locator("tbody tr").filter({ hasText: catName }).filter({ hasText: /830,000|8,30,000/ });
    // Two <tr>s share this text - DataTable renders a plain row and a role="button" one together - so the
    // match is narrowed to the one that actually carries the row's own Actions menu, not just `.first()`.
    const row = ours
      .filter({ has: page.getByRole("button", { name: "Actions" }) })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await confirmDelete(page);
    // The row going is the deletion; the toast is only the app saying so, and it expires on its own timer - so
    // on a lane where the write takes a moment the notification can be gone before anything asks about it.
    // Given a short look, then the record is what the claim rests on.
    await toast(page, "Budget deleted").waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    await expect(ours).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await purgeCaps(page, category.path);
    await purge(page, category.path);
  }
});

/** Hard-drop every cap on this spec's own category, the deleted one included (it sits in the trash). */
async function purgeCaps(page: import("@playwright/test").Page, categoryPath: string) {
  const res = await page.request.get("/v1/expense-budgets?max_page_size=100&show_deleted=true");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; category?: string | null }[] };
  const id = categoryPath.split("/")[1];
  for (const b of results.filter((x) => x.category?.split("/")[1] === id)) await purge(page, b.path);
}
