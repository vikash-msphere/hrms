import { gotoRoute, test, expect } from "./fixtures";

// Back goes back.
//
// The app owns its own history (web/src/router.ts): every in-app link is a `pushState`, every modal layer
// pushes an entry of its own so that Back dismisses it (lib/dialogHistory.ts), and several writers replace the
// address without announcing anything. Nothing in that stack exists on the server, and vitest has no session
// history at all - a browser pressing the button is the only witness to whether the reader lands where they
// were. Four ways it had stopped doing that, each with a different cause:
//
//   - every dialog a page DECLARES pushed an entry as the page loaded, open or not, because the wrapper
//     component mounts with the page while Radix only renders the layer when it opens. A busy page stacked ten
//     dead entries, all pointing at the address already on screen, and the reader had to press Back through
//     all of them before anything moved;
//   - a sheet is a modal layer like a dialog, but only dialogs pushed an entry, so Back over an open sheet
//     unmounted the whole page behind it instead of closing the panel;
//   - a tab picked on a routed-tab page wrote `/<page>/<tab>`, but stepping back to the bare `/<page>` left
//     the component sitting on the tab that had been stepped away from: the press did visibly nothing;
//   - a settings key that lives on a host page redirected with a PUSH, so the address bounced off stayed in
//     the history and threw the reader forward again the moment Back landed on it.
test.describe("the back button", () => {
  test("one press returns to the page before, however many dialogs that page declares", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    // The directory declares a handful of dialogs nobody has opened - the shape that used to spend a back
    // press each.
    await gotoRoute(page, "employees", "Directory");

    await page.goBack();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/dashboard");
  });

  test("steps back to the tab the reader came from", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "leave-requests", "Leaves");

    const requests = page.getByRole("tab").first();
    const history = page.getByRole("tab", { name: /^History/ });
    await expect(requests).toHaveAttribute("data-state", "active", { timeout: 30_000 });

    await history.click();
    await expect(history).toHaveAttribute("data-state", "active", { timeout: 30_000 });
    await expect.poll(() => page.url()).toContain("/leave-requests/history");

    await page.goBack();
    // Both halves matter: the URL alone was always right, and the tab alone would pass on a page that never
    // wrote the address in the first place.
    await expect.poll(() => page.url()).not.toContain("/history");
    await expect(requests).toHaveAttribute("data-state", "active", { timeout: 30_000 });
  });

  test("closes an open sheet instead of leaving the page", async ({ as }) => {
    const page = await as("employee");
    // The phone geometry, where the sheet in question exists: a table's sort and filter controls do not fit
    // beside the rows on a 390px screen, so they move into a bottom sheet - and a phone is exactly where the
    // back GESTURE is how a person dismisses a layer.
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoRoute(page, "employees", "Directory");

    const at = page.url();
    await page.getByRole("button", { name: "Sort & filter" }).first().click();
    const sheet = page.getByRole("dialog").filter({ hasText: "Sort & filter" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });

    await page.goBack();
    await expect(sheet).toBeHidden({ timeout: 30_000 });
    // Still on the page, at the same address: the press spent itself on the layer, not on the navigation.
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(at);
  });

  // The entry a dialog pushes is dropped again when it is closed from its own button, and only ONE is pushed
  // per opening. React's StrictMode mounts every effect twice, and the second push used to bury the first:
  // the deferred drop saw a newer token and stood down, so each dialog opened left a dead entry behind and
  // Back straight after confirming a decision stayed on the page.
  test("a dialog opened and closed from its own button costs no back press", async ({ as }) => {
    const page = await as("employee");
    // The phone geometry, where "Sort & filter" is a sheet - the same layer primitive every dialog uses.
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoRoute(page, "dashboard");
    await gotoRoute(page, "employees", "Directory");

    await page.getByRole("button", { name: "Sort & filter" }).first().click();
    const sheet = page.getByRole("dialog").filter({ hasText: "Sort & filter" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await expect(sheet).toBeHidden({ timeout: 30_000 });

    await page.goBack();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/dashboard");
  });

  test("a settings key that redirects to its host page does not trap the reader", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // `board-config` is per-board, so /settings/board-config has nothing to configure and bounces to Boards.
    await page.goto("/settings/board-config");
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/boards");

    await page.goBack();
    // The redirect must not still be in the stack: landing on it again would fire it again, and the reader
    // would be back on Boards with a button that appears dead.
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/dashboard");
  });
});
