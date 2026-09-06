import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The role catalog editor itself - `accessAdmin.spec.ts` proves a role can be created and given a level, by
// typing the identifier by hand. That leaves everything this form actually computes untested: the identifier
// derived from the display name, both duplicate checks (an identifier collision fails at the server, a
// duplicate display name silently succeeds and leaves two indistinguishable roles in every picker), a
// "Protected" role nobody - not even its own creator - can delete, and "Start from", which copies an
// existing role's whole permission set into the new one through the same grant API a person would use by
// hand.
test.describe("the role catalog editor", () => {
  test("the identifier derives from the display name, and both duplicate checks fire", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const stamp = Date.now();
    const label = `E2E Slug Role ${stamp}`;

    await gotoRoute(page, "settings/roles", "Roles");
    await page.getByRole("button", { name: "New role" }).click();
    let form = page.getByRole("dialog");
    // The identifier is untouched, so typing the display name derives it - "Finance Lead" becomes
    // `finance_lead`, without the identifier ever being typed into directly.
    await form.getByLabel("Display name").fill(label);
    await expect(form.getByLabel("Identifier")).toHaveValue(`e2e_slug_role_${stamp}`);
    await form.getByRole("button", { name: "Create", exact: true }).click();

    // A role with no permissions is inert - creating one hands straight to its own permissions dialog.
    const perms = page.getByRole("dialog");
    await expect(perms.getByRole("heading", { name: new RegExp(`Permissions · ${label}`) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    try {
      // The same display name again: silently succeeding would leave two roles a picker cannot tell apart.
      await page.getByRole("button", { name: "New role" }).click();
      form = page.getByRole("dialog");
      const create = form.getByRole("button", { name: "Create", exact: true });
      await form.getByLabel("Display name").fill(label);
      await expect(form.getByText("Another role is already called that", { exact: false })).toBeVisible();
      // The identifier auto-derived to the SAME slug too, which is its own, separate collision.
      await expect(form.getByText("A role with this identifier already exists.")).toBeVisible();
      await expect(create).toBeDisabled();

      // A distinct identifier, typed by hand: the label clash alone does not block the save.
      await form.getByLabel("Identifier").fill(`e2e_slug_role_${stamp}_b`);
      await expect(form.getByText("A role with this identifier already exists.")).toHaveCount(0);
      await expect(create).toBeEnabled();
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog");
      if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
        await discard.getByRole("button", { name: /Discard|Leave/ }).click();
      }
    } finally {
      await purgeRole(page, `e2e_slug_role_${stamp}`);
    }
  });

  test("a protected role cloned from an existing one copies its permissions and cannot be deleted", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const stamp = Date.now();
    const label = `E2E Protected Role ${stamp}`;
    const roleName = `e2e_protected_role_${stamp}`;

    await gotoRoute(page, "settings/roles", "Roles");
    await page.getByRole("button", { name: "New role" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Identifier").fill(roleName);
    await form.getByLabel("Display name").fill(label);
    await form.locator("#role-protected").click();

    // "Start from": the new role starts with everything the picked role can do - said before it's saved,
    // not discovered afterwards in the permissions grid.
    await form.getByLabel("Start from").click();
    await page.getByRole("option", { name: "Employee" }).click();
    await expect(form.getByText("The new role starts with everything Employee can do.", { exact: false })).toBeVisible();

    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(toast(page, /Role created · \d+ rules copied/)).toBeVisible({ timeout: 30_000 });
    const perms = page.getByRole("dialog");
    await expect(perms.getByRole("heading", { name: new RegExp(`Permissions · ${label}`) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    try {
      const row = page.locator("tbody tr").filter({ hasText: label });
      await expect(row).toBeVisible({ timeout: 30_000 });

      // Its own permissions dialog reads back what the clone actually copied, not an empty grid a "rules
      // copied" toast merely claimed - the dialog names an empty one outright ("grants nothing until
      // something is set below"), so its absence here is the proof.
      await row.getByRole("button", { name: "Role actions" }).click();
      await page.getByRole("menuitem", { name: "Manage permissions" }).click();
      const clonedPerms = page.getByRole("dialog").filter({ hasText: `Permissions · ${label}` });
      await expect(clonedPerms).toBeVisible({ timeout: 30_000 });
      await expect(clonedPerms.getByText("No access anywhere.", { exact: false })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(clonedPerms).toHaveCount(0, { timeout: 15_000 });

      // Protected: the row's own menu offers Edit and Manage permissions, but no Delete at all.
      await row.getByRole("button", { name: "Role actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally {
      // `purgeRole` lifts Protected first - the server refuses the delete outright otherwise.
      await purgeRole(page, roleName);
    }
  });
});

/** Delete a role by identifier, unprotecting it first if the delete would otherwise be refused. */
async function purgeRole(page: import("@playwright/test").Page, name: string) {
  const got = await page.request.get(`/v1/roles/${name}`);
  if (!got.ok()) return;
  const role = (await got.json()) as { etag: string; protected?: boolean };
  if (role.protected) {
    const unprotected = await page.request.patch(`/v1/roles/${name}`, {
      headers: { ...SPA_HEADERS, "If-Match": role.etag },
      data: { protected: false },
    });
    if (unprotected.ok()) role.etag = ((await unprotected.json()) as { etag: string }).etag;
  }
  await purge(page, `roles/${name}`);
}
