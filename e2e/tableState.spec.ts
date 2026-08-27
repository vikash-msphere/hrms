import { gotoRoute, test, expect } from "./fixtures";

// A sorted, filtered table you can send to somebody.
//
// DataTable carries its sort and filters in the hash query as `t.<tableId>` and writes them with
// `history.replaceState` - so the URL in the bar is always the view on screen, a reload comes back to the
// same view, and a pasted link opens what the sender was looking at. All three are properties of the URL and
// the browser's history, and nothing outside a browser can check any of them.
test.describe("table state in the URL", () => {
  test("sorting writes the URL, and the URL restores the sort", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors", "Vendors");

    // Untouched, a table adds nothing to the URL - the deep link stays clean until somebody changes something.
    expect(page.url()).not.toContain("t.vendors");

    await sortBy(page, "Vendor");
    await expect.poll(() => page.url()).toContain("t.vendors");
    const sortedFirst = await firstVendor(page);

    // The same view after a reload, from the URL alone.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    expect(await firstVendor(page)).toBe(sortedFirst);

    // And the sort really is a sort: reversing it puts a different vendor on top.
    await sortBy(page, "Vendor");
    await expect.poll(() => firstVendor(page)).not.toBe(sortedFirst);
  });

  test("the link opens somebody else's view", async ({ as }) => {
    const author = await as("super");
    await gotoRoute(author, "vendors", "Vendors");
    await sortBy(author, "Vendor");
    await sortBy(author, "Vendor"); // and again, for descending
    await expect.poll(() => author.url()).toContain("t.vendors");
    const shared = author.url();
    const theirTop = await firstVendor(author);

    // A colleague opening the pasted link sees the same table, not the default one.
    const colleague = await as("super");
    await colleague.goto(shared);
    await expect(colleague.getByRole("main")).toBeVisible();
    expect(await firstVendor(colleague)).toBe(theirTop);
  });
});

/** Click a column's sort control. The `<th>` itself is not clickable - the header text is a button inside it,
 *  next to the drag handle that reorders columns. */
async function sortBy(page: import("@playwright/test").Page, column: string) {
  await page.getByRole("columnheader", { name: column }).getByRole("button", { name: column }).click();
}

/** The first vendor name in the table body. `tbody tr` because a clickable row is `role="button"`, not `row`. */
async function firstVendor(page: import("@playwright/test").Page): Promise<string> {
  const cell = page.locator("tbody tr").first().locator("td").first();
  await expect(cell).toBeVisible();
  return (await cell.innerText()).trim();
}
