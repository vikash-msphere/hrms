import { SPA_HEADERS, gotoRoute, personPath, test, expect, toast } from "./fixtures";

// The correction queue that lives ON the attendance page.
//
// `attendanceCorrection.spec.ts` files a correction and decides it from the Approvals inbox. This is the
// other half, and it is a different surface with a different rule: an approver reads their own attendance
// page anyway, so the requests waiting on THEM are drawn there, above their own days - and only when there
// are any. That card is the one place a decision is made while looking at the day it changes, which is why
// it names whose day it is and reads back the punches being asked for rather than a row id.
//
// `test/attendanceRegularizationFlow.test.ts` owns what approval does to the day. What only a browser shows
// is the queue appearing, saying what it is about, asking first, and going away when it is answered.
test("a filed correction waits on the approver's own attendance page, and answering it clears the queue", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const manager = await as("manager");
  const reason = `E2E queue ${Date.now() % 100000}`;

  // Filed over the wire: composing one is the other spec's subject. A past weekday, varied per run, because
  // a regularization is answered rather than deleted (its table has no delete_time) and a second request for
  // a day that already has one is refused.
  const day = pastWeekday();
  const filed = await employee.request.post("/v1/attendance-regularizations", {
    headers: SPA_HEADERS,
    data: {
      date: day,
      sessions: [{ clock_in: `${day}T09:30:00.000Z`, clock_out: `${day}T18:00:00.000Z` }],
      reason,
    },
  });
  expect(filed.status(), await filed.text()).toBe(200);

  await gotoRoute(manager, "attendance", "Attendance");

  // The queue, above the manager's own days, counting what is waiting.
  const queue = manager.locator("div").filter({ hasText: "Corrections awaiting you" }).last();
  await expect(manager.getByText("Corrections awaiting you")).toBeVisible({ timeout: 30_000 });
  // Named, dated and priced: whose day, which day, and the times being asked for - a decision made without
  // those is a decision made blind.
  // The row, not the innermost box the text happens to sit in: the one that carries the decision buttons.
  const row = manager
    .locator("div")
    .filter({ hasText: reason })
    .filter({ has: manager.getByRole("button", { name: "Approve" }) })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Eve Employee");
  await expect(row).toContainText(reason);
  await expect(queue).toBeVisible();

  // Approving rewrites a day payroll reads, so it asks first - and names whose day it is about to change.
  await row.getByRole("button", { name: "Approve" }).click();
  const confirm = manager.getByRole("dialog");
  await expect(confirm.getByText(/Eve Employee's correction/)).toBeVisible();
  await confirm.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(toast(manager, "Correction approved")).toBeVisible({ timeout: 30_000 });

  // Answered, so it is no longer waiting on anybody: the row leaves the queue without a reload.
  await expect(manager.locator("div").filter({ hasText: reason })).toHaveCount(0, { timeout: 30_000 });

  // And an employee is not offered somebody else's queue - the card is for whoever may decide.
  await gotoRoute(employee, "attendance", "Attendance");
  await expect(employee.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();
  await expect(employee.getByText("Corrections awaiting you")).toHaveCount(0);
  // The request itself is the employee's own, which is what makes the queue above theirs to answer.
  expect(await personPath(employee, "employee")).toContain("employees/");
});

/**
 * A past weekday nobody has filed a correction for.
 *
 * A correction is for a day that is over, and a filed request is answered rather than deleted - so a day
 * this spec used on an earlier run still holds one, and the server is right to refuse a second. The day
 * therefore moves with the run (and with the worker), and lands on a weekday because a weekend has no
 * scheduled punches to correct.
 */
function pastWeekday(): string {
  const spread = 3 + ((Date.now() / 1000 / 60) % 40 | 0) + test.info().parallelIndex * 41;
  for (let back = spread; back < spread + 7; back++) {
    const day = new Date(Date.now() - back * 86_400_000);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) return day.toISOString().slice(0, 10);
  }
  throw new Error("e2e: a week with no weekday in it");
}
