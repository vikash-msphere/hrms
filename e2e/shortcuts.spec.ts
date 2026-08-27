import { gotoRoute, test, expect } from "./fixtures";

// The global keyboard layer, which is nothing but browser behaviour.
//
// `ShortcutLayer` listens on `window` for the whole app: `?` opens the reference, `g` then a letter jumps to a
// page, `[` and `]` walk the current workspace's tabs. None of that exists outside a real key event - there is
// no route, no payload and no source convention a scan could pin, which is why nothing else in the suite says
// whether the keys work.
//
// The half that matters more than the jumping is the RESTRAINT. A layer that listens globally is one mistake
// away from eating the letters somebody is typing into a search box, and that mistake is invisible until a
// person types "g" in a filter and lands on another page with their work gone. So two of the three tests here
// are about the keys NOT firing: while a text field has focus, and while a dialog owns the keyboard.
test.describe("keyboard shortcuts", () => {
  test("g jumps, ] walks the workspace tabs, and ? explains both", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // The chord: `g` arms, the letter within 1.5s decides. Pressed on `body`, which is where a reader's focus
    // sits when they have not clicked into anything.
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await expect.poll(() => page.url()).toMatch(/#\/leave-requests\b/);

    // `]` is the same workspace's next tab, not a jump: Directory and Org Chart are two tabs of the People
    // workspace, so this proves the layer reads the CURRENT page's tab list rather than a fixed order.
    await gotoRoute(page, "employees", "Directory");
    await page.keyboard.press("]");
    await expect.poll(() => page.url()).toMatch(/#\/org-chart\b/);

    // And the reference, which is the only place a reader learns any of this exists.
    await page.keyboard.press("?");
    const help = page.getByRole("dialog");
    await expect(help.getByText("Keyboard shortcuts")).toBeVisible();
    // Listed chords are gated by the same nav rules as the sidebar, so this is the super's own list.
    await expect(help.getByText("Leave", { exact: true })).toBeVisible();
  });

  test("the chord keys are not eaten by a field somebody is typing in", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "employees", "Directory");

    // "gl" is a plausible fragment of a name ("Douglas"), and the directory's search box is exactly where it
    // would be typed. The layer must leave every keystroke alone and the page must not move.
    const search = page.getByRole("searchbox", { name: /Search people/i });
    await search.click();
    await page.keyboard.type("gl");
    await expect(search).toHaveValue("gl");
    expect(page.url(), "a chord fired from inside a text field").toMatch(/#\/employees\b/);
  });

  test("an open dialog owns the keyboard", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors", "Vendors");
    await page.getByRole("button", { name: "New vendor" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New vendor")).toBeVisible();

    // A dialog has its own Enter/Esc semantics and its own focus trap; a chord that navigated out from under
    // it would unmount the form mid-edit. The keys go to the dialog's own handling instead, and the page
    // behind it stays put.
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await expect(dialog).toBeVisible();
    expect(page.url()).toMatch(/#\/vendors\b/);
  });
});
