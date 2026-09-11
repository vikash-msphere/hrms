import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A required custom input field - `letterTemplates.spec.ts` adds one but never checks its "Required" box,
// and every OTHER letter-generation spec deliberately picks a stock template with no inputs at all, so
// `missingRequiredInputs` (the thing that actually disables Generate) has never run. The label itself is
// the first tell: a required field's label carries no "(optional)" suffix, unlike every other input.
test("a required letter input blocks Generate until it's filled", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const label = `E2E Required Letter ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/letters");
  // Added and CONFIRMED as one retried unit, by the button's own name rather than by its position in the
  // rail (the rail is a shared list, and other letter specs add to it while this runs). The editor opening
  // on the new type is what proves the add landed: the rail renders from the shared `letter-templates`
  // snapshot, and the panel's own selection reconciliation (LettersTab.tsx - `setSelId` falls back to the
  // list's first row whenever the selected id is not in the latest fetch it has seen) can be handed a
  // pre-add snapshot, leaving the editor on whichever type was selected before - somebody else's, on a busy
  // lane. Reloading re-establishes the list and the selection together.
  const inRail = () => page.getByRole("button", { name: label, exact: true });
  await expect(async () => {
    if ((await page.getByLabel("Label").inputValue().catch(() => "")) === label) return;
    await page.reload();
    await expect(page.getByPlaceholder("New letter type…")).toBeVisible({ timeout: 15_000 });
    // If an earlier pass DID create it, pick it rather than adding a second one under the same name: the
    // cleanup at the end finds this type by that name, and two of them would leave one behind for good.
    if (await inRail().count()) {
      await inRail().first().click({ timeout: 8_000 });
    } else {
      await page.getByPlaceholder("New letter type…").fill(label);
      await page.getByRole("button", { name: "Add letter type" }).click({ timeout: 8_000 });
    }
    await expect(page.getByLabel("Label")).toHaveValue(label, { timeout: 15_000 });
  }).toPass({ timeout: 90_000 });

  const blocks = page.getByRole("tabpanel");
  await addBlock(page, "Subject");
  await blocks.getByRole("textbox").last().fill("Your E2E letter");
  await addBlock(page, "Paragraph");
  await blocks.getByRole("textbox").last().fill("Dear {{employee.first_name}}, reason: {{reason}}.");

  await page.getByRole("tab", { name: "Input fields" }).click();
  await page.getByRole("button", { name: "Add input field" }).click();
  const inputs = page.getByRole("tabpanel");
  await inputs.getByPlaceholder("key").fill("reason");
  await inputs.getByPlaceholder("Label").fill("Reason");
  await inputs.getByRole("checkbox", { name: "Required" }).check();

  const save = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(save).toBeEnabled();
  await save.click();
  // The toast, not the button: Save disables the instant it starts (it is `loading` as well as `!dirty`), so
  // `toBeDisabled` is satisfied while the PATCH is still in flight and the spec would leave the page mid-save.
  await expect(toast(page, "Letter template saved")).toBeVisible({ timeout: 30_000 });
  await expect(save).toBeDisabled();

  try {
    await gotoRoute(page, "documents", "Documents");
    await page.getByRole("button", { name: "Generate letter" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Select an employee/ }).click();
    await page.getByPlaceholder("Search employees…").fill("Eve");
    await page.getByRole("button", { name: "Eve Employee", exact: true }).click();
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: label }).click();

    // No "(optional)" on this one - the tell that it's required, before anything is typed.
    const reasonField = dialog.getByLabel("Reason", { exact: true });
    await expect(reasonField).toBeVisible();
    await expect(dialog.getByLabel("Reason (optional)")).toHaveCount(0);

    const generate = dialog.getByRole("button", { name: "Generate", exact: true });
    await expect(generate).toBeDisabled();
    await reasonField.fill("E2E test reason");
    await expect(generate).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent("download"), generate.click()]);
    await expect(toast(page, "Letter generated")).toBeVisible({ timeout: 30_000 });
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  } finally {
    const docs = await page.request.get("/v1/personal-documents?page_size=200");
    if (docs.ok()) {
      const { results = [] } = (await docs.json()) as { results?: { path: string; display_name?: string }[] };
      const created = results.find((d) => (d.display_name ?? "").includes(label));
      if (created) await purge(page, created.path);
    }
    await gotoRoute(page, "settings/letters");
    await page.getByRole("button", { name: label }).click();
    await page.getByRole("button", { name: /^Delete/ }).first().click();
    const confirmDialog = page.getByRole("dialog");
    await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
  }
});

/** Add a content block of the given kind to the open template. */
async function addBlock(page: import("@playwright/test").Page, kind: string) {
  await page.getByRole("tabpanel").getByRole("combobox").last().click();
  await page.getByRole("option", { name: kind, exact: true }).click();
}
