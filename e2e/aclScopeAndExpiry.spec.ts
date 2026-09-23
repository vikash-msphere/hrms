import type { Locator, Page } from "@playwright/test";
import {
  SPA_HEADERS,
  accessRules,
  gotoRoute,
  inDays,
  makeThrowawayPerson,
  retireThrowawayPerson,
  toast,
  userPath,
  test,
  expect,
} from "./fixtures";

// The two dimensions of a rule that are neither "who" nor "how much": HOW FAR it reaches, and HOW LONG it
// lasts.
//
// Scope is the reason this model is worth having at all - "read leave requests" means something completely
// different at `own`, at `department` and at `all`, and the chips that pick between them are authored from
// the backend's own manifest (SUPPORTED_SCOPES), so a collection offers exactly the tiers the engine will
// honour. Expiry is the other half: a grant that removes itself beats one nobody remembers to revoke, which
// is the whole argument for putting a date on the contractor's access rather than a reminder in a calendar.
//
// Neither has ever been driven in a browser. `aclModalRoleDeny` and `aclUserGrant` both author at the default
// scope and never set a date, so nothing covers the chips, the narrowest-first default, the promise that
// rules at different tiers are never conflated in one list, or the expiry control on the roles tab.
test.describe("rule scope and expiry", () => {
  test("a rule is scoped to the subject's own rows, and other tiers do not show it", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Scoped");
    const subject = await userPath(admin, person.email);

    try {
      const editor = await openTabAccess(admin, "leave-requests", "Leaves", "My Leave");

      // Leave requests are employee-coded, so the manifest offers all three subject-relative tiers, narrowest
      // first - and the narrowest is the one selected on open, so the careless press grants the least.
      for (const chip of ["Own", "Department", "All"]) {
        await expect(editor.getByRole("button", { name: chip, exact: true }), `no "${chip}" scope chip`).toBeVisible({ timeout: 30_000 });
      }
      await editor.getByRole("button", { name: "Own", exact: true }).click();

      await editor.getByRole("tab", { name: /^Users/ }).click();
      await pick(admin, editor, "Search people…", person.email);
      // The sentence says the tier in words before the press - "their own leave requests", not "leave requests".
      // Not unique: the summary line and the per-user note both say "their own leave requests" once a person
      // is picked - `.first()` is enough, since either occurrence proves the tier reads back in words.
      await expect(editor.getByText("their own leave requests", { exact: false }).first()).toBeVisible();
      await editor.getByRole("button", { name: /^Add$/ }).click();
      await expect(toast(admin, "1 person updated")).toBeVisible({ timeout: 30_000 });

      const rule = (await accessRules(admin)).find((r) => r.subject === subject && r.collection === "leave-requests");
      expect(rule?.scope, "the chip did not reach the rule").toBe("self");
      expect(rule?.level).toBe("read");

      // The tiers are separate lists, deliberately: a rule authored at `own` must not appear while the
      // editor is pointed at `department`, or an admin reads one tier's rules as another's.
      await editor.getByRole("button", { name: "Department", exact: true }).click();
      // The person's own row, specifically - not "the list is empty", which another spec's concurrent grant
      // on the same collection could make untrue for a reason that is none of this test's business.
      await expect(editor.getByText(person.email, { exact: false })).toHaveCount(0, { timeout: 30_000 });
      await editor.getByRole("button", { name: "Own", exact: true }).click();
      await expect(editor.getByText(person.email, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await sweep(admin, (r) => r.subject === subject);
      await retireThrowawayPerson(admin, person.path);
    }
  });

  test("a role grant can be temporary, and the modal says when it ends", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
    const name = `e2e_temp_${stamp}`;
    const label = `E2E Temp Role ${stamp}`;
    const until = inDays(7);

    const made = await admin.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
    expect(made.status(), await made.text()).toBe(200);

    try {
      const editor = await openTabAccess(admin, "vendors", "Vendors", "Vendors");
      await editor.getByRole("tab", { name: /^Roles/ }).click();

      // Empty means permanent, and the control says so - a date field with no explanation beside it is how
      // somebody grants a year of access believing it was a week.
      await expect(editor.getByText("Empty = permanent", { exact: false })).toBeVisible();
      await editor.locator('input[type="date"]').fill(until);
      await expect(editor.getByText(`Access set below removes itself on ${until}.`)).toBeVisible();

      const filter = editor.getByPlaceholder("Filter roles…");
      if (await filter.count()) await filter.fill(label);
      // `has:` page-rooted, not re-scoped from `editor` - a has-locator carries its whole ancestor chain into
      // the containment check, so `editor.getByRole(...)` would ask each row to contain another dialog
      // nested inside it (it never will) and silently match nothing.
      const row = editor.locator("div").filter({ hasText: label }).filter({ has: admin.getByRole("combobox") }).last();
      await expect(row, "the new role never showed up in the role list").toBeVisible({ timeout: 30_000 });
      const level = row.getByRole("combobox").last();
      await level.click();
      await admin.getByRole("option", { name: /^read$/i }).click();
      // The toast lives in the shared Notifications region, not inside the dialog.
      await expect(toast(admin, `Updated ${label}`)).toBeVisible({ timeout: 30_000 });

      // The grant reads as temporary wherever it is read - the level dropdown alone cannot say it.
      await expect(row.getByText(/expires/i)).toBeVisible({ timeout: 30_000 });

      const rule = (await accessRules(admin)).find((r) => r.subject === name && r.collection === "vendors");
      expect(rule?.level).toBe("read");
      expect(rule?.expire_time, "the date never reached the rule").toBeTruthy();
      expect(rule!.expire_time!.slice(0, 10)).toBe(until);

      // Taken back by hand rather than waiting a week for it - the expiry is the server's business
      // (`test/accessLifecycle`), and this spec's business was the control that set it.
      // Retried, and waited for the control to be live first: this select DISABLES itself while the grant it
      // just set is saving, and a press that lands in that window is dropped with nothing to show for it -
      // the level simply stays as it was.
      await expect(async () => {
        if (/none/i.test((await level.textContent()) ?? "")) return;
        await expect(level).toBeEnabled({ timeout: 8_000 });
        await level.click({ timeout: 8_000 });
        await admin.getByRole("option", { name: /^none$/i }).click({ timeout: 8_000 });
        await expect(level).toContainText(/none/i, { timeout: 8_000 });
      }).toPass({ timeout: 45_000 });
    } finally {
      await sweep(admin, (r) => r.subject === name);
      // deleteRole drops the role's own access-rules rows and takes no If-Match: roles are a bespoke router.
      await admin.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
  });
});

/** Access mode on, and the rule editor open on a workspace TAB's collection (its key sits beside the tab). */
async function openTabAccess(admin: Page, route: string, heading: string, tabLabel: string): Promise<Locator> {
  await gotoRoute(admin, route, heading);
  // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name is
  // the initials the fallback draws.
  await admin.locator('header button[title^="Sam Super"]').click();
  await admin.getByRole("menuitem", { name: /Access management/ }).click();
  await admin.getByRole("button", { name: `Manage access: ${tabLabel}` }).first().click();
  const editor = admin.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: /Manage access ·/ })).toBeVisible({ timeout: 30_000 });
  return editor;
}

/** Pick somebody in one of the modal's comboboxes: filter, then Enter (see aclUserGrant for why). */
async function pick(page: Page, scope: Locator, trigger: string, query: string) {
  await scope.getByRole("button", { name: trigger }).click();
  await page.getByPlaceholder("Search…").fill(query);
  // Combobox.tsx picks `filtered[active]` on Enter - a candidate list built from a fetch this popover only
  // starts once it opens, not from what is already on screen. Enter fired before that fetch lands finds
  // `filtered` still empty, selects nothing, and leaves the search box open forever (nothing here ever
  // retries the press) - waited on the one thing that proves a candidate exists to choose.
  await expect(page.locator("[data-idx]").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Search…")).toHaveCount(0, { timeout: 15_000 });
}

/** Every rule this test authored, gone - whatever it managed to write before failing. */
async function sweep(admin: Page, mine: (r: { subject?: string }) => boolean) {
  for (const rule of await accessRules(admin)) {
    if (mine(rule)) await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
}
