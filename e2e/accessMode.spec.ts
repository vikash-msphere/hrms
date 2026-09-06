import { gotoRoute, test, expect } from "./fixtures";

// The keys an admin turns on to see what they are actually granting.
//
// Access-management mode is the app's answer to "where do I change who can do this?": switch it on, and
// every element that IS an access target grows a key icon that opens the rule editor scoped to exactly that
// target. `test/webAccessCoverage.test.ts` proves the affordances exist IN THE SOURCE - which is the part
// that rots as pages are added - but it cannot show that the mode turns on, that the icons appear on a
// rendered page, that one of them opens the editor for the right collection, or that switching the mode off
// leaves the page as ordinary as it was. That is all in the browser.
test("access mode surfaces the keys, opens the rule editor, and switches off again", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "vendors", "Vendors");

  const key = page.getByRole("button", { name: "Manage access: Vendors" });
  // Off by default, and costing the page nothing: the icons are not in the document at all.
  await expect(key).toHaveCount(0);

  // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name is
  // the initials the fallback draws.
  await page.locator('header button[title^="Sam Super"]').click();
  await page.getByRole("menuitem", { name: /Access management/ }).click();

  await expect(key.first()).toBeVisible();
  await key.first().click();

  // The editor opens on the collection the key belongs to - a key that opened the wrong scope would edit
  // somebody else's rules, which is the failure worth catching here.
  const editor = page.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: /Manage access · Vendors/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);

  // The pill is the way out, and the page goes back to being an ordinary table.
  await page.getByRole("button", { name: "Turn off access mode" }).click();
  await expect(key).toHaveCount(0);
});
