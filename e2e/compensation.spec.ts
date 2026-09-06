import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// What somebody is paid, and the two ways it changes: a revision to the standing figure, and a one-off bonus.
//
// `test/compensation.test.ts` owns the CTC split and `test/bonuses.test.ts` the award. What only a browser
// has is that both are entered against a live timeline: a revision derives basic and allowances from the CTC
// as it is typed and lands on a date, and the timeline afterwards has to READ BACK the new figure - a person's
// pay silently reverting to the old number is the worst possible outcome of a form that looked like it saved.
test.describe("compensation", () => {
  test("a revision is entered and the timeline reads back the new CTC", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("payroll");
    // A figure no other spec would produce, so reading it back off the timeline means this revision and not
    // a leftover.
    const ctc = 1_800_000 + (Date.now() % 900) * 1000;

    // Somebody's own profile page, on the pay tab - compensation is never a list, it is one person's history.
    await gotoRoute(page, "employees", "Directory");
    await page.getByPlaceholder("Search people…").fill("Eve");
    await page.locator("tbody tr").filter({ hasText: "Eve Employee" }).first().click();
    await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();

    await page.getByRole("button", { name: "Revise", exact: true }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Revise compensation")).toBeVisible();

    // One number in; the split out. Basic is a percentage of CTC and a special allowance balances the rest,
    // which the form derives rather than asking anybody to compute.
    await form.getByLabel("Annual CTC").fill(String(ctc));
    await expect(form.getByText(/Basic/).first()).toBeVisible();
    await form.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Read back on the timeline. The timeline shows monthly by default - the number most people think in -
    // so it is switched to annual, the unit the revision was entered in, and the figure has to be the one
    // that was typed.
    const annual = ctc.toLocaleString("en-US");
    await page.getByRole("button", { name: "Annual", exact: true }).click();
    await expect(page.getByText(annual).first()).toBeVisible({ timeout: 30_000 });

    // And again from cold, because a revision that lives only in the page's state is a pay cut nobody ordered.
    await page.reload();
    await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
    await page.getByRole("button", { name: "Annual", exact: true }).click();
    await expect(page.getByText(annual).first()).toBeVisible({ timeout: 30_000 });

    await purgeNewest(page, "compensation");
  });

  // HR awards, payroll pays: the seeded policy gives `bonuses` write to HR and read to payroll, because a
  // bonus is a decision about a person rather than a payroll operation.
  test("a bonus is awarded to one person and lands on the bonus list", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");
    const reason = `E2E bonus ${Date.now() % 100000}`;

    // An award is recorded against the person, on their own pay tab: it is a decision about them, and the
    // payroll run that covers its award date is what pays it out.
    await gotoRoute(page, "employees", "Directory");
    await page.getByPlaceholder("Search people…").fill("Eve");
    await page.locator("tbody tr").filter({ hasText: "Eve Employee" }).first().click();
    await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();

    await page.getByRole("button", { name: "Record bonus" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Record bonus / incentive")).toBeVisible();

    // Nothing to record until there is an amount and a date to pay it on, which the disabled Save says.
    const save = form.getByRole("button", { name: "Save", exact: true });
    await form.getByLabel("Amount").fill("25000");
    await form.getByLabel("Reason (optional)").fill(reason);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // On their record, with the reason it was given for - and still there after a reload, because an award
    // nobody can find is an award nobody gets paid.
    await expect(page.getByText(reason)).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
    await expect(page.getByText(reason)).toBeVisible({ timeout: 30_000 });

    await purgeBonus(page, reason);
  });
});

/** Drop the newest row of a collection - the one the test just made. */
async function purgeNewest(page: import("@playwright/test").Page, collection: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (newest) await purge(page, newest.path);
}

/** Drop the bonus this spec awarded. */
async function purgeBonus(page: import("@playwright/test").Page, reason: string) {
  const res = await page.request.get("/v1/bonuses?page_size=100", { headers: SPA_HEADERS });
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string }[] };
  for (const b of results.filter((x) => x.reason === reason)) await purge(page, b.path);
}
