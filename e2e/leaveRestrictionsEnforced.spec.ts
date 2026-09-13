import { apiPost, gotoRoute, nextWeekday, purge, test, expect, SPA_HEADERS } from "./fixtures";
import type { Page } from "@playwright/test";

// What the leave policy DOES to somebody filing a request, in a browser.
//
// The rules themselves are pure and pinned in test/leaveRestrictions.test.ts; the create path is pinned in
// test/leaveRestrictionsRoute.test.ts. Neither can show the thing this feature is actually for: that the
// refusal arrives while the form is still open and the dates can still be changed. The dialog runs the same
// evaluator the server does (web imports src/domain/leaveRestrictions.ts directly), so what is being proved
// here is the wiring - that the selected type's policy reaches the form, prices the days, blocks the button,
// and that a WAIVED rule lets the request through carrying what it broke as far as the approver's card.
//
// Every type here is created by the spec and retired at the end: the org-wide baseline is shared with every
// other spec filing leave in the same seconds, and a rule set there would refuse their requests too.

/** Soft-delete, never `?force=true`: a type with requests against it has undeclared children and purges 409. */
async function retireLeaveType(page: Page, path: string) {
  const got = await page.request.get(`/v1/${path}`);
  if (!got.ok()) return;
  const { etag } = (await got.json()) as { etag: string };
  await page.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
}

/** A leave type nobody else is using. Unpaid on purpose, so no balance stands between the spec and the rule
 *  it is testing ("not enough balance" is a different refusal, and it comes first). */
