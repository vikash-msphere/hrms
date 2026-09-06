import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The benefit plan editor (Settings → Benefits) - `catalogEditors.spec.ts` proves a bare-named plan saves,
// but never touches billing period, cost, category or Dependents, so the one thing this form actually
// computes live - which suffix "Employee cost" and "Employer cost" carry - is untested, and so is the row
// behind the dialog repeating the same period and the Dependents badge it earns.
test("switching a benefit plan's billing period relabels both cost fields, and the saved row repeats it", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const name = `E2E benefit plan ${Date.now()}`;

  await gotoRoute(page, "settings/benefit-plans");
  await page.getByRole("button", { name: "New plan" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Provider").fill("E2E Insurer");

  // Monthly by default: both cost fields say so.
  await expect(form.getByText("Employee cost /mo")).toBeVisible();
  await expect(form.getByText("Employer cost /mo")).toBeVisible();

  await form.getByLabel("Billing period").click();
  await page.getByRole("option", { name: "Per year" }).click();
  await expect(form.getByText("Employee cost /yr")).toBeVisible();
  await expect(form.getByText("Employer cost /yr")).toBeVisible();
  await expect(form.getByText("Employee cost /mo")).toHaveCount(0);

  await form.getByLabel("Employee cost /yr").fill("12000");
  await form.getByLabel("Employer cost /yr").fill("18000");
  await form.locator("label", { hasText: "Dependents can be covered" }).getByRole("checkbox").click();

  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    const row = page.locator("div").filter({ hasText: name }).filter({ hasText: "Dependents" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // The employer/employee costs as saved, repeated with the SAME period suffix the form was left on.
    await expect(row).toContainText("E2E Insurer");
    await expect(row).toContainText("/yr");
    await expect(row).not.toContainText("/mo");
  } finally {
    const res = await page.request.get("/v1/benefit-plans?page_size=200", { headers: SPA_HEADERS });
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
      const created = results.find((p) => p.name === name);
      if (created) await purge(page, created.path);
    }
  }
});
