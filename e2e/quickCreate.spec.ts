import { gotoRoute, test, expect } from "./fixtures";

// Starting a create from anywhere, through the top bar's "+".
//
// The menu item does two things in one click: it navigates to the owning page and it fires a named intent that
// the page picks up as it mounts (`lib/intent.ts`). That handoff is a timing contract between a global menu
// and a page that does not exist yet - the intent stays pending until the page registers - and it either
// completes or it silently does nothing, leaving somebody on a page they did not ask for with no dialog. Only
// a browser can tell those two apart.
//
// The menu is also capability-gated per entry, so what it OFFERS is part of the hide-never-disable rule: an
// action whose page the caller could not write to must not be in the list.
test.describe("quick create", () => {
  test("the + menu lands on the page and opens its create dialog", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Set a goal" }).click();

    // Navigated...
    await expect.poll(() => page.url()).toMatch(/#\/goals\b/);
    // ...and the intent was picked up by the page that had not mounted yet when it was fired.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New goal")).toBeVisible();

    // And it is the real create flow, not a lookalike: what it writes shows up on the page behind it.
    const title = `E2E quick goal ${Date.now()}`;
    // By placeholder: a Field's label is not wired to its control with `htmlFor`, so `getByLabel` finds
    // nothing here.
    await dialog.getByPlaceholder("e.g. Ship the billing revamp").fill(title);
    await dialog.getByRole("button", { name: "Create goal", exact: true }).click();
    // `.first()`: the success toast carries the same title while it is on screen.
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  });

  test("the menu offers nothing the caller could not write", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "dashboard");

    await page.getByRole("button", { name: "New", exact: true }).click();
    // An employee raises their own requests, so the menu is not empty...
    await expect(page.getByRole("menuitem", { name: "Request leave" })).toBeVisible();
    // ...but hiring is not theirs to start, and an entry that only ever ends in a 403 is worse than no entry.
    await expect(page.getByRole("menuitem", { name: "Open a job" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Add an employee" })).toHaveCount(0);
  });
});