async function throwawayType(page: Page, name: string, restrictions: Record<string, unknown>): Promise<string> {
  const res = await apiPost(page, "leave-types", {
    display_name: name,
    paid: false,
    accrual_days_per_year: 0,
    restrictions,
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Open the request form on the Leaves page with one type and one date range chosen. */
async function openRequest(page: Page, typeName: string, from: string, to = from) {
  await gotoRoute(page, "leave-requests", "Leaves");
  await page.getByRole("button", { name: "Request leave" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Request leave" })).toBeVisible({ timeout: 30_000 });
  await form.getByRole("combobox").first().click();
  await page.getByRole("option", { name: typeName }).click();
  await form.getByLabel("Start date").fill(from);
  await form.getByLabel("End date").fill(to);
  return form;
}

/** Close whatever is open without filing anything. Not Escape: a toast is its own dismissable layer and eats
 *  the first press, so the dialog's own button is what actually closes it. */
async function abandon(page: Page) {
  await expect(async () => {
    if (!(await page.getByRole("dialog").count())) return;
    const cancel = page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.first().click();
    const discard = page.getByRole("dialog").getByRole("button", { name: /^(Discard|Leave)$/ });
    if (await discard.count()) await discard.first().click();
    if (await page.getByRole("dialog").count()) await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

test("the form refuses short notice before it is filed, and says what the rule is", async ({ as }) => {
  test.setTimeout(180_000);
  const admin = await as("super");
  const stamp = Date.now();
  const name = `E2E notice ${stamp}`;
  // Sixty days for anything: whatever weekday the suite lands on, a request a few days out is short notice.
  const typePath = await throwawayType(admin, name, {
    timing: { advance_notice: { tiers: [{ up_to_days: 99, notice_days: 60 }] } },
  });

  try {
    const employee = await as("employee");
    const day = nextWeekday(3);
    const form = await openRequest(employee, name, day);

    // The refusal is on screen, naming the rule and the shortfall - not a 400 after a press.
    await expect(form.getByText(`This doesn't meet the ${name} policy`)).toBeVisible({ timeout: 15_000 });
    await expect(form.getByText(/needs 60 days/)).toBeVisible();
    // And the button is not offering to file it.
    await expect(form.getByRole("button", { name: "Request leave" })).toBeDisabled();

    // Moving the dates past the notice period answers the rule, and the form says so by letting go.
    await form.getByLabel("Start date").fill(nextWeekday(75));
    await form.getByLabel("End date").fill(nextWeekday(75));
    await expect(form.getByText(`This doesn't meet the ${name} policy`)).toHaveCount(0, { timeout: 15_000 });
    await expect(form.getByRole("button", { name: "Request leave" })).toBeEnabled();

    await abandon(employee);
  } finally {
    await retireLeaveType(admin, typePath);
  }
});

test("the sandwich rule prices the weekend inside a block, before the request is filed", async ({ as }) => {
  test.setTimeout(180_000);
  const admin = await as("super");
  const stamp = Date.now();
  const plainName = `E2E plain ${stamp}`;
  const sandwichName = `E2E sandwich ${stamp}`;
  const plain = await throwawayType(admin, plainName, {});
  const sandwich = await throwawayType(admin, sandwichName, {
    counting: { sandwich: { weekends: "intervening", holidays: "exclude" } },
  });

  // A Friday and the Monday after it, far enough out that no seeded holiday lands in the range - the count is
  // the whole assertion, and a holiday in the middle would change it for a reason that isn't the rule.
  const friday = "2028-03-03";
  const monday = "2028-03-06";

  try {
    const employee = await as("employee");

    // Ordinarily the weekend is free: two working days.
    const plainForm = await openRequest(employee, plainName, friday, monday);
    await expect(plainForm.getByText(/2 days of leave/)).toBeVisible({ timeout: 15_000 });
    await expect(plainForm.getByText(/2 weekend\/holiday days in between don't count/)).toBeVisible();
    await abandon(employee);

    // Under the sandwich rule the same range costs four: the Saturday and Sunday come off the balance too,
    // which is exactly the surprise this number exists to prevent.
    const sandwichForm = await openRequest(employee, sandwichName, friday, monday);
    await expect(sandwichForm.getByText(/4 days of leave/)).toBeVisible({ timeout: 15_000 });
    await abandon(employee);
  } finally {
    await retireLeaveType(admin, plain);
    await retireLeaveType(admin, sandwich);
  }
});

test("a waived rule files anyway, and the approver is told what it broke", async ({ as }) => {
  test.setTimeout(240_000);
  const admin = await as("super");
  const stamp = Date.now();
  const name = `E2E waived ${stamp}`;
  // The same impossible notice requirement as the first test - but listed in `soft_rules`, so it warns
  // instead of refusing. That difference is the whole feature: "emergency, at the manager's discretion"
  // without a second policy system beside this one.
  const typePath = await throwawayType(admin, name, {
    timing: { advance_notice: { tiers: [{ up_to_days: 99, notice_days: 60 }] } },
    soft_rules: ["advance_notice"],
  });
  let requestPath = "";

  try {
    const employee = await as("employee");
    const day = nextWeekday(3);
    const form = await openRequest(employee, name, day);

    // Warned, not blocked: the panel says who will be told, and the button still files.
    await expect(form.getByText(/Outside the usual policy - your approver will be told/)).toBeVisible({ timeout: 15_000 });
    await expect(form.getByText(/needs 60 days/)).toBeVisible();
    const submit = form.getByRole("button", { name: "Request leave" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The waiver is ON THE ROW, which is what carries it to the approver (and into the audit trail). Asked
    // for BY TYPE rather than by reading a page of this person's requests: the seeded employee has been filed
    // against by every run of this suite, so the one this test just made need not be on the first page.
    const mine = await employee.request.get(`/v1/leave-requests?leave_type=${encodeURIComponent(typePath)}&page_size=100`);
    const { results = [] } = (await mine.json()) as {
      results?: { path: string; leave_type?: string; policy_warnings?: { code: string; message: string }[] }[];
    };
    const filed = results[0];
    expect(filed, "the waived request should have been filed").toBeTruthy();
    requestPath = filed!.path;
    expect(filed!.policy_warnings?.[0]?.code).toBe("advance_notice");

    // And the approver reads it on the card they decide from, beside the balance and the overlap - the one
    // place a waiver can still change somebody's mind.
    await gotoRoute(admin, "approvals");
    const card = admin.locator("li, div").filter({ hasText: name }).filter({ hasText: /needs 60 days/ }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
  } finally {
    if (requestPath) await purge(admin, requestPath);
    await retireLeaveType(admin, typePath);
  }
});
