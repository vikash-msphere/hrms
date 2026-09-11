import { formatDate } from "../web/src/lib/utils";
import { gotoRoute, purge, test, expect } from "./fixtures";

// A recurring expense - a TEMPLATE, not money spent, so it lives on its own tab and skips the rules that
// only make sense for a real expense (no invoice-required gate, no auto-approve). Nothing in the suite has
// ever created one: the preview line that names the next three actual dates it will generate on - computed
// client-side, the same math a cron applies later - has never been checked against real dates.
test("a recurring expense previews its next three occurrences and lands on its own tab", async ({ as }) => {
  test.setTimeout(220_000);
  const page = await as("super");
  const amount = 1500 + Math.floor(Math.random() * 400);

  await gotoRoute(page, "expenses", "Expenses");
  const form = page.getByRole("dialog");
  // Retried as one whole unit, the OPEN included: the form re-renders as its own category/vendor lists
  // resolve, and a click can land on the checkbox a beat before one of those re-renders replaces it out from
  // under the press - and, on a busier lane, the "New expense" press itself can just as easily miss (a route
  // transition still settling). Retrying only the checkbox click left that second case with nothing to
  // recover it: no dialog ever opened, so `#recurring` was never going to appear no matter how long the wait.
  await expect(async () => {
    // The general "New expense" dialog, not the Recurring tab's own empty-state button - that one only
    // exists while the tab has nothing on it yet, and this org may already have a schedule from an earlier
    // run.
    // Opened at most ONCE, and only from a page with nothing open. `count()` taken while the first dialog is
    // still animating in reads 0, so a retry pressed "New expense" again and left two stacked dialogs - the
    // second one's full-screen overlay then sits above the first and swallows every click aimed at the form
    // underneath ("<div ... intercepts pointer events"). A reload is the one thing that clears a stray layer.
    if ((await form.count()) > 1) await page.reload();
    if (!(await form.count())) {
      await page.getByRole("button", { name: "New expense" }).first().click({ timeout: 8_000 });
      await expect(form.first()).toBeVisible({ timeout: 8_000 });
    }
    const box = form.locator("#recurring");
    await expect(box).toBeVisible({ timeout: 8_000 });
    // Ticked only when it is not already ticked, and confirmed on a field that the tick REVEALS. A retry that
    // clicked it blind turned recurring back off, and "Recurring expense (auto-generated on a schedule)" is the
    // checkbox's own label - present either way - so the loop passed with the schedule fields gone and the fill
    // below then waited out its timeout on a "Next occurrence" that was never going to render.
    if (!(await box.isChecked())) await box.click({ timeout: 8_000 });
    await expect(form.getByLabel("Next occurrence")).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 150_000 });

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
