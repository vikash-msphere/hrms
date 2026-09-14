import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Overriding a letter type's own e-signature setting, for one document - `letterPdf.spec.ts` only ever
// drives "Employment Verification" (a template with no e-signature block at all), so this checkbox and the
// sentence explaining what it will do have never been touched. "Confidentiality & IP Assignment Agreement"
// carries an e-signature block and needs no other typed input, so it drives the toggle without dragging in
// compensation data.
test("the e-signature checkbox defaults to the template's own setting, and says so until it's touched", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  await gotoRoute(page, "documents");

  await page.getByRole("button", { name: "Generate letter" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Generate letter")).toBeVisible();

  await dialog.getByRole("button", { name: /Select an employee/ }).click();
  await page.getByPlaceholder("Search employees…").fill("Eve");
  await page.getByRole("option", { name: "Eve Employee", exact: true }).click();

  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Confidentiality & IP Assignment Agreement" }).click();

  const esign = dialog.locator("label", { hasText: "Require e-signature" }).getByRole("checkbox");
  // On, because the template carries an e-signature block - and said to be the template's own choice.
  await expect(esign).toBeChecked();
  await expect(dialog.getByText("Following this template's own setting.")).toBeVisible();

  // Off: no ambiguity about what happens, and the sentence now says this document is the exception.
  await esign.click();
  await expect(esign).not.toBeChecked();
  await expect(dialog.getByText("Filed as a final document - nobody is asked to sign it.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Overriding this template.", { exact: false })).toBeVisible();

  // Back on: the VALUE matches the template again, but it is still an override once it has been touched.
  await esign.click();
  await expect(esign).toBeChecked();
  await expect(dialog.getByText("The employee signs it in place; the letter locks once signed.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Overriding this template.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Following this template's own setting.")).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Generate", exact: true }).click(),
  ]);
  await expect(toast(page, "Letter generated")).toBeVisible();
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  const eve = await (async () => {
    const res = await page.request.get("/v1/employees?page_size=200");
    const { results = [] } = (await res.json()) as { results?: { path: string; first_name?: string; last_name?: string }[] };
    return results.find((e) => e.first_name === "Eve" && e.last_name === "Employee")?.path;
  })();
  if (eve) {
    const docs = await page.request.get(`/v1/personal-documents?employee=${encodeURIComponent(eve)}&page_size=200`);
    if (docs.ok()) {
      const { results = [] } = (await docs.json()) as { results?: { path: string; display_name?: string; create_time?: string }[] };
      const created = [...results]
        .filter((d) => (d.display_name ?? "").includes("Confidentiality"))
        .sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
      if (created) await purge(page, created.path);
    }
  }
});
