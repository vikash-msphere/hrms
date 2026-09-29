import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Proving somebody is looking at the actual thing.
//
// Custody in this app is claimed by SCANNING the sticker, and the scan is the proof: the tag secret is the
// one value that cannot be produced from a desk. The camera path needs a camera and is out of this lane's
// reach - but the dialog it lives in has two other doors that a browser can drive and that carry the same
// consequences, and neither has ever been walked here:
//
//   - the wedge box, which is what a USB scanner types into (and what a person types when the camera will not
//     focus). The value is checked against this asset, so a wrong tag has to be refused rather than accepted
//     as "close enough";
//   - the no-scan override, offered to a VERIFIER only, which demands a written reason and records the
//     confirmation as unproven.
//
// `test/assetTags.test.ts` owns the proof rules and `foundPage` the public tag lane. What only a browser
// shows is the dialog: which doors it opens for which mode, the refusal, and the register afterwards.
test("an asset is checked into stock by typing its tag, and a wrong tag is refused", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("it");
  const admin = await as("super"); // the hard purge is an admin's to make
  const name = `E2E custody ${Date.now() % 1_000_000}`;

  // An asset of this spec's own, with a printed sticker: `printTag` is what mints the secret the scan proves,
  // and its human tag is what the wedge box takes.
  const created = await page.request.post("/v1/assets", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const printed = await page.request.post(`/v1/${path}:printTag`, { headers: SPA_HEADERS });
  expect(printed.status(), await printed.text()).toBe(200);
  const tag = ((await printed.json()) as { asset_tag?: string }).asset_tag;
  expect(tag, "the asset came back with no tag to scan").toBeTruthy();

  try {
    await gotoRoute(page, "assets", "Assets");
    await page.getByRole("button", { name: "Filter by name" }).click();
    await page.getByPlaceholder("Search name").fill(name);
    await page.keyboard.press("Escape");
    const row = page.locator("tbody tr").filter({ hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Check in" }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Check this asset into stock" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // The wedge box - what a USB scanner types into - and the refusal that makes the proof mean anything: a
    // value that is not this asset's tag leaves the confirm REFUSED, in the form, before anything is sent.
    // A wedge scanner types the code and presses Enter by itself, which is what submits it - typing alone
    // sets nothing, and that is the behaviour being driven here rather than a shortcut around it.
    const box = dialog.getByLabel("Or type the tag / scan into this box");
    const confirm = dialog.getByRole("button", { name: "Confirm in stock" });
    await box.fill("NOT-THIS-ASSET");
    await box.press("Enter");
    // Refused where the person can read it, and the confirm stays shut: a scan that names a different asset
    // means they are holding the wrong laptop, and saying so beats a 400 after they press confirm.
    await expect(page.getByText("That tag belongs to a different asset").first()).toBeVisible({ timeout: 30_000 });
    await expect(confirm).toBeDisabled();
    expect(await verifiedAt(page, path), "a wrong tag was accepted as proof").toBeFalsy();

    // The right one, and the asset is now sighted - which is the whole point of the walk.
    await box.fill(tag!);
    await box.press("Enter");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => verifiedAt(page, path), { timeout: 30_000 }).toBeTruthy();
  } finally {
    await purge(admin, path);
  }
});

/** When the asset was last sighted, as the server records it - set only by a confirmed custody check. */
async function verifiedAt(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { last_verified_time?: string }).last_verified_time;
}
