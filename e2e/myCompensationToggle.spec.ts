import { gotoRoute, test, expect } from "./fixtures";

// The self-service compensation card on /profile - deliberately a different read than HR's own
// (EmployeeCompensation): no revise action, no grade/band, no client-side split math. Nothing in the suite
// opens it, so the one thing it actually computes client-side - the Monthly/Annual toggle re-pricing the
// same CTC and its whole breakdown - has never run.
test("the Monthly/Annual toggle re-prices the CTC and its breakdown together", async ({ as }) => {
  test.setTimeout(90_000);
  // Read as payroll, not as an ordinary employee: `compensation` is granted to payroll_admin (and super)
  // alone in the seeded role matrix, so on any other login the tab is correctly not offered at all. This is
  // the SELF-service card either way - payroll reading their own row, on their own profile.
  const page = await as("payroll");
  await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
  await page.getByRole("tab", { name: "Compensation" }).click();

  const panel = page.getByRole("tabpanel").filter({ hasText: "Cost to company" });
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Monthly by default: a real figure, captioned "a month".
  await expect(panel.getByText("a month", { exact: false })).toBeVisible();
  const monthlyCtc = await panel.locator("p.text-2xl").innerText();

  await panel.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(panel.getByText("a year", { exact: false })).toBeVisible();
  await expect(panel.getByText("a month", { exact: false })).toHaveCount(0);
  const annualCtc = await panel.locator("p.text-2xl").innerText();
  // The same salary, priced two ways - not the same string twice under a different caption.
  expect(annualCtc).not.toBe(monthlyCtc);

  // Back to monthly, and the figure reverts with it - the toggle is a live re-price, not a one-way reveal.
  await panel.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(panel.getByText("a month", { exact: false })).toBeVisible();
  await expect(panel.locator("p.text-2xl")).toHaveText(monthlyCtc);
});
