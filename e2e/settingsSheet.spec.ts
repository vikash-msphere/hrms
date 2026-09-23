import { gotoRoute, test, expect } from "./fixtures";

// Settings, opened where the setting is USED.
//
// The gear on a feature page opens that page's own panel in a right-docked Sheet - the same panel the central
// Settings hub renders, without navigating away. A page with one setting gets a gear that opens it directly; a
// page with several gets one gear whose menu lists them by name. Three things about that are browser-only:
//
//   - the panel bodies live in a lazily imported chunk (`SettingsPanelContent`), so "the sheet opens" and "the
//     chunk actually loaded and rendered" are different claims, and only the second one is worth anything;
//   - the open state is deep-linked as `?setting=<key>` on the page's URL, so a pasted link opens straight into
//     the panel and closing it leaves a clean URL behind;
//   - the gate is hide-never-disable: a caller who may not open the panel must not be shown the gear at all.
//
// What the panel SAVES is the settings API's business and is pinned by the vitest suite; nothing about it is
// re-asserted here.
test.describe("inline settings", () => {
  test("the gear opens the page's own panel, and the URL says so", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "attendance", "Attendance");

    // Untouched, the page carries no panel state - the deep link stays clean until the gear is used.
    expect(page.url()).not.toContain("setting=");

    await page.getByRole("button", { name: "Attendance schedule" }).click();
    // By the dialog's own accessible name, which Radix takes from the sheet title: the panel BODY also says
    // "Attendance schedule" on its card, and matching either one would pass without the sheet being right.
    const sheet = page.getByRole("dialog", { name: "Attendance schedule" });
    await expect(sheet).toBeVisible();
    // Proof the lazy chunk arrived and rendered, rather than the sheet sitting on its skeleton forever.
    await expect(sheet.getByText("Shift start")).toBeVisible();
    await expect.poll(() => page.url()).toContain("setting=attendance");

    // Closing puts the URL back, so the next copy of the link is the page and not the panel.
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.url()).not.toContain("setting=");
  });

  test("the pasted link opens straight into the panel", async ({ as }) => {
    const page = await as("super");

    // What a colleague receives: the page, plus which panel was open on it.
    await page.goto("/attendance?setting=attendance");
    await expect(page.getByRole("main")).toBeVisible();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Shift start")).toBeVisible();

    // The org-scope escape hatch: the same panel, full width, at its own address.
    await sheet.getByRole("button", { name: "Open full settings" }).click();
    await expect.poll(() => page.url()).toMatch(/\/settings\/attendance\b/);
    await expect(page.getByText("Shift start")).toBeVisible();
  });

  test("a page with several settings offers one gear with a labelled menu", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "payroll-runs", "Payroll");

    // One trigger for the whole page, not a row of look-alike icons - no per-panel button survives outside it.
    const gear = page.getByRole("main").getByRole("button", { name: "Settings", exact: true });
    await expect(gear).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Payslip design" })).toHaveCount(0);

    await gear.click();
    const menu = page.getByRole("menu");
    // Each row reads as its panel's title, so it can be picked without hovering a row of icons.
    await expect(menu.getByRole("menuitem", { name: "Pay components" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "All settings" })).toBeVisible();

    // The one-line description is a hover tooltip on the row, not text under it.
    const row = menu.getByRole("menuitem", { name: "Payslip design" });
    await row.hover();
    await expect(page.getByRole("tooltip")).toContainText("The blocks a generated payslip is laid out from");

    await row.click();
    const sheet = page.getByRole("dialog", { name: "Payslip design" });
    await expect(sheet).toBeVisible();
    await expect.poll(() => page.url()).toContain("setting=payslip-design");

    // Back closes it, the same as a single gear's sheet: the open state is the URL either way.
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.url()).not.toContain("setting=");
  });

  test("a caller who may not configure the page is not offered the gear", async ({ as }) => {
    const page = await as("employee");
    // Attendance is a page an employee holds (their own punches), so this isolates the GEAR's gate rather
    // than the page's: same page, same route, no affordance for a panel they could not save.
    await gotoRoute(page, "attendance", "Attendance");
    await expect(page.getByRole("button", { name: "Attendance schedule" })).toHaveCount(0);
  });
});
