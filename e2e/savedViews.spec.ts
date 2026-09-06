import { gotoRoute, test, expect } from "./fixtures";

// A table set up the way one person works, following them to the next machine.
//
// A saved view is a named snapshot of a table's sort, filters, search and visible columns; the pinned one is
// applied on mount unless the URL is more specific. It is stored twice on purpose (lib/tablePrefs.ts):
// localStorage for an instant paint, and a per-user `preferences/table_<id>` row so the layout is the
// person's rather than the browser's. Neither half is reachable from the server suite - one lives in a
// browser store, and the other only matters at the moment a SECOND browser mounts the table with an empty
// cache and has to prefer the server's answer to its own.
//
// The state a view captures is asserted through a column, not only through the sort: a view that restored
// the sort but silently dropped the column layout is the failure this exists to catch, and it looks fine on
// the machine that saved it, where localStorage still has the layout.
test("a saved view is pinned, and opens the table on another machine", async ({ as }) => {
  const page = await as("super");
  const viewName = `E2E view ${Date.now()}`;
  await gotoRoute(page, "vendors", "Vendors");

  // A run that died half way through leaves a pinned view behind, and the table would then OPEN on it - so
  // start from the built-in baseline rather than from whatever the last run believed.
  await resetTable(page);

  // Narrow the table two ways, so applying the view somewhere else has two things to get right.
  await hideColumn(page, "Terms");
  await expect(page.getByRole("columnheader", { name: "Terms" })).toHaveCount(0);
  // `exact`: the header carries a sort button named for the column AND a filter button named "Filter by
  // <column>", and a loose match takes both.
  await page.getByRole("columnheader", { name: "Vendor" }).getByRole("button", { name: "Vendor", exact: true }).click();
  await expect.poll(() => page.url()).toContain("t.vendors");

  // Save it, and pin it.
  const views = page.getByRole("button", { name: "Saved views" });
  await views.click();
  await page.getByPlaceholder("Name this view").fill(viewName);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The control names the view the table is showing - which is how anybody knows a table is narrowed at all.
  await expect(views).toContainText(viewName);
  await page.getByRole("button", { name: `Open ${viewName} by default` }).click();
  await page.keyboard.press("Escape");
  // The server copy rides a debounce, so wait for the request rather than for a guessed number of seconds.
  // Each change restarts that timer, so the write registered here is the one carrying the pin.
  await prefWrite(page);

  // A different browser for the same person: empty localStorage, no table state in the URL, so the only way
  // it can come up on this view is by reading the preference row back and applying the pin on mount.
  const otherDevice = await as("super");
  await gotoRoute(otherDevice, "vendors", "Vendors");
  const theirViews = otherDevice.getByRole("button", { name: "Saved views" });
  await expect(theirViews).toContainText(viewName);
  await expect(otherDevice.getByRole("columnheader", { name: "Terms" })).toHaveCount(0);

  // Default puts the table back as the page ships it - the built-in baseline, not "whatever was last saved".
  await theirViews.click();
  await otherDevice.getByRole("button", { name: "Default", exact: true }).click();
  await expect(otherDevice.getByRole("columnheader", { name: "Terms" })).toBeVisible();

  // Take the view away again, so the next spec (and the next run) meets an ordinary vendors table.
  await theirViews.click();
  await otherDevice.getByRole("button", { name: `Delete view ${viewName}` }).click();
  await otherDevice.keyboard.press("Escape");
  await prefWrite(otherDevice);
  await gotoRoute(otherDevice, "vendors", "Vendors");
  await expect(theirViews).not.toContainText(viewName);
});

type Page = import("@playwright/test").Page;

/** Wait for the debounced write of this table's layout to the user's preference row. */
function prefWrite(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes("/v1/preferences/table_vendors") && r.request().method() !== "GET",
    { timeout: 30_000 },
  );
}

/** Put the table back on its built-in baseline and drop any view an earlier run left pinned. */
async function resetTable(page: Page) {
  const views = page.getByRole("button", { name: "Saved views" });
  await views.click();
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await views.click();
  const leftovers = page.getByRole("button", { name: /^Delete view E2E view / });
  for (let n = await leftovers.count(); n > 0; n--) await leftovers.first().click();
  await page.keyboard.press("Escape");
}

/** Turn a column off through the Columns popover, the way a reader would. */
async function hideColumn(page: Page, header: string) {
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("checkbox", { name: header }).click();
  await page.keyboard.press("Escape");
}
