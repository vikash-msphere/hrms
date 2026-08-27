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

  // The session lapses (expired cookie, revoked key, a signed-out sibling tab).
  await page.context().clearCookies();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // In place, and honest about what happened.
  await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
  await expect(page.getByText(/Your session expired\. Anything you were typing is still here/)).toBeVisible();

  // The whole point: still on the page, still holding what was typed. Located from the page rather than
  // through `dialog`: the overlay is modal, so Radix hides everything outside it from the accessibility tree
  // and a role-based lookup would find nothing even though the form is still mounted and filled in.
  await expect(page.getByPlaceholder("Vendor or supplier name")).toHaveValue(typed);
  await expect(page).toHaveURL(/#\/vendors/);
});
