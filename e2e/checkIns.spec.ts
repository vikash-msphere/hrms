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

  // Dated in the future, so the dialog offers to SCHEDULE it rather than log it as already held. Its own
  // path is read off THIS response, not guessed as "whatever check-in is newest org-wide" once the dialog
  // closes - `checkInDelete.spec.ts` creates one for the SAME two people (employee/manager) at the same time,
  // and a global "newest" pick can grab its row and hard-purge it out from under that spec's own soft-delete
  // assertion instead of this spec's own.
  const [response] = await Promise.all([
    employee.waitForResponse((r) => r.url().includes("/v1/check-ins") && r.request().method() === "POST"),
    form.getByRole("button", { name: "Schedule 1:1" }).click(),
  ]);
  const created = ((await response.json()) as { path: string }).path;
  await expect(employee.getByRole("dialog")).toHaveCount(0);
  await expect(employee.getByText("Mara Manager").first()).toBeVisible(); // their own page names who it is with

  // The manager finds it on their own page, named by the person it is with.
  await gotoRoute(manager, "check-ins", "1:1s");
  await expect(manager.getByText("Eve Employee").first()).toBeVisible();

  await purge(employee, created);
});
