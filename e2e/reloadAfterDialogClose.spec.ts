import { gotoRoute, test, expect } from "./fixtures";

// A reload pressed the moment a dialog has closed has to reload.
//
// A dialog owns a history entry while it is open and steps off it with `history.back()` once its exit animation
// has finished (web/src/lib/dialogHistory.ts). A traversal started while a reload is still in flight cancels the
// reload, so a reload pressed in those ~200ms did nothing at all: the old document stayed, and Playwright saw
// `net::ERR_ABORTED; maybe frame was detached?`. The app now skips that step once the document is unloading.
//
// `page.reload()` is not usable here - `as()` makes it wait out a pending drop (e2e/fixtures.ts), which is the
// very window this pins. `Page.reload` over CDP is what it sends underneath, and the document response is held
// for a second so the reload is still pending when the drop's timer comes due.
test("a reload pressed right after a dialog closes is not cancelled by the dialog's own history step", async ({ as }) => {
  const page = await as("employee");
  await gotoRoute(page, "dashboard");
  const cdp = await page.context().newCDPSession(page);
  await page.route((url) => url.pathname === "/dashboard", async (route) => {
    await new Promise((r) => setTimeout(r, 1_000));
    await route.continue();
  });

  for (let i = 0; i < 3; i++) {
    await page.locator("body").press("?");
    await expect(page.getByRole("dialog").filter({ hasText: "Keyboard shortcuts" })).toBeVisible();
    // A marker on the CURRENT document: a reload that landed is a fresh one without it, a cancelled one keeps it.
    await page.evaluate(() => { (window as unknown as { __beforeReload: number }).__beforeReload = 1; });
    await page.keyboard.press("Escape");
    await cdp.send("Page.reload");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __beforeReload?: number }).__beforeReload ?? 0).catch(() => -1), { timeout: 10_000 })
      .toBe(0);
    await expect(page.getByRole("main")).toBeVisible();
  }
});
