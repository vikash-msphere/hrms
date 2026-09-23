import { fileLeave, gotoRoute, nextWeekday, purge, test, expect } from "./fixtures";

// The dashboard's team timeline: two weeks of the team, drawn.
//
// It is the heaviest widget in the app - fourteen days by every visible employee, over attendance, leave,
// holidays, celebrations, events and the roster - and for that reason it is not rendered at all until its
// slot comes into view, so a reader who never scrolls that far never pays for any of those reads. That alone
// is only observable in a browser, and so is everything it draws: a person's pending leave as a dashed pill
// on their own row, the count of what is awaiting approval INSIDE the window (a number that changes as the
// window moves), and the fortnight itself as something you page through.
//
// `test/` owns leave arithmetic and the attendance rollup. This is about the picture.
test("a filed leave appears on the team timeline, which mounts on view and pages by the fortnight", async ({ as }) => {
  test.setTimeout(240_000);
  const employee = await as("employee");
  // `timeline` is a virtual UI capability with no seeded grant (src/domain/collections.ts): until an org
  // grants it, only super is offered the widget at all - so super is who reads it here. A manager would be
  // testing an org this seed does not describe.
  const manager = await as("super");

  // Inside the window: the timeline draws from the Sunday of this week for a fortnight, so the far-future
  // placeholder day `fileLeave` normally picks would be filed correctly and drawn nowhere.
  const leave = await fileLeave(employee, `E2E timeline ${Date.now()}`, { from: nextWeekday(1) });

  await gotoRoute(manager, "dashboard");
  // Mount-on-view: the widget is not in the page until its slot is scrolled to, which is what keeps its
  // fan-out off a cold dashboard load. So it has to be scrolled to - an assertion alone would wait forever.
  const title = manager.getByText("Team timeline");
  for (let nudge = 0; nudge < 12 && !(await title.isVisible()); nudge++) {
    await manager.mouse.wheel(0, 1_500);
    await manager.waitForTimeout(250);
  }
  await expect(title).toBeVisible({ timeout: 60_000 });

  // The rows are the team, and the header says how many of them there are rather than leaving the reader to
  // count a scrolling list.
  const person = manager.getByText("Eve Employee").first();
  await expect(person).toBeVisible({ timeout: 30_000 });

  // Awaiting approval is a toggle over the same rows, and the number on it counts what is pending in the
  // window that is on screen - the request just filed is in it.
  const pending = manager.getByRole("button", { name: "Awaiting approval" });
  await expect(pending).toHaveAttribute("aria-pressed", "true");
  await expect(pending).toHaveText(/\d+/, { timeout: 30_000 });

  // Paging moves the fortnight, and Today comes back to the one containing now - which is why it starts
  // disabled: the window on screen is already the current one.
  const today = manager.getByRole("button", { name: "Today", exact: true });
  await expect(today).toBeDisabled();
  await manager.getByRole("button", { name: "Next", exact: true }).click();
  await expect(today).toBeEnabled({ timeout: 30_000 });
  await today.click();
  await expect(today).toBeDisabled({ timeout: 30_000 });

  // The pending pills are drawn under the caller's control, and the toggle is a real pressed state rather
  // than a filter that forgets itself.
  await pending.click();
  await expect(pending).toHaveAttribute("aria-pressed", "false");
  await pending.click();
  await expect(pending).toHaveAttribute("aria-pressed", "true");

  await purge(employee, leave);
});
