import { SPA_HEADERS, personPath, purge, gotoRoute, test, expect, toast } from "./fixtures";

// Two row actions on the asset register that `assets.spec.ts` (assigning) and `assetReissueTag.spec.ts`
// (the tag) never reach: taking an asset back off someone ("Return"), and removing one from the register
// outright. Removing is worth its own care - this collection has no soft-delete/restore at all, so the
// confirm copy says "permanently deleted... there is no undo", and that claim had never been checked.
test("an assigned asset is returned to stock, and a separate one is removed for good", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("it");
  const stamp = Date.now();
  const returnName = `E2E return asset ${stamp}`;
  const removeName = `E2E remove asset ${stamp}`;
  const eve = await personPath(page, "employee");

  const madeReturn = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name: returnName, assigned_to: eve, status: "assigned" },
  });
  expect(madeReturn.status(), await madeReturn.text()).toBe(200);
  const returnPath = ((await madeReturn.json()) as { path: string }).path;

  const madeRemove = await page.request.post("/v1/assets", { headers: SPA_HEADERS, data: { name: removeName } });
  expect(madeRemove.status(), await madeRemove.text()).toBe(200);
  const removePath = ((await madeRemove.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "assets", "Assets");

    // Return: unassigns and parks the row waiting on a check-in scan rather than pretending the asset is
    // back the moment somebody clicks a button.
    const returnRow = page.locator("tbody tr").filter({ hasText: returnName });
    await expect(returnRow).toHaveCount(1, { timeout: 30_000 });
    await returnRow.getByRole("button", { name: "Return", exact: true }).click();
    const returnConfirm = page.getByRole("dialog").filter({ hasText: "Return this asset to the company?" });
    await expect(returnConfirm).toBeVisible({ timeout: 30_000 });
    await returnConfirm.getByRole("button", { name: "Return", exact: true }).click();
    await expect(toast(page, /Returned/)).toBeVisible({ timeout: 30_000 });
    await expect(returnRow).not.toContainText("Eve Employee", { timeout: 30_000 });
    // Unassigned lands on the unproven state ahead of in_stock, not in_stock itself - the same custody policy
    // (statusForAssignment) a fresh unassigned create lands on, per its own confirm copy above ("waits as
    // 'Awaiting check-in' until someone scans its tag back into stock"). `assigned_to` is omitted from the
    // wire entirely once null (toAssetResource), not sent back as an explicit null/undefined - so its absence
    // is its own check rather than a key inside toMatchObject.
    await expect
      .poll(async () => {
        const r = await page.request.get(`/v1/${returnPath}`);
        return r.ok() ? ((await r.json()) as { assigned_to?: string; status?: string }) : undefined;
      }, { timeout: 30_000 })
      .toMatchObject({ status: "pending_verification" });
    const after = (await (await page.request.get(`/v1/${returnPath}`)).json()) as { assigned_to?: string };
    expect(after.assigned_to, "a returned asset should carry no assignee").toBeUndefined();

    // Remove: no soft-delete/restore on this collection at all, so this is the only chance to prove the
    // confirm's "there is no undo" is actually true and not just brave copy.
    const removeRow = page.locator("tbody tr").filter({ hasText: removeName });
    await expect(removeRow).toHaveCount(1, { timeout: 30_000 });
    // Icon-only (Trash2) with no visible text - "Remove asset" is its title, not "Remove" (that's the
    // confirm dialog's own button, checked below).
    await removeRow.getByRole("button", { name: "Remove asset", exact: true }).click();
    const removeConfirm = page.getByRole("dialog").filter({ hasText: "Remove this asset?" });
    await expect(removeConfirm).toBeVisible({ timeout: 30_000 });
    await expect(removeConfirm.getByText(/permanently deleted.*no undo/)).toBeVisible();
    await removeConfirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toast(page, "Asset removed")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("tbody tr").filter({ hasText: removeName })).toHaveCount(0, { timeout: 30_000 });

    const gone = await page.request.get(`/v1/${removePath}`);
    expect(gone.status(), "a removed asset should be genuinely gone, not soft-deleted").toBe(404);
  } finally {
    await purge(page, returnPath);
    await purge(page, removePath);
  }
});
