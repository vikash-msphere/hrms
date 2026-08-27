import { ROLES, gotoRoute, test, expect, type Role } from "./fixtures";

// Does the app run at all, for each kind of person who signs in?
//
// Nothing else in the suite answers that. `tsc` proves the types line up, the vitest files prove the Worker
// answers correctly, and the source scans prove the front end follows its conventions in the source - but a
// component that throws on mount, a bootstrap read that never resolves, or an effect that loops still ships
// green through all three. This spec is the smoke alarm: five roles, the shell mounts, the router lands, the
// console stays clean (asserted for every page by the `as` fixture).
//
// The second half is the hide-never-disable rule, tested live rather than by regex: a page the caller cannot
// read must be neither offered in the nav NOR served when the URL is typed anyway.
test.describe("boot", () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    test(`the shell mounts and routes for ${role}`, async ({ as }) => {
      const page = await as(role);
      await gotoRoute(page, "dashboard");

      // The route the app thinks it is on, according to the nav it drew: proves the router mounted and the
      // shell rendered, not merely that a <main> element exists.
      const sidebar = page.getByRole("complementary");
      await expect(sidebar.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("main")).not.toBeEmpty();
    });
  }

  test("a page the caller cannot read is neither offered nor served", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "dashboard");

    // Payroll (route key `payroll-runs`, gated on `payroll-runs.read`) is nothing an employee holds - the API
    // answers 403 for them, which the vitest suite already pins. What only a browser shows is the UI's half
    // of the rule.
    await expect(page.getByRole("complementary").getByRole("link", { name: "Payroll", exact: true })).toHaveCount(0);

    await gotoRoute(page, "payroll-runs");
    await expect(page.getByText("You don't have access to this")).toBeVisible();
  });

  test("the same page is offered and served to a caller who holds it", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await expect(page.getByRole("complementary").getByRole("link", { name: "Payroll", exact: true })).toBeVisible();

    await gotoRoute(page, "payroll-runs");
    await expect(page.getByText("You don't have access to this")).toHaveCount(0);
  });
});
