import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The sticker that has to stop working.
//
// A tag peels off, gets defaced, or ends up on the wrong laptop - and from that moment the sticker in the
// world is a key to the wrong door, because scanning it is what proves custody. Reissuing mints a new secret
// and puts the asset back in the print queue, which is destructive in the quiet way: nothing looks different
// afterwards except that somebody's scan will now fail.
//
// So the browser's job is to ASK first, naming what stops working, and to mean it when the answer is no.
// `confirmDecision` is the convention (docs/…: one-click decisions must ask first); `test/assetTags.test.ts`
// owns the secret. What only a browser shows is the question, the refusal path, and that going through with
// it really put the asset back in the queue.
test("reissuing a tag asks first, and puts the asset back in the print queue", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  const name = `E2E tagged ${Date.now() % 1_000_000}`;

  // An asset of this spec's own, already tagged: `printTag` is what stamps "the sticker exists", and the
  // reissue is only meaningful against one that has been printed.
  const created = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name, status: "in_stock" },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    const printed = await page.request.post(`/v1/${path}:printTag`, { headers: SPA_HEADERS });
    expect(printed.status(), await printed.text()).toBe(200);
    expect(await tagPrintedTime(page, path), "the tag was not stamped as printed").toBeTruthy();

    await gotoRoute(page, "assets", "Assets");
    // Found by the name this spec gave it: the register is long, and the row has to be beyond doubt before
    // anything destructive is pressed on it. The register has no search box of its own - narrowing it is the
    // Name column's own filter, which lives behind the control in its header. Closed again afterwards: an
    // open popover covers the very row it filtered down to.
    await page.getByRole("button", { name: "Filter by name" }).click();
    await page.getByPlaceholder("Search name").fill(name);
    await page.keyboard.press("Escape");
    const row = page.locator("tbody tr").filter({ hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Asked, with the consequence in the question rather than in a help page.
    await row.getByRole("button", { name: /^Reissue tag/ }).click();
    // The shared confirm is an ordinary dialog carrying the question as its title.
    const ask = page.getByRole("dialog").filter({ hasText: "Reissue this asset's tag?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText(/stops working/)).toBeVisible();

    // Backing out has to actually back out: this is the press somebody makes by accident.
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    expect(await tagPrintedTime(page, path), "backing out still reissued the tag").toBeTruthy();

    // And through with it: the printed stamp is cleared, which is what puts the asset back in the queue the
    // sticker printer works from.
    await row.getByRole("button", { name: /^Reissue tag/ }).click();
    await page.getByRole("button", { name: "Reissue", exact: true }).click();
    await expect.poll(() => tagPrintedTime(page, path), { timeout: 30_000 }).toBeFalsy();
  } finally {
    await purge(admin, path);
  }
});

/** When this asset's sticker was last printed, as the server records it. */
async function tagPrintedTime(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { tag_printed_time?: string }).tag_printed_time;
}
