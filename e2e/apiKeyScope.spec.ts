import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// The scope the mint form promised, kept by the credential it produced.
//
// `apiKeys` mints, reveals, rotates and revokes - and never once USES a key. That leaves the most
// consequential part of the panel untested: the three controls that decide what the credential may do
// (Access level, Collections, and the off-by-default "Allow actions"), and whether the key that comes out the
// other end is narrowed the way the form said it would be. A checkbox read from the wrong draft field, a
// level that never reaches the request body, an "every collection" default that survives the picker - each of
// those mints a wider credential than the form describes, and nothing anywhere would notice.
//
// `test/apiKeyToken.test.ts` owns the token format and `narrowGrant`. What only a browser can answer is
// whether THIS FORM produces THAT scope, so the key is minted through the UI and then actually used - one
// request per control, each isolating a different one.
test("a key minted through the form is limited to exactly what the form said", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // Copying goes through the clipboard API, which a headless browser may refuse; the app says so in a toast.
  allowConsoleErrors(page, /clipboard|Document is not focused/i);
  const name = `E2E scoped key ${Date.now() % 1_000_000}`;
  let made = "";

  await gotoRoute(page, "settings/api-keys", "API keys");
  await page.getByRole("button", { name: "New key" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(name);

  // Read & write, vendors only, no actions. Every collection is the DEFAULT, so the picker only appears once
  // that is unticked - which is itself one of the controls under test.
  //
  // Vendors and not assets, because the LEVEL control below is the hard purge: `?force=true` is the one
  // standard method that asks for the rung above `write`, and it only means a purge on a collection that HAS
  // one. Assets' delete is permanent already (`softDelete: false`), so its route ignores `?force` outright
  // and the request it answers is the plain delete - a write-level act, which proves nothing about a ceiling.
  await form.getByLabel("Access level").click();
  await page.getByRole("option", { name: "Read & write" }).click();
  await form.getByLabel("Every collection").uncheck();
  await form.getByRole("searchbox", { name: "Filter collections…" }).fill("Vendors");
  // The picker's rows are labels wrapping their checkbox, so the row itself is the control to press.
  await form.locator("label").filter({ hasText: /^Vendors$/ }).first().click();
  await expect(form.getByLabel(/Allow actions/), "actions are meant to be off unless asked for").not.toBeChecked();
  // The form says what it is about to mint, in one sentence, before it exists.
  await expect(form.getByText("This key will be able to:")).toBeVisible();

  await form.getByRole("button", { name: "Create key" }).click();
  const reveal = page.getByRole("dialog").filter({ hasText: "Copy your key now" });
  await expect(reveal).toBeVisible({ timeout: 30_000 });
  const secret = await reveal.getByRole("textbox").first().inputValue();
  expect(secret.length, "the key itself is on screen, not a placeholder").toBeGreaterThan(20);
  await reveal.getByRole("button", { name: "Done" }).click();
  const nagged = page.getByRole("button", { name: "Close anyway" });
  if (await nagged.count()) await nagged.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The machine lane is terminal on the bearer (src/middleware/auth.ts): a request carrying an `hrms_` key is
  // resolved as that key or refused, never as the browser's own session - so these are honest key requests
  // even though they leave from a signed-in context.
  const auth = { Authorization: `Bearer ${secret}` };
  try {
    // In scope, at its level.
    const read = await page.request.get("/v1/vendors?page_size=1", { headers: auth });
    expect(read.status(), await read.text()).toBe(200);
    const write = await page.request.post("/v1/vendors", { headers: auth, data: { display_name: `E2E key-made vendor ${Date.now()}` } });
    expect(write.status(), await write.text()).toBe(200);
    made = ((await write.json()) as { path: string }).path;

    // The COLLECTIONS control: a collection that was never ticked is not the key's business, however wide
    // the level is.
    const elsewhere = await page.request.get("/v1/assets?page_size=1", { headers: auth });
    expect(elsewhere.status(), "a key scoped to vendors could read assets").toBe(403);

    // The LEVEL control: the ladder is read ⊂ write ⊂ full, and the hard purge is on the rung above this
    // key's. (A soft delete is part of write, so it would prove nothing about the ceiling.)
    const purged = await page.request.delete(`/v1/${made}?force=true`, { headers: auth });
    expect(purged.status(), "a write-level key could purge a row").toBe(403);

    // The ACTIONS control, isolated: writing rows is allowed, and a custom method on the very same
    // collection still is not. `:disable` is the lifecycle verb every catalog with a `disabled` column
    // carries (http/lifecycleVerb.ts) - a custom method, so it is off the ladder entirely and gated by the
    // "Allow actions" box rather than by the level.
    // No body at all: `:disable` declares none (openapi.yaml), and the Prism proxy every e2e request goes
    // through answers a request carrying one it did not declare itself, before the Worker is ever asked.
    const method = await page.request.post(`/v1/${made}:disable`, { headers: auth });
    expect(method.status(), "a key minted without actions could call a custom method").toBe(403);
  } finally {
    if (made) await purge(page, made);
    await purgeNamed(page, name);
  }

  // Gone is gone, on the very next request: the key row is read live on every call, so this is the auth lane
  // refusing an unknown credential rather than the policy lane refusing a known one.
  const dead = await page.request.get("/v1/assets?page_size=1", { headers: auth });
  expect(dead.status(), "a purged key still authenticated").toBe(401);
});

/** Drop the key this spec minted. */
async function purgeNamed(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.get("/v1/api-keys?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  for (const k of results.filter((x) => x.display_name === name)) await purge(page, k.path);
}
