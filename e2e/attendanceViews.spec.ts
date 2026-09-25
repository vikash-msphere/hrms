import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personId, test, expect } from "./fixtures";

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
    // run would pile up in somebody's queue. Closed by its own Cancel button, not Escape: the dialog opens with
    // focus in the "Clock in" time field, whose picker takes the first Escape for itself.
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
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

    // A row in the period table is a summary of somebody's log, and the question it raises - which days? -
    // is answered by opening it. The sheet reads that person's own punches, so the totals in the row and the
    // days in the sheet are the same window.
    const periodRow = manager.locator("tbody tr").filter({ has: manager.getByRole("button", { name: /^Open .+'s attendance$/ }) }).first();
    await expect(periodRow).toBeVisible({ timeout: 30_000 });
    const opener = periodRow.getByRole("button", { name: /^Open .+'s attendance$/ });
    // The person the row is about, taken off the affordance that opens them rather than off a cell: the table
    // is sorted worst-first, so which name leads is data.
    const who = (await opener.getAttribute("aria-label"))!.replace(/^Open /, "").replace(/'s attendance$/, "");
    await opener.click();

    const sheet = manager.getByRole("dialog").filter({ hasText: who });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    // It is the same history component the reader gets for themselves - the view switch and the window pager
    // are the proof it is the log and not another summary.
    await expect(sheet.getByRole("group", { name: "History view" })).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("button", { name: "Previous month" })).toBeVisible();
    // Read-only: an approver reads somebody else's days, they do not file that person's correction. Nothing
    // in here offers to.
    await expect(sheet.getByRole("button", { name: /Correct/ })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: /Request a correction/ })).toHaveCount(0);
    await manager.keyboard.press("Escape");
    await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // An ordinary employee is offered none of it: nothing the caller cannot use may render.
    const employee = await as("employee");
    await gotoRoute(employee, "attendance", "Attendance");
    await expect(employee.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();
    await expect(employee.getByText("Team attendance")).toHaveCount(0);

    // Punched back out, so the next spec reads the day this one found.
    await manager.request.post("/v1/attendance/me:clockOut", { headers: SPA_HEADERS });
  });

  test("an employee's record carries their attendance, read-only", async ({ as }) => {
    test.setTimeout(180_000);
    // HR reads a record. The tab is the collection grant (`attendance.read`), not the approver capability -
    // reading somebody's log is a read. It is a tab on SOMEBODY ELSE's record only: on one's own, the
    // Attendance page is the place, so HR reading a colleague is what this walks.
    const hr = await as("hr");
    // Straight to the record, by id. The directory is reached by clicking a row, and this spec does not care
    // which person it lands on - it cares that their record carries the log, so it names one.
    const subject = await personId(hr, "employee");
    await gotoRoute(hr, `employees/${subject}`);
    await expect(hr.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });

    const tab = hr.getByRole("tab", { name: "Attendance" });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();
    const panel = hr.getByRole("tabpanel");
    await expect(panel.getByRole("group", { name: "History view" })).toBeVisible({ timeout: 30_000 });

    // Deep-linked, so the tab survives a reload and can be sent to somebody - the same contract every other
    // tab on this record has.
    expect(hr.url()).toContain("/attendance");
    await hr.reload();
    await expect(hr.getByRole("tab", { name: "Attendance" })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

    // Read-only here too, for the same reason as the manager's drill-in above.
    await expect(hr.getByRole("tabpanel").getByRole("button", { name: /Request a correction/ })).toHaveCount(0);

    // The hours chart comes with the history, which is why `everyChart.spec.ts` names this spec for this
    // page: its walk arrives on static routes and this one lives behind a tab on a record. So the same two
    // things that walk asserts are asserted here - a picture with real pixels, and the numbers in a table
    // under it for a reader who cannot see it. A window with fewer than two recorded days draws nothing at
    // all, which is allowed; what is not allowed is a figure with one half missing.
    const figure = hr.getByRole("tabpanel").locator("figure").filter({ has: hr.locator("figcaption") }).first();
    await figure.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    if (await figure.count()) {
      const svg = figure.locator("svg").first();
      await expect(svg).toBeAttached({ timeout: 30_000 });
      await expect.poll(async () => {
        const b = await svg.boundingBox();
        return (b?.width ?? 0) > 0 && (b?.height ?? 0) > 0;
      }, { timeout: 10_000 }).toBe(true);
      await expect(figure.locator("table")).toHaveCount(1);
    }

    // And the same two tabs are gone from the reader's OWN record: a person's leave and attendance live on
    // the pages that can act on them, not as a second copy on the profile.
    await gotoRoute(hr, "profile");
    await expect(hr.getByRole("tab", { name: "Profile", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(hr.getByRole("tab", { name: "Attendance" })).toHaveCount(0);
    await expect(hr.getByRole("tab", { name: "Leave" })).toHaveCount(0);
  });

  // HR decides what a day is worth, and the employee is shown the decision without being able to make it.
  //
  // The arithmetic and the payroll wiring are pinned in `test/` (attendanceLop, moneyFlow). What only exists
  // in a browser is the handover between the two people: that the action is on the record at all, that it is
  // a full round trip (set, read back, withdraw) rather than a form that posts into nothing, and that it is
  // offered to exactly one of them.
  test("HR marks what a day counts as, and the employee sees it but cannot set it", async ({ as }) => {
    test.setTimeout(240_000);
    const hr = await as("hr");
    const subject = await personId(hr, "employee");
    await gotoRoute(hr, `employees/${subject}/attendance`);
    await expect(hr.getByRole("tab", { name: "Attendance" })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

    // The month grid is where a day is picked deliberately; the list's own affordance is a hover icon, which
    // is not a thing to hang a spec on.
    const panel = hr.getByRole("tabpanel");
    await panel.getByRole("group", { name: "History view" }).getByRole("button", { name: "Month" }).click();
    await expect(panel.getByText("Click a day for its punches", { exact: false })).toBeVisible({ timeout: 30_000 });

    // Any day the grid drew - which day it is does not matter, only that it is one with a standing. Stepping
    // back a month rather than asserting against whatever today happens to be, the way the bulk-correction
    // read above does.
    const days = panel.getByRole("button", { name: /·/ }).filter({ hasNotText: /Tick|Untick/ });
    let opened = false;
    for (let back = 0; back < 6 && !opened; back++) {
      if (await days.count()) { await days.first().click(); opened = true; break; }
      await panel.getByRole("button", { name: "Previous month" }).click({ timeout: 10_000 });
      await hr.waitForTimeout(800);
    }
    expect(opened, "no month in the last six drew a day to mark").toBe(true);

    const counts = panel.getByRole("button", { name: "Counts as" });
    await expect(counts).toBeVisible({ timeout: 30_000 });
    await counts.click();

    // Three answers, all on screen at once: this changes somebody's pay, so it is not hidden behind a select.
    const form = hr.getByRole("dialog");
    await expect(form.getByRole("heading", { name: /^What does .* count as\?$/ })).toBeVisible({ timeout: 30_000 });
    const group = form.getByRole("radiogroup", { name: "Counts as" });
    await expect(group.getByRole("radio")).toHaveCount(3);
    await group.getByRole("radio", { name: "Half day" }).click();
    await expect(group.getByRole("radio", { name: "Half day" })).toHaveAttribute("aria-checked", "true");
    await form.getByLabel("Reason").fill("E2E: agreed short day");
    // "Mark day" on a fresh day, "Save" on one an interrupted earlier run left marked - this spec withdraws
    // its own mark at the end, but a run killed between the two would otherwise poison every run after it.
    await form.getByRole("button", { name: "Mark day" }).or(form.getByRole("button", { name: "Save", exact: true })).click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });

    // Read back on the day itself, BESIDE what the punches earned rather than instead of it - both facts are
    // what makes a marked day answerable later.
    await expect(panel.getByText("Counted as half day").first()).toBeVisible({ timeout: 30_000 });

    // CHANGED, not just made. The factory mounts a PATCH lane only when the spec supplies a patch mapper, so
    // an editor that offers Save on an existing mark can ship with nothing behind that button - which is
    // exactly what happened, and what nothing in the first version of this spec would have noticed.
    await counts.click();
    await expect(form.getByRole("radio", { name: "Half day" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await form.getByRole("radio", { name: "Full day" }).click();
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });
    await expect(panel.getByText("Counted as full day").first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Counted as half day")).toHaveCount(0);

    const employee = await as("employee");
    // The employee can READ the decision about their own days. Asserted over the API rather than by hunting
    // the marked day in their own grid, because which day HR just marked is whatever the month offered: what
    // this pins is the CAPABILITY, which is the half that was missing - the row grant shipped without the
    // bare list token, so the badge was invisible to the one person the notification is addressed to and
    // nothing 403'd to say so.
    const mine = await employee.request.get("/v1/attendance-day-marks", { headers: SPA_HEADERS });
    expect(mine.status(), "an employee must be able to list marks on their own days").toBe(200);

    // And is offered no way to make one: nothing the caller cannot use may render, and re-valuing your own
    // attendance is the thing this grant exists to keep away from you.
    await gotoRoute(employee, "attendance", "Attendance");
    await expect(employee.getByRole("button", { name: "Counts as" })).toHaveCount(0);
    await expect(employee.getByRole("button", { name: /Set what .* counts as/ })).toHaveCount(0);

    // Withdrawn, so the next run starts where this one found it - and the badge goes with it, which is the
    // assertion that the day really did go back to being judged on its punches.
    await counts.click();
    await form.getByRole("button", { name: "Remove mark" }).click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });
    await expect(panel.getByText(/^Counted as /)).toHaveCount(0, { timeout: 30_000 });
  });
});
