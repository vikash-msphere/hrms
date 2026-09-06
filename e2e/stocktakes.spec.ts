import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Walking the floor with a scanner, and what the walk leaves behind.
//
// A stocktake is a `stocktakes` row that collects sightings while somebody walks, then freezes into a result
// nobody can edit afterwards. `test/stocktakes.test.ts` owns the scope maths and the frozen result. What only
// a browser has is the walk itself: a count is opened with a scope, tags are logged one at a time (a USB
// scanner types into a field and presses Enter - the same path as typing, and the one path here that needs no
// camera), the counter moves as they land, and closing the count turns a live walk into a report on the
// Stocktakes page. The camera path is deliberately out of scope: it needs a device this lane doesn't have.
test("a count is opened, a tag is logged into it, and closing it leaves a report", async ({ as }) => {
  test.setTimeout(180_000);
  // Super, not HR: the seeded policy hands HR the asset register but not `stocktakes.create`, so HR sees the
  // register without the button that opens a walk.
  const it = await as("super");
  const stamp = Date.now();
  const label = `E2E count ${stamp % 100000}`;

  // An asset to find. Created over the wire because the register's own form is `assets.spec.ts`'s subject -
  // what this test needs is the tag the server allocated, which is what a sticker would say.
  const category = await assetCategory(it);
  const asset = await createAsset(it, `E2E Tagged ${stamp}`, category.path);
  expect(asset.asset_tag, "an asset is tagged when it is registered").toBeTruthy();

  // A count left open by an interrupted run is resumed rather than replaced (that is the point: two people
  // scanning into one walk), so the walk would open on somebody else's count and never offer the start form.
  await purgeOpenCounts(it);

  await gotoRoute(it, "assets", "Assets");
  await it.getByRole("button", { name: "Stocktake" }).first().click();
  // The walk is an overlay over the register rather than a modal dialog: it stays next to the inventory it is
  // counting, so it is addressed as part of the page.
  const walk = it.locator("body");

  // A count declares what it is counting before it starts, because the scope is what its missing list will
  // mean - and it is fixed once the count closes.
  await walk.getByLabel("What to call it").fill(label);
  await walk.getByRole("button", { name: "Start counting" }).click();

  // The walk. A USB scanner types the tag into this field and presses Enter by itself; typing it is the same
  // path, which is what makes the count usable without a camera.
  const field = walk.getByPlaceholder("Tag, or scan into this field…");
  await expect(field).toBeVisible({ timeout: 30_000 });
  await field.fill(asset.asset_tag!);
  await field.press("Enter");

  // The tally moves as sightings land: "seen / in scope", which is what tells the person walking when to
  // stop.
  await expect(walk.getByText(new RegExp(`^\\s*[1-9]\\d*\\s*/\\s*\\d+`))).toBeVisible({ timeout: 30_000 });
  // `.first()`: the asset is named twice now - once in the register underneath, once in the walk's own
  // just-sighted list.
  await expect(walk.getByText(asset.name).first()).toBeVisible();

  // Closing freezes it - the numbers stop being live and become this count's own result - so it asks first.
  await walk.getByRole("button", { name: "Close count" }).click();
  await it.getByRole("button", { name: "Close count" }).last().click();

  // Closing hands the walker its own report - the walk is over, and what is worth looking at now is what it
  // found, so the app takes them there rather than back to the register.
  await expect(it.getByRole("heading", { level: 1, name: new RegExp(label) })).toBeVisible({ timeout: 30_000 });
  await expect(it).toHaveURL(/#\/stocktakes\/\w+/);

  // And it is on the Stocktakes page too, with the sighting this walk produced.
  await gotoRoute(it, "stocktakes", "Stocktakes");
  const row = it.locator("tbody tr").filter({ hasText: label });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("1");
  await row.getByRole("button", { name: "Open" }).click();
  await expect(it.getByRole("heading", { level: 1, name: new RegExp(label) })).toBeVisible({ timeout: 30_000 });

  await purgeCount(it, label);
  await purge(it, asset.path);
  if (category.created) await purge(it, category.path);
});

/**
 * The category an asset has to be filed under - the org's own if it has one, otherwise a fresh one.
 *
 * It reads a PAGE and picks the first category that does not demand a serial, rather than reading one row and
 * taking whatever comes back. `assetSerialRequired.spec.ts` creates a `requires_serial` category and removes
 * it again, and on a wide run that category is in the table while this spec is choosing one: taking it meant
 * the asset below was refused ("a serial number is required for …") for a reason nothing here is about.
 */
async function assetCategory(page: import("@playwright/test").Page): Promise<{ path: string; created: boolean }> {
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  const rows = ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return { path: found, created: false };
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E asset category ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, created: true };
}

/** An in-stock asset, tagged by the server on create. */
async function createAsset(page: import("@playwright/test").Page, name: string, category: string) {
  const res = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name, category, status: "in_stock" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { path: string; name: string; asset_tag?: string };
}

/** Drop any count still open, so this walk starts one of its own. */
async function purgeOpenCounts(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/stocktakes?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; status?: string; close_time?: string }[] };
  for (const c of results.filter((x) => x.status === "open" || !x.close_time)) await purge(page, c.path);
}

/** Drop the count this spec walked. */
async function purgeCount(page: import("@playwright/test").Page, label: string) {
  const res = await page.request.get("/v1/stocktakes?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; label?: string }[] };
  for (const c of results.filter((x) => x.label === label)) await purge(page, c.path);
}
