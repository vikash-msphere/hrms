import { allowConsoleErrors, gotoRoute, test, expect, toast } from "./fixtures";

// Taking a revision back out - not the same affordance as `compensationCorrect.spec.ts`'s in-place fix, and
// not reachable by the same actor either: the seeded grant gives payroll_admin only WRITE on `compensation.**`
// (create + update - `compensationCorrect.spec.ts`'s "Correct" press), and this ladder's "full" tier (delete +
// purge) is never handed out to any role in the seed - only super's wildcard bypass reaches it. That is
// exactly why Remove has never been pressed: every other compensation spec runs as payroll, on purpose.
// Removing carries its own confirm copy that names WHO the person ends up on: the previous revision resumes,
// or (only if this were the sole revision) nobody has a price at all - and the correctness that matters is
// exactly that restatement, not just that a row disappears.
test("a revision is removed, and the previous one resumes as the timeline restates", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // Driven on the manager's record - Mara is not written by any other spec (`compensation` revises Eve,
  // `compensationCorrect` was moved off Mara onto Aadhya Patel after the two collided here: both specs held
  // an etag for the same row, and whichever saved second 409'd on the other's write). Kept as a retry rather
  // than a single shot anyway, since a stuck dialog from a slow save is cheaper to reload past than to debug.
  allowConsoleErrors(page, /status of 409/);
  const added = 1_500_000 + (Date.now() % 400) * 1000;

  await gotoRoute(page, "employees", "Directory");
  await page.getByPlaceholder("Search people…").first().fill("Mara");
  await page.locator("tbody tr").filter({ hasText: "Mara Manager" }).first().click();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
  await page.getByRole("button", { name: "Annual", exact: true }).click();

  // The figure this revision will fall back TO, read before adding anything - the whole point is proving the
  // timeline goes back to this number, not just that the new one disappears.
  const priorText = await page.locator("tbody tr").first().innerText();

  await expect(async () => {
    // A prior attempt's own dialog, left open by its own 409: closed first, or "Revise" underneath it is not
    // there to press. Escape (with the draft guard's own "Discard changes?" answered too) has proven
    // unreliable at actually closing a dialog under load elsewhere in this suite - a real reload is
    // unconditional, so it is what clears a stuck one here too, at the cost of re-navigating back to the tab.
    if (await page.getByRole("dialog").count()) {
      await page.reload();
      await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
      await page.getByRole("button", { name: "Annual", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }
    await page.getByRole("button", { name: "Revise", exact: true }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Revise compensation")).toBeVisible();
    await form.getByLabel("Annual CTC").fill(String(added));
    await form.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(added.toLocaleString("en-US")).first()).toBeVisible({ timeout: 30_000 });

  const removeBtn = page.getByRole("button", { name: /^Remove the revision effective / }).first();
  await removeBtn.click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText(/^Remove the revision effective /)).toBeVisible();
  // Named, not generic: the previous revision's own figure and date, since that is who the person becomes.
  await expect(confirm.getByText(/The previous revision \(.+\) takes over this period/)).toBeVisible();
  await confirm.getByRole("button", { name: "Remove revision", exact: true }).click();
  await expect(toast(page, "Revision removed")).toBeVisible({ timeout: 30_000 });

  // Gone, and the earlier figure is back reading as current - not just one fewer row.
  await expect(page.getByText(added.toLocaleString("en-US"))).toHaveCount(0, { timeout: 30_000 });
  // `priorText` was captured via `.innerText()`, which tabs between table cells (the browser's own layout-based
  // algorithm) - `toHaveText`'s default recompute goes through `textContent()` instead (no separators at all),
  // so a plain comparison never matches regardless of the row's actual content. `useInnerText` puts both sides
  // through the same extraction.
  await expect(page.locator("tbody tr").first()).toHaveText(priorText, { timeout: 30_000, useInnerText: true });

  // And from cold: a removal that only lived in the page's own state would still be paying the added figure.
  await page.reload();
  await page.getByRole("tab", { name: /Compensation|Pay/ }).first().click();
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByText(added.toLocaleString("en-US"))).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toHaveText(priorText, { useInnerText: true });
});
