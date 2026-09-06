import { gotoRoute, test, expect } from "./fixtures";

// Watching the app as somebody else.
//
// "View as" is a server-side simulation: the SPA stamps `X-View-As` on every request and the Worker installs
// that person as the request principal, so the nav, the rows and the redactions are all theirs while the audit
// trail keeps naming the admin (`src/lib/viewAs.ts`, pinned by the vitest suite). What only a browser can show
// is the client half of it, and that half is where the feature can go quietly wrong:
//
//   - the subject is read from localStorage synchronously at import time, because the header has to ride the
//     VERY FIRST request of the page load - a version that resolved it later would boot as the admin and
//     silently show the admin's data under a pill that says otherwise;
//   - starting and stopping both RELOAD, which is what drops every module cache holding the other identity's
//     rows;
//   - the pill is the only exit, so an invisible simulation is a trap.
//
// The proof used here is the same pair boot.spec.ts uses for the hide-never-disable rule, which is what makes
// it meaningful: an admin simulating an employee must lose the Payroll nav entry AND be refused the page when
// the URL is typed anyway - the exact answer the real employee gets.
test.describe("view as", () => {
  test("an admin simulating an employee gets that person's app, and the pill is the way back", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByRole("link", { name: "Payroll", exact: true })).toBeVisible();

    // The simulation lives behind access-management mode, which is where an admin already is when they are
    // asking "what does this person actually see?".
    // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name is
    // the initials the fallback draws.
    await page.locator('header button[title^="Sam Super"]').click();
    await page.getByRole("menuitem", { name: /Access management/ }).click();
    await page.getByRole("button", { name: /view as/i }).click();

    // The picker lists every employee and every unlinked account, by name and work email. Its placeholder is
    // the tell that the list has arrived: opening it while it still says "Loading people…" means picking from
    // a list that is replaced underneath the press.
    const picker = page.getByRole("button", { name: "View app as…" });
    await expect(picker).toBeVisible();
    await picker.click();
    // Filter, then Enter. The pill is a `w-max` fixed row whose width follows the live count of key icons on
    // the page behind it, so while the dashboard is still mounting widgets the popover anchored to it keeps
    // being repositioned - a mouse click on a row waits for it to hold still and eventually gives up. The
    // keyboard path picks the highlighted row and does not care where it is on screen.
    await page.getByPlaceholder("Search…").fill("emp@example.com");
    // `.first()`: the picker lists the match, and the page underneath can be naming them too.
    await expect(page.getByRole("button", { name: /Eve Employee/ }).first()).toBeVisible();
    await page.keyboard.press("Enter");

    // Picking reloads the app as them. From here the nav is the employee's, not the admin's.
    await expect(page.getByText(/Viewing as/)).toBeVisible();
    await expect(page.getByText("Eve Employee · emp@example.com", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Payroll", exact: true })).toHaveCount(0);

    // And typing the URL anyway gets the employee's answer, because the server is answering as them.
    await gotoRoute(page, "payroll-runs");
    await expect(page.getByText("You don't have access to this")).toBeVisible();

    // Stopping is one click on the pill, and the admin gets their own app back.
    await page.getByRole("button", { name: "stop", exact: true }).click();
    await expect(page.getByText(/Viewing as/)).toHaveCount(0);
    await gotoRoute(page, "dashboard");
    await expect(sidebar.getByRole("link", { name: "Payroll", exact: true })).toBeVisible();
  });
});
