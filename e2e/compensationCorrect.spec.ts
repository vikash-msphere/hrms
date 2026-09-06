import { gotoRoute, purge, test, expect } from "./fixtures";

// Fixing a number somebody got wrong.
//
// A compensation timeline is not append-only: a revision entered with a typo has to be correctable in place,
// because the alternative - a second revision "cancelling" the first on the same date - is how a person's pay
// history becomes unreadable. The correction is the same dialog as the revision, opened ON a row, pre-filled
// with what that row says, and the timeline behind it has to restate afterwards.
//
// `compensation` covers entering a revision and reading it back; `test/compensation.test.ts` owns the CTC
// split. What only a browser shows is the correction: that the affordance is on the row it corrects, that the
// dialog arrives carrying that row's figures rather than a blank form, and that the timeline ends up saying
// the corrected number and not the original.
test("a revision is corrected in place and the timeline restates", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("payroll");
  // Two figures no other spec would produce, so both reads below are about this row.
  const wrong = 1_500_000 + (Date.now() % 400) * 1000;
  const right = wrong + 111_000;

  // Driven on the manager's record rather than the employee's: `compensation` revises Eve, and two specs
  // correcting the newest revision on one person would be correcting each other's row.
  await gotoRoute(page, "employees", "Directory");
  await page.getByPlaceholder("Search people…").first().fill("Mara");
  await page.locator("tbody tr").filter({ hasText: "Mara Manager" }).first().click();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();

  await page.getByRole("button", { name: "Revise", exact: true }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("Revise compensation")).toBeVisible();
  await form.getByLabel("Annual CTC").fill(String(wrong));
  await form.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The timeline reads in monthly by default; the annual unit is the one the figures were typed in.
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByText(wrong.toLocaleString("en-US")).first()).toBeVisible({ timeout: 30_000 });

  // The correction lives on the row it corrects, named for the date that row is effective from - which is
  // what stops a page of revisions offering one anonymous "edit".
  await page.getByRole("button", { name: /^Correct the revision effective / }).first().click();
  const fix = page.getByRole("dialog");
  await expect(fix.getByText("Correct revision")).toBeVisible();
  // Pre-filled from the row: a correction dialog that opens blank invites somebody to retype a salary from
  // memory, which is the mistake this whole affordance exists to undo. Compared on the digits alone, since
  // whether the field carries its grouping separators is presentation and not the point.
  await expect
    .poll(async () => ((await fix.getByLabel("Annual CTC").inputValue()) || "").replace(/\D/g, ""))
    .toBe(String(wrong));

  await fix.getByLabel("Annual CTC").fill(String(right));
  await fix.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Restated, not appended: the timeline says the corrected figure.
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByText(right.toLocaleString("en-US")).first()).toBeVisible({ timeout: 30_000 });

  // And from cold, because a correction that lives in the page's state is the old number still being paid.
  await page.reload();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByText(right.toLocaleString("en-US")).first()).toBeVisible({ timeout: 30_000 });

  await purgeNewest(page, "compensation");
});

/** Drop the newest row of a collection - the one this test made. */
async function purgeNewest(page: import("@playwright/test").Page, collection: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (newest) await purge(page, newest.path);
}
