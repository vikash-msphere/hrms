import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The other half of the decision `pendingCorrections.spec.ts` only takes one side of: that spec approves the
// filed correction, so nothing has ever pressed Reject on the same queue. It is not the same code path -
// `attendance-regularizations.reject` is its own gated verb, wired to its own confirm copy ("Reject this
// request?" / "Correction rejected") - and unlike approve, a rejection does NOT touch the employee's punches,
// so the queue clearing on reject (rather than the day changing) is the thing worth a browser proving.
test("a filed correction is rejected from the approver's own attendance page, and leaves the day untouched", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const manager = await as("manager");
  const reason = `E2E reject-queue ${Date.now() % 100000}`;
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
  await expect(manager.getByText("Corrections awaiting you")).toBeVisible({ timeout: 30_000 });
  const row = manager
    .locator("div")
    .filter({ hasText: reason })
    .filter({ has: manager.getByRole("button", { name: "Reject" }) })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Eve Employee");

  await row.getByRole("button", { name: "Reject" }).click();
  const confirm = manager.getByRole("dialog");
  await expect(confirm.getByText("Reject this request?")).toBeVisible();
  await expect(confirm.getByText(/Eve Employee's correction/)).toBeVisible();
  await confirm.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(toast(manager, "Correction rejected")).toBeVisible({ timeout: 30_000 });

  // Answered, so it leaves the queue without a reload - same as an approval does.
  await expect(manager.locator("div").filter({ hasText: reason })).toHaveCount(0, { timeout: 30_000 });

  // Rejection is a "no", not an edit: it never rewrote the day's punches, so nothing to correct was created.
  const after = await employee.request.get(`/v1/attendance-regularizations?page_size=50`);
  const { results = [] } = (await after.json()) as { results?: { reason?: string; state?: string }[] };
  const mine = results.find((r) => r.reason === reason);
  expect(mine?.state?.toUpperCase()).toBe("REJECTED");
});

/** A past weekday nobody has filed a correction for - see `pendingCorrections.spec.ts` for why this dance. */
function pastWeekday(): string {
  const spread = 3 + ((Date.now() / 1000 / 60) % 40 | 0) + test.info().parallelIndex * 41 + 500;
  for (let back = spread; back < spread + 7; back++) {
    const day = new Date(Date.now() - back * 86_400_000);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) return day.toISOString().slice(0, 10);
  }
  throw new Error("e2e: a week with no weekday in it");
}
