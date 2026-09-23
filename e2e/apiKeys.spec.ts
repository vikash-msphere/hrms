import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// Minting a machine credential, and being made to copy it.
//
// `test/apiKeyToken.test.ts` owns the token format and what a key may do. What only a browser has is the
// one-shot handover: the secret exists on screen exactly once, in a dialog that says so, and closing that
// dialog throws it away for good. Every part of that is UI - the create form, the reveal, and the list
// afterwards showing a key that can never be read again - and getting it wrong means either a credential
// nobody can use or one sitting in a page that should never have kept it.
test("an API key is created, shown once, and revoked", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // Copying goes through the clipboard API, which a headless browser may refuse; the app says so in a toast
  // and the key is still on screen, so the refusal is not this spec's failure.
  allowConsoleErrors(page, /clipboard|Document is not focused/i);
  const name = `E2E key ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/api-keys");
  await expect(page.locator("h1").first()).toHaveText("API keys");

  await page.getByRole("button", { name: "New key" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Create key" }).click();

  // The reveal. This dialog is the only place the secret is ever shown, which is why it says so plainly and
  // offers a copy rather than leaving somebody to select it by hand.
  const reveal = page.getByRole("dialog").filter({ hasText: "Copy your key now" });
  await expect(reveal).toBeVisible({ timeout: 30_000 });
  // The secret rides in a readonly input so it can be selected and copied, rather than as text somebody has
  // to drag a cursor across.
  const secret = await reveal.getByRole("textbox").first().inputValue();
  expect(secret.length, "the key itself is on screen, not a placeholder").toBeGreaterThan(20);
  await reveal.getByRole("button", { name: "Copy", exact: true }).click().catch(() => undefined);

  // Leaving without copying throws the key away for good, so this is the one dialog in the app that argues
  // with Done.
  await reveal.getByRole("button", { name: "Done" }).click();
  const nagged = page.getByRole("button", { name: "Close anyway" });
  if (await nagged.count()) await nagged.click();

  // On the list, and the secret is NOT: it was handed over once and the app kept only what it needs to
  // identify the key.
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(page.getByText(secret)).toHaveCount(0);

  // Revoking is the kill switch for a credential that has leaked, so it asks first and then says so on the
  // row rather than removing it - a revoked key is history somebody may need to read.
  await row.getByRole("button", { name: "API key actions" }).click();
  await page.getByRole("menuitem", { name: /Revoke/ }).click();
  const confirm = page.getByRole("dialog");
  if (await confirm.getByRole("button", { name: /Revoke/ }).count()) {
    await confirm.getByRole("button", { name: /Revoke/ }).last().click();
  }
  await expect(row).toContainText(/Revoked/i, { timeout: 30_000 });

  await purgeNamed(page, name);
});

// Rotating is a different press from plain Revoke above: one action mints a same-scope replacement, shows
// ITS secret once, and only then revokes the old key - so a credential in use never has a window with
// nothing working. Never pressed anywhere before this.
test("rotating an API key mints a same-scope replacement and revokes the old one", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  allowConsoleErrors(page, /clipboard|Document is not focused/i);
  const name = `E2E rotate key ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/api-keys");
  await page.getByRole("button", { name: "New key" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Create key" }).click();
  const minted = page.getByRole("dialog").filter({ hasText: "Copy your key now" });
  await expect(minted).toBeVisible({ timeout: 30_000 });
  const originalSecret = await minted.getByRole("textbox").first().inputValue();
  await minted.getByRole("button", { name: "Done" }).click();
  const nagged1 = page.getByRole("button", { name: "Close anyway" });
  if (await nagged1.count()) await nagged1.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const rows = page.locator("tbody tr").filter({ hasText: name });
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: "API key actions" }).click();
  await page.getByRole("menuitem", { name: "Rotate" }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: `Rotate "${name}"?` });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm.getByText(/revoked immediately after/)).toBeVisible();
  await confirm.getByRole("button", { name: "Create the replacement", exact: true }).click();

  // The replacement's own one-time reveal - a second, DIFFERENT secret, not the same key shown twice.
  const replacement = page.getByRole("dialog").filter({ hasText: "Copy your key now" });
  await expect(replacement).toBeVisible({ timeout: 30_000 });
  const newSecret = await replacement.getByRole("textbox").first().inputValue();
  expect(newSecret.length).toBeGreaterThan(20);
  expect(newSecret).not.toBe(originalSecret);
  await replacement.getByRole("button", { name: "Done" }).click();
  const nagged2 = page.getByRole("button", { name: "Close anyway" });
  if (await nagged2.count()) await nagged2.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // Same name, both generations on the list: the old one revoked, the new one live to take its place.
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.filter({ hasText: /Revoked/i })).toHaveCount(1);
  const stillActive = rows.filter({ hasNotText: /Revoked/i });
  await expect(stillActive).toHaveCount(1);

  await purgeNamed(page, name);
});

/** Drop the key this spec minted. */
async function purgeNamed(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.get("/v1/api-keys?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  for (const k of results.filter((x) => x.display_name === name)) await purge(page, k.path);
}
