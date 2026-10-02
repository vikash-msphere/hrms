import { gotoRoute, test, expect } from "./fixtures";

// The chart strip's fold (`ChartStrip` in components/common/Chart.tsx).
//
// Every list page that leads with a row of charts lets the reader fold it away, and the fold is a choice this
// browser keeps per page. There is no request behind it, so only a browser can tell whether the toggle hides
// the charts, whether a reload remembers it, and whether showing them again brings the charts back. The
// directory stands in for every page that uses the strip: they share the one component.

test("the chart strip folds, the browser remembers it, and it unfolds again", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  await gotoRoute(page, "employees", "Directory");

  // A figure is named by its caption, which is the chart's own description - exact, because a role name
  // matches as a substring by default.
  const chart = page.getByRole("figure", { name: "Headcount by department", exact: true });
  const hide = page.getByRole("button", { name: "Hide charts", exact: true });
  const show = page.getByRole("button", { name: "Show charts", exact: true });

  // A fresh browser has nothing stored, so the charts start open.
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(hide).toHaveAttribute("aria-expanded", "true");

  await hide.click();
  await expect(chart).toHaveCount(0);
  await expect(show).toHaveAttribute("aria-expanded", "false");

  // The fold has to survive the reload that drops everything the page is holding, or every visit starts
  // with the charts the reader put away.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });
  await expect(show).toBeVisible({ timeout: 30_000 });
  await expect(chart).toHaveCount(0);

  await show.click();
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(hide).toBeVisible();
});
