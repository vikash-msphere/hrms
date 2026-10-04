import { gotoRoute, purge, test, expect } from "./fixtures";

// The last payment somebody is owed.
//
// A full & final settlement is a leaver's terminal payout: unused leave encashed, notice shortfall recovered,
// dues netted off, computed once and STORED as a snapshot so a later recompute cannot quietly rewrite what
// was paid. `test/settlement.test.ts` owns that arithmetic. What only a browser has is the form that feeds
// it - the settlement date, the notice shortfall and the encashable days are HR's judgement, entered here -
// and the breakdown that comes back, which is the number a leaver argues about. It lives on the person's pay
// tab rather than on a payroll page, because a settlement is about one person leaving.
test("HR computes a leaver's full and final settlement, and the breakdown reads back", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");

  await gotoRoute(page, "employees", "Directory");
  await page.getByRole("searchbox", { name: "Search people…" }).fill("Eve");
  await page.locator("tbody tr").filter({ hasText: "Eve Employee" }).first().click();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();

  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Full & final settlement")).toBeVisible({ timeout: 30_000 });

  // Nothing is computed until somebody asks: an FnF is a decision, not a number the page derives on its own.
  const compute = panel.getByRole("button", { name: /^(Compute|Recompute)$/ });
  await expect(compute).toBeVisible();
  await compute.click();

  // The three inputs that are HR's judgement rather than the ledger's: when it settles, how much notice was
  // short, and how many leave days are being encashed (blank = whatever the balance says).
  const form = page.getByRole("dialog");
  await expect(form.getByText(/full & final settlement/i)).toBeVisible();
  await form.getByLabel("Notice shortfall (days)").fill("2");
  await form.getByLabel("Encashable leave (days)").fill("3");
  await form.getByRole("button", { name: /^(Compute|Recompute)$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The breakdown: what is being paid and what is being recovered, itemised. A settlement that says only a
  // total is one nobody can check.
  await expect(panel.getByText(/Encash|Leave encashment/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Notice/i).first()).toBeVisible();

  // And it is stored, not recomputed on sight: the same figures come back from cold, which is what makes a
  // settlement something the leaver can be shown twice.
  await page.reload();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
  await expect(page.getByRole("tabpanel").getByText(/Encash|Leave encashment/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tabpanel").getByRole("button", { name: "Recompute" })).toBeVisible();

  await purgeSettlements(page);
});

/** Drop the settlement this spec computed, so the leaver's record is as it was. */
async function purgeSettlements(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/settlements?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (newest) await purge(page, newest.path);
}
