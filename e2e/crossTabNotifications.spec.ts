import { SPA_HEADERS, fileLeave, gotoRoute, test, expect } from "./fixtures";

// One tab's mutation, mirrored into a SIBLING tab of the same login - with no reload and no extra read.
//
// `test/notifications` owns the server side and `notifications.spec.ts` owns a write in one PERSON's session
// reaching another person's on their next load. Neither can show the thing `lib/crossTabBus.ts` actually
// exists for: two tabs open as the SAME person share nothing but local state and a BroadcastChannel, so
// marking a notification read in one has no way to reach the other except this bus - and `notifications.spec`
// only ever drives one page per person, which is exactly where that gap hides. If the broadcast silently
// stopped firing, that spec and the server test would both stay green while a real person with the app open
// on two monitors watched their bell disagree with itself.
//
// The count is read as a strict decrease rather than an exact one, the same way `notifications.spec.ts` reads
// it as a strict increase: this employee's pile is shared with every other spec that decides one of their
// requests, so an exact delta would be a coin flip on a busy run.
test("marking a notification read in one tab drops the unread count in a sibling tab, with no reload", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const manager = await as("manager");
  const title = `E2E cross-tab ${Date.now()}`;

  // A notification this spec can be sure exists, so there is always something on tab A to mark read - the
  // same mechanism `notifications.spec.ts` uses to raise the employee's bell, over the API so the form behind
  // it isn't tested a second time here.
  const leave = await fileLeave(employee, title);
  const decided = await manager.request.post(`/v1/${leave}:approve`, { headers: SPA_HEADERS });
  expect(decided.ok(), await decided.text()).toBe(true);

  // Two tabs of the one login: `newPage` on the SAME context, which is what shares the storage partition the
  // bus's BroadcastChannel lives on. Two separate `as()` calls would each get their own context and prove
  // nothing about this mechanism.
  const tabA = employee;
  const tabB = await employee.context().newPage();

  await gotoRoute(tabA, "notifications", "Notifications");
  // Waited on rather than assumed present: the emit is a server-side follow-on to the approve above and can
  // land a beat after the response does.
  const row = tabA.getByRole("button", { name: /Leave approved/i }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });

  await gotoRoute(tabB, "dashboard");
  const bellB = tabB.getByRole("banner").getByRole("button", { name: /^Notifications/ });
  await expect(bellB).toBeVisible();
  await tabB.waitForLoadState("networkidle").catch(() => {});
  const before = unreadOf(await bellB.getAttribute("aria-label"));
  expect(before, "tab B has to start with at least the notification tab A is about to clear").toBeGreaterThan(0);

  // The mark-read that matters: pressed on tab A, read back on tab B, on the SAME dropdown that never
  // reloaded and never issued a second fetch of its own.
  await row.click();
  await expect
    .poll(async () => unreadOf(await bellB.getAttribute("aria-label")), { timeout: 15_000 })
    .toBeLessThan(before);

  await tabB.close();
});

function unreadOf(label: string | null): number {
  return Number(/\((\d+) unread\)/.exec(label ?? "")?.[1] ?? 0);
}
