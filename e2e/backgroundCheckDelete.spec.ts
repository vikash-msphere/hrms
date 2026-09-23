import { SPA_HEADERS, gotoRoute, personPath, test, expect, toast } from "./fixtures";

// Deleting a background check record - neither `backgroundChecks.spec.ts` (the standard-set form) nor
// `backgroundCheckFlow.spec.ts` (the status workflow) ever removes one; both purge via the API. Shares the
// generic `useSoftDelete` mechanism `undo.spec.ts` proves once (on vendors); this is this page's own copy.
// Its own employee record, not Eve's or Mara's - both of those are shared with the other two background-
// check specs, and a third spec's row would be one more thing "how many checks does Eve have" has to ignore.
test("a background check record is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  const vendor = `E2E delete check ${Date.now() % 1_000_000}`;
  const employee = await personPath(page, "hr");

  const made = await page.request.post("/v1/background-checks", {
    headers: SPA_HEADERS,
    data: { employee, check_type: "reference", vendor },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "background-checks", "Background Verification");
  const row = page.locator("tbody tr").filter({ hasText: vendor });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Background check deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: vendor })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws notFound
  // on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/background-checks?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((r) => r.path === path);
  expect(found?.delete_time, "the check should survive soft-deleted, not be gone entirely").toBeTruthy();
});
