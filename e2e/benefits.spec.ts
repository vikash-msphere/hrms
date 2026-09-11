import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Enrolling in a benefit, with a dependent on the cover.
//
// The employee's benefits page is a self-service surface with two moving parts that only exist once it is
// rendered: the plan card, which says whether this person is in or out and offers the one press that changes
// that, and the enrolment dialog, which is where dependents are attached to the cover. `test/benefitsAdmin`
// owns the rows and the costs. An employee who cannot find the press, or who enrols and sees the card
// unchanged, has no benefits feature at all.
test("an employee adds a dependent and enrols in a plan that covers them", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const employee = await as("employee");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). It lands on the bootstrap read here, so the shell shows its own
  // "Can't reach the server" screen; `gotoRoute` presses the app's own Try again, and this keeps the console
  // line that came with it from failing a test that the retry already recovered.
  allowConsoleErrors(employee, /status of 500|status of 503/i);
  const planName = `E2E Health ${Date.now()}`;

  // The catalogue is HR's business (Settings → Benefit plans), so the plan arrives through the API and this
  // spec stays about the employee's side of it.
  const plan = await makePlan(hr, planName);

  await gotoRoute(employee, "benefits", "Benefits");

  // A dependent first: the person the cover is being extended to.
  await employee.getByRole("button", { name: "Add dependent" }).first().click();
  const dep = employee.getByRole("dialog");
  await expect(dep.getByRole("heading", { name: "Add dependent" })).toBeVisible();
  await dep.getByLabel("Name").fill("E2E Dependent");
  await dep.getByRole("button", { name: /^(Add|Save)/ }).last().click();
  await expect(toast(employee, "Dependent added")).toBeVisible();

  // Then the plan. The card carries the press, and the dialog is where the dependent is put on the cover.
  const card = employee.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: planName }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Enrol" }).click();
  const enrol = employee.getByRole("dialog");
  await expect(enrol.getByRole("heading", { name: `Enrol in ${planName}` })).toBeVisible();
  await enrol.getByRole("checkbox", { name: /E2E Dependent/ }).click();
  await enrol.getByRole("button", { name: "Enrol", exact: true }).click();
  await expect(toast(employee, `Enrolled in ${planName}`)).toBeVisible();

  // The card now says they are in - and offers to CHANGE rather than to enrol again.
  await expect(card.getByRole("button", { name: "Change" })).toBeVisible();

  // Waiving is the other press the card offers right beside it - never pressed anywhere before. Enrolled,
  // it asks first (ending real cover, not a no-op), and the card goes back to offering Enrol afterwards.
  await card.getByRole("button", { name: "Waive" }).click();
  const waiveConfirm = employee.getByRole("dialog");
  await expect(waiveConfirm.getByText(`Waive ${planName}?`)).toBeVisible();
  await expect(waiveConfirm.getByText(/dependents.*ends/i)).toBeVisible();
  await waiveConfirm.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(toast(employee, `Waived ${planName}`)).toBeVisible();
  await expect(card.getByRole("button", { name: "Enrol" })).toBeVisible({ timeout: 30_000 });
  // Waived, so there is nothing left to waive - the button is gone rather than offered a second time.
  await expect(card.getByRole("button", { name: "Waive" })).toHaveCount(0);

  // Removing the dependent itself - a different row entirely from the plan card, and never pressed anywhere
  // before this. No success toast of its own (only a failure one), so the chip actually leaving is the only
  // signal there is. This doubles as this spec's own cleanup for the dependent it added.
  const depChip = employee.locator("span").filter({ hasText: "E2E Dependent" });
  await expect(depChip).toBeVisible({ timeout: 30_000 });
  await depChip.getByRole("button", { name: "Remove" }).click();
  const removeConfirm = employee.getByRole("dialog");
  await expect(removeConfirm.getByText("Remove E2E Dependent?")).toBeVisible({ timeout: 30_000 });
  await removeConfirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(depChip).toHaveCount(0, { timeout: 30_000 });

  await purgeMatching(employee, "benefit-enrollments", () => true, plan);
  await purge(hr, plan);
});

/** A benefit plan for this spec to enrol in. */
async function makePlan(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.post("/v1/benefit-plans", {
    headers: SPA_HEADERS,
    data: { name, category: "health", allows_dependents: true, employee_cost: 0, employer_cost: 1000 },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Purge rows of `collection` the predicate picks out (optionally only those on `plan`). */
async function purgeMatching(
  page: import("@playwright/test").Page,
  collection: string,
  match: (row: Record<string, string>) => boolean,
  plan?: string,
) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) {
    if (plan && r.plan !== plan) continue;
    if (match(r)) await purge(page, r.path!);
  }
}
