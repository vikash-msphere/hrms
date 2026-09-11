import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting a pay period - `payPeriodForm.spec.ts` proves the create form's own arithmetic but never removes
// anything (every other payroll spec that needs a period skips the form entirely and posts one straight
// through the wire). Shares the generic `useSoftDelete` mechanism `undo.spec.ts` proves once on vendors; this
// is this page's own copy actually saying "Pay period deleted" and the row actually leaving the table.
test("an unused pay period is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const label = `E2E delete period ${Date.now() % 100000}`;

  const made = await page.request.post("/v1/pay-periods", {
    headers: SPA_HEADERS,
    data: { display_name: label, period_start: "2032-04-01", period_end: "2032-04-30", pay_date: "2032-04-30" },
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
