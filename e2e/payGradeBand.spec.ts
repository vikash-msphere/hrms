import { gotoRoute, purge, test, expect } from "./fixtures";

// The salary band, not just the grade's name - `catalogEditors.spec.ts` proves the catalog takes a row; this
// proves the one thing on that row with real arithmetic behind it. A midpoint pushed off-centre quietly skews
// every compa-ratio computed against the grade, so the form draws the bar and says the percentage rather than
// letting three numbers hide it, and refuses to save an order that doesn't hold (min above max, mid outside
// either end) rather than storing a band nobody could read.
test("a pay grade's band centres, flags an off-centre midpoint, and refuses a bad order", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E grade ${Date.now()}`;

  await gotoRoute(page, "settings/pay-grades");
  // `.first()`: the toolbar button. An EMPTY table offers the very same action again in its placeholder
  // (DataTable takes one `createBtn` for both `toolbar` and `emptyAction`), and this catalog starts empty.
  await page.getByRole("button", { name: "New grade" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Grade name").fill(name);

  await form.getByPlaceholder("Min").fill("1000000");
  await form.getByPlaceholder("Max").fill("2000000");
  // No midpoint yet: the form offers to centre it rather than silently having no compa-ratio for anyone here.
  await expect(form.getByText("No midpoint, so no compa-ratio for anyone on this grade.")).toBeVisible();
  const centre = form.getByRole("button", { name: /Use the centre/ });
  await expect(centre).toBeVisible();
  await centre.click();
  await expect(form.getByText("Midpoint 50% through the band", { exact: false })).toBeVisible();
  await expect(form.getByText("(off-centre)")).toHaveCount(0);

  // Skewed low: 10% through a band this wide is exactly the shape the warning exists for.
  await form.getByPlaceholder("Mid").fill("1100000");
  await expect(form.getByText("Midpoint 10% through the band (off-centre)")).toBeVisible();

  // Min above max: refused on the field, and the submit follows it.
  const submit = form.getByRole("button", { name: "Create", exact: true });
  await form.getByPlaceholder("Min").fill("2500000");
  await expect(form.getByText("Min is above max.")).toBeVisible();
  await expect(submit).toBeDisabled();

  // Back to a real band, and this time saved.
  await form.getByPlaceholder("Min").fill("1000000");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("2,000,000");
  } finally {
    await purgeGrade(page, name);
  }
});

async function purgeGrade(page: import("@playwright/test").Page, name: string): Promise<void> {
  const res = await page.request.get("/v1/pay-grades?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const row = results.find((g) => g.display_name === name);
  if (row) await purge(page, row.path);
}
