import { gotoRoute, purge, test, expect } from "./fixtures";

// A letterhead's own print version - `letterheads.spec.ts` only ever designs the screen one. Print starts
// as an empty placeholder ("this letterhead prints exactly as it renders") rather than a greyed-out copy of
// the real editor, because a working Add button next to a non-functional Remove one over the WRONG
// version's images was worse than admitting there is nothing here yet. Adding one splits the two versions
// completely apart - nothing done to Print touches Screen afterwards, and switching back proves it.
test("adding a print version gives a letterhead a second, independent page", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const label = `E2E print version ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/identity");
  await page.getByRole("tab", { name: "Letterheads" }).click();
  await page.getByRole("button", { name: "Add letterhead" }).click();
  const designer = page.getByRole("dialog");
  await expect(designer).toBeVisible({ timeout: 30_000 });
  await designer.getByLabel("Name").fill(label);

  // Print, before it exists: a plain admission, not a disabled copy of the screen editor.
  await designer.getByRole("tab", { name: "Print" }).click();
  await expect(designer.getByText("This letterhead prints exactly as it renders")).toBeVisible();
  await expect(designer.getByRole("button", { name: "Drop the print version" })).toHaveCount(0);

  await designer.getByRole("button", { name: "Add a print version" }).click();
  await expect(designer.getByText("This letterhead prints exactly as it renders")).toHaveCount(0);
  await expect(designer.getByRole("button", { name: "Drop the print version" })).toBeVisible();
  await expect(designer.getByText("Nothing here is shared with the screen version", { exact: false })).toBeVisible();
  await expect(designer.getByText(/on the print version/, { exact: false })).toBeVisible({ timeout: 30_000 });

  // Back to Screen: the other version's own editor, untouched by any of the above.
  await designer.getByRole("tab", { name: "Screen" }).click();
  await expect(designer.getByRole("button", { name: "Drop the print version" })).toHaveCount(0);
  await expect(designer.getByText(/on the screen version/, { exact: false })).toBeVisible({ timeout: 30_000 });

  await designer.getByRole("button", { name: "Create letterhead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // Reads back with its print version intact, not just a screen-only design that forgot the split.
    // Both filters: the row is the innermost div that names this letterhead AND carries its Design button.
    // On `hasText` alone, `.last()` lands on whichever nested div is deepest - a leaf holding only the name,
    // once other specs' letterheads have made the list long - and the click then waits out its timeout.
    const row = page.locator("div").filter({ hasText: label }).filter({ has: page.getByRole("button", { name: "Design", exact: true }) }).last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Design", exact: true }).click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByLabel("Name")).toHaveValue(label, { timeout: 30_000 });
    await reopened.getByRole("tab", { name: "Print" }).click();
    await expect(reopened.getByRole("button", { name: "Drop the print version" })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
  } finally {
    const res = await page.request.get("/v1/letterheads?page_size=100");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; label?: string }[] };
      const found = results.find((l) => l.label === label);
      if (found) await purge(page, found.path);
    }
  }
});
