import { SPA_HEADERS, allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// The two ways to read attendance, and the manager's view of the same days.
//
// `clock.spec.ts` owns punching, `attendanceCorrection.spec.ts` owns fixing one day, and `test/` owns the
// arithmetic. What is left is the page itself, which is the densest read-only surface in the app and is
// entirely a rendering problem: the same window of days is either a week-grouped list or a month grid, the
// choice is remembered per person, a month grid lets several days be ticked and fixed with ONE set of times
// (a whole week of missed punches is not a week of dialogs), the window pages backwards, and the daily-hours
// strip will fetch the PREVIOUS window on request to show deltas against it.
//
// None of that exists outside a browser, and none of it is asserted anywhere else.
test.describe("attendance views", () => {
  test("the month grid ticks several days for one correction, and the view choice is remembered", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("employee");
    await gotoRoute(page, "attendance", "Attendance");

    const views = page.getByRole("group", { name: "History view" });
    const list = views.getByRole("button", { name: "List" });
    const month = views.getByRole("button", { name: "Month" });
    await expect(list.or(month).first()).toBeVisible({ timeout: 30_000 });

    // The list is days grouped by week, which is how a timesheet is read.
    if ((await list.getAttribute("aria-pressed")) !== "true") await list.click();
    await expect(page.getByText(/^Week of /).first()).toBeVisible({ timeout: 30_000 });

    // The month is the same days as a calendar, and it says what it is for before anything is ticked.
    await month.click();
    await expect(month).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Click a day for its punches, or tick several to correct them together.")).toBeVisible({ timeout: 30_000 });

    // Days that HAVE a standing are the tickable ones (a day outside the month, or before the person joined,
    // is not). A month can open on one that has too few - so step back a month rather than assert against
    // whatever today happens to be.
    const ticks = page.getByRole("button", { name: /^Tick .* for a bulk correction$/ });
    // WAITED for, not counted once. The helper line above renders from the moment the grid mounts, while the
    // punches it draws the days from arrive after - so a count taken the instant a month opens can see zero
    // days for no reason but that none have landed yet, which is how this read "found no days to correct" on
    // a month that had them. And a month really can hold fewer than two (the person joined mid-month, or it
    // sits before they joined at all), so an empty one is stepped back past instead of asserted against.
    const enoughTicks = async (): Promise<boolean> => {
      for (let i = 0; i < 20 && (await ticks.count()) < 2; i++) await page.waitForTimeout(500);
      return (await ticks.count()) >= 2;
    };
    let found = false;
    for (let back = 0; back < 6 && !found; back++) {
      found = await enoughTicks();
      if (!found) {
        await page.getByRole("button", { name: "Previous month" }).click({ timeout: 10_000 });
        await expect(page.getByText("Click a day for its punches, or tick several to correct them together.")).toBeVisible({ timeout: 30_000 });
      }
    }
    expect(found, "no month in the last six offered two days to correct").toBe(true);

    // Ticking counts, and the count is what the action is named after - a bulk fix that did not say how many
    // days it was about to rewrite would be the wrong thing to press.
    await ticks.nth(0).click();
    await ticks.nth(1).click();
    await expect(page.getByText("2 days ticked")).toBeVisible({ timeout: 30_000 });
    const correct = page.getByRole("button", { name: "Correct 2 days" });
    await expect(correct).toBeVisible();
    await correct.click();

    // One dialog for both days: the times are entered once and the request is one per day behind the scenes.
    const form = page.getByRole("dialog");
    // Named after the days it covers, not after one of them: a single-day correction is titled "Correct
    // attendance — <day>", and this dialog is the other shape.
    await expect(form.getByRole("heading", { name: "Correct 2 days" })).toBeVisible({ timeout: 30_000 });
    // One press, two requests - so each day can still be approved on its own, and the button counts them.
    await expect(form.getByRole("button", { name: "Submit 2 requests" })).toBeVisible();
    await expect(form.getByText("These times are applied to every selected day", { exact: false })).toBeVisible();
    // Nothing is submitted: filing a correction is `attendanceCorrection.spec.ts`, and two more of them per
    // run would pile up in somebody's queue.
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Clearing the ticks puts the prompt back rather than leaving a stale count on screen.
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByText("Click a day for its punches, or tick several to correct them together.")).toBeVisible();

    // The choice of view is a per-person preference, so it survives a reload - the page a person reads their
    // own attendance on should not reset to somebody else's default every morning.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("group", { name: "History view" }).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

    // And back, so the next run starts where this one found it.
    await page.getByRole("group", { name: "History view" }).getByRole("button", { name: "List" }).click();
    await expect(page.getByText(/^Week of /).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the daily-hours strip compares the window with the one before it", async ({ as }) => {
    const page = await as("employee");
    // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
    // (complianceRuleDelete.spec.ts et al.).
    allowConsoleErrors(page, /status of 503/i);
    await gotoRoute(page, "attendance", "Attendance");

    // The comparison is opt-in because it costs a second window of attendance - it is not read until it is
    // asked for, and the control says which window it would be comparing against.
    const compare = page.getByRole("button", { name: /^Compare with / });
    await expect(compare).toBeVisible({ timeout: 30_000 });
    await expect(compare).toHaveAttribute("aria-pressed", "false");
    await compare.click();
    await expect(page.getByRole("button", { name: "Hide comparison" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Hide comparison" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Hide comparison" }).click();
    await expect(page.getByRole("button", { name: /^Compare with / })).toBeVisible();
  });

  test("a manager reads where the team stands today, and how the window went", async ({ as }) => {
    test.setTimeout(180_000);
    // The team panel is for whoever can decide corrections - it is the pre-payroll check that attendance
    // supports what will be paid, so it is not offered to somebody who only has their own days.
    const manager = await as("manager");

    // Somebody with a standing today, brought by this spec rather than borrowed. On a day off nobody is
    // expected in, so "Not in yet" is (correctly) not offered and every remaining group is empty unless a
    // person is actually punched in - which left this reading whichever OTHER spec happened to be clocked in
    // at that instant, and failing on the weekends. The manager is on their own team panel, and no other spec
    // punches for them (clock.spec.ts and clockFence.spec.ts both use the employee). Ignored if it refuses:
    // an open session left by an earlier run is the state this wants anyway.
    await manager.request.post("/v1/attendance/me:clockIn", { headers: SPA_HEADERS });

    await gotoRoute(manager, "attendance", "Attendance");

    await expect(manager.getByText("Team attendance")).toBeVisible({ timeout: 60_000 });

    // Today's standing, as counted groups rather than a list to read: in now, not in yet, wrapped up, on
    // leave. Which groups are offered is data ("not in yet" means nothing on a day off), and each one carries
    // its own count so the panel is readable without opening any of them.
    const groups = manager.getByRole("button", { name: /^(In now|Not in yet|Wrapped up|On leave) \d+$/ });
    await expect(groups.first()).toBeVisible({ timeout: 30_000 });
    expect(await groups.count()).toBeGreaterThan(1);
    // A group with nobody in it is not a view to open - the panel keeps the selection on one that has people,
    // which is why the chip to press is one with a count on it.
    const peopled = manager.getByRole("button", { name: /^(In now|Not in yet|Wrapped up|On leave) [1-9]\d*$/ });
    await expect(peopled.first()).toBeVisible();
    await peopled.last().click();
    await expect(peopled.last()).toHaveAttribute("aria-pressed", "true");

    // The other half of the panel is the same window the history shows, per person - the second button in
    // the switch is named after that window, not "period", because which fortnight it is matters.
    const teamView = manager.getByRole("group", { name: "Team view" });
    await teamView.getByRole("button").nth(1).click();
    await expect(teamView.getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(manager.getByRole("main")).not.toBeEmpty();

    // An ordinary employee is offered none of it: nothing the caller cannot use may render.
    const employee = await as("employee");
    await gotoRoute(employee, "attendance", "Attendance");
    await expect(employee.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();
    await expect(employee.getByText("Team attendance")).toHaveCount(0);

    // Punched back out, so the next spec reads the day this one found.
    await manager.request.post("/v1/attendance/me:clockOut", { headers: SPA_HEADERS });
  });
});
