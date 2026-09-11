import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Deleting a budget cap - `expenseBudgets.spec.ts` creates one and reads it back across all three views
// (caps, rollup, matrix) but never removes it, cleaning up through the API instead. Shares the generic
// `useSoftDelete` mechanism `undo.spec.ts` proves once (on vendors); this is this page's own copy.
test("a budget cap is deleted from the caps table", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const amount = "830000"; // a figure distinctive enough that nothing else in the seed shares it

  // Self-healing: a budget is scope+period unique, and a prior failed run of this very test (create
  // succeeded, the rest didn't) leaves one behind that the form's own duplicate check would then refuse to
  // recreate. Cleared by the amount instead of by scope/period, which drift if the picks above ever change.
  await purgeByAmount(page, Number(amount));

  await gotoRoute(page, "expense-budgets", "Budgets");
  await page.getByRole("button", { name: "New budget" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Category").click();
  await page.getByRole("option").nth(2).click(); // a different category than `expenseBudgets.spec.ts` picks
  await form.getByLabel("Period type").click();
  await page.getByRole("option", { name: /Quarterly/ }).first().click();
  await form.getByLabel("Budget amount").fill(amount);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole("button", { name: /^Caps/ }).click();
  // Rendered through formatMoney (INR grouping), not the bare digits typed above - same locale-proof match
  // `expenseBudgets.spec.ts` uses for its own amount.
  const amountText = /830,000|8,30,000/;
  // Two <tr>s share this text - DataTable renders a plain row and a role="button" one together - so the
  // match is narrowed to the one that actually carries the row's own Actions menu, not just `.first()`.
  const row = page
    .locator("tbody tr")
    .filter({ hasText: amountText })
    .filter({ has: page.getByRole("button", { name: "Actions" }) })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  // The row going is the deletion; the toast is only the app saying so, and it expires on its own timer - so
  // on a lane where the write takes a moment the notification can be gone before anything asks about it. Given
  // a short look, then the record is what the claim rests on.
  await toast(page, "Budget deleted").waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  await expect(page.locator("tbody tr").filter({ hasText: amountText })).toHaveCount(0, { timeout: 30_000 });
});

/** Drop any expense-budget row at this amount - the leftover a failed prior run of this test would create. */
async function purgeByAmount(page: import("@playwright/test").Page, amount: number) {
  const res = await page.request.get("/v1/expense-budgets?page_size=100&show_deleted=true");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; amount?: number }[] };
  for (const b of results.filter((x) => x.amount === amount)) await purge(page, b.path);
}
