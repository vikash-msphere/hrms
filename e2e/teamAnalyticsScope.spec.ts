import { gotoRoute, test, expect } from "./fixtures";

// "An employee opening this sees one row - their own report" - the guarantee `TeamAnalytics.tsx`'s own top
// comment makes about `GET /v1/people-analytics`, and nothing has ever opened the page as a plain employee to
// check it. The page holds no scoping logic of its own (every measure is aggregated server-side, under the
// caller's own access to the collection it came from), which is exactly why a regression there would be
// invisible from the component alone - the table would just render whatever the endpoint decided to send.
test("a plain employee's report is one row, and it opens on their own record", async ({ as }) => {
  test.setTimeout(60_000);
  const page = await as("employee");
  await gotoRoute(page, "team-analytics", "Team analytics");

  // Scoped to the roster table specifically: the page also carries a "Measure to compare" Chart above it,
  // whose own sr-only accessible mirror table (Chart.tsx) is ALSO a `<table>` with one row per person in
  // `chartPeople` - for a single-employee viewer that is one MORE row, so a bare page-wide `tbody tr` reads 2
  // here, not 1. "Person" is the one header only the real roster carries.
  const rosterTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Person" }) });
  // The "Team" summary line is its own row, but only under `people.length > 1` - so a genuinely single-person
  // report has no such row at all, and this table's own `tbody tr` is simply this one person, nothing to filter out.
  const personRows = rosterTable.locator("tbody tr");
  await expect(personRows).toHaveCount(1, { timeout: 30_000 });

  // Clicking the one row opens their own report, and the Sheet says "My profile" (not "Open profile") only
  // when `me.employee_id === id` - the exact identity check the guarantee above rests on. The row's own
  // click target is the avatar+name button inside its first cell, not the <tr> itself.
  await personRows.first().getByRole("button").first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole("button", { name: /^My profile/ })).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole("button", { name: /^Open profile/ })).toHaveCount(0);
});
