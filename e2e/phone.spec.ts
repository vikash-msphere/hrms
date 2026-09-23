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

  test("the top bar's Menu button is the way around, and it opens the drawer", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // The desktop sidebar is not on screen here, so this one button is the route to every destination that
    // is not on the current page - which is why the drawer behind it matters so much.
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    // Create sits beside search in the same bar, and is the only "+" on a phone. Icon-only there, but it
    // keeps the name it has on a desktop - the word is `sr-only`, not dropped.
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();

    await menu.click();
    // Open, the sidebar IS a modal drawer and says so (role=dialog + aria-modal, web/src/components/layout/
    // Sidebar.tsx); docked on a desktop it is a plain complementary landmark instead.
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    // A top-level destination, not a workspace tab (Vendors, Directory and the like live in a tab bar on the
    // page, never in the sidebar) - the drawer is the only route to these on a phone.
    const payroll = drawer.getByRole("link", { name: "Payroll", exact: true });
    await expect(payroll).toBeVisible();

    await payroll.click();
    await expect(page).toHaveURL(/\/payroll-runs/);
  });

  test("the drawer freezes the page behind it, and Escape gives both back", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // The drawer is not a Radix layer (Sidebar.tsx says so directly) - Radix brings its own scroll lock, so
    // this is the one place `lib/scrollLock.ts` itself is exercised rather than assumed alongside it.
    const overflowY = () => page.evaluate(() => document.documentElement.style.overflowY);
    const before = await overflowY();
    expect(before, "the page starts unlocked").not.toBe("hidden");

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect.poll(overflowY).toBe("hidden");

    // Escape is the drawer's own close, not the browser's - and it has to hand back exactly what it locked,
    // not just any unlocked value, in case something else is holding a lock of its own underneath.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect.poll(overflowY).toBe(before);
  });

  test("swiping the drawer left closes it, but a mostly-vertical drag does not", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();

    // A mostly-vertical drag first, so this proves the axis lock (the nav list has to keep scrolling under a
    // finger, not close the drawer every time someone scrolls it) rather than assuming the closing gesture is
    // the only one that has ever been tried.
    await page.evaluate(() => {
      const el = document.querySelector('aside[role="dialog"]')!;
      const fire = (type: string, x: number, y: number) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], targetTouches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
      };
      fire("touchstart", 150, 300);
      fire("touchmove", 150, 380); // dy -80, dx 0: vertical, not the swipe this component listens for
      fire("touchend", 150, 380);
    });
    await expect(drawer).toBeVisible();

    // Left, past the 56px the component itself requires - one touchmove is enough: the handler decides the
    // axis and checks the distance in the same call, unlike the pull-to-refresh gesture next to this test.
    await page.evaluate(() => {
      const el = document.querySelector('aside[role="dialog"]')!;
      const fire = (type: string, x: number, y: number) => {
        const t = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], targetTouches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
      };
      fire("touchstart", 300, 400);
      fire("touchmove", 220, 400); // dx -80, dy 0: past the -56px threshold, horizontal
      fire("touchend", 220, 400);
    });
    await expect(drawer).toHaveCount(0);
  });

  test("pulling down from the top re-reads the page", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.waitForLoadState("networkidle").catch(() => {});

    let reads = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/v1/batch:run") reads++;
    });

    // A real drag needs real Touch objects - Playwright has no higher-level API for a multi-point touch
    // move, so this dispatches the same three events `usePullToRefresh` listens for on `window`. Two
    // touchmoves, not one: the hook's first move past 8px only DECIDES the gesture is vertical and returns
    // without setting the pull distance, so the distance that actually clears the 72px threshold has to be
    // the second one.
    await page.evaluate(() => {
      const fire = (type: string, y: number) => {
        const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
        window.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], targetTouches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
      };
      fire("touchstart", 60);
      fire("touchmove", 90); // +30px: past the 8px axis-lock, but this move alone sets no pull distance
      fire("touchmove", 260); // +200px from the start: comfortably past the 72px refresh threshold once damped
      fire("touchend", 260);
    });

    await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(0);
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
    // The role with the fewest capabilities, and so the one whose chrome has the most to get wrong: the top
    // bar's create menu is built from what the caller actually holds (web/src/components/layout/TopBar.tsx),
    // and the drawer button is what is left when every other control drops away.
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    await expect(page.getByRole("main")).not.toBeEmpty();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  });
});
