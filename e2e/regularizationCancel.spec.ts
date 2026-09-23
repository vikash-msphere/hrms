import { SPA_HEADERS, gotoRoute, inDays, personPath, purge, test, expect } from "./fixtures";

// Taking back a correction you should not have asked for.
//
// A correction request sits in somebody else's queue until it is decided, and the requester's own escape is
// on their attendance page: their list of what they have asked to fix, each row with where it stands and -
// while it is still pending - a way to withdraw it. Cancelling is a DECISION verb, so it asks first with the
// shared copy every decision uses, and the row then has to stop offering the way out.
//
// `attendanceCorrection` covers filing one and `pendingCorrections` the approver's side of the queue.
// `test/attendanceRegularizationFlow.test.ts` owns the state machine. What only a browser shows is the
// requester's own list: the affordance appearing only on a pending row, the question, and the row settling.
test("a pending correction is withdrawn by the person who asked for it", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("employee");
  // The reason is what identifies the row: it is printed on it, and it is unique to this run - the DATE is
  // formatted for the reader and several specs correct days for this same seeded person.
  const reason = `E2E withdraw ${Date.now() % 1_000_000}`;

  // A correction of this spec's own, on a day far enough back that nothing else is deciding it. Filed over
  // the wire: the correction dialog is `attendanceCorrection`'s subject, and this one starts once a pending
  // request exists.
  const day = inDays(-40);
  const employee = await personPath(page, "employee");
  const created = await page.request.post("/v1/attendance-regularizations", {
    headers: SPA_HEADERS,
    data: {
      employee,
      date: day,
      sessions: [{ clock_in: `${day}T09:30:00.000Z`, clock_out: `${day}T18:00:00.000Z` }],
      reason,
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  await gotoRoute(page, "attendance", "Attendance");
  const row = requestRow(page, reason);
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Offered because it is still pending, and asked the same way every decision in the app is asked.
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  const ask = page.getByRole("dialog").filter({ hasText: "Cancel this request?" });
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask.getByText(/withdrawn/)).toBeVisible();
  await ask.getByRole("button", { name: "Cancel request", exact: true }).click();

  // Withdrawn on the server...
  await expect.poll(() => state(page, path), { timeout: 30_000 }).toBe("CANCELLED");
  // ...and the row stops offering the way out, because there is nothing left to withdraw.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  const settled = requestRow(page, reason);
  await expect(settled).toBeVisible({ timeout: 30_000 });
  await expect(settled.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);

  // Taken away afterwards: a withdrawn request stays on this person's list forever otherwise, and the next
  // run of this spec would be looking for its row in a longer and longer card. A hard purge is an admin's to
  // make, so it is made from an admin's session.
  const admin = await as("super");
  await purge(admin, path);
});

/** The requester's own row for the correction carrying `reason`, in "My correction requests". */
function requestRow(page: import("@playwright/test").Page, reason: string) {
  // The row is the card's own flex block: it holds the dates, the state pill AND the withdraw button, which a
  // filter on the text alone would not - the deepest element carrying the reason is the paragraph beside them.
  return page.locator("div.flex.items-start.gap-3").filter({ hasText: reason }).first();
}

/** The request's state, as the server records it. */
async function state(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { state?: string }).state?.toUpperCase();
}
