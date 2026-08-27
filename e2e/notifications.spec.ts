import { fileLeave, gotoRoute, test, expect } from "./fixtures";

// Something one person did, arriving in another person's browser.
//
// The emit is the server's business and is tested there. What is only true in a browser is the receiving
// end: that the bell carries an unread count for the person it was addressed to, that opening it lists the
// thing that happened, and that reading it clears the count. That chain crosses two users and the
// notifications provider, and it is the mechanism half the app leans on to tell anybody anything.
test("a request filed by one person shows up in their manager's bell", async ({ as }) => {
  const employee = await as("employee");
  const manager = await as("manager");

  // The manager's starting position, whatever the seed left them.
  await gotoRoute(manager, "dashboard");
  const bell = manager.getByRole("banner").getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  const unreadBefore = await settledUnread(manager, bell);

  // The employee files leave (through the API - the UI path is leaveTwoRoles.spec.ts, and repeating it here
  // would be testing the form twice to test the bell once).
  await fileLeave(employee, `E2E bell ${Date.now()}`);

  // The manager's browser learns about it on its next load - a write in somebody else's session cannot reach
  // into this one's cache.
  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  expect(await settledUnread(manager, bell)).toBe(unreadBefore + 1);

  // And it says what happened, not just that something did.
  await bell.click();
  const item = manager.getByText("New leave request to review").first();
  await expect(item).toBeVisible();
});

/** The number on the bell, from its own accessible name ("Notifications (3 unread)").
 *
 *  Read only once the page has stopped fetching: the count arrives with the notifications themselves, so
 *  sampling it the moment the shell paints reads a confident 0 and turns the delta below into nonsense. */
async function settledUnread(
  page: import("@playwright/test").Page,
  bell: import("@playwright/test").Locator,
): Promise<number> {
  await page.waitForLoadState("networkidle").catch(() => {});
  const label = (await bell.getAttribute("aria-label")) ?? "";
  return Number(/\((\d+) unread\)/.exec(label)?.[1] ?? 0);
}
