import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// "Save as a copy" - never pressed by `letterheads.spec.ts`, which only ever creates and removes one design.
// The split happens server-side (the artwork is carried across, never re-uploaded through the browser), and
// the open dialog then follows the COPY rather than staying on the original - the design just split off is
// what the reader is now working on, and it's already saved, so closing the dialog can't lose it.
test("Save as a copy splits a letterhead in two, and the dialog follows the new one", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const label = `E2E copy source ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/identity");
  await page.getByRole("tab", { name: "Letterheads" }).click();
  await page.getByRole("button", { name: "Add letterhead" }).click();
  const designer = page.getByRole("dialog");
  await expect(designer).toBeVisible({ timeout: 30_000 });
  await designer.getByLabel("Name").fill(label);
  await designer.getByRole("button", { name: "Create letterhead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // Both filters: the row is the innermost div that names this letterhead AND carries its Design button.
    // On `hasText` alone, `.last()` lands on whichever nested div is deepest - a leaf holding only the name,
    // once other specs' letterheads have made the list long - and the click then waits out its timeout.
    const row = page.locator("div").filter({ hasText: label }).filter({ has: page.getByRole("button", { name: "Design", exact: true }) }).last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Design", exact: true }).click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByLabel("Name")).toHaveValue(label, { timeout: 30_000 });

    await reopened.getByRole("button", { name: "Save as a copy" }).click();
    await expect(toast(page, `Saved as "${label} copy"`)).toBeVisible({ timeout: 30_000 });
    // The dialog followed the split, not the original - it now names the copy, still open, already saved.
    await expect(reopened.getByLabel("Name")).toHaveValue(`${label} copy`, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // Both exist: the split added a second row rather than renaming the first.
    await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 30_000 });
    // `exact`, because the "Saved as …" toast quotes the same name and its live region repeats it: a loose
    // match resolves to those two as readily as to the new row, and fails on strict mode rather than on the
    // thing being checked.
    await expect(page.getByText(`${label} copy`, { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    const res = await page.request.get("/v1/letterheads?page_size=100");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; label?: string }[] };
      for (const l of results.filter((x) => x.label === label || x.label === `${label} copy`)) await purge(page, l.path);
    }
  }
});
