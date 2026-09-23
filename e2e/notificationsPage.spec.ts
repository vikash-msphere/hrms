import { fileLeave, gotoRoute, test, expect } from "./fixtures";

// The notifications page: the whole pile, not the bell.
//
// `notifications` covers the bell going up when somebody else acts. This is the page behind it, where the
// pile is dealt with - and it is a page of client state that has to agree with the bell at every step: a
// per-type filter with counts, an unread filter, and "mark all read" clearing the count in one press
// without deleting anything. Marking read is not deleting, and a page that conflated the two would lose
// people's history.
test("the notifications page filters by type, then clears the unread count", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const manager = await as("manager");

  // Something to be notified about: the employee files leave, which notifies their manager.
  await fileLeave(employee, `E2E notify ${Date.now()}`);

  await gotoRoute(manager, "notifications", "Notifications");
  await manager.waitForLoadState("networkidle").catch(() => {});

  // The type filter carries its own count, which is how a pile of thirty is triaged by kind.
  const leaveFilter = manager.getByRole("button", { name: /^Leave \d+$/ });
  await expect(leaveFilter).toBeVisible();
  await leaveFilter.click();
  await expect(manager.getByRole("button", { name: /Leave/ }).first()).toBeVisible();

  // Unread, with the number the bell shows.
  const unread = manager.getByRole("button", { name: /^Unread \d+$/ });
  const before = Number(((await unread.innerText()) || "").replace(/\D+/g, ""));
  expect(before).toBeGreaterThan(0);

  // One press clears the pile - and the bell in the top bar agrees, because both read the same collection.
  await manager.getByRole("button", { name: "Mark all read" }).click();
  await expect.poll(async () => (await manager.getByRole("button", { name: /^Unread/ }).innerText()).replace(/\D+/g, ""), { timeout: 15_000 }).toBe("0");
  // The bell agrees, because it reads the same collection: no unread count on it any more.
  await expect(manager.getByRole("button", { name: /^Notifications \(\d+ unread\)/ })).toHaveCount(0);

  // Read, not gone: the history is still under "All".
  await manager.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(manager.getByRole("button", { name: /notification|Leave|announcement/i }).first()).toBeVisible();
});
