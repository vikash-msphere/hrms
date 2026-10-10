import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

type LeaveBalanceRow = { path: string; employee?: string; leave_type?: string; balance_days?: number };
type LeaveTypeRow = { path: string; etag: string; encashable?: boolean; encashment_cap_days_per_year?: number | null; min_balance_retained_days?: number };

// The encashment row's own decision buttons - `timeOffAdmin.spec.ts` proves an encashment can be FILED,
// `leaveEncashmentEligibility.spec.ts` proves the create form's arithmetic, but nothing has ever pressed
// Approve, Reject or Cancel on the row those tests leave sitting in "Pending". A PENDING encashment does not
// touch the balance yet (`computeAndStoreEncashment`'s own comment: "re-priced at approval, which is when the
// payout is committed") - so rejecting one is provably a no-op on the balance, which this pins alongside the
// decision itself.
//
// Same borrow-a-real-balance trick as `leaveEncashmentEligibility.spec.ts`, for the same reason: the seed
// ships no encashable leave type, so one is made encashable just long enough to file and decide against it,
// then put back exactly as found.
test("a pending encashment is rejected from its own row, and the balance is untouched", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");

  const balRes = await page.request.get("/v1/leave-balances?max_page_size=200");
  expect(balRes.status(), await balRes.text()).toBe(200);
  const { results: balances = [] } = (await balRes.json()) as { results?: LeaveBalanceRow[] };
  // Between 1 and 2 days on purpose: `leaveEncashmentEligibility.spec.ts` borrows the same way but only takes
  // >=2, so this picks from a disjoint slice of the same list rather than racing it for the same row.
  const bal = balances.find((b) => (b.balance_days ?? 0) >= 1 && (b.balance_days ?? 0) < 2) ?? balances.find((b) => (b.balance_days ?? 0) >= 1);
  expect(bal, "no seeded employee has a leave balance of at least 1 day to borrow").toBeTruthy();
  const balanceBefore = bal!.balance_days!;

  const typeRes = await page.request.get(`/v1/${bal!.leave_type}`);
  expect(typeRes.status(), await typeRes.text()).toBe(200);
  const original = (await typeRes.json()) as LeaveTypeRow;

  const empRes = await page.request.get(`/v1/${bal!.employee}`);
  expect(empRes.status(), await empRes.text()).toBe(200);
  const employee = (await empRes.json()) as { first_name: string; last_name: string };
  const empName = `${employee.first_name} ${employee.last_name}`;

  const patched = await page.request.patch(`/v1/${bal!.leave_type}`, {
    headers: { ...SPA_HEADERS, "If-Match": original.etag },
    data: { encashable: true, min_balance_retained_days: 0, encashment_cap_days_per_year: null },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  let encashmentPath: string | undefined;
  try {
    const made = await page.request.post("/v1/leave-encashments", {
      headers: SPA_HEADERS,
      data: { employee: bal!.employee, leave_type: bal!.leave_type, days: 1 },
    });
    expect(made.status(), await made.text()).toBe(200);
    encashmentPath = ((await made.json()) as { path: string }).path;

    await gotoRoute(page, "leave-requests", "Leaves");
    await page.getByRole("tab", { name: /^Encashments/ }).click();
    const row = page.locator("tbody tr").filter({ hasText: empName }).filter({ has: page.getByRole("button", { name: "Reject" }) }).last();
    await expect(row, "the filed encashment never showed up pending").toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Reject" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Reject this request?")).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText(new RegExp(`${empName}'s encashment of 1 day`))).toBeVisible();
    await confirm.getByRole("textbox", { name: "Reason", exact: true }).fill("Keep the days for the year-end shutdown");
    await confirm.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(toast(page, "Encashment rejected")).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(async () => {
        const after = await page.request.get(`/v1/${encashmentPath}`);
        return after.ok() ? ((await after.json()) as { state?: string }).state : "unreadable";
      }, { timeout: 30_000 })
      .toBe("REJECTED");

    // The balance a pending (now rejected) request never actually reserved is exactly what it was before.
    // (leave-balances filters by employee only - the type is matched client-side.)
    const balAfter = await page.request.get(`/v1/leave-balances?employee=${encodeURIComponent(bal!.employee!)}&max_page_size=200`);
    const { results: after = [] } = (await balAfter.json()) as { results?: LeaveBalanceRow[] };
    expect(after.find((b) => b.leave_type === bal!.leave_type)?.balance_days).toBe(balanceBefore);
  } finally {
    if (encashmentPath) await purge(page, encashmentPath);
    // Restored last, so a failure above still leaves the borrowed type as found rather than compounding onto
    // the next run of this or `leaveEncashmentEligibility.spec.ts`.
    const current = await page.request.get(`/v1/${bal!.leave_type}`);
    if (current.ok()) {
      const now = (await current.json()) as LeaveTypeRow;
      await page.request.patch(`/v1/${bal!.leave_type}`, {
        headers: { ...SPA_HEADERS, "If-Match": now.etag },
        data: {
          encashable: original.encashable ?? false,
          min_balance_retained_days: original.min_balance_retained_days ?? 0,
          encashment_cap_days_per_year: original.encashment_cap_days_per_year ?? null,
        },
      });
    }
  }
});
