import { gotoRoute, purge, test, expect } from "./fixtures";

// The "Require a receipt" checkbox itself - `reimbursementReceiptGate.spec.ts` proves what the flag DOES
// (blocks a claim with no file attached), but only against the seeded "Travel" category, which already
// carries it. Nothing has ever set the checkbox in this editor, or proved the setting it carries over to
// "add another" for a run of categories that all want the same rule.
test("a reimbursement category is created with Require a receipt on, and the setting carries to the next one", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const stamp = Date.now();
  const nameA = `E2E receipt category a ${stamp}`;
  const nameB = `E2E receipt category b ${stamp}`;

  await gotoRoute(page, "settings/reimbursements");
  await page.getByRole("tab", { name: "Categories" }).click();
  await page.getByRole("button", { name: "New category" }).first().click();
  let form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(nameA);
  await form.getByLabel("Require a receipt").check();
  await form.getByText("Keep this open to add another").click();
  await form.getByRole("button", { name: "Create & add another", exact: true }).click();

  // Still open, ready for the next one - and the receipt rule is still checked without retyping it.
  form = page.getByRole("dialog");
  await expect(form.getByLabel("Name")).toHaveValue("");
  await expect(form.getByLabel("Require a receipt")).toBeChecked();
  await form.getByLabel("Name").fill(nameB);
  await form.getByRole("button", { name: "Create & add another", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

  try {
    for (const name of [nameA, nameB]) {
      const row = page.locator("tbody tr").filter({ hasText: name });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText("Required");
    }
  } finally {
    const res = await page.request.get("/v1/reimbursement-categories?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
      for (const c of results.filter((r) => r.display_name === nameA || r.display_name === nameB)) await purge(page, c.path);
    }
  }
});
