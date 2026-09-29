import { hasCapability } from "../web/src/lib/perm";
import { ROLES, allowConsoleErrors, capabilitiesOf, gotoRoute, test, expect, type Role } from "./fixtures";

// Who is even offered the keys.
//
// `accessMode` proves the mode works for an admin. Nothing proves it is UNAVAILABLE to everybody else - and
// that is the more dangerous direction: access management is the surface that changes what the whole org can
// see, so an ordinary employee finding the toggle (even one that 403s on save) is both an information leak
// about the org's rule set and an invitation. The gate is a single capability, `access-rules.write`
// (web/src/lib/perm.ts `useCanManageAccess`), applied in one place - which is exactly the kind of check that
// can be removed without any test noticing.
//
// So: every seeded role opens the avatar menu, and the toggle is there if and only if the server says they
// hold the capability. Then the admin's own path is followed one step further than `accessMode` takes it -
// into "Who can manage access", the modal that governs the governing, which nothing has ever opened.

/** How the avatar's tooltip names each seeded person (scripts/seed.sql). */
const WHO: Record<Role, string> = {
  super: "Sam Super",
  hr: "Hank Hr",
  manager: "Mara Manager",
  payroll: "Pat Pay",
  employee: "Eve Employee",
  it: "Aditya Patel",
  pm: "Krishna Williams",
};

test.describe("access-management mode availability", () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    test(`${role} is offered the access toggle only with access-rules.write`, async ({ as }) => {
      test.setTimeout(120_000);
      const page = await as(role);
      await gotoRoute(page, "dashboard");
      const expected = hasCapability(await capabilitiesOf(page), "access-rules.write");

      // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name
      // is the initials the fallback draws.
      await page.locator(`header button[title^="${WHO[role]}"]`).click();
      const toggle = page.getByRole("menuitem", { name: /Access management/ });
      await expect(toggle).toHaveCount(expected ? 1 : 0);
      // The menu is still the useful thing it always was for everybody - this is a missing entry, not a
      // broken menu.
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();

      if (!expected) {
        // And there is no way in from the page either: the key icons are what the mode draws, and a caller
        // who cannot have the mode must never see one.
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: /^Manage access: / })).toHaveCount(0);
      }
    });
  }

  test("an admin can open the rules that govern who manages access", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
    // (complianceRuleDelete.spec.ts et al.) - a genuine gating mismatch still fails via this test's own
    // assertions.
    allowConsoleErrors(page, /status of 503/i);
    // Not the dashboard: it keeps several widgets polling/streaming in as they resolve, and re-rendering the
    // header avatar menu mid-interaction is what made the second click below flaky (Playwright retried into
    // a detached element). The subject here is the avatar menu itself, which is page-agnostic - `vendors` is
    // the same plain, settled page `accessMode.spec.ts` already proves this menu against.
    await gotoRoute(page, "vendors", "Vendors");

    await page.locator('header button[title^="Sam Super"]').click();
    // Off first: the second entry is the one that only exists while the mode is on, which is itself the
    // rule being checked here.
    await expect(page.getByRole("menuitem", { name: "Who can manage access" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: /Access management/ }).click();
    await expect(page.getByRole("button", { name: "Turn off access mode" })).toBeVisible({ timeout: 15_000 });

    // Retried as one unit: every access target on the page (a table full of them, on Vendors) grows a key
    // icon the instant the mode turns on, and each one resolves its own capability check asynchronously - the
    // header can re-render more than once in that window, which is what detached the menu mid-click before.
    // Re-opening the menu from scratch on a retry is cheap and exactly what a person would do.
    await expect(async () => {
      await page.locator('header button[title^="Sam Super"]').click();
      await page.getByRole("menuitem", { name: "Who can manage access" }).click({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    // The modal that governs the governing: `access-rules` is a collection like any other, which is what
    // makes delegating access administration possible at all.
    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("heading", { name: /Manage access · Access/ })).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByRole("tab", { name: /^Roles/ })).toBeVisible();
    await expect(editor.getByRole("tab", { name: /^Users/ })).toBeVisible();
    // Nothing is changed here - a wrong press on this target is how an org locks itself out of its own
    // permissions - so the modal is read and closed.
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    await page.getByRole("button", { name: "Turn off access mode" }).click();
    await expect(page.getByRole("button", { name: /^Manage access: / })).toHaveCount(0);
  });
});
