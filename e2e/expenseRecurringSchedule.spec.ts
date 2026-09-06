import { formatDate } from "../web/src/lib/utils";
import { gotoRoute, purge, test, expect } from "./fixtures";

// A recurring expense - a TEMPLATE, not money spent, so it lives on its own tab and skips the rules that
// only make sense for a real expense (no invoice-required gate, no auto-approve). Nothing in the suite has
// ever created one: the preview line that names the next three actual dates it will generate on - computed
// client-side, the same math a cron applies later - has never been checked against real dates.
test("a recurring expense previews its next three occurrences and lands on its own tab", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const amount = 1500 + Math.floor(Math.random() * 400);

  await gotoRoute(page, "expenses", "Expenses");
  // The general "New expense" dialog, not the Recurring tab's own empty-state button - that one only exists
  // while the tab has nothing on it yet, and this org may already have a schedule from an earlier run.
  await page.getByRole("button", { name: "New expense" }).first().click();
  const form = page.getByRole("dialog");
  await form.locator("#recurring").click();
  await expect(form.getByText("Recurring expense (auto-generated on a schedule)")).toBeVisible();

  await form.getByLabel("Amount").fill(String(amount));
  // Monthly is the default rule; a known start date makes the preview's three dates exact.
  await form.getByLabel("Next occurrence").fill("2027-01-15");
  const expected = ["2027-01-15", "2027-02-15", "2027-03-15"].map((d) => formatDate(d)).join(", ");
  await expect(form.getByText(`Generates on ${expected}, and so on.`)).toBeVisible();

  // Quarterly instead: the same three-date preview follows the rule change, not just the start date.
  await form.getByLabel("Repeats").click();
  await page.getByRole("option", { name: "Quarterly" }).click();
  const expectedQuarterly = ["2027-01-15", "2027-04-15", "2027-07-15"].map((d) => formatDate(d)).join(", ");
  await expect(form.getByText(`Generates on ${expectedQuarterly}, and so on.`)).toBeVisible();

  // A recurring template skips the invoice-required gate a real expense would carry - there is no invoice
  // for a schedule that hasn't generated anything yet.
  await expect(form.getByText("This category requires an invoice.")).toHaveCount(0);

  await form.getByRole("button", { name: "Create schedule", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    await page.getByRole("tab", { name: /^Recurring/ }).click();
    const row = page.locator("tbody tr").filter({ hasText: "Quarterly" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(formatDate("2027-01-15"));
  } finally {
    const res = await page.request.get("/v1/expenses?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; recurring?: boolean; next_occurrence_on?: string; amount?: number }[] };
      const created = results.find((r) => r.recurring && r.next_occurrence_on === "2027-01-15" && r.amount === amount);
      if (created) await purge(page, created.path);
    }
  }
});
