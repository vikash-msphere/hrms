import { gotoRoute, test, expect } from "./fixtures";

// The directory, as cards instead of rows.
//
// The people list is two renderings of one collection: a table, and a card grid that can be grouped by
// department. Which one you get is a personal choice kept in this browser, and the grouping is computed in
// the page from the rows it already holds - there is no request behind either, so nothing outside a browser
// can tell whether the toggle works, whether the choice is remembered, or whether grouping produces sections
// with the right people under them.
//
// `directory` covers the server-side search and the deep link into a record; `tablePaging` covers the table's
// own pager. This is the other half of the page.

/** The people table's own rows.
 *
 *  Not a bare `tbody tr`: the charts above the directory each carry an accessible data table (the figure a
 *  screen reader reads instead of the canvas), so "no table at all" is never true of the page as a whole.
 *  A clickable DataTable row is `role="button"`; a chart's data row is not. */
const rows = (page: import("@playwright/test").Page) => page.locator('tbody tr[role="button"]');

test("the card view is a choice the browser remembers, and it groups by department", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  await gotoRoute(page, "employees", "Directory");

  // The table is where a fresh browser lands (nothing stored yet), which is what makes the switch below a
  // switch rather than a coincidence.
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });

  // The two view buttons are icon-only and named by their tooltips.
  await page.getByRole("button", { name: "Card view" }).click();
  // Cards, and no table at all: a grid drawn beside a still-rendered table would look right and be wrong.
  await expect(rows(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByPlaceholder("Search people…").first()).toBeVisible();

  // Grouping is only offered on the cards (a table groups by sorting), and it redraws the same people under
  // department headings that count what is in them.
  await page.getByRole("button", { name: "Grouped" }).click();
  // Each group is a section with a heading of its own; the count beside the name is what makes it a grouping
  // rather than a divider.
  const heading = page.locator("section h3").first();
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(heading).toHaveText(/\S+\s+\d+$/);

  // A per-browser preference, so it has to survive the reload that drops everything the page is holding -
  // otherwise every visit starts in a view the reader did not choose.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });
  await expect(rows(page)).toHaveCount(0);

  // And back, so the choice is reversible rather than a trap.
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
});
