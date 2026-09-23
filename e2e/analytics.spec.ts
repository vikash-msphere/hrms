import { gotoRoute, test, expect } from "./fixtures";

// The two rollup pages: people, and hiring.
//
// Both are read-only, which is exactly why they need a browser test - there is no write to check afterwards,
// so a page that quietly reports the wrong window, or refuses to open the rows behind a number, looks fine
// from the server. The measures themselves are server-side (`test/teamAnalytics.test.ts`); what is tested
// here is the reading: the window it reports on, the guard on a window too wide to compute, the per-person
// report behind a row, and the drill-through that turns a number into the list it counted.
test.describe("analytics", () => {
  test("team analytics reports on a window, guards a silly one, and opens a person", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    await gotoRoute(page, "team-analytics", "Team analytics");

    // Everyone the reader can see, over a window they choose.
    await expect(page.getByText(/working days in the window/)).toBeVisible({ timeout: 30_000 });

    // A custom window wider than a quarter is refused before it is asked for: the measures are computed per
    // day per person, and a year-wide ask is how this page becomes a timeout.
    await page.getByLabel("Reporting window").click();
    await page.getByRole("option", { name: /Custom/ }).click();
    await page.getByLabel("From", { exact: true }).fill("2026-01-01");
    await page.getByLabel("To", { exact: true }).fill("2026-12-31");
    await expect(page.getByText("Pick a window of 92 days or less.")).toBeVisible();

    // Back to a sane window, and the report is readable again.
    await page.getByLabel("From", { exact: true }).fill("2026-06-01");
    await page.getByLabel("To", { exact: true }).fill("2026-06-30");
    await expect(page.getByText("Pick a window of 92 days or less.")).toHaveCount(0);
    await expect(page.getByText(/working days in the window/)).toBeVisible({ timeout: 30_000 });

    // The chart compares one measure across the team, and the measure is the reader's choice.
    await page.getByLabel("Measure to compare").click();
    await page.getByRole("option").nth(1).click();

    // A person's own numbers are behind their row - the table answers "what are their numbers", the panel
    // answers "why". Located by the person rather than by row index: the chart above renders its own data
    // table for screen readers, and that table's rows come first in the document.
    const person = page.getByRole("button", { name: /Eve Employee/ }).first();
    await person.click();
    const report = page.getByRole("dialog");
    await expect(report).toBeVisible({ timeout: 30_000 });
    await expect(report.getByRole("heading")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The search narrows the report in the browser rather than re-asking the server for a different one.
    await page.getByLabel("Find a person").fill("zzzz-nobody");
    await expect(page.getByRole("button", { name: /Eve Employee/ })).toHaveCount(0);
    await page.getByLabel("Find a person").fill("Eve");
    await expect(page.getByRole("button", { name: /Eve Employee/ }).first()).toBeVisible();
  });

  test("recruiting analytics turns its numbers into the lists they counted", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    await gotoRoute(page, "recruiting-analytics", "Recruiting analytics");

    // With no hiring activity the page says so instead of drawing empty charts, and there is nothing to
    // drill into. Which of the two it is depends on what the rest of the suite left behind, so the page is
    // given time to settle on one of them before it is read.
    await expect(page.getByText(/No recruiting activity yet|Pipeline funnel \(active\)/)).toBeVisible({ timeout: 30_000 });
    if (await page.getByText("No recruiting activity yet").count()) {
      await expect(page.getByText(/Open a job and add candidates/)).toBeVisible();
      return;
    }

    // The funnel and the offer outcomes are the two shapes this page exists to draw. Matched on the FIRST
    // hit of each: once there are offers to draw, the section's title is also the chart's own label, so the
    // text is on the page twice and "is it drawn" must not turn on how many times it is written.
    await expect(page.getByText("Pipeline funnel (active)").first()).toBeVisible();
    await expect(page.getByText("Offer outcomes").first()).toBeVisible();

    // Nothing here is a list you can narrow, so each number opens the page that owns its rows. "Candidates"
    // is the one that always has somewhere to go.
    await page.getByText("Candidates", { exact: true }).first().click();
    await expect(page.locator("h1").first()).toHaveText(/Candidates|Talent/, { timeout: 30_000 });
  });
});
