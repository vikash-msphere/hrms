import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

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

  await purgeMatching(employee, "benefit-enrollments", () => true, plan);
  await purgeMatching(employee, "dependents", (r) => (r.name ?? r.display_name) === "E2E Dependent");
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
