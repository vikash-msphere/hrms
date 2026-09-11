import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A letter type's own letterhead can be overridden for a single document - the "Letterhead" picker in
// GenerateLetterDialog.tsx, for an org with several legal entities that issue the same letter type on
// different letterheads. Never driven before this: `letterPrintDownload.spec.ts` proves the DOWNSTREAM print
// variant reading a letterhead baked into the template, never one picked at generation time; `letterheadCopy`
// and `letterheadPrintVersion` never touch this dialog at all. The template's own default carries no print
// version; the override does - so "Download (print)" appearing on the generated document is proof the
// override actually won, not the template's own choice.
test("overriding a letter's letterhead at generation time changes which one the document actually gets", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const defaultLabel = `E2E override default ${stamp}`;
  const printLabel = `E2E override print ${stamp}`;
  const templateLabel = `E2E override template ${stamp}`;

  const madeDefault = await page.request.post("/v1/letterheads", {
    headers: SPA_HEADERS,
    data: { label: defaultLabel, design: {} },
  });
  expect(madeDefault.status(), await madeDefault.text()).toBe(200);
  const defaultLetterhead = (await madeDefault.json()) as { path: string };

  const madePrint = await page.request.post("/v1/letterheads", {
    headers: SPA_HEADERS,
    data: { label: printLabel, design: {}, print_design: {} },
  });
  expect(madePrint.status(), await madePrint.text()).toBe(200);
  const printLetterhead = (await madePrint.json()) as { path: string };

  const madeTemplate = await page.request.post("/v1/letter-templates", {
    headers: SPA_HEADERS,
    data: {
      label: templateLabel,
      letterhead: defaultLetterhead.path,
      blocks: [
        { kind: "subject", text: `Subject: ${templateLabel}` },
        { kind: "para", text: "Dear {{employee.first_name}}, this is the letterhead-override spec." },
      ],
    },
  });
  expect(madeTemplate.status(), await madeTemplate.text()).toBe(200);
  const template = (await madeTemplate.json()) as { path: string };

  let docPath: string | undefined;
  try {
    await gotoRoute(page, "documents");
    await page.getByRole("button", { name: "Generate letter" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Generate letter")).toBeVisible();

    await dialog.getByRole("button", { name: /Select an employee/ }).click();
    await page.getByPlaceholder("Search employees…").fill("Eve");
    await page.getByRole("button", { name: "Eve Employee", exact: true }).click();

    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: templateLabel, exact: true }).click();

    // Defaults to the template's own choice - said as much - before anything is touched.
    await expect(dialog.getByText("What this letter type is set to. Change it for just this document.")).toBeVisible({ timeout: 30_000 });

    // The field is the innermost div that carries the label AND the combobox it labels; `hasText` alone
    // resolves `.last()` to whichever nested div is deepest, which is the bare label once the dialog has
    // grown a hint line under it.
    // The `has:` locator is matched inside each candidate, so it is page-rooted: `dialog.getByRole(...)`
    // would ask for a dialog nested within the field.
    const letterheadField = dialog.locator("div").filter({ hasText: "Letterhead" }).filter({ has: page.getByRole("combobox") }).last();
    await letterheadField.getByRole("combobox").click();
    await page.getByRole("option", { name: printLabel, exact: true }).click();
    await expect(dialog.getByText("Overriding this letter type, for this document only.")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Generate", exact: true }).click(),
    ]);
    await expect(toast(page, "Letter generated")).toBeVisible({ timeout: 30_000 });
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);

    // The proof: the row offers a PRINT download at all, which only the OVERRIDE letterhead has - the
    // template's own default carries no print version.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    const row = page.locator("tbody tr").filter({ hasText: templateLabel }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    docPath = await rowPath(page, templateLabel);
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Download (print)" })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
  } finally {
    if (docPath) await purge(page, docPath);
    await purge(page, template.path);
    await purge(page, printLetterhead.path);
    await purge(page, defaultLetterhead.path);
  }
});

/** The wire path of the personal-document this run generated, named after the template. */
async function rowPath(page: import("@playwright/test").Page, templateLabel: string): Promise<string | undefined> {
  const res = await page.request.get("/v1/personal-documents?page_size=200");
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  return results.find((d) => (d.display_name ?? "").includes(templateLabel))?.path;
}
