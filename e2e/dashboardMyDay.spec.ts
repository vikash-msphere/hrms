import { gotoRoute, test, expect } from "./fixtures";

// The band of the dashboard that is about YOU.
//
// Most of the dashboard is the org's numbers. "My day" is the opposite: the caller's own leave balance, their
// next payday, the time off ahead of them, their onboarding checklist - self-scoped reads, assembled in the
// browser, and a tile appears only when it has something to say. Which is why it is worth a browser test and
// not a route test: the composition IS the feature, and a tile that renders for somebody with no data (or
// fails to render for somebody with plenty) is invisible to every other kind of test.
//
// `dashboardLayout` covers the order and hiding of sections and `kpiVisibility` who may see which org KPI;
// neither reads a tile. This one takes the employee's side of the page, because self-scoped data is the whole
// point of the band and an admin is not the person it is for.
test("the employee's own band renders their numbers and drills through", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("employee");
  await gotoRoute(page, "dashboard");

  // The tile a seeded employee always has: they hold leave balances, so the tile is the one piece of this
  // band whose presence is a fact rather than a coincidence of what else has been run today.
  const balance = page.getByRole("button").filter({ hasText: "Leave balance" }).first();
  await expect(balance).toBeVisible({ timeout: 30_000 });
  // A tile with a heading and no number is the failure mode worth naming: the band renders, the read did not.
  await expect(balance).toHaveText(/\d/);

  // Every tile is a way into the page it summarises - that is what makes the band a starting point rather
  // than a poster. The card itself is the control (role="button"), so this is the press a reader makes.
  await balance.click();
  await expect(page.getByRole("heading", { level: 1, name: "Leaves" })).toBeVisible({ timeout: 30_000 });
});
