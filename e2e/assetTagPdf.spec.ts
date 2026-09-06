import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The sticker sheet, built in the browser.
//
// Asset tags are printed against physical label stock, where a millimetre matters: the browser's own print
// dialog silently rescales, so the printer offers a PDF drawn to exact geometry by pdf-lib - lazy-imported,
// assembled in memory, and handed over through a blob URL. `test/assetTags.test.ts` owns the tag codes and
// the custody rules; the PDF has no server side at all, so the only place its lazy import, its page geometry
// and its download can be observed is a real browser clicking the button.
//
// Calibration mode is what this drives: it is the one export that needs no queued tags (it prints the
// outlines you hold against a sheet to nudge the offsets), so the spec proves the PDF path without depending
// on which assets happen to be seeded or on their tag codes having been minted.
test("the tag printer exports a calibration sheet as a real PDF", async ({ as }) => {
  const page = await as("super");
  // The printer is offered against stock: with an empty register there is nothing to print tags for, and the
  // button is not there. So this brings one asset of its own rather than depending on what is seeded.
  const asset = await makeAsset(page);

  await gotoRoute(page, "assets", "Assets");
  await page.getByRole("button", { name: "Print tags" }).click();
  await expect(page.getByRole("heading", { name: "Print asset tags" })).toBeVisible();

  // Outlines only: no queue needed, and the export button stops being disabled.
  await page.getByRole("button", { name: "Calibrate" }).click();
  const pdfButton = page.getByRole("button", { name: "PDF", exact: true });
  await expect(pdfButton).toBeEnabled();

  const [download] = await Promise.all([page.waitForEvent("download"), pdfButton.click()]);
  expect(download.suggestedFilename()).toBe("tag-sheet-calibration.pdf");

  const path = await download.path();
  if (!path) throw new Error("the export produced no file");
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  // A failed lazy import, or a sheet drawn with no pages, gives an empty or truncated body rather than this.
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);

  await purge(page, asset);
});

/** One asset, so the page has stock to offer the printer against. */
async function makeAsset(page: import("@playwright/test").Page): Promise<string> {
  const category = await assetCategory(page);
  const res = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name: `E2E tag asset ${Date.now()}`, category },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/**
 * The category an asset has to be filed under - the org's own if it has one, otherwise a fresh one.
 *
 * A PAGE of them, and the first that does not demand a serial: `assetSerialRequired.spec.ts` keeps a
 * `requires_serial` category in the table for the length of its own run, and taking that one refuses the
 * asset below ("a serial number is required for …") for a reason nothing here is about.
 */
async function assetCategory(page: import("@playwright/test").Page): Promise<string> {
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  expect(existing.status(), await existing.text()).toBe(200);
  const rows = ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return found;

  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E tag category ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}
