import { gotoRoute, test, expect } from "./fixtures";

// WHO THIS PAGE IS FOR, AND WHOSE NUMBERS IT SHOWS.
//
// Team analytics is a per-person report ACROSS the roster, so the nav gates it on reach past the caller's own
// record (`nav.ts` `others: "employees"`) and the router puts the same wall up for a typed URL. The capability
// alone cannot say this: the set the SPA gates on is scope-stripped (`domain/permissions.ts` stripScope), so
// the bare directory grant every employee holds is spelled exactly like the org-wide one HR holds, and an
// "Analytics" entry gated on it offered every employee a report about one person - themselves.
//
// The page holds no scoping logic of its own (every measure is aggregated server-side, under the caller's own
// access to the collection it came from), which is why both halves of the guarantee live outside the
// component: the wall in front of a caller with no reach, and `GET /v1/people-analytics` returning exactly
// the people the caller's own directory list would have, for one who has it.
test("a plain employee is walled rather than handed a report about themselves", async ({ as }) => {
  const page = await as("employee");

  // No heading to wait for: the wall goes up INSTEAD of the page, so `gotoRoute`'s `<main>` is all there is.
  await gotoRoute(page, "team-analytics");
  await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Team analytics" })).toHaveCount(0);

  // And the sidebar never offered it either - the same answer in the surface the gate was written for.
  await expect(page.getByRole("complementary").getByRole("link", { name: "Analytics", exact: true })).toHaveCount(0);
});

test("a manager's report lists their people and opens on their own record", async ({ as }) => {
  test.setTimeout(60_000);
  const page = await as("manager");

  // Which row is the caller's own, asked of the endpoint the page itself reads. The displayed name is
  // composed server-side, so spelling it here from first/last would be this spec guessing at that.
  const me = (await (await page.request.get("/v1/users/me")).json()) as { employee?: string };
  expect(me.employee, "the manager fixture has no employee record").toBeTruthy();
  const report = await page.request.get("/v1/people-analytics");
  expect(report.status(), await report.text()).toBe(200);
  const { people } = (await report.json()) as { people: { employee: string; name: string }[] };
  const mine = people.find((p) => p.employee === me.employee);
  expect(mine, "the manager is missing from their own report").toBeTruthy();
  const theirs = people.find((p) => p.employee !== me.employee);
  expect(theirs, "a manager's report is supposed to reach past their own record").toBeTruthy();

  await gotoRoute(page, "team-analytics", "Team analytics");

  // Scoped to the roster table specifically: the page also carries a "Measure to compare" Chart above it,
  // whose own sr-only accessible mirror table (Chart.tsx) is ALSO a `<table>` with one row per person in
  // `chartPeople`, so a bare page-wide `tbody tr` counts everybody twice. "Person" is the one header only the
  // real roster carries.
  const rosterTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Person" }) });
  const row = (name: string) => rosterTable.locator("tbody tr").filter({ hasText: name });
  await expect(row(mine!.name)).toHaveCount(1, { timeout: 30_000 });

  // Clicking their own row opens their own report, and the Sheet says "My profile" (not "Open profile") only
  // when `me.employee_id === id` - the identity check the page's own guarantee rests on. The row's click
  // target is the avatar+name button inside its first cell, not the <tr> itself.
  await row(mine!.name).getByRole("button").first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole("button", { name: /^My profile/ })).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole("button", { name: /^Open profile/ })).toHaveCount(0);

  // And somebody else's row is the other side of that same check, which is what makes it an identity test
  // rather than a label that reads the same whoever is clicked.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
  await row(theirs!.name).getByRole("button").first().click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /^Open profile/ })).toBeVisible({ timeout: 30_000 });
});
