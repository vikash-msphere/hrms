import { gotoRoute, test, expect } from "./fixtures";

// The nav, made smaller.
//
// The sidebar has two pieces of state a person sets and expects to find again: the whole thing collapsed to
// an icon rail, and individual groups folded away. Both are pure UI preferences kept in this browser's
// storage - no row, no request - so nothing outside a browser can see them, and the failure they guard
// against is nasty in a quiet way: a rail that navigates to nothing, or a fold that eats the page you are on.
//
// What only a browser shows: collapsing really swaps the nav for the icon rail (the group headings go, the
// destinations stay reachable and still navigate), the choice survives a reload rather than living in the
// page, and a folded group keeps the ACTIVE page visible - the one case where the app deliberately overrides
// what the person asked for, because hiding where they are standing is never right.
test.describe("the sidebar", () => {
  test("collapsing leaves a rail that still navigates, and the choice survives a reload", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("hr");
    await gotoRoute(page, "dashboard");

    // Group headings are the part the rail gives up - the destinations keep their names (as labels on the
    // icons), so the headings are what tells the two layouts apart.
    await expect(page.getByRole("button", { name: "Workforce" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Workforce" })).toHaveCount(0);

    // A rail that cannot be navigated from is a decoration: the icons are still the links, named for anyone
    // who cannot see the picture.
    // `.first()` and a prefix match: a nav item's accessible name carries its unread badge ("Connect 2"), and
    // once the Directory is open the page's own workspace tab bar adds links of its own.
    await page.getByRole("link", { name: /^Team/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });

    // Written down, not held in the page.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 30_000 });

    // And back, so the preference is a toggle rather than a one-way door.
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Workforce" })).toBeVisible();
  });

  test("a folded group hides its pages, but never the one you are on", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("hr");
    await gotoRoute(page, "dashboard");

    // Folded from the dashboard, so the group being folded is NOT the one holding the current page.
    const workforce = page.getByRole("button", { name: "Workforce" });
    await expect(workforce).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
    await workforce.click();
    await expect(workforce).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("link", { name: /^Team/ })).toHaveCount(0);

    // Now stand inside the folded group. Keeping it shut would leave the nav with no mark of where the reader
    // is, so the app opens it for as long as the page belongs to it.
    await gotoRoute(page, "employees", "Directory");
    await expect(page.getByRole("button", { name: "Workforce" })).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
    await expect(page.getByRole("link", { name: /^Team/ }).first()).toBeVisible();
  });
});
