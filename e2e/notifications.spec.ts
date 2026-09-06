import { SPA_HEADERS, fileLeave, gotoRoute, test, expect } from "./fixtures";

// Something one person did, arriving in another person's browser.
//
// The emit is the server's business and is tested there. What is only true in a browser is the receiving
// end: that the bell carries an unread count for the person it was addressed to, that opening it lists the
// thing that happened, and that reading it clears the count. That chain crosses two users and the
// notifications provider, and it is the mechanism half the app leans on to tell anybody anything.
//
// Read on the EMPLOYEE's bell, on a decision rather than on the filing. The other direction - a request
// landing in the manager's bell - is the same mechanism, but the manager's unread pile is what
// `notificationsPage.spec.ts` empties in one press ("Mark all read"), and two specs cannot both be the
// authority on one person's unread count. Nothing clears the employee's pile wholesale, and the other specs
// that decide this employee's requests can only push the count UP, which is all this asserts.
test("a decision by one person shows up in the other's bell", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const manager = await as("manager");

  // The employee's starting position, whatever the seed and the rest of the lane have left them.
  await gotoRoute(employee, "dashboard");
  const bell = employee.getByRole("banner").getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  const unreadBefore = await settledUnread(employee, bell);

  // A request of their own, decided by their manager - both over the API, because the forms behind them are
  // `leaveTwoRoles.spec.ts`'s subject and repeating them here would test them twice to test the bell once.
  const leave = await fileLeave(employee, `E2E bell ${Date.now()}`);
  const decided = await manager.request.post(`/v1/${leave}:approve`, { headers: SPA_HEADERS });
  expect(decided.ok(), await decided.text()).toBe(true);

  // The employee's browser learns about it on its next load - a write in somebody else's session cannot
  // reach into this one's cache. Polled across reloads: the emit is a server-side follow-on to the decision,
  // and on a busy lane it lands a moment after the response does.
  await expect
    .poll(async () => {
      await employee.reload();
      await expect(employee.getByRole("main")).toBeVisible();
      return settledUnread(employee, bell);
    }, { timeout: 60_000 })
    .toBeGreaterThan(unreadBefore);

  // And it says what happened, not just that something did.
  await bell.click();
  await expect(employee.getByText(/Leave approved/i).first()).toBeVisible({ timeout: 30_000 });
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
