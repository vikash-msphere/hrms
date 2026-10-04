import { gotoRoute, searchBox, searchPanel, test, expect } from "./fixtures";

// ⌘K obeys the same rule the sidebar does.
//
// `search` proves the palette opens, reaches the index and navigates. This is the other half: WHAT it offers.
// The palette is the one surface in the app that is deliberately a list of everywhere you can go, so it is
// also the easiest place to leak the existence of somewhere you cannot - and the leak is invisible in the
// source, because the page list, the settings list and the action list are each filtered by a different gate
// (nav capability, `settings.write` plus the panel's own permission, the action's own grant).
//
// `test/globalSearch.test.ts` owns the server's half: which RECORDS a caller's query is allowed to match.
// What only a browser shows is the locally-built half of the same list - and that the two are one answer to
// one person, with no "Vendors" row leading to a wall.
/** The open search: everything is asserted inside it, because the sidebar beside it says some of the same words. */
function palette(page: import("@playwright/test").Page) {
  return searchPanel(page);
}

/** Open it on whatever page the browser is on, and return its input. */
async function open(page: import("@playwright/test").Page) {
  // ControlOrMeta so this is the same test on a mac laptop and a linux CI runner.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  return searchBox(page);
}

/** A row in the palette, by the label on it. */
function row(page: import("@playwright/test").Page, label: string | RegExp) {
  return palette(page).getByRole("option").filter({ hasText: label });
}

test.describe("what the palette offers", () => {
  test("an admin is offered the page and the settings panel their query names", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    const input = await open(page);
    await input.fill("vendors");
    // Grouped, which is what keeps a mixed list of pages, people and records readable.
    await expect(palette(page).getByRole("group", { name: "Pages" })).toBeVisible({ timeout: 30_000 });
    await expect(row(page, "Vendors").first()).toBeVisible();

    // A settings panel is its own kind of destination, grouped apart from the pages - and it is the kind an
    // ordinary employee must never be shown, which is what the next test turns on.
    await input.fill("permissions");
    await expect(palette(page).getByText("Settings", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row(page, "Permissions").first()).toBeVisible();
  });

  test("an employee is offered neither the page nor the panel they may not open", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("employee");
    await gotoRoute(page, "dashboard");

    const input = await open(page);
    // Vendors is a page this person holds no grant for. The sidebar already hides it (`boot` covers that);
    // the palette is a second, entirely separate list of the same places, built from the same capabilities -
    // and a row here is a wall one press away.
    // A negative assertion that passes instantly is worth very little here: the palette debounces, then asks
    // the server, and a row that arrives a moment later is exactly the leak this is looking for. So the count
    // is taken after the query this typing produces has been answered.
    const answered = page.waitForResponse((r) => r.url().includes("/search?q=vendors"), { timeout: 30_000 });
    await input.fill("vendors");
    await answered;
    await expect(row(page, /^Vendors$/)).toHaveCount(0);

    await input.fill("permissions");
    await expect(row(page, /^Permissions$/)).toHaveCount(0);

    // And the palette is not simply broken for them: their own pages are offered by the same list, in the
    // same keystroke - which is what makes the two counts above a statement about access rather than about a
    // palette that never renders anything. A page inside a workspace is offered as "<workspace>: <tab>", so
    // this is the row's whole label, not the route key.
    await input.fill("my leave");
    await expect(row(page, "Leave: My Leave").first()).toBeVisible({ timeout: 30_000 });

    // And Escape puts the results away, from the input where the focus is - the press somebody makes when they
    // opened the search by accident, or changed their mind after reading the rows.
    await input.press("Escape");
    await expect(palette(page)).toHaveCount(0);
  });
});
