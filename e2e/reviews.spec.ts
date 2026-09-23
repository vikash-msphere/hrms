import { gotoRoute, purge, test, expect } from "./fixtures";

// A review cycle, launched at somebody.
//
// Launching is the one irreversible press on the cycles page: it puts a review on every chosen person's
// plate and asks their manager for theirs. So the UI deliberately splits it in three - create (which asks
// nobody for anything), pick who, then a PREVIEW that says what launching will do before it does it. That
// three-step shape, and the review then appearing on the reviewee's own page, is the part that only exists
// in the browser; `test/reviewFlow.test.ts` owns what a launch writes.
test("HR creates a cycle, previews the launch, and the reviewee finds their review", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const name = `E2E cycle ${Date.now()}`;

  await gotoRoute(hr, "settings/performance", "Performance framework");
  await hr.getByRole("tab", { name: "Review cycles" }).click();
  await hr.getByRole("button", { name: /New cycle|Create cycle|New review cycle/ }).first().click();
  const form = hr.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: /^(Create|Save)/ }).last().click();

  // A draft cycle asks nobody for anything yet - that is what makes launching a separate press.
  const card = hr.locator("div.shadow-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Draft/i);

  await card.getByRole("button", { name: "Launch" }).click();
  const picker = hr.getByRole("dialog");
  await expect(picker.getByRole("heading", { name: new RegExp(`Launch .${name}`) })).toBeVisible();
  await picker.getByPlaceholder("Search name…").fill("Eve");
  await picker.getByRole("checkbox").last().click();
  await picker.getByRole("button", { name: "Review and launch" }).click();

  // The preview: what launching is about to do, named and counted, with a way back to change it.
  const preview = hr.getByRole("dialog");
  await expect(preview.getByRole("button", { name: "Change who" })).toBeVisible();
  await preview.getByRole("button", { name: /^Launch for \d+/ }).click();

  // The cycle is running, and the review is on the reviewee's own page - which is the whole point of a
  // launch, and the only place it can be seen.
  await expect(hr.locator("div.shadow-card").filter({ hasText: name }).first()).toContainText(/Active/i);

  await gotoRoute(employee, "reviews", "Reviews");
  await expect(employee.getByText(name).first()).toBeVisible();

  // Close it and take it away again: a live cycle nags everybody it touches.
  await gotoRoute(hr, "settings/performance", "Performance framework");
  await hr.getByRole("tab", { name: "Review cycles" }).click();
  const running = hr.locator("div.shadow-card").filter({ hasText: name }).first();
  await running.getByRole("button", { name: "Close" }).click();
  await expect(running).toContainText(/Closed/i);
  await purge(hr, await cyclePath(hr, name));
});

/** The wire path of the cycle this spec created. */
async function cyclePath(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.get("/v1/review-cycles?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
  const row = results.find((c) => (c.name ?? c.display_name) === name);
  if (!row) throw new Error(`e2e: the cycle "${name}" is not in the collection`);
  return row.path;
}
