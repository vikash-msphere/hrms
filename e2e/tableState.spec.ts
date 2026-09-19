import { gotoRoute, test, expect } from "./fixtures";

// A sorted, filtered table you can send to somebody.
//
// DataTable carries its sort and filters in the URL query as `t.<tableId>` and writes them with
// `history.replaceState` - so the URL in the bar is always the view on screen, a reload comes back to the
// same view, and a pasted link opens what the sender was looking at. All three are properties of the URL and
// the browser's history, and nothing outside a browser can check any of them.
//
// Read on DEPARTMENTS rather than on a busier table: `savedViews.spec.ts` pins a default view on vendors for
// this same person, and a table that opens already sorted is one where "click twice for descending" lands on
// the third state of the cycle instead. Nothing pins a view here, and the rows are the org's own departments.
//
// Each test starts from the built-in baseline, because sort is now kept in the person's table prefs: every
// browser in the suite is the same `super`, so a sort left behind by the test above would decide where this
// one's first click lands.
test.describe("table state in the URL", () => {
  test("sorting writes the URL, and the URL restores the sort", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "departments", "Departments");
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
    await resetTable(page);

    // On its baseline, a table adds nothing to the URL - the deep link stays clean until somebody changes
    // something.
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain("t.departments");

    await sortBy(page, "Name");
    await expect(header(page, "Name")).toHaveAttribute("aria-sort", "ascending", { timeout: 30_000 });
    // The URL is written on a debounce, so it is polled rather than read - and given a load's worth of time,
    // because a browser sharing a machine with fifteen others can be a while getting round to a timer.
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("t.departments");

    // The same view after a reload, from the URL alone. What is checked is the ORDER, not which department
    // happens to be on top: the specs running beside this one add and re-parent departments, so a name
    // captured a moment ago is not a fact about the table - "is it still ascending" is.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(header(page, "Name")).toHaveAttribute("aria-sort", "ascending", { timeout: 30_000 });
    await expectOrdered(page, "asc");

    // And the sort really is a sort: reversing it turns the order round.
    await sortBy(page, "Name");
    await expect(header(page, "Name")).toHaveAttribute("aria-sort", "descending", { timeout: 30_000 });
    await expectOrdered(page, "desc");
  });

  test("the link opens somebody else's view", async ({ as }) => {
    const author = await as("super");
    await gotoRoute(author, "departments", "Departments");
    await expect(author.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
    await resetTable(author);
    await sortBy(author, "Name");
    await sortBy(author, "Name"); // and again, for descending
    await expect(header(author, "Name")).toHaveAttribute("aria-sort", "descending", { timeout: 30_000 });
    await expect.poll(() => author.url(), { timeout: 30_000 }).toContain("t.departments");
    const shared = author.url();

    // A colleague opening the pasted link sees the same table, not the default one: the sender's order, on
    // the receiver's own copy of the data. Whether a department was added between the two loads is not the
    // subject and must not decide the result, so the two are compared by their ORDER rather than by name.
    const colleague = await as("super");
    await colleague.goto(shared);
    await expect(colleague.getByRole("main")).toBeVisible();
    // The address bar still says what was pasted: the state travels IN the link, so an app that tidies the
    // query away on boot has thrown the view away before any table could read it.
    expect(colleague.url(), "the pasted link lost its table state on load").toContain("t.departments");
    await expect(header(colleague, "Name")).toHaveAttribute("aria-sort", "descending", { timeout: 30_000 });
    await expectOrdered(colleague, "desc");
  });
});

/** Put the table back on its built-in baseline, clearing any sort a previous test persisted for this user. */
async function resetTable(page: import("@playwright/test").Page) {
  const views = page.getByRole("button", { name: "Saved views" });
  await views.click();
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("th[aria-sort]:not([aria-sort='none'])")).toHaveCount(0, { timeout: 30_000 });
}

/** The column's header cell - the thing that carries `aria-sort`. */
function header(page: import("@playwright/test").Page, column: string) {
  return page.getByRole("columnheader", { name: column });
}

/** The first column really is in the order the header claims, read off the page. */
async function expectOrdered(page: import("@playwright/test").Page, dir: "asc" | "desc") {
  await expect
    .poll(async () => {
      const names = (await page.locator("tbody tr").locator("td:first-child").allInnerTexts())
        .map((t) => t.trim().toLocaleLowerCase())
        .filter(Boolean);
      if (names.length < 2) return true; // one row is in order whichever way you read it
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      const want = dir === "asc" ? sorted : sorted.reverse();
      return names.join("|") === want.join("|");
    }, { timeout: 30_000 })
    .toBe(true);
}

/** Click a column's sort control. The `<th>` itself is not clickable - the header text is a button inside it,
 *  next to the drag handle that reorders columns. */
async function sortBy(page: import("@playwright/test").Page, column: string) {
  // `exact`: a sortable column's header holds two buttons - the sort (named for the column) and the filter
  // ("Filter by <column>") - and a substring match would take both.
  await page.getByRole("columnheader", { name: column }).getByRole("button", { name: column, exact: true }).click();
}
