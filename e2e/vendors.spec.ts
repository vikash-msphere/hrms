import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The vendor catalog - not in `catalogEditors.spec.ts`'s sweep, and nothing else in the suite opens its
// dialog, so none of it has ever run: the same name entered twice (advisory, not blocked - "Acme" and
// "Acme Labs" are different suppliers, and only the person typing knows which), a contact email that
// doesn't look like one (this one DOES block), and the spend summary that only appears once a vendor is
// being edited - read from that vendor's own committed expenses, never counting a draft or a rejected one.
test("a duplicate vendor name warns, a bad email blocks, and editing shows what's been filed", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const nameA = `E2E vendor a ${stamp}`;
  const nameB = `E2E vendor b ${stamp}`;

  await gotoRoute(page, "vendors", "Vendors");

  // Vendor A: plain, with a tax ID that should surface alongside the clash warning later.
  await page.getByRole("button", { name: "New vendor" }).first().click();
  let form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(nameA);
  await form.getByLabel("Tax ID / GSTIN").fill("GSTIN-A1");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(nameA)).toBeVisible({ timeout: 30_000 });

  // Vendor B: walked through both refusals before it's ever valid to save.
  await page.getByRole("button", { name: "New vendor" }).first().click();
  form = page.getByRole("dialog");
  const submit = form.getByRole("button", { name: "Create", exact: true });

  await form.getByLabel("Name").fill(nameA);
  await expect(form.getByText(`"${nameA}" is already on the list (GSTIN-A1)`, { exact: false })).toBeVisible();
  // Advisory only - a repeat name does not block the save by itself.
  await expect(submit).toBeEnabled();

  await form.getByLabel("Contact email").fill("not-an-email");
  await expect(form.getByText("That doesn't look like an email address.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await form.getByLabel("Name").fill(nameB);
  await expect(form.getByText("is already on the list", { exact: false })).toHaveCount(0);
  await form.getByLabel("Contact email").fill("accounts@e2e-vendor.example");
  await expect(form.getByText("That doesn't look like an email address.")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const listed = await page.request.get("/v1/vendors?page_size=200");
  const { results = [] } = (await listed.json()) as { results?: { path: string; display_name?: string }[] };
  const vendorA = results.find((v) => v.display_name === nameA);
  const vendorB = results.find((v) => v.display_name === nameB);
  expect(vendorA, "vendor A is not in the collection").toBeTruthy();
  expect(vendorB, "vendor B is not in the collection").toBeTruthy();

  let expensePath: string | undefined;
  try {
    // Editing vendor A before anything is filed against it.
    const rowA = page.locator("tbody tr").filter({ hasText: nameA });
    await rowA.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editA = page.getByRole("dialog");
    await expect(editA.getByText("Nothing has been filed against this vendor yet.")).toBeVisible();
    await page.keyboard.press("Escape");

    // One committed expense against vendor A - a draft or a rejected one would not count, so this is
    // submitted AND approved before the summary is read back.
    const madeExpense = await page.request.post("/v1/expenses", {
      headers: SPA_HEADERS,
      data: { amount: 4200, vendor: vendorA!.path, description: `E2E vendor spend ${stamp}`, incurred_on: new Date().toISOString().slice(0, 10) },
    });
    expect(madeExpense.status(), await madeExpense.text()).toBe(200);
    const expense = (await madeExpense.json()) as { path: string };
    expensePath = expense.path;
    const submitted = await page.request.post(`/v1/${expense.path}:submit`, { headers: SPA_HEADERS });
    expect(submitted.status(), await submitted.text()).toBe(200);
    const approved = await page.request.post(`/v1/${expense.path}:approve`, { headers: SPA_HEADERS });
    expect(approved.status(), await approved.text()).toBe(200);

    // Those three writes went straight to the API, so the page this browser is holding never heard about them:
    // it already read this vendor's (empty) spend when the dialog was open a moment ago, and a cached read is
    // not re-issued for a write it was never told about. A reload is what a session that missed a write does.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible({ timeout: 30_000 });
    await rowA.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editA2 = page.getByRole("dialog");
    await expect(editA2.getByText("across 1 expense", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(editA2.getByText("4,200", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    if (expensePath) await purge(page, expensePath);
    await purge(page, vendorA!.path);
    await purge(page, vendorB!.path);
  }
});
