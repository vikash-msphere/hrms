import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting a holiday - never pressed by `holidays.spec.ts`, `holidayBulk.spec.ts` or `holidayBridge.spec.ts`,
// all of which only ever add or bulk-import. Holidays share the generic `useSoftDelete` mechanism
// `undo.spec.ts` already proves once (on vendors) - what that spec does NOT cover is this page's own copy
// actually saying "Holiday deleted" and its own row actually leaving the calendar/list.
test("a holiday is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  const name = `E2E delete holiday ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/holidays", {
    headers: SPA_HEADERS,
    data: { display_name: name, date: "2027-11-11", kind: "fixed" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  const listedBefore = await page.request.get(`/v1/${path}`);
  expect(((await listedBefore.json()) as { delete_time?: string }).delete_time).toBeFalsy();

  await gotoRoute(page, "holidays", "Holiday Calendar");
  // The page defaults to Calendar view (Holidays.tsx `view` state) - `tbody tr` only exists once List view's
  // own DataTable is showing. A holiday dated 2027 (a year deliberately unused by other holiday specs, so it
  // never collides with a real one) then also never shows until that year chip is picked.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "2027", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  // No confirmation on a soft delete - the row is already gone by the time the toast lands.
  await expect(toast(page, "Holiday deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get`,
  // src/services/crud.ts, throws notFound on `deleteTime` for every collection) - `show_deleted=true` on the
  // list is the way to prove it survived rather than being gone entirely.
  const after = await page.request.get(`/v1/holidays?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((h) => h.path === path);
  expect(found?.delete_time, "the holiday should survive soft-deleted, not be gone entirely").toBeTruthy();
});
