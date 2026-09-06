import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A letterhead's own artwork slots (web/src/components/settings/LetterheadDesigner.tsx's "Artwork" sub-tab:
// header mark / stationery / watermark) - `uploadImage`/`deleteImage`, never exercised through the designer
// before this. Each slot is its own hidden file input behind a label ("Add", then "Replace" once something is
// stored), and removing drops it back to nothing - no separate save step either way, the bytes land as soon
// as the file is picked.
test("uploading and removing a letterhead's artwork updates the slot immediately", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const label = `E2E artwork letterhead ${Date.now() % 100000}`;

  const made = await page.request.post("/v1/letterheads", {
    headers: SPA_HEADERS,
    data: { label, design: {} },
  });
  expect(made.status(), await made.text()).toBe(200);
  const letterhead = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "settings/identity");
    await page.getByRole("tab", { name: "Letterheads" }).click();
    // The row is the innermost div that BOTH names this letterhead and carries its Design button. Without
    // the second filter, `.last()` is whichever nested div happens to end up deepest - a leaf holding only
    // the name, once the list is long enough that other specs' letterheads are in it too - and the click
    // below then waits 15s for a button that was never inside what was picked.
    const row = page.locator("div").filter({ hasText: label }).filter({ has: page.getByRole("button", { name: "Design", exact: true }) }).last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Design", exact: true }).click();

    const designer = page.getByRole("dialog");
    await expect(designer.getByLabel("Name")).toHaveValue(label, { timeout: 30_000 });
    await designer.getByRole("tab", { name: "Artwork" }).click();

    // The slot is the innermost div that BOTH names this mark and carries its file input - `hasText` alone
    // resolves `.last()` to the bare caption, which holds neither the Add affordance nor the input.
    const slot = designer.locator("div").filter({ hasText: "Header mark" }).filter({ has: designer.locator('input[type="file"]') }).last();
    await expect(slot.getByText("Add", { exact: true })).toBeVisible({ timeout: 15_000 });
    await slot.locator('input[type="file"]').setInputFiles({
      name: "mark.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG, "base64"),
    });

    const remove = slot.getByRole("button", { name: "Remove header mark" });
    await expect(remove).toBeVisible({ timeout: 30_000 });
    await expect(slot.getByText("Replace", { exact: true })).toBeVisible();
    await expect(slot.getByText("Add", { exact: true })).toHaveCount(0);

    await remove.click();
    await expect(remove).toHaveCount(0, { timeout: 30_000 });
    await expect(slot.getByText("Add", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
  } finally {
    await purge(page, letterhead.path);
  }
});

/** A 1x1 transparent PNG, base64. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
