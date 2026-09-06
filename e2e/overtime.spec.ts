import { allowConsoleErrors, inDays, gotoRoute, test, expect, toast } from "./fixtures";

// Logging extra hours, through the control that composes a time RANGE.
//
// The hours themselves are the server's business. What only a browser shows is `TimeRangeField` - the shared
// start/end picker this form, the shift roster and the events editor all use. It is a small state machine of
// its own: a date, two times, a live duration between them, quick-set chips that move the end relative to the
// start, and a next-day label when the range crosses midnight. None of that is reachable from a unit test,
// and a broken chip means every page that composes a time range is broken at once.
test("an employee logs overtime with the range picker and their manager approves it", async ({ as }) => {
  const employee = await as("employee");
  const manager = await as("manager");
  // A conflict is a legitimate answer here (see the retry below), and the browser logs every 409 it receives.
  allowConsoleErrors(manager, /status of 409/);

  await gotoRoute(manager, "approvals", "Approvals");
  await manager.waitForLoadState("networkidle").catch(() => {});
  const queue = manager.getByRole("button", { name: "Approve", exact: true });

  const reason = `E2E overtime ${Date.now()}`;
  await gotoRoute(employee, "overtime", "Overtime");
  await employee.getByRole("button", { name: "Log overtime" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Log overtime" })).toBeVisible();

  // Whose hours: the common case collapses to a line of text rather than a picker, so a self-service form
  // does not read like an admin one.
  await expect(form.getByText(/Eve Employee/)).toBeVisible();

  // The range: a day, a start, and a duration chip that sets the end from it.
  await form.getByLabel("Date", { exact: true }).fill(yesterday());
  // `exact`: the picker button beside each field is labelled "Pick time", which a substring match would
  // sweep up along with the fields themselves.
  const times = form.getByLabel("Time", { exact: true });
  await times.first().fill("6:00 PM");
  await times.first().blur();
  await form.getByRole("button", { name: "2h", exact: true }).click();
  // The duration between the two ends is drawn live - it is how anybody checks they typed what they meant -
  // and the end field is moved BY the chip rather than typed.
  await expect(form.getByText("2h", { exact: true }).first()).toBeVisible();
  await expect(times.last()).toHaveValue(/8:00\s*PM/i);

  await form.getByLabel("Reason").fill(reason);
  await form.getByRole("button", { name: "Log overtime", exact: true }).click();
  await expect(toast(employee, "Overtime logged")).toBeVisible();
  await expect(employee.locator("tbody tr").filter({ hasText: reason })).toHaveCount(1);

  // Their manager decides it - my-dept is the breadth the seeded policy gives a manager over overtime.
  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  // This request's own row, not "one more than there was": the inbox is shared with every other spec that
  // files something for this person.
  const row = manager
    .locator("div")
    .filter({ hasText: reason })
    .filter({ has: manager.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Retried on a lost race: the inbox is shared, so another browser can decide something in the same instant
  // and the server answers this one with a conflict. Reloading and pressing again is what the reader does.
  await expect(async () => {
    if (!(await row.count())) return;
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    await manager.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(
    manager.locator("li, div").filter({ hasText: reason }).filter({ has: queue }),
  ).toHaveCount(0, { timeout: 30_000 });
});

/** Yesterday, as a date input wants it - overtime is logged after it is worked. */
const yesterday = () => inDays(-1);
