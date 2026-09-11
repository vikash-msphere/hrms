import { ROLES, gotoRoute, test, expect } from "./fixtures";

// The report narrows three ways - a name typed in, a department picked, a person opened - and nothing has
// ever driven any of the three. `teamAnalyticsScope.spec.ts` owns the one-row guarantee for a plain employee;
// this is the same page opened by someone who can see the whole roster, so there is more than one row to
// narrow among and someone else's report to open.
test.describe("team analytics: search, department and the person sheet", () => {
  test("typing a name narrows the roster to it, and opening someone else's row offers their profile, not mine", async ({ as }) => {
    test.setTimeout(60_000);
    const page = await as("super");

    // A real seeded person to search for, found the same way `fixtures.ts personPath` does - by the login
    // email `ROLES` already keys `employee` to, since a first name alone is one seeded joiner away from
    // matching somebody else too.
    const res = await page.request.get("/v1/employees?page_size=200");
    expect(res.status(), await res.text()).toBe(200);
    const { results = [] } = (await res.json()) as {
      results?: { path: string; work_email?: string; first_name?: string; last_name?: string; department?: string }[];
    };
    const person = results.find((e) => e.work_email === ROLES.employee);
    if (!person) throw new Error("e2e: no employee record for the employee fixture");
    const fullName = `${person.first_name} ${person.last_name}`;

    await gotoRoute(page, "team-analytics", "Team analytics");
    // Scoped to the roster table specifically: the page also carries a "Measure to compare" Chart above it,
    // whose own sr-only accessible mirror table (Chart.tsx) is ALSO a `<table>` with one row per person - a
    // bare page-wide `tbody tr` matches both, and (since the chart's rows carry no button of their own) a
    // `.first()` that happens to land on the chart's copy of this person's row finds no button to click at all.
    // "Person" is the one header only the real roster carries.
    const rosterTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Person" }) });
    // `gotoRoute` only waits for the page shell (main + heading) - the roster itself is a separate async
    // fetch, and reading the row count synchronously right after can catch it before that lands (0 rows,
    // making the "fewer than before" check below impossible to ever satisfy). Waited for a real row first.
    await expect(rosterTable.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
    const rowsBefore = await rosterTable.locator("tbody tr").count();

    // The search box narrows the same table an unfiltered load shows - a positive match, and fewer rows than
    // the unfiltered roster (rather than asserting on the exact remaining count, which the wider seed decides).
    await page.getByLabel("Find a person", { exact: true }).fill(fullName);
    const match = rosterTable.locator("tbody tr").filter({ hasText: fullName });
    await expect(match.first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => rosterTable.locator("tbody tr").count(), { timeout: 30_000 }).toBeLessThan(rowsBefore);

    // Opening THEIR row as an admin offers "Open profile" - the sheet's own `mine` check is
    // `me.employee_id === id`, and super is never that id for a seeded employee's record.
    await match.first().getByRole("button").first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText(fullName)).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Open profile/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^My profile/ })).toHaveCount(0);

    // The report itself, not just the header around it: every measure PersonReport lists carries the team's
    // own number beside the person's, so a reader never has to hold the team average in their head to tell
    // whether "12" is good - it renders right there as "team 12", one per <dd>.
    await expect(sheet.getByText(/^team /).first()).toBeVisible({ timeout: 15_000 });

    // "Leave history" is a door too, off this same sheet - to THEIR leave tab, not the admin's own.
    await sheet.getByRole("button", { name: "Leave history" }).click();
    await expect.poll(() => page.url()).toContain(`#/employees/${person.path.split("/")[1]}/leave`);
    // The sheet's own close (dialogHistory.ts useHistoryClose) pushes then asynchronously pops a history entry -
    // waiting for it to actually disappear here keeps that deferred pop from landing after (and undoing) the
    // gotoRoute below, which is itself another history push.
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await gotoRoute(page, "team-analytics", "Team analytics");

    // The department filter is URL state (`?department=`), same as the range picker beside it - the
    // narrowed page is a link, not a client-only toggle that a reload would lose.
    if (person.department) {
      await page.getByLabel("Find a person", { exact: true }).fill("");
      await page.getByLabel("Department", { exact: true }).click();
      const deptRes = await page.request.get(`/v1/${person.department}`);
      const deptName = deptRes.ok() ? ((await deptRes.json()) as { display_name?: string }).display_name : undefined;
      if (deptName) {
        await page.getByRole("option", { name: deptName, exact: true }).click();
        await expect.poll(() => page.url()).toContain("department=");
        await expect(rosterTable.locator("tbody tr").filter({ hasText: fullName }).first()).toBeVisible({ timeout: 30_000 });
      } else {
        await page.keyboard.press("Escape");
      }
    }
  });
});
