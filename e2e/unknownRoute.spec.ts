import { gotoRoute, test, expect } from "./fixtures";

// An address the app no longer knows (`/pay-periods` was an alias until 4aebb5b moved it under Payroll Runs)
// renders the dashboard. The chrome has to say so: the breadcrumb and the tab title used to humanize the dead
// key, so the reader saw "Pay Periods" above a dashboard.
test("an unknown route is named as the dashboard it renders", async ({ as }) => {
  const page = await as("employee");
  await gotoRoute(page, "pay-periods");

  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumb).toContainText("Dashboard");
  await expect(crumb).not.toContainText("Pay Periods");
  await expect(page).toHaveTitle(/^Dashboard · /);
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
});
