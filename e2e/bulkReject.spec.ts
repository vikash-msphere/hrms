import { allowConsoleErrors, fileLeave, gotoRoute, test, expect } from "./fixtures";

// Clearing a queue several at a time, the other way.
//
// `bulkApproval.spec.ts` proves the bulk bar's Approve path. Reject is not the same button with a different
// label: `runBulkDecision` asks for ONE required reason that every requester in the batch is sent, a
// different verb per collection, and its own merged summary.
test("several requests can be rejected together, with one reason sent to each requester", async ({ as }) => {
  const page = await as("super");
  // Two browsers deciding from one shared inbox can collide; the server says 409 and the batch is pressed
  // again below, so the console line that comes with it is expected rather than a failure.
  allowConsoleErrors(page, /status of 409/);
  const employee = await as("employee");
  const mine = [await fileLeave(employee, `E2E bulk-reject a ${Date.now()}`), await fileLeave(employee, `E2E bulk-reject b ${Date.now()}`)];
  await gotoRoute(page, "approvals");

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve.first()).toBeVisible();
  expect(await approve.count(), "the two requests filed above should be waiting here").toBeGreaterThanOrEqual(2);

  const state = async (path: string) => {
    const after = await page.request.get(`/v1/${path}`);
    return after.ok() ? ((await after.json()) as { state?: string }).state : "unreadable";
  };

  // Retried as one whole selection-and-submit unit: two admins deciding from the same shared inbox at once
  // (this suite runs several approval specs concurrently against it) can collide, and the batch write 409s on
  // a row somebody else just moved out from under it - reselecting from the still-pending rows and pressing
  // again is what recovers, matching what an admin re-opening the page would do, not a single trusted press.
  await expect(async () => {
    const pending = (await Promise.all(mine.map(async (path) => ((await state(path)) === "PENDING" ? path : null))))
      .filter((p): p is string => p !== null);
    if (!pending.length) return;

    for (const path of pending) {
      const filed = await page.request.get(`/v1/${path}`);
      expect(filed.ok(), await filed.text()).toBe(true);
      const startDate = ((await filed.json()) as { start_date: string }).start_date;
      const [year, , day] = startDate.split("-");
      // The specific month, not a wildcard: day-of-month + year alone collides across the far-future days
      // this suite hands out (see bulkApproval.spec.ts's own comment on the same fix), and would just as
      // happily match somebody else's pending request.
      const month = new Date(`${startDate}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
      const row = page.locator("li, div").filter({ hasText: new RegExp(`${Number(day)}\\s+${month}\\s+${year}`) }).filter({ has: approve }).last();
      await expect(row, `nothing waiting for ${path}`).toBeVisible({ timeout: 10_000 });
      const box = row.getByRole("checkbox", { name: /Select .*'s request/ });
      if (!(await box.isChecked())) await box.check();
    }
    await expect(page.getByText(`${pending.length} selected`)).toBeVisible({ timeout: 10_000 });

    // Reject selected: a destructive prompt that will not go until it has a reason, the same reason for all.
    await page.getByRole("button", { name: "Reject selected" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText(new RegExp(`Reject ${pending.length} request`))).toBeVisible({ timeout: 10_000 });
    const submit = confirm.getByRole("button", { name: `Reject ${pending.length}`, exact: true });
    await expect(submit).toBeDisabled();
    await confirm.getByRole("textbox", { name: "Reason", exact: true }).fill(REASON);
    await submit.click();
    await expect(page.getByText(`${pending.length} selected`)).toHaveCount(0, { timeout: 10_000 });

    for (const path of pending) expect(await state(path), `${path} after the bulk reject`).toBe("REJECTED");
  }).toPass({ timeout: 60_000 });

  // Each request carries the one reason, for its requester to read.
  for (const path of mine) {
    const res = await employee.request.get(`/v1/${path}`);
    expect(((await res.json()) as { decision_note?: string }).decision_note).toBe(REASON);
  }
});

const REASON = "Team is at minimum cover that week";
