import { SPA_HEADERS, gotoRoute, personId, test, expect } from "./fixtures";

// "Stop telling me about this."
//
// The per-user notification preferences are a settings panel with nothing but the caller's own row behind it:
// mute a category, and notifications of that category are never created for you. `test/notifications` owns
// what the mute DOES on the server. What only a browser shows is the panel itself, and it is a panel nothing
// else in the lane opens:
//
//   - it is a lazy chunk behind a gear on the Notifications page, so "the sheet opened" and "the panel
//     rendered" are different claims;
//   - what it saves is a row on the server, not a browser preference - so the mute has to be true in a SECOND
//     browser, which is the whole reason it is stored per employee rather than in local storage;
//   - the browser-push row must never render nothing. It is the one place somebody comes to ask why they are
//     not being notified, and blank space answers by implying the feature does not exist - so it says either
//     "this device can be enrolled" or which of the two reasons it cannot be.
//
// The category muted here is Encashment, deliberately: it is nobody else's business in this lane, so a run
// that dies between the mute and the restore cannot change what another spec is told.
const CATEGORY = "Encashment";
const PANEL = "Your notification preferences";

/** The panel, however it was opened - by the gear, or by the `?setting=` link. */
function prefs(page: import("@playwright/test").Page) {
  return page.getByRole("dialog", { name: PANEL });
}

/** The on/off box for one category row, named by the category beside it. */
function categoryBox(page: import("@playwright/test").Page, label: string) {
  return prefs(page).getByRole("checkbox", { name: label, exact: true });
}

test.describe("notification preferences", () => {
  test("a muted category is saved, survives a reload, and is true in another browser", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("employee");
    await gotoRoute(page, "notifications", "Notifications");

    // The gear beside the page's own heading, named for the panel it opens.
    await page.getByRole("button", { name: PANEL }).click();
    await expect(prefs(page)).toBeVisible();
    // Proof the lazy panel actually rendered rather than the sheet sitting on its skeleton.
    await expect(prefs(page).getByText("Turn a category off to stop those notifications for you.")).toBeVisible({ timeout: 30_000 });
    // The row that must never be empty - one of the two answers, whichever this build and browser justify.
    await expect(
      prefs(page)
        .getByText("Browser notifications on this device")
        .or(prefs(page).getByText("Browser notifications unavailable"))
        .first(),
    ).toBeVisible();

    const box = categoryBox(page, CATEGORY);
    await expect(box).toBeChecked(); // every category is on until somebody turns it off
    const id = await personId(page, "employee");
    const before = await page.request.get(`/v1/employees/${id}/notification-prefs`);
    const kept = (await before.json()) as { muted?: string[]; digest?: boolean };
    try {
      await box.uncheck();
      // Dirty, and the panel says so: the shared unsaved-changes banner is what stops a mute being lost by
      // closing the sheet, and it brings a Save of its own - hence `.last()` below, which is the panel's own.
      await expect(prefs(page).getByText("You have unsaved changes")).toBeVisible();
      await prefs(page).getByRole("button", { name: "Save", exact: true }).last().click();
      // The banner going is the write landing AND the form re-baselining on what it now holds.
      await expect(prefs(page).getByText("You have unsaved changes")).toBeHidden({ timeout: 30_000 });
      // The panel keeps the change on screen, so what proves the write landed is reading it back from cold.
      // The reload comes back INTO the panel rather than onto the page behind it - the gear wrote `?setting=`
      // when it opened the sheet, which is the deep link the second browser uses below.
      await page.reload();
      // Waited on by the panel rather than by `<main>`: the sheet is modal, so while it is open the page
      // behind it is `aria-hidden` and the app's own landmark is not in the tree at all.
      await expect(prefs(page)).toBeVisible({ timeout: 30_000 });
      await expect(categoryBox(page, CATEGORY)).not.toBeChecked({ timeout: 30_000 });

      // The cross-device half: a different browser, the same person, reading the server's copy. A preference
      // that only silenced the tab it was set in would pass everything above and still be the wrong feature.
      const elsewhere = await as("employee");
      await elsewhere.goto("/notifications?setting=notification-prefs");
      await expect(prefs(elsewhere)).toBeVisible({ timeout: 30_000 });
      await expect(categoryBox(elsewhere, CATEGORY)).not.toBeChecked({ timeout: 30_000 });
    } finally {
      // Put the row back exactly as it was found, however this ended: a mute left behind is a category the
      // next run finds already off, and the assertion above would then pass without the panel doing anything.
      // Over the wire rather than through the panel, because this is housekeeping after the assertions and a
      // restore that has to be driven, waited on and re-read is a second flaky thing to go wrong.
      await page.request.patch(`/v1/employees/${id}/notification-prefs`, {
        headers: SPA_HEADERS,
        data: { muted: kept.muted ?? [], digest: kept.digest ?? false },
      });
    }
  });

  test("the pasted link opens straight into the panel", async ({ as }) => {
    const page = await as("employee");
    // The same `?setting=` deep link every inline panel is addressed by, on a USER-scoped one: it resolves
    // against the caller's own employee id rather than an org row, which is the half that has no equivalent
    // in the org panels `settingsSheet` covers.
    await page.goto("/notifications?setting=notification-prefs");
    await expect(prefs(page).getByText("Daily digest")).toBeVisible({ timeout: 30_000 });
    await expect(categoryBox(page, CATEGORY)).toBeVisible();
  });
});
