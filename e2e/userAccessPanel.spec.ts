import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The Users panel - `accessAdmin.spec.ts` only ever touches the role CATALOG; nothing drives the login
// side, where an actual account's role, status and employee link are changed. Every seeded fixture login
// (super/hr/manager/payroll/employee) is load-bearing for every other spec in the suite, so this test never
// touches one - it creates two throwaway employees of its own (which auto-provisions their own logins, per
// services/employees.ts) and works entirely on those.
//
// Users have no delete route at all ("provisioned when an employee is created, disabled rather than
// removed" - src/routes/users.ts), so there is nothing to purge afterwards: the disable this spec exercises
// IS the cleanup, and the employees are soft-deleted (never force-purged - their own login row is an
// undeclared reference the purge cascade would refuse).
test("a login's role and employee link are changed, and two accounts are disabled together", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const emailA = `e2e.roles.a.${stamp}@example.com`;
  const emailB = `e2e.roles.b.${stamp}@example.com`;

  const empA = await makeEmployee(page, "E2E", `RolesA${stamp}`, emailA);
  const empB = await makeEmployee(page, "E2E", `RolesB${stamp}`, emailB);

  try {
    await gotoRoute(page, "settings/users", "Users");

    // A: role changed, with the amber "what this will do" line - said before Save, not discovered after.
    const rowA = page.locator("tbody tr").filter({ hasText: emailA });
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await expect(rowA).toContainText("Employee");
    await rowA.getByRole("button", { name: "User actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    let edit = page.getByRole("dialog").filter({ hasText: "Edit access" });
    const save = edit.getByRole("button", { name: "Save changes", exact: true });
    await expect(save).toBeDisabled();
    await edit.getByLabel("Role").click();
    await page.getByRole("option", { name: "Manager", exact: true }).click();
    await expect(edit.getByText("Role goes from", { exact: false })).toBeVisible();
    await expect(edit.getByText("Everything they can see and do changes with it.", { exact: false })).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(toast(page, "User updated")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
    await expect(rowA).toContainText("Manager");

    // B: the employee-link picker names whoever already holds a candidate - one employee on two logins is
    // how "my leave disappeared" happens, so it says so before the second link is ever saved.
    const rowB = page.locator("tbody tr").filter({ hasText: emailB });
    await rowB.getByRole("button", { name: "User actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    edit = page.getByRole("dialog").filter({ hasText: "Edit access" });
    await edit.getByLabel("Linked employee").click();
    await page.getByPlaceholder("Search employees…").fill(`RolesA${stamp}`);
    await expect(page.getByText(`already linked to ${emailA}`, { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // Both together, disabled in one bulk action - and the confirm names what it will actually do.
    await rowA.getByRole("checkbox", { name: "Select row" }).check();
    await rowB.getByRole("checkbox", { name: "Select row" }).check();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Disable the selected accounts?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("signed out and their next request is refused", { exact: false })).toBeVisible();
    await confirm.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(toast(page, "2 users updated")).toBeVisible({ timeout: 30_000 });
    await expect(rowA).toContainText("Disabled");
    await expect(rowB).toContainText("Disabled");
  } finally {
    // A plain soft-delete, not a hard purge: the employee's own auto-provisioned login is an undeclared
    // reference (users has no delete route at all), so `?force=true` here would 409, not clean up.
    await softDeleteEmployee(page, empA);
    await softDeleteEmployee(page, empB);
  }
});

/** A throwaway employee, whose login is auto-provisioned with it. */
async function makeEmployee(page: import("@playwright/test").Page, first: string, last: string, email: string): Promise<string> {
  const res = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: email },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

async function softDeleteEmployee(page: import("@playwright/test").Page, path: string) {
  const got = await page.request.get(`/v1/${path}`);
  if (!got.ok()) return;
  const { etag } = (await got.json()) as { etag: string };
  await page.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
}
