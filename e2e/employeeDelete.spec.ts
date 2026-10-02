import { SPA_HEADERS, confirmDelete, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting an employee record from the Directory itself - the row action, not the API call every disposable-
// employee spec this session makes to clean up after itself. Shares the generic `useSoftDelete` mechanism
// `undo.spec.ts` proves once (on vendors); this is Directory's own copy, on its own disposable person -
// never a seeded one every other spec still needs active.
test("an employee record is deleted from the Directory", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const first = "E2eDirDelete";
  const last = `Person${stamp}`;
  const fullName = `${first} ${last}`;

  const made = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: `e2e.dirdelete.${stamp}@example.com` },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "employees", "Directory");
  const row = page.locator("tbody tr").filter({ hasText: fullName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await confirmDelete(page);
  await expect(toast(page, "Employee deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: fullName })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (getEmployee throws notFound on `deleteTime`, same as
  // every other collection's item-get) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/employees?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((e) => e.path === path);
  expect(found?.delete_time, "the employee should survive soft-deleted, not be gone entirely").toBeTruthy();
});
