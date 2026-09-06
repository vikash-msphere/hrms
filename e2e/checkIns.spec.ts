import { gotoRoute, purge, test, expect } from "./fixtures";

// A 1:1, scheduled with a cadence.
//
// The recurrence is the part the composer has to make visible: a repeat nobody can see is a repeat nobody
// trusts, so the form previews the next few dates a cadence will produce BEFORE it is saved - stepped the
// same way the cron will step them. `test/checkInRecurrence.test.ts` owns the stepping; the preview and the
// 1:1 landing on the other person's page only exist in the browser.
//
// The employee books it and the manager reads it, which is the direction the seeded policy allows: a 1:1 is
// owner-coded to whoever created it (`check-ins.me.**`), and the manager's dept breadth
// (`check-ins.my-dept.**`) is what lets the other side see it at all.
test("a recurring 1:1 previews its dates, and the other side can read it", async ({ as }) => {
  const employee = await as("employee");
  const manager = await as("manager");

  await gotoRoute(employee, "check-ins", "1:1s");
  await employee.getByRole("button", { name: "New 1:1" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New 1:1" })).toBeVisible();

  // An employee's "With" is left blank on purpose: they can only read their own employee record, so the
  // picker has nobody to offer them - and the form says so, defaulting the 1:1 to their manager. A form that
  // demanded a pick here would be unusable for exactly the people it is for.
  await expect(form.getByLabel("With")).toHaveText("Your manager");
  await expect(form.getByText(/Shared with your manager/)).toBeVisible();
  await form.getByRole("button", { name: "Next week", exact: true }).click();

  // A cadence, and the dates it will produce - shown before anybody commits to it.
  await form.getByLabel("Repeats").click();
  await employee.getByRole("option", { name: "Weekly", exact: true }).click();
  await expect(form.getByText(/^Then /)).toBeVisible();

  // Dated in the future, so the dialog offers to SCHEDULE it rather than log it as already held.
  await form.getByRole("button", { name: "Schedule 1:1" }).click();
  await expect(employee.getByRole("dialog")).toHaveCount(0);
  await expect(employee.getByText("Mara Manager").first()).toBeVisible(); // their own page names who it is with

  // The manager finds it on their own page, named by the person it is with.
  await gotoRoute(manager, "check-ins", "1:1s");
  await expect(manager.getByText("Eve Employee").first()).toBeVisible();

  await purge(employee, await latestCheckIn(employee));
});

/** The most recent check-in, which is the one this spec just scheduled. */
async function latestCheckIn(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/check-ins?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (!newest) throw new Error("e2e: no check-ins to clean up");
  return newest.path;
}
