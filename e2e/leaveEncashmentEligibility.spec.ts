import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

type LeaveBalanceRow = { path: string; employee?: string; leave_type?: string; balance_days?: number };
type LeaveTypeRow = {
  path: string;
  etag: string;
  display_name?: string;
  encashable?: boolean;
  encashment_cap_days_per_year?: number | null;
  min_balance_retained_days?: number;
};

// `timeOffAdmin.spec.ts` already proves the happy path of encashing a day - but this stack's seed ships no
// encashable leave type, so that test's own "no leave types are marked encashable" branch is the one that
// actually runs. What never gets exercised anywhere is the form's real arithmetic: the type's retained
// minimum and yearly cap bound how many days can be encashed RIGHT NOW, worked out and shown before the
// request is sent rather than left for the server to refuse.
//
// leave-balances is read-only (accrued by a cron this stack never runs), so there is no way to hand a fresh
// type a balance of its own - this borrows an already-nonzero balance from the seed by making its EXISTING
// leave type encashable just long enough to exercise the math, then puts the type back exactly as found.
test("an encashment's hint, Max button and cap refusal match the balance/retained/cap arithmetic", async ({ as }) => {
  test.setTimeout(120_000);
  // hr_admin: the role that actually works this page day to day. It has read on leave-balances (grants.ts),
  // so its balance-driven hint reflects the employee's REAL balance rather than silently reading 0.
  const page = await as("hr");

  const balRes = await page.request.get("/v1/leave-balances?max_page_size=200");
  expect(balRes.status(), await balRes.text()).toBe(200);
  const { results: balances = [] } = (await balRes.json()) as { results?: LeaveBalanceRow[] };
  // >=2 leaves at least 1 day of headroom once 1 is retained, so the cap constructed below is always the
  // tighter number - the one branch every assertion below is written against.
  const bal = balances.find((b) => (b.balance_days ?? 0) >= 2);
  expect(bal, "no seeded employee has a leave balance of at least 2 days to borrow").toBeTruthy();
  const balanceDays = bal!.balance_days!;

  const typeRes = await page.request.get(`/v1/${bal!.leave_type}`);
  expect(typeRes.status(), await typeRes.text()).toBe(200);
  const original = (await typeRes.json()) as LeaveTypeRow;

  const empRes = await page.request.get(`/v1/${bal!.employee}`);
  expect(empRes.status(), await empRes.text()).toBe(200);
  const employee = (await empRes.json()) as { first_name: string; last_name: string };
  const empName = `${employee.first_name} ${employee.last_name}`;

  const snapHalf = (x: number) => Math.floor(x * 2) / 2;
  const retained = 1;
  const remaining = balanceDays - retained;
  const cap = Math.max(0.5, snapHalf(remaining / 2));
  const capSuffix = cap === 1 ? "" : "s";

  let etag = original.etag;
  const patched = await page.request.patch(`/v1/${bal!.leave_type}`, {
    headers: { ...SPA_HEADERS, "If-Match": etag },
    data: { encashable: true, min_balance_retained_days: retained, encashment_cap_days_per_year: cap },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  etag = ((await patched.json()) as { etag: string }).etag;

  let createdPath: string | undefined;
  try {
    await gotoRoute(page, "leave-requests", "Leaves");
    await page.getByRole("tab", { name: /^Encashments/ }).click();
    await page.getByRole("button", { name: "New encashment" }).first().click();
    const form = page.getByRole("dialog");

    await form.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill(empName);
    await expect(page.getByRole("button", { name: new RegExp(empName) })).toBeVisible();
    await page.keyboard.press("Enter");

    await form.getByLabel("Leave type").click();
    await page.getByRole("option").filter({ hasText: original.display_name ?? "" }).first().click();

    // The hint says the balance, what the policy keeps back, what's left of the cap, and the max in one
    // line - before anything is typed into "Days to encash".
    await expect(form.getByText(`Balance: ${balanceDays} days`, { exact: false })).toBeVisible();
    await expect(form.getByText("policy keeps 1 unencashed", { exact: false })).toBeVisible();
    await expect(form.getByText(`of the ${cap}/year cap left`, { exact: false })).toBeVisible();
    await expect(form.getByText(`max now: ${cap}`, { exact: false })).toBeVisible();

    // "Cash out everything I'm allowed to" filled in with one press, rather than the caller working the
    // retained minimum and the cap out by hand.
    const maxBtn = form.getByRole("button", { name: `Max ${cap}` });
    await expect(maxBtn).toBeVisible();
    await maxBtn.click();
    const daysField = form.getByLabel("Days to encash");
    await expect(daysField).toHaveValue(String(cap));
    const submit = form.getByRole("button", { name: "Request encashment" });
    await expect(submit).toBeEnabled();

    // Over the cap: refused on the field, and the submit follows it - not left for the server to reject.
    await daysField.fill(String(cap + 1));
    await expect(form.getByText(`Only ${cap} day${capSuffix} can be encashed.`)).toBeVisible();
    await expect(submit).toBeDisabled();

    // Back within the cap, and this time it goes through.
    await daysField.fill(String(cap));
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const listed = await page.request.get("/v1/leave-encashments?max_page_size=200");
    const { results = [] } = (await listed.json()) as {
      results?: { path: string; employee?: string; leave_type?: string; days?: number; create_time?: string }[];
    };
    const created = [...results]
      .filter((r) => r.employee === bal!.employee && r.leave_type === bal!.leave_type && r.days === cap)
      .sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
    expect(created, "the encashment request is not in the collection").toBeTruthy();
    createdPath = created!.path;
  } finally {
    if (createdPath) await purge(page, createdPath);
    await page.request.patch(`/v1/${bal!.leave_type}`, {
      headers: { ...SPA_HEADERS, "If-Match": etag },
      data: {
        encashable: original.encashable ?? false,
        min_balance_retained_days: original.min_balance_retained_days ?? 0,
        encashment_cap_days_per_year: original.encashment_cap_days_per_year ?? null,
      },
    });
  }
});
