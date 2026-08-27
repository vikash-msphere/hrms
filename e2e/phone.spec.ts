import { gotoRoute, test, expect } from "./fixtures";

// The phone, measured rather than reasoned about.
//
// This runs only in the `phone` project (390x844, `isMobile`, `hasTouch`), so `pointer: coarse` is true and
// every `coarse:` rule in the app is actually applied - measuring the desktop rendering in a narrow window is
// the classic way to get a clean bill of health for a broken layout (docs/06-responsive-ui.md).
//
// test/responsiveCoverage.test.ts already pins the CONVENTIONS in the source: every table in a scroll box,
// no fixed width that beats the viewport, no dialog stating its own height. What it cannot do is ask the
// layout engine whether the page really scrolls sideways once everything cascaded. `scripts/uiShots.mjs`
// asks, but by hand and never in CI. These are the few answers worth having on every push.
test.describe("phone", () => {
  // The heaviest surfaces: wide tables, a metric strip, a board that scrolls horizontally BY DESIGN inside
  // its own container (which is exactly the case a naive check gets wrong).
  const ROUTES = ["dashboard", "employees", "leaves", "approvals", "boards", "vendors"];

  for (const route of ROUTES) {
    test(`${route} does not scroll sideways`, async ({ as }) => {
      const page = await as("super");
      await gotoRoute(page, route);
      // Let the route's own reads land and the layout settle before measuring.
      await page.waitForLoadState("networkidle").catch(() => {});

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });
      // 1px of slack for sub-pixel rounding; anything more is a real sideways scroll of the whole page.
      expect(
        overflow.scrollWidth - overflow.clientWidth,
        `the page itself scrolls sideways (${overflow.scrollWidth}px in a ${overflow.clientWidth}px viewport)`,
      ).toBeLessThanOrEqual(1);
    });
  }

  test("the bottom bar is the way around, and it opens the drawer", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // The phone's primary nav. The desktop sidebar is not on screen here - the bar is the only route to
    // everything that is not one of its slots, which is why the drawer behind "Menu" matters so much.
    const bar = page.getByRole("navigation", { name: "Primary" });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "Home" })).toBeVisible();

    await bar.getByRole("button", { name: "Menu" }).click();
    // Open, the sidebar IS a modal drawer and says so (role=dialog + aria-modal, web/src/components/layout/
    // Sidebar.tsx); docked on a desktop it is a plain complementary landmark instead.
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    // A top-level destination, not a workspace tab (Vendors, Directory and the like live in a tab bar on the
    // page, never in the sidebar) - the drawer is the only route to these on a phone.
    const payroll = drawer.getByRole("link", { name: "Payroll", exact: true });
    await expect(payroll).toBeVisible();

    await payroll.click();
    await expect(page).toHaveURL(/#\/payroll-runs/);
  });

  test("a dialog's actions stay on screen", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors");
    await page.getByRole("button", { name: "New vendor" }).click();

    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", { name: "Create", exact: true });

    // Visible is not the same as reachable: a dialog that states its own height pushes its footer below the
    // fold, where `toBeVisible` still passes because the element is painted. `toBeInViewport({ratio: 1})` is
    // the real question - the WHOLE button on screen - and it retries, which also rides out the open
    // animation (measure during the slide-in and the dialog is still off the bottom of the screen).
    await expect(submit).toBeInViewport({ ratio: 1 });

    // The touch floor from docs/06-responsive-ui.md: a real target on a coarse pointer, not a 28px desktop row.
    const box = await submit.boundingBox();
    expect(box, "the submit button has no layout box").not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(36);
  });

  test("the app boots on a phone for an ordinary employee", async ({ as }) => {
    // The role with the fewest capabilities, and so the one whose nav has the most to get wrong: the bottom
    // bar's second slot is picked from what the caller actually holds (web/src/components/layout/BottomNav.tsx).
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    await expect(page.getByRole("main")).not.toBeEmpty();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
});
