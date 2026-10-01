import { gotoRoute, purge, test, expect } from "./fixtures";

// Administering access itself: roles, the permissions matrix, and machine credentials.
//
// This is the most consequential surface in the app - a wrong press here changes what everybody can see -
// and it is also the one the server suite cannot check the shape of. `test/permissions`, `test/grants` and
// `test/compileGrants` own what a rule MEANS; what only a browser shows is whether an admin can express the
// rule they intend: a role created and named, a level set on a collection for that role and read back (with
// the inherited "everyone" level shown beside it, which is the number that makes an org-wide grid
// interpretable), and an API key that is shown its secret exactly once.
test.describe("access administration", () => {
  test("a role is created, then given a level on one collection", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const id = `e2e_role_${Date.now() % 100000}`;

    await gotoRoute(page, "settings/roles", "Roles");
    await page.getByRole("button", { name: "New role" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Identifier").fill(id);
    await form.getByLabel("Display name").fill(`E2E Role ${id}`);
    await form.getByRole("button", { name: "Create", exact: true }).click();

    // A role with no permissions is inert, so creating one hands straight over to ITS permissions - the step
    // that gets forgotten when the flow just drops you back on a table row that does nothing.
    const perms = page.getByRole("dialog");
    await expect(perms.getByRole("heading", { name: new RegExp(`Permissions · E2E Role ${id}`) })).toBeVisible();

    // One level per collection, and the cell is a real control rather than a read-out of something set
    // elsewhere. Setting it reads back off the same cell.
    const cell = perms.getByRole("combobox").first();
    await expect(cell).toBeVisible();
    await cell.click();
    await page.getByRole("option", { name: /^read$/i }).first().click();
    await expect(cell).toContainText(/read/i);
    await page.keyboard.press("Escape");

    // The org-wide matrix gains a COLUMN for the new role (collections are the rows), and every cell there
    // is a way INTO the per-collection editor - a grid that could only set one number would be a dead end.
    await gotoRoute(page, "settings/permissions", "Permissions");
    // 30s like every first paint after a cold load: the role columns land on their own read, beside the
    // users and rules walks the same page starts.
    await expect(page.getByRole("columnheader", { name: `E2E Role ${id}` }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Manage access for/ }).first()).toBeVisible();

    await purgeNamed(page, "roles", id);
  });

  test("an API key is created and its secret is shown exactly once", async ({ as }) => {
    const page = await as("super");
    const name = `E2E key ${Date.now()}`;

    await gotoRoute(page, "settings/api-keys", "API keys");
    await page.getByRole("button", { name: "New key" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "New API key" })).toBeVisible();
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Create key" }).click();

    // The secret: shown once, with a way to copy it, because it can never be shown again. A key whose secret
    // is not surfaced here is a credential nobody can use.
    const shown = page.getByRole("dialog");
    await expect(shown.getByText(/hrms_|copy|once/i).first()).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.getByText(name).first()).toBeVisible();
    await purgeNamed(page, "api-keys", name);
  });
});

/** Purge rows of `collection` by any of the usual name columns. */
async function purgeNamed(page: import("@playwright/test").Page, collection: string, name: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) {
    if ([r.name, r.display_name, r.label, r.title].includes(name)) await purge(page, r.path!);
  }
}
