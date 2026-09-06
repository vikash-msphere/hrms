import { SPA_HEADERS, gotoRoute, toast, test, expect } from "./fixtures";

// The join-speed tiers behind a referral bonus - `settingsPanels.spec.ts`'s generic pass over this same panel
// only ever flips the award-trigger radio; the tier table it never touches is sorted on save (ascending by
// how many days the tier allows, nulls last as the catch-all) to match what the resolver expects, regardless
// of the order they were typed in - a real invariant with a real failure mode: a tier list saved out of order
// would have the resolver matching the wrong bracket for a referral that joined fast.
test("join-speed tiers are added out of order and read back sorted", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  const before = await page.request.get("/v1/settings/referrals");
  const kept = before.ok() ? ((await before.json()) as { value?: unknown }).value : undefined;

  await gotoRoute(page, "settings/referrals", "Referral bonuses");
  const card = page.locator("div").filter({ has: page.getByRole("button", { name: "Add tier" }) }).last();

  // Added in the "wrong" order on purpose - the 60-day bracket typed before the 30-day one.
  await card.getByRole("button", { name: "Add tier" }).click();
  const rows = () => card.locator("div.flex-wrap").filter({ has: page.getByRole("button", { name: "Remove" }) });
  await rows().last().locator('input[type="number"]').first().fill("60");
  await rows().last().locator('input[type="number"]').last().fill("5000");

  await card.getByRole("button", { name: "Add tier" }).click();
  await rows().last().locator('input[type="number"]').first().fill("30");
  await rows().last().locator('input[type="number"]').last().fill("3000");

  try {
    // Save sits outside the tiers section (a sibling in the card, not a child of it).
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Referral settings saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.locator("h1").first()).toHaveText("Referral bonuses", { timeout: 30_000 });
    const reopened = page.locator("div").filter({ has: page.getByRole("button", { name: "Add tier" }) }).last();
    const reopenedRows = reopened.locator("div.flex-wrap").filter({ has: page.getByRole("button", { name: "Remove" }) });
    await expect(reopenedRows).toHaveCount(2, { timeout: 30_000 });
    // Sorted ascending - the 30-day bracket first, whichever order they were typed in.
    await expect(reopenedRows.first().locator('input[type="number"]').first()).toHaveValue("30");
    await expect(reopenedRows.first().locator('input[type="number"]').last()).toHaveValue("3000");
    await expect(reopenedRows.last().locator('input[type="number"]').first()).toHaveValue("60");
    await expect(reopenedRows.last().locator('input[type="number"]').last()).toHaveValue("5000");
  } finally {
    await page.request.patch("/v1/settings/referrals", { headers: SPA_HEADERS, data: { value: kept ?? {} } }).catch(() => undefined);
  }
});
