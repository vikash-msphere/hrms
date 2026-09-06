import { gotoRoute, inDays, purge, expect, test } from "./fixtures";

// The receipt behind a filing - `ProofField`/`fileProof` (components/common/ProofField.tsx), shared by
// Compliance and Background Checks. `compliance.spec.ts` files an item with neither a reference nor a proof;
// this is the other half: a reference number is a claim, a challan is what an auditor actually asks for, and
// the form itself says so - "filed with neither, nothing proves it later" - until either one is given. What
// only a browser shows is the whole life of that receipt: attaching it clears the warning before anything is
// saved, the saved item reads back as "Proof on file" rather than the drop target it started as, opening it
// downloads the real bytes, and unlinking hands the field back to a drop target without touching the file
// still sitting on the document shelf.
test("a filing's proof clears the warning, uploads, opens, and can be unlinked", async ({ as }) => {
  test.setTimeout(150_000);
  const page = await as("hr");
  const title = `E2E proof ${Date.now()}`;
  const due = inDays(10);

  await gotoRoute(page, "compliance", "Compliance Calendar");
  await page.getByRole("button", { name: "Add item" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Obligation").fill(title);
  await form.getByLabel(/Authority/).fill("EPFO");
  await form.getByLabel("Due date").fill(due);

  await form.getByLabel("Status").click();
  await page.getByRole("option", { name: "Filed", exact: true }).click();
  await expect(form.getByText(/Filed with neither a reference nor a receipt/)).toBeVisible();

  await form.locator('input[type="file"]').first().setInputFiles({
    name: "e2e-challan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  // Staged, not yet uploaded - the warning is about the record being ABOUT to save with nothing, and a file
  // waiting to go up with it already answers that.
  await expect(form.getByText(/Filed with neither a reference nor a receipt/)).toHaveCount(0);

  await form.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  try {
    await page.getByRole("button", { name: "List" }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const edit = page.getByRole("dialog");
    await expect(edit.getByText("Proof on file")).toBeVisible({ timeout: 30_000 });
    // Unlinking is a plain client-side toggle back to the drop target - not asserted against the server,
    // which still has the document; only the FIELD gave it up.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      edit.getByRole("button", { name: "Open" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);

    await edit.getByRole("button", { name: "Unlink" }).click();
    await expect(edit.getByText("Proof on file")).toHaveCount(0);
    await expect(edit.getByText(/PDF or image of the challan/)).toBeVisible();

    await page.keyboard.press("Escape");
    const discard = page.getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
  } finally {
    await purge(page, await eventPath(page, title));
  }
});

async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/compliance-events?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((e) => (e.title ?? e.display_name) === title);
  if (!row) throw new Error(`e2e: the compliance item "${title}" is not in the collection`);
  return row.path;
}
