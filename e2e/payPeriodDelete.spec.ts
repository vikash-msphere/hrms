import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting a pay period - `payPeriodForm.spec.ts` proves the create form's own arithmetic but never removes
// anything (every other payroll spec that needs a period skips the form entirely and posts one straight
// through the wire). Shares the generic `useSoftDelete` mechanism `undo.spec.ts` proves once on vendors; this
// is this page's own copy actually saying "Pay period deleted" and the row actually leaving the table.
test("an unused pay period is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const label = `E2E delete period ${Date.now() % 100000}`;
  // A MONTH OF ITS OWN PER ATTEMPT. Periods may not overlap (services/payPeriods.ts), and a retry re-runs this
  // body against a database that may still be holding the previous attempt's period - the delete is what was
  // being attempted, so the attempt that failed is exactly the one that left the row behind. Re-using April
  // 2032 then fails on the overlap during setup and reports a create fault for a delete test. 2032 is this
  // spec's year, so a month per attempt keeps them clear of each other.
  const month = String(4 + test.info().retry).padStart(2, "0");
  const lastDay = new Date(Date.UTC(2032, 4 + test.info().retry, 0)).toISOString().slice(0, 10);

  const made = await page.request.post("/v1/pay-periods", {
    headers: SPA_HEADERS,
    data: { display_name: label, period_start: `2032-${month}-01`, period_end: lastDay, pay_date: lastDay },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "pay-periods", "Pay Periods");
  const row = page.locator("tbody tr").filter({ hasText: label });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Pay period deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: label })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws notFound
  // on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/pay-periods?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((r) => r.path === path);
  expect(found?.delete_time, "the pay period should survive soft-deleted, not be gone entirely").toBeTruthy();
});
