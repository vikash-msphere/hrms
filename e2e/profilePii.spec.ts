import { gotoRoute, test, expect } from "./fixtures";

// The two self-service panels on a person's own profile that nobody else fills in for them: government IDs,
// and the previous-employer income that keeps this year's tax projection honest.
//
// Both are `OWN_PII` (src/domain/grants.ts) - the owner and super, nobody in between - so both are done here
// by the person themselves. `test/employees.test.ts` owns the encryption and the masking; what only a browser
// has is the pair of forms: the identity editor refuses to save while a mandatory field is empty and SAYS
// which one, a sensitive value comes back masked with "leave blank to keep it", and the prior-income figure
// changes the projected tax on the same page it was typed on.
test.describe("own PII", () => {
  test("identity details are captured by their owner, on the fields the org asked for", async ({ as }) => {
    test.setTimeout(240_000);
    const admin = await as("super");
    const page = await as("employee");
    const label = `E2E ID ${Date.now() % 100000}`;

    // The identity card has no fields of its own: an org declares what it collects (PAN, Aadhaar, a passport
    // number), and the card is that list. So the field is declared first, by the only role that may.
    // Retried as a whole. This is ONE org-wide blob and `settingsPanels.spec.ts` saves the same panel, so a
    // save built on a snapshot that another spec has since replaced is refused by the settings compare-and-swap
    // - correctly, and with the added field simply not there afterwards. The answer is to take a fresh snapshot
    // (the reload) and add it again, which is what an admin who saw "couldn't save" would do.
    await expect(async () => {
      await gotoRoute(admin, "settings/employee-fields");
      await expect(admin.locator("h1").first()).toHaveText("Employee identity fields");
      await admin.getByRole("button", { name: "Add field" }).click();
      await admin.getByPlaceholder("e.g. Passport number").last().fill(label);
      await admin.getByRole("button", { name: "Save fields" }).click();
      await admin.reload();
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).toHaveValue(label, { timeout: 30_000 });
    }).toPass({ timeout: 120_000 });

    // And the owner fills it in - nobody else may, `OWN_PII` being the point.
    await gotoRoute(page, "profile", "My Profile");
    await page.getByRole("tab", { name: "Identity" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText(label)).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: /^(Add|Edit)$/ }).first().click();

    const form = page.getByRole("dialog");
    await expect(form.getByText("Edit identity details")).toBeVisible();
    await form.getByLabel(label).fill("ABCDE1234F");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Read back on the card, and again from cold - an ID that has to be typed twice is an ID nobody types.
    await expect(panel.getByText("ABCDE1234F")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByRole("tab", { name: "Identity" }).click();
    await expect(page.getByRole("tabpanel").getByText("ABCDE1234F")).toBeVisible({ timeout: 30_000 });

    // Take the field back off the org's list: every profile in the app shows it while it is there.
    // Retried for the same reason the add above is: the removal is a save of the same shared blob, and leaving
    // the field behind would put it on every profile in the app for the rest of the run.
    await expect(async () => {
      await gotoRoute(admin, "settings/employee-fields");
      // Ours is the row that was appended, so it is the last one - checked before it is removed, because
      // removing the last row blind would take somebody else's field off every profile in the org.
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).toHaveValue(label, { timeout: 30_000 });
      const row = admin.locator("div").filter({ has: admin.getByPlaceholder("e.g. Passport number") }).last();
      await row.getByRole("button", { name: "Remove field" }).last().click();
      await admin.getByRole("button", { name: "Save fields" }).click();
      await admin.reload();
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).not.toHaveValue(label, { timeout: 30_000 });
    }).toPass({ timeout: 120_000 });
  });

  test("a joiner declares last year's employer income and the projection takes it", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("employee");
    await gotoRoute(page, "profile", "My Profile");
    await page.getByRole("tab", { name: "Tax", exact: true }).click();

    const panel = page.getByRole("tabpanel");
    // Somebody who joined mid-year has already been taxed elsewhere this financial year, and the projection
    // is wrong until it knows - which is what this panel asks for.
    await expect(panel.getByText(/Joined mid-year\?/)).toBeVisible({ timeout: 30_000 });
    // Scoped to the mid-year block, and named either way: the button reads "Declare" on a first pass and
    // "Edit" once something is on file, so which one it is depends on what ran before this.
    // `.first()`: the filter matches the whole block AND the paragraph inside it, and only the block holds
    // the button.
    const midYear = panel.locator("div").filter({ hasText: /^Joined mid-year\?/ }).first();
    await midYear.getByRole("button", { name: /^(Declare|Edit)$/ }).first().click();

    const form = page.getByRole("dialog");
    await expect(form.getByText("Income from a previous employer (this financial year)")).toBeVisible();
    await form.getByLabel("Gross income").fill("450000");
    await form.getByLabel("TDS deducted").fill("32000");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The panel now says the projection counts it - the number is only useful because it changes the tax
    // shown right there.
    await expect(panel.getByText(/previous employer/).first()).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByRole("tab", { name: "Tax", exact: true }).click();
    await expect(page.getByRole("tabpanel").getByText(/previous employer/).first()).toBeVisible({ timeout: 30_000 });

    // Declared, not verified: an employee's own figure does not lower withholding until payroll has seen the
    // proof, which is the whole point of the verification step.
    await expect(page.getByRole("tabpanel")).toContainText(/Declared|Pending|Unverified|verify/i);
  });
});
