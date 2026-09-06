import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { extractPdfText } from "./pdfText";

// The tag sheet's REAL export, not the calibration one `assetTagPdf.spec.ts` proves the render path with.
// This PDF has no server side at all (web/src/lib/assetTagsPdf.ts assembles it entirely in the browser from
// pdf-lib), so nothing anywhere - not `test/assetTags.test.ts`, not a byte-signature check - has ever
// confirmed it actually draws the QUEUED ASSET'S OWN tag code as real text, rather than only baking it into
// the QR image (which a text check could never see) or drawing whatever the last-used sheet happened to
// have queued.
test("printing a real asset's tag draws that asset's own tag code onto the sheet", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E tag content ${Date.now() % 1_000_000}`;

  const created = await page.request.post("/v1/assets", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const printed = await page.request.post(`/v1/${path}:printTag`, { headers: SPA_HEADERS });
  expect(printed.status(), await printed.text()).toBe(200);
  const tag = ((await printed.json()) as { asset_tag?: string }).asset_tag;
  expect(tag, "the asset came back with no tag to print").toBeTruthy();

  try {
    await gotoRoute(page, "assets", "Assets");
    await page.getByRole("button", { name: "Print tags" }).click();
    await expect(page.getByRole("heading", { name: "Print asset tags" })).toBeVisible();

    await page.getByPlaceholder("Search tag, name, serial…").fill(name);
    const row = page.locator("div").filter({ hasText: name }).last();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Add" }).click();

    const pdfButton = page.getByRole("button", { name: "PDF", exact: true });
    await expect(pdfButton).toBeEnabled({ timeout: 15_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), pdfButton.click()]);
    expect(download.suggestedFilename()).toBe("asset-tags.pdf");

    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("the export produced no file");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(downloadPath);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = await extractPdfText(bytes);
    expect(text).toContain(tag);
  } finally {
    await purge(page, path);
  }
});
