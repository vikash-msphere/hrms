import { allowConsoleErrors, gotoRoute, test, expect, toast } from "./fixtures";

// Fixing a day that was clocked wrong.
//
// A correction is NOT a ticket and not an edit: it is an `attendance-regularizations` row that an approver
// decides, and the flow only exists on the attendance page - the day whose times are wrong carries the
// affordance, the dialog is seeded with what the day currently says, and it offers the scheduled day as the
// usual replacement. `test/attendanceRegularizationFlow.test.ts` owns what approval does to the day. What
// only a browser shows is that the wrong day can be FOUND and the request composed from it: the dialog reads
// the day's own punches, shows the difference the request would make, and refuses to file without times.
test("an employee asks for a wrong day to be corrected, and their manager approves it", async ({ as }) => {
  const employee = await as("employee");
  const manager = await as("manager");

  // The inbox is shared: another browser deciding in the same instant makes the server answer this one with
  // a conflict, which the poll below simply presses through.
  allowConsoleErrors(manager, /status of 409/);

  const reason = `E2E correction ${Date.now()}`;
  await gotoRoute(employee, "attendance", "Attendance");

  // Every day in the month list carries its own correction affordance, named after the day it fixes - so a
  // request can never be filed against the row above the one that was clicked.
  const correct = employee.getByRole("button", { name: /^Request a correction for/ });
  // Only days that have happened carry one (a correction for tomorrow is refused), so on the 1st - when the
  // month's only rows can be the holidays still ahead in it - the month before is where the days are.
  const previous = employee.getByRole("button", { name: "Previous month" });
  await expect(previous).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if (!(await correct.count())) await previous.click();
    await expect(correct.first()).toBeAttached({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await correct.first().click();

  const dialog = employee.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Correct attendance/ })).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Submit request" });

  // The scheduled day is the replacement people actually want, offered as one press rather than four typed
  // times.
  await dialog.getByRole("button", { name: /^Scheduled day/ }).click();
  await expect(dialog.getByText(/Day totals/)).toBeVisible();

  await dialog.getByLabel("Reason").fill(reason);
  await submit.click();
  await expect(toast(employee, /Correction requested/)).toBeVisible();

  // The request this spec just filed, by its path: what follows decides THAT row and reads THAT row back,
  // rather than counting the queue. The inbox is shared with every other spec that files something for this
  // person, so its size says nothing about this request - and approving whatever happens to be last in it
  // would be deciding somebody else's.
  const path = await filedCorrection(employee, reason);

  // The manager's queue has it, and deciding it settles the row.
  await gotoRoute(manager, "approvals", "Approvals");
  await manager.reload();
  // A cold reload rebuilds the shell and refetches the inbox, which is not a five-second job on a loaded lane.
  await expect(manager.getByRole("main")).toBeVisible({ timeout: 30_000 });
  const row = manager
    .locator("div")
    .filter({ hasText: reason })
    .filter({ has: manager.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await expect(row, "the correction never reached the approvals inbox").toBeVisible({ timeout: 30_000 });

  // Pressed until the record says approved: a decision can lose a race with another browser working the
  // same inbox, and the app then says so and expects the reader to press again.
  await expect
    .poll(
      async () => {
        // `isEnabled`, not `count`: the button disables itself while the decision it already carries is in
        // flight, and the row is replaced when the answer lands. Pressing a disabled one only waits for it to
        // come back - which it never does, because it leaves with the row.
        const approve = row.getByRole("button", { name: "Approve", exact: true });
        // Bounded and swallowed: the row is REPLACED when a decision lands, so this very button can detach
        // between resolving and being asked - and an `isEnabled` that throws out of a poll callback ends the
        // poll then and there, with most of its budget unspent. A button that cannot answer is simply not
        // pressable this pass; the next one resolves the row again.
        const pressable = (await approve.count()) && (await approve.isEnabled({ timeout: 2_000 }).catch(() => false));
        if (pressable) {
          await approve.click({ timeout: 5_000 }).catch(() => undefined);
          const confirm = manager.getByRole("dialog").getByRole("button", { name: "Approve", exact: true });
          if (await confirm.count()) await confirm.click({ timeout: 5_000 }).catch(() => undefined);
        }
        const after = await manager.request.get(`/v1/${path}`);
        return after.ok() ? ((await after.json()) as { state?: string }).state : "unreadable";
      },
      { timeout: 90_000 },
    )
    .toBe("APPROVED");
});

/** The path of the correction this spec filed, found by its own reason. */
async function filedCorrection(employee: import("@playwright/test").Page, reason: string): Promise<string> {
  const res = await employee.request.get("/v1/attendance-regularizations?page_size=200");
  expect(res.ok(), await res.text()).toBe(true);
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string }[] };
  const mine = results.find((r) => r.reason === reason);
  expect(mine, `the correction "${reason}" was not filed`).toBeTruthy();
  return mine!.path;
}
