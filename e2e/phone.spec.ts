import { gotoRoute, test, expect, makeThrowawayPerson, retireThrowawayPerson, allowConsoleErrors, searchBox } from "./fixtures";

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

  test("the lock screen's pad sits under the thumb, fits upright and sideways, and a tapped PIN opens the app", async ({ as }) => {
    // A login of its own: a PIN on one of the seeded five would lock every other worker signed in as them.
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "PhoneLock");
    try {
      const page = await as({ email: person.email });
      allowConsoleErrors(page, /status of 401/);
      // The PIN and the lock through the API, from a static file of the app's own origin so the requests are
      // same-site like the app's; the setup screen is appLock.spec.ts's subject.
      await page.goto("/favicon.svg");
      for (const [path, method, body] of [["/auth/lock/pin", "PUT", { pin: "482916" }], ["/auth/lock", "POST", {}]] as const) {
        const status = await page.evaluate(
          async ([p, m, b]) => (await fetch(p, { method: m, credentials: "include", headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" }, body: b })).status,
          [path, method, JSON.stringify(body)] as const,
        );
        // 200 for the PIN, 204 for the lock.
        expect(status, `${method} ${path}`).toBeGreaterThanOrEqual(200);
        expect(status, `${method} ${path}`).toBeLessThan(300);
      }
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible({ timeout: 30_000 });

      const pad = page.getByRole("group", { name: "Number pad" });
      const key = (d: string) => pad.getByRole("button", { name: d, exact: true });
      // The phone's own keyboard must never open over the pad.
      await expect(page.getByLabel("Enter your 6-digit PIN")).toHaveAttribute("inputmode", "none");

      const fits = () => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
      const viewport = page.viewportSize()!;
      expect(await fits(), "the lock screen scrolls upright").toBeLessThanOrEqual(1);
      // The pad pinned to the bottom, every row's centre in the lower half of the screen, where a thumb holding
      // the phone reaches.
      const top = (await key("1").boundingBox())!;
      const bottom = (await key("0").boundingBox())!;
      expect(top.y + top.height / 2, "the pad's top row is above the thumb's reach").toBeGreaterThan(viewport.height / 2);
      expect(bottom.y + bottom.height, "the pad is not pinned to the bottom of the screen").toBeGreaterThan(viewport.height * 0.85);
      expect(top.height, "a pad key under the 44px touch floor").toBeGreaterThanOrEqual(44);
      await expect(key("0")).toBeInViewport({ ratio: 1 });

      // Sideways the pad moves beside the rest, and the whole screen still fits.
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await expect(key("0")).toBeInViewport({ ratio: 1 });
      await expect(key("1")).toBeInViewport({ ratio: 1 });
      expect(await fits(), "the lock screen scrolls sideways-on").toBeLessThanOrEqual(1);
      expect((await key("1").boundingBox())!.height, "a pad key under the 44px touch floor").toBeGreaterThanOrEqual(44);
      await page.setViewportSize(viewport);

      // Taps, not typing: the pad is the only way in on a phone.
      for (const d of "482916") await key(d).tap();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    } finally {
      await retireThrowawayPerson(admin, person.path);
    }
  });

  // The search on a phone is the modal, with its own box and phone-size text: the filter words drawn behind it
  // (CommandPalette.tsx QueryHighlight) have to line up with ITS text, as they do with the top bar field's.
  test("the search's filter words line up with the text in the phone's search box", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.getByRole("banner").getByRole("button", { name: "Search", exact: true }).tap();
    const search = searchBox(page);
    await search.fill("laptop in:leave-requests ");
    await expect(page.locator("[data-query-highlight]")).toHaveCount(1);
    const widths = await search.evaluate((input: HTMLInputElement) => {
      const drawn = input.parentElement!.querySelector("[data-query-highlight] > div")!;
      const range = document.createRange();
      range.selectNodeContents(drawn);
      const ctx = document.createElement("canvas").getContext("2d")!;
      // From its parts: Chrome serialises the `font` shorthand as "" when it cannot express every part.
      const cs = getComputedStyle(input);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return { drawn: range.getBoundingClientRect().width, typed: ctx.measureText(input.value).width };
    });
    expect(Math.abs(widths.drawn - widths.typed)).toBeLessThanOrEqual(1);
  });
});
