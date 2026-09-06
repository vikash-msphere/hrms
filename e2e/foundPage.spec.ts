import { SPA_HEADERS, personPath, purge, test, expect } from "./fixtures";

// The one page in this app a stranger is meant to see.
//
// A printed asset sticker's QR can encode `<origin>/found/<wire-id>` (web/src/lib/assetTags.ts), so somebody
// who picks a company laptop up off a train knows where to send it. That page is unlike everything else
// here: no session, no SPA, no `/v1` - a small HTML document the Worker renders itself, on a path that has
// to survive Vite in front of it and the org's own opt-in behind it.
//
// So it is exactly the thing a browser test is for, and nothing else in either suite can reach it. Every
// other spec runs signed in - the fixture's whole job is minting a cookie - and `e2e/globalSetup.ts` refuses
// to run the lane at all unless an unauthenticated read really 401s. This spec is the deliberate exception,
// and it asserts the exception is exactly as narrow as it is meant to be: the tag, a way to return it, and
// NOTHING about the person who was carrying it.
test("a found sticker opens for a stranger, says only what it must, and closes when the org turns it off", async ({ as, browser, baseURL }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const contact = "e2e-lost-and-found@example.com";

  // An asset of this spec's own, held by somebody - so "the holder's name is not on the page" is an
  // assertion about redaction rather than about an empty field. The org ships none, and a spec that borrowed
  // a neighbour's would be printing a sticker for a row that spec is about to delete.
  const asset = await anAsset(admin);
  const restore = await enableFoundPage(admin, contact);

  // A stranger: their own browser, no cookie, nothing in storage.
  const stranger = await browser.newContext({ baseURL });
  try {
    const page = await stranger.newPage();
    const res = await page.goto(`/found/${asset.id}`);
    expect(res?.status(), "the finder has no session, so this is the one page that must not 401").toBe(200);

    // What it is for: whose it is, which one it is, and how to give it back.
    await expect(page.getByText(asset.tag, { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: contact })).toBeVisible();

    // What it is NOT for. The finder is a stranger, and the person who lost the laptop did not agree to have
    // their name handed to them - nor the serial, which is what a thief needs to claim it as theirs.
    const text = await page.locator("body").innerText();
    expect(text, "the holder's name must not be on a public page").not.toContain(asset.holder);
    expect(text, "the serial must not be on a public page").not.toContain(asset.serial);

    // A token that is not a token. The id is the authenticated wire token, so the page cannot be walked by
    // guessing - and a forged one costs the Worker no read to refuse.
    expect((await page.goto(`/found/${asset.id.slice(0, -2)}zz`))?.status(), "a forged token must not resolve").toBe(404);

    // Opt-in, and revocable: an org that turns the page off has turned it off for everybody holding a
    // sticker already printed, not just for the ones printed afterwards.
    await restore();
    expect((await page.goto(`/found/${asset.id}`))?.status(), "a disabled found page is not served").toBe(404);
  } finally {
    await stranger.close();
    await restore();
    await asset.remove();
  }
});

type Page = import("@playwright/test").Page;

/** An asset to print a sticker for, held by a real person, and the way to take it back out again. */
async function anAsset(page: Page): Promise<{ id: string; tag: string; serial: string; holder: string; remove: () => Promise<void> }> {
  const category = await assetCategory(page);
  const holderPath = await personPath(page, "employee");
  const who = await page.request.get(`/v1/${holderPath}`);
  expect(who.status(), await who.text()).toBe(200);
  const person = (await who.json()) as { first_name?: string; last_name?: string };
  const holder = `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim();
  expect(holder, "the holder needs a name for the redaction assertion to mean anything").not.toBe("");

  const serial = `E2E-SER-${Date.now()}`;
  const made = await page.request.post("/v1/assets", {
    headers: SPA_HEADERS,
    data: { name: `E2E Found Laptop ${Date.now()}`, category: category.path, serial_number: serial, assigned_to: holderPath },
  });
  expect(made.status(), await made.text()).toBe(200);
  // The tag is ALLOCATED by the server from settings/asset-tags and the category's code - it is what the
  // sticker prints and what the whole public page is about, so a create that produced none is not a fixture
  // this spec can work with.
  const row = (await made.json()) as { path: string; asset_tag?: string };
  expect(row.asset_tag, "an asset is created with its tag allocated").toBeTruthy();

  return {
    id: row.path.split("/")[1]!,
    tag: row.asset_tag!,
    serial,
    holder,
    remove: async () => {
      await purge(page, row.path);
      if (category.created) await purge(page, category.path);
    },
  };
}

/** A category to file the asset under - the org's own if it has one, otherwise a fresh one. */
async function assetCategory(page: Page): Promise<{ path: string; created: boolean }> {
  // A page of them, and the first that does not demand a serial: `assetSerialRequired.spec.ts` keeps a
  // `requires_serial` category in the table for the length of its own run, and picking that one refuses the
  // asset ("a serial number is required for …") for a reason nothing here is about.
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  const rows = existing.ok() ? ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [] : [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return { path: found, created: false };
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E Found ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, created: true };
}

/**
 * Turn the public page on, and hand back the way to put the setting back as it was found.
 *
 * Read-modify-write of ONE key, retried: `settings/asset-tags` is one shared blob that the tag printer and
 * the stocktake scanner also read, and a spec that wrote a whole snapshot back would delete whatever a
 * neighbouring spec had put in it meanwhile. The restore is idempotent, because it is called both in the
 * assertion that the page closes again and on the way out of the test.
 */
async function enableFoundPage(page: Page, contact: string): Promise<() => Promise<void>> {
  const before = await editTags(page, (cfg) => ({ ...cfg, found_page: { enabled: true, contact, show_name: false } }));
  const wasSet = before.found_page !== undefined;
  return async () => {
    await editTags(page, (cfg) => {
      const next = { ...cfg };
      if (wasSet) next.found_page = before.found_page;
      else delete next.found_page;
      return next;
    });
  };
}

type TagConfig = Record<string, unknown> & { found_page?: unknown };

/** Read-modify-write the asset-tag settings blob, retrying so a concurrent write is merged rather than lost. */
async function editTags(page: Page, change: (cfg: TagConfig) => TagConfig): Promise<TagConfig> {
  for (let tries = 0; tries < 5; tries++) {
    const res = await page.request.get("/v1/settings/asset-tags");
    const cfg = (res.ok() ? (((await res.json()) as { value?: TagConfig }).value ?? {}) : {}) as TagConfig;
    const wrote = await page.request.patch("/v1/settings/asset-tags", { headers: SPA_HEADERS, data: { value: change(cfg) } });
    if (wrote.ok()) return cfg;
  }
  throw new Error("e2e: could not update the asset-tag settings");
}
