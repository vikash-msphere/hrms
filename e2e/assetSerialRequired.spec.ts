import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// The serial-required category - every other asset spec deliberately seeds its category with
// `requires_serial: false` to sidestep this, so the rule has never actually run end to end: the FORM only
// ever hints at it ("the server enforces it either way", per its own comment) and hides the Quantity field
// (a serial names one device, so a batch of them makes no sense) - the refusal itself is the server's, and
// nothing here pre-checks it before the request is sent.
test("a serial-required category hides Quantity, hints, and the server refuses an asset with no serial", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  // The save below is refused by the server on purpose, and the browser logs every failed load. That 400 is
  // the behaviour under test, not the app breaking.
  allowConsoleErrors(page, /status of 400/);
  const catName = `E2E serial-required category ${Date.now()}`;
  const assetName = `E2E serial asset ${Date.now()}`;

  const madeCat = await page.request.post("/v1/asset-categories", { headers: SPA_HEADERS, data: { display_name: catName, requires_serial: true } });
  expect(madeCat.status(), await madeCat.text()).toBe(200);
  const category = (await madeCat.json()) as { path: string };

  let assetPath: string | undefined;
  try {
    await gotoRoute(page, "assets", "Assets");
    await page.getByRole("button", { name: "Add asset" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill(assetName);
    await form.getByLabel("Category").click();
    await page.getByRole("option", { name: catName }).click();

    // Said before anything is typed, and Quantity steps aside - a serial names ONE device.
    await expect(form.getByText("A serial number is required for this kind.")).toBeVisible();
    await expect(form.getByLabel("Quantity")).toHaveCount(0);

    const submit = form.getByRole("button", { name: /^(Add asset|Save|Add)/ }).last();
    await submit.click();
    // Nothing here pre-checked it - this is the server's own refusal, surfaced in the dialog rather than
    // swallowed behind a generic "couldn't save".
    await expect(form.getByText(`a serial number is required for ${catName}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog")).toHaveCount(1);

    await form.getByLabel("Serial number").fill(`SN-${Date.now()}`);
    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const listed = await page.request.get("/v1/assets?page_size=200");
    const { results = [] } = (await listed.json()) as { results?: { path: string; name?: string }[] };
    const created = results.find((a) => a.name === assetName);
    expect(created, "the asset is not in the register").toBeTruthy();
    assetPath = created!.path;
  } finally {
    if (assetPath) await purge(page, assetPath);
    await purge(page, category.path);
  }
});
