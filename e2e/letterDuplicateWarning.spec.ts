import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The duplicate-letter warning - a letter of the same kind already filed for the same person in the last
// 30 days, surfaced before a second one is ever sent rather than discovered afterwards as two documents
// saying the same thing. `letterPdf.spec.ts` generates once and never opens the dialog again, so the warning
// itself has never rendered. Advisory only: the dialog still lets the second one through, since a corrected
// or re-issued letter is legitimate.
test("generating the same letter type for the same person twice is flagged, not silently allowed to look new", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  await gotoRoute(page, "documents");

  await page.getByRole("button", { name: "Generate letter" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Select an employee/ }).click();
  await page.getByPlaceholder("Search employees…").fill("Leo Moore");
  await page.getByRole("button", { name: "Leo Moore", exact: true }).click();
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Employment Verification" }).click();
  await expect(dialog.getByText(/already filed for/)).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Generate", exact: true }).click(),
  ]);
  await expect(toast(page, "Letter generated")).toBeVisible();
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  try {
    // The exact same person, the exact same letter type, opened again straight away.
    await page.getByRole("button", { name: "Generate letter" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Select an employee/ }).click();
    await page.getByPlaceholder("Search employees…").fill("Leo Moore");
    await page.getByRole("button", { name: "Leo Moore", exact: true }).click();
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Employment Verification" }).click();

    // The document is named "<letter type> - <person>", which is what the warning quotes back.
    await expect(dialog.getByText(/"Employment Verification - Leo Moore" was already filed for Leo Moore/)).toBeVisible();
    // Advisory, not a block: the generate button still works, it's just the reader who now has to decide.
    await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();

    // Not actually sent again - the warning is the point of this spec, not a second document.
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
  } finally {
    const res = await page.request.get("/v1/employees?page_size=200");
    const { results: emps = [] } = (await res.json()) as { results?: { path: string; first_name?: string; last_name?: string }[] };
    const leo = emps.find((e) => e.first_name === "Leo" && e.last_name === "Moore");
    if (leo) {
      const docs = await page.request.get(`/v1/personal-documents?employee=${encodeURIComponent(leo.path)}&page_size=200`);
      if (docs.ok()) {
        const { results = [] } = (await docs.json()) as { results?: { path: string; display_name?: string }[] };
        for (const d of results.filter((x) => (x.display_name ?? "").includes("Employment Verification"))) await purge(page, d.path);
      }
    }
  }
});
