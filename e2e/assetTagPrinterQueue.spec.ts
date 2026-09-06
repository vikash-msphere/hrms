import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The two ways the sticker queue is cleared - `assetTagPdf.spec.ts` deliberately stays in Calibration mode
// to avoid needing a queue at all, so neither "Clear queue" (queued tags off, used-slot marks stay) nor
// "New sheet" (both cleared - offered only when the sheet actually has something to lose) has ever run.
// Both ask first: a queue is easy to rebuild by hand, a used-slot mark on a physical sheet already spent is
// not.
test("clearing the queue and starting a new sheet each confirm before they take anything", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const asset = await makeAsset(page);

  await gotoRoute(page, "assets", "Assets");
  await page.getByRole("button", { name: "Print tags" }).click();
  await expect(page.getByRole("heading", { name: "Print asset tags" })).toBeVisible();

  const row = page.locator("div").filter({ hasText: `E2E printer asset` }).filter({ has: page.getByRole("button", { name: /^Add/ }) }).last();
  await row.getByRole("button", { name: /^Add/ }).click();
  await expect(row.getByText("queued ×1")).toBeVisible();

  // Clear queue: only offered once there is one to clear, and it says exactly what it will and won't touch.
  // Filtered by its own text, not just "dialog" - the printer itself is one, still open underneath it.
  const clearQueue = page.getByRole("button", { name: "Clear queue", exact: true });
  await expect(clearQueue).toBeVisible();
  await clearQueue.click();
  const clearConfirm = page.getByRole("dialog").filter({ hasText: "Clear the queue?" });
  await expect(clearConfirm).toBeVisible();
  await expect(clearConfirm.getByText("Takes all 1 queued tag off the sheets. Used-slot marks stay.")).toBeVisible();
  await clearConfirm.getByRole("button", { name: "Clear queue", exact: true }).click();
  await expect(clearConfirm).toHaveCount(0, { timeout: 15_000 });
  await expect(clearQueue).toHaveCount(0);
  await expect(row.getByText("queued ×1")).toHaveCount(0);

  // Queued again, then a whole new sheet: this one clears used-slot marks too, so it asks in stronger terms.
  await row.getByRole("button", { name: /^Add/ }).click();
  await expect(row.getByText("queued ×1")).toBeVisible();
  await page.getByRole("button", { name: "New sheet", exact: true }).click();
  const newSheetConfirm = page.getByRole("dialog").filter({ hasText: "Start a new blank sheet?" });
  await expect(newSheetConfirm).toBeVisible();
  await expect(newSheetConfirm.getByText("Clears the queue and every used-slot mark.", { exact: false })).toBeVisible();
  await newSheetConfirm.getByRole("button", { name: "New sheet", exact: true }).click();
  await expect(newSheetConfirm).toHaveCount(0, { timeout: 15_000 });
  await expect(row.getByText("queued ×1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear queue", exact: true })).toHaveCount(0);

  await purge(page, asset);
});

/** One asset, so the printer has stock to queue. */
async function makeAsset(page: import("@playwright/test").Page): Promise<string> {
  const category = await assetCategory(page);
  const res = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name: `E2E printer asset ${Date.now()}`, category },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/**
 * The category an asset has to be filed under - the org's own if it has one, otherwise a fresh one.
 *
 * A PAGE of them, and the first that does not demand a serial. `assetSerialRequired.spec.ts` puts a
 * `requires_serial` category in the table for the length of its own run, and on a wide run "the first
 * category" is sometimes that one - which refuses the asset below ("a serial number is required for …") for a
 * reason nothing here is about.
 */
async function assetCategory(page: import("@playwright/test").Page): Promise<string> {
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  expect(existing.status(), await existing.text()).toBe(200);
  const rows = ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return found;

  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E printer category ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}
