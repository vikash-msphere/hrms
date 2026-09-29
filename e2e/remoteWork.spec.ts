import { gotoRoute, inDays, toast, expect, test } from "./fixtures";

// Asking to work from somewhere else, and the form doing the counting.
//
// A remote-work request is a date RANGE with half-day ends, and the form's whole job is to turn what was
// picked into the number of days it is asking for before anybody commits to it - a count that changes as the
// ends are switched between full day and half. That preview only exists in the rendered form, and it is the
// number both the requester and the approver read.
test("an employee requests remote days, the form counts them, and the manager approves", async ({ as }) => {
  // Two sign-ins, a request, a decision and three waits of up to 30s each: the 30s default is the whole test.
  test.setTimeout(120_000);
  const employee = await as("employee");
  const manager = await as("manager");

  await gotoRoute(manager, "approvals", "Approvals");
  await manager.waitForLoadState("networkidle").catch(() => {});

  const reason = `E2E remote ${Date.now()}`;
  await gotoRoute(employee, "remote-work", "Remote work");
  await employee.getByRole("button", { name: "Request remote" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Request remote work" })).toBeVisible();

  // Three days, next week: the count is drawn from the range, not typed.
  await form.getByLabel("From").fill(inDays(7));
  await form.getByLabel("To").fill(inDays(9));
  await expect(form.getByText(/3 remote days requested/)).toBeVisible();

  // Halving the last day is a real change to what is being asked for. The end-of-range choices are a
  // radiogroup, which is what makes them arrow-key operable rather than three lookalike buttons.
  const lastDay = form.getByRole("radiogroup", { name: "Last day" });
  await lastDay.getByRole("radio", { name: /Morning only/ }).click();
  await expect(lastDay.getByRole("radio", { name: /Morning only/ })).toHaveAttribute("aria-checked", "true");
  await expect(form.getByText(/remote days? requested/)).toBeVisible();

  await form.getByLabel("Location").fill("Home");
  await form.getByLabel("Reason").fill(reason);
  await form.getByRole("button", { name: "Request remote work", exact: true }).click();
  await expect(toast(employee, "Remote work requested")).toBeVisible();
  await expect(employee.locator("tbody tr").filter({ hasText: "Home" }).first()).toBeVisible();

  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  // Found by its own reason rather than by "one more than there was": the inbox is shared, and another spec
  // filing or deciding something in parallel would make a count-based assertion a coin toss.
  const row = manager
    .locator("div")
    .filter({ hasText: reason })
    .filter({ has: manager.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // "Open" is THIS request, on the requester's record - not the Remote work page, which lists only the
  // manager's own requests and so had nothing of the employee's on it.
  await row.getByRole("button", { name: "Open this request" }).click();
  await expect(manager).toHaveURL(/\/employees\/[^/]+\/attendance\?request=remote-work-requests%2F/);
  await expect(manager.getByRole("tab", { name: "Attendance", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  const picked = manager.locator('tr[aria-current="true"]').filter({ hasText: reason });
  await expect(picked).toBeVisible({ timeout: 30_000 });

  // And it is decided right there: the same confirmation as the inbox, and the row re-reads as approved.
  await picked.getByRole("button", { name: "Approve", exact: true }).click();
  await manager.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(picked.getByText("Approved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(picked.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  // The decision is done when THIS request has left the queue - not when the queue is a particular size.
  await manager.goBack();
  await expect(manager.locator("div").filter({ hasText: reason }).filter({ has: manager.getByRole("button", { name: "Approve", exact: true }) })).toHaveCount(0, { timeout: 30_000 });
});
