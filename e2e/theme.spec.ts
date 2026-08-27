import { gotoRoute, test, expect } from "./fixtures";

// A preference that is supposed to follow the person, not the machine.
//
// The theme is stored twice on purpose (web/src/lib/theme.ts): localStorage so the inline script in
// index.html can paint the right colours before React exists, and a per-user `preferences/theme` row so the
// choice reaches the person's other devices. Neither half is observable from the server suite - one lives in
// a browser store and the other only matters at the moment a SECOND browser loads the app and has to pick
// the server's answer over its own empty cache.
test("a theme choice sticks, and follows the person to another browser", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "dashboard");
  const dark = (p: typeof page) => p.evaluate(() => document.documentElement.classList.contains("dark"));

  // Start from Light explicitly. "System" would make the assertion depend on the runner's OS setting.
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect.poll(() => dark(page)).toBe(false);

  // The choice, and the write to the server that carries it off this machine.
  const saved = page.waitForResponse((r) => r.url().includes("/v1/preferences/theme") && r.request().method() !== "GET");
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect.poll(() => dark(page)).toBe(true);
  await saved;

  // Survives a reload, from the local cache - this is the no-flash path.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  expect(await dark(page)).toBe(true);

  // A different browser for the same person: its own empty localStorage, so the only way it can come up dark
  // is by reading the preference back from the server.
  const otherDevice = await as("super");
  await gotoRoute(otherDevice, "dashboard");
  await expect.poll(() => dark(otherDevice)).toBe(true);

  // Put it back, so a rerun starts from the same place this one did.
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect.poll(() => dark(page)).toBe(false);
});
