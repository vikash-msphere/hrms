import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// What the app does when the session dies under somebody's hands.
//
// The promise the code makes (web/src/api.ts, web/src/App.tsx) is specific: once the shell is up, a 401 does
// NOT navigate away. It shows an overlay in place, so the half-filled form behind it survives while the
// person signs in again in another tab. Getting that wrong is not a subtle defect - it is a form thrown away,
// and the only way to see it is to kill a real session in a real browser with something typed in.
test("a session that dies mid-form keeps the form", async ({ as }) => {
  const page = await as("super");
  // The doomed request logs itself; that is the scenario, not a defect.
  allowConsoleErrors(page, /401|Unauthorized|unauthenticated/i);

  await gotoRoute(page, "vendors");
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog");
  const typed = `Half-finished vendor ${Date.now()}`;
  await dialog.getByPlaceholder("Vendor or supplier name").fill(typed);

  // The session lapses (expired cookie, revoked key, a signed-out sibling tab). Any request can be the one
  // that trips it - a background poll (notifications, presence) hitting the 401 first is just as much this
  // scenario as the deliberate Create press below, and once the overlay is up it blocks that press same as
  // any other click, which is not a failure of the click, just a race this test does not need to win.
  await page.context().clearCookies();
  const signedOut = page.getByText("Signed out", { exact: true });
  if (!(await signedOut.count())) {
    await dialog.getByRole("button", { name: "Create", exact: true }).click().catch(() => undefined);
  }

  // In place, and honest about what happened.
  await expect(signedOut).toBeVisible();
  await expect(page.getByText(/Your session expired\. Anything you were typing is still here/)).toBeVisible();

  // The whole point: still on the page, still holding what was typed. Located from the page rather than
  // through `dialog`: the overlay is modal, so Radix hides everything outside it from the accessibility tree
  // and a role-based lookup would find nothing even though the form is still mounted and filled in.
  await expect(page.getByPlaceholder("Vendor or supplier name")).toHaveValue(typed);
  await expect(page).toHaveURL(/\/vendors/);
});

// The same lapse, met by a page's CODE rather than its data. In production the static-site gate
// (src/http/staticSite.ts) refuses every chunk to a signed-out browser, and a refused dynamic import reports only
// "failed to fetch" - exactly what a chunk deleted by a newer deploy reports. So the crash boundary used to say
// "this tab is out of date - reload", which is wrong twice: nothing shipped, and a reload leaves for sign-in.
// What the app must do instead (web/src/lib/lazyPage.tsx): ask whether the session is alive, show the in-place
// "Signed out" dialog, and once the person is back, load the page - in place where the browser will fetch the
// chunk again, and through the one reload it offers where it will not. Chrome keeps a failed module fetch for the
// life of the document (this spec's own trace showed no second request), so on Chrome it is the reload - offered,
// never done behind the person's back, because anything else on screen would go with it.
//
// The suite serves the SPA from Vite, so the gate is not in the path here: the refusal is simulated by answering
// that one page module with the 401 the gate would send, while the cleared cookie makes the app's own probe of
// /v1/users/me genuinely 401 against the real Worker.
test("a page chunk refused while signed out waits for sign-in instead of calling the tab out of date", async ({ as }) => {
  // Two cold compiles of the page in Vite (before and after the reload) on top of the lapse itself.
  test.slow();
  const page = await as("super");
  allowConsoleErrors(page, /401|Unauthorized|unauthenticated|dynamically imported module|Failed to load module/i);

  await gotoRoute(page, "vendors", "Vendors");
  // A marker a reload would wipe: the page must resume in place.
  await page.evaluate(() => ((window as unknown as { __noReload?: number }).__noReload = 1));

  const saved = await page.context().cookies();
  await page.context().clearCookies();
  const holidaysModule = /\/src\/pages\/Holidays\.tsx/;
  await page.route(holidaysModule, (route) => route.fulfill({ status: 401, body: "" }));

  // A client-side move to a page whose chunk this tab has never loaded - the moment the gate would refuse it.
  await page.evaluate(() => {
    history.pushState(null, "", "/holidays");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
  await expect(page.getByText("This tab is out of date")).toHaveCount(0);

  // Signed back in (the cookie returns, and the module is served again), then "continue".
  await page.unroute(holidaysModule);
  await page.context().addCookies(saved);
  await page.getByRole("button", { name: "I've signed in - continue" }).click();

  // Back in, on the same document: either the page loaded in place, or it says plainly what one reload will do.
  // Never the "out of date" diagnosis, and never a reload nobody asked for.
  const holidays = page.getByRole("heading", { level: 1, name: "Holiday Calendar" });
  const signedBackIn = page.getByRole("heading", { name: "You're signed back in" });
  await expect(holidays.or(signedBackIn)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This tab is out of date")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);

  if (await signedBackIn.isVisible()) {
    await page.getByRole("main").getByRole("button", { name: "Reload", exact: true }).click();
  }
  await expect(holidays).toBeVisible({ timeout: 30_000 });
});
