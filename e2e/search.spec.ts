import { gotoRoute, test, expect } from "./fixtures";

// ⌘K: the only way into a lot of this app.
//
// `test/globalSearch.test.ts` proves the server side - the FTS index, the per-collection scoping the
// middleware decides, what a given caller is allowed to match. What it cannot prove is that the keystroke
// opens anything, that typing reaches the search, that results render grouped, or that Enter lands you on
// the thing you picked. That chain is four separate pieces of browser behaviour and no other test touches
// any of it.
test.describe("global search", () => {
  test("the shortcut opens it, and Enter goes where it says", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // ControlOrMeta so this is the same test on a mac laptop and a linux CI runner.
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await expect(search).toBeVisible();

    await search.fill("vendors");
    // The palette highlights its first row; Enter takes it.
    await expect(page.getByRole("button").filter({ hasText: "Vendors" }).first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/vendors/);
    await expect(page.getByRole("main")).toContainText("Vendors");
  });

  test("it searches the data, not just the menu", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await search.fill("Eve Employee");

    // A seeded person, found through the search index rather than the static page/action list - which is the
    // half of the palette that needs a server round trip to work at all.
    await expect(page.getByRole("button").filter({ hasText: "Eve Employee" }).first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
  });
});
