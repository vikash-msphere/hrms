import { gotoRoute, test, expect } from "./fixtures";

// Page two of a long table.
//
// Every collection page in the app is the same DataTable, and the pager under it is the only way to see a row
// that is not in the first twenty-five. It is entirely a browser concern: the page cursor never leaves the
// component, the footer's counts are computed from what was fetched and what is filtered, and the reset that
// makes searching from page 3 work at all ("you are now looking at a different, shorter list, so you are on
// page 1 of it") is a rule with nowhere else to live.
//
// `tableState` covers the sort that rides in the URL and `savedViews` the layout that rides on the server;
// neither ever leaves page one. This does it on the Directory, which is the one table the seed guarantees is
// longer than a page.
//
// Nothing here changes a stored preference: rows-per-page and column layout are saved per user (and would
// then be what the next spec meets), while the page cursor is the component's own state and resets with the
// mount. That is why this pages with the arrows and never touches the "Rows per page" select.

/** A footer or pager line, by the text on it. `.first()`: the wrapper element carries the same text as the
 *  span inside it, so both match and the outer one is the stable choice. */
const line = (page: import("@playwright/test").Page, re: RegExp) => page.getByText(re).first();

/** The DataTable's own rows.
 *
 *  Not a bare `tbody tr`: every chart on the page carries an accessible data table of its own (the figure a
 *  screen reader reads instead of the canvas), and the Directory's charts are drawn ABOVE the table - so the
 *  first `tbody tr` on this page is a row of "Headcount by department". A clickable DataTable row is
 *  `role="button"`; a chart's data row is not, which is what separates the two. */
const rows = (page: import("@playwright/test").Page) => page.locator('tbody tr[role="button"]');

test.describe("the table pager", () => {
  test("the arrows move a page at a time, and the footer says where you are", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("hr");
    await gotoRoute(page, "employees", "Directory");

    await expect(line(page, /^Showing 1-25 of \d+/)).toBeVisible({ timeout: 30_000 });
    await expect(line(page, /^Page 1 of \d+$/)).toBeVisible();

    // A clickable DataTable row is `role="button"`, which takes it out of the table's accessibility tree - so
    // rows are reached by CSS. Which person is first is not the point; that it is a DIFFERENT person after
    // the step is, and the same one again after stepping back. Retried as one whole round trip: the Directory
    // is org-wide and unfiltered, and the rest of this suite creates and removes employees in it constantly
    // under 16-worker load - an employee landing (or leaving) ahead of the captured first row in the moment
    // between "Next" and "Previous" changes who page 1's own first row legitimately is, which is a real change
    // in the data this test does not own, not a pager bug. A fresh snapshot on retry is what tells the two
    // apart from an actual regression, which would fail the very same way on every attempt.
    const firstRow = rows(page).first();
    await expect(async () => {
      const wasFirst = (await firstRow.textContent()) ?? "";
      expect(wasFirst.trim().length, "the directory drew no rows").toBeGreaterThan(0);

      await page.getByRole("button", { name: "Next page" }).click();
      await expect(line(page, /^Showing 26-50 of \d+/)).toBeVisible({ timeout: 30_000 });
      await expect(line(page, /^Page 2 of \d+$/)).toBeVisible();
      await expect.poll(async () => (await firstRow.textContent()) ?? "", { timeout: 10_000 }).not.toBe(wasFirst);

      await page.getByRole("button", { name: "Previous page" }).click();
      await expect(line(page, /^Showing 1-25 of \d+/)).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await firstRow.textContent()) ?? "", { timeout: 10_000 }).toBe(wasFirst);
    }).toPass({ timeout: 60_000 });
    // Nothing before the first page: the arrow is refused rather than paging into an empty table.
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  test("searching from page two puts you on page one of what you searched for", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("hr");
    await gotoRoute(page, "employees", "Directory");
    await expect(line(page, /^Showing 1-25 of \d+/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(line(page, /^Page 2 of \d+$/)).toBeVisible({ timeout: 30_000 });

    // The narrowing that makes the cursor meaningless: page 2 of the whole directory is off the end of a
    // three-row result, and a table left on it would show the reader nothing and say "no records".
    await page.getByRole("searchbox", { name: "Search people…" }).first().fill("Eve");
    await expect(line(page, /^Page 1 of \d+$/)).toBeVisible({ timeout: 30_000 });
    await expect(rows(page).first()).toBeVisible();
  });

  test("a search that matches nothing offers the way back out of it", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("hr");
    await gotoRoute(page, "employees", "Directory");
    await expect(line(page, /^Showing 1-25 of \d+/)).toBeVisible({ timeout: 30_000 });

    // An empty table has two different causes and the app owes a different answer to each: nothing has been
    // created yet (offer the create), or a search excluded everything (offer the way back). Only a browser
    // can say which one was drawn - and getting it wrong strands the reader on a page that looks broken.
    const search = page.getByRole("searchbox", { name: "Search people…" }).first();
    await search.fill("zzzz-nobody-zzzz");
    await expect(page.getByText("Nothing here matches what you're filtering by.").first()).toBeVisible({ timeout: 30_000 });
    await expect(line(page, /^No records$/)).toBeVisible();

    // The offer works, which is the half that makes it an escape rather than a message. Matched on the text
    // ON the button: the search box carries its own X, whose accessible name is the same two words, and the
    // empty state's offer is the one this is about.
    await page.getByRole("button").filter({ hasText: /^Clear search$/ }).click();
    await expect(search).toHaveValue("");
    await expect(line(page, /^Showing 1-25 of \d+/)).toBeVisible({ timeout: 30_000 });
  });
});
