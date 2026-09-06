import { gotoRoute, test, expect } from "./fixtures";

// The palette learns where you live.
//
// ⌘K opened on nothing shows a catalogue: every page, every action, every settings panel this caller holds.
// That is a long list, and what makes it usable is the "Recent" group on top - a use-count decayed by recency,
// kept per user in this browser's storage and read on every open. Nothing outside a browser has any of that:
// there is no request, no row, and no server order to check.
//
// What only a browser shows: a palette that has never been used offers no Recent group at all (an empty one
// would be a lie about what this person opens), using it puts what was picked at the top of the next open,
// and the memory is written down rather than held in the page - so it is still there after a reload.
//
// `search` covers opening and navigating; `searchScope` covers what the list is allowed to contain.
const PLACEHOLDER = "Search people, records, pages and settings…";

test("what the palette is used for comes back at the top of it", async ({ as }) => {
  test.setTimeout(120_000);
  // A fresh browser context per test, so this person's palette starts with no history - which is what makes
  // the "no Recent group yet" assertion below a fact rather than a coincidence.
  const page = await as("super");
  await gotoRoute(page, "dashboard");

  const palette = page.getByRole("dialog", { name: "Search everything" });
  const open = async () => {
    // ControlOrMeta so this is the same test on a mac laptop and a linux CI runner.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder(PLACEHOLDER)).toBeVisible();
  };

  await open();
  // The empty-query view: the catalogue is there, and Recent is not.
  await expect(palette.getByText("Go to", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(palette.getByText("Recent", { exact: true })).toHaveCount(0);

  // Use it for something. Clicked rather than Entered: this spec is about what is remembered, so which row
  // was taken has to be beyond doubt.
  await page.getByPlaceholder(PLACEHOLDER).fill("vendors");
  await palette.getByRole("button").filter({ hasText: "Vendors" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible({ timeout: 30_000 });

  // Opened again on nothing: the destination that was just used leads the list. The query resets on close, so
  // this really is the empty-query view rather than the last search still standing.
  await open();
  const recent = palette.getByText("Recent", { exact: true });
  await expect(recent).toBeVisible({ timeout: 30_000 });
  await expect(palette.getByRole("button").filter({ hasText: "Vendors" }).first()).toBeVisible();

  // Written down, not held in the page: a reload drops every bit of state the app has in memory, and the
  // palette still knows. That is the half that makes it useful tomorrow morning rather than for ten minutes.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await open();
  await expect(recent).toBeVisible({ timeout: 30_000 });
});
