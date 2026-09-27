import { apiPost, gotoRoute, patchSettings, personId, purge, test, expect, toast } from "./fixtures";

// SCHEDULES: the repeating week somebody works, and the thing that makes a part-time or rotating roster
// expressible at all.
//
// The two halves are tested together because neither means anything alone: the editor draws a cycle of shifts
// and rest days, and the roster is where that cycle becomes somebody's actual days. What this proves is the
// join - that a schedule assigned to a person is what the grid then says about their week, including the days
// the org works and they do not.
//
// `work-patterns` and `work-pattern-assignments` are org-wide catalogs, so this spec owns its rows by name
// (`E2E Sched …`) and clears them at both ends - a run that died mid-way would otherwise leave a person on a
// schedule and send the next run down a different branch.
test("a part-time schedule is defined, assigned from the roster, and decides that person's days", async ({ as }) => {
  const page = await as("hr");
  // The sweep runs as super: it is a forced purge, and `?force` needs admin on the collection, which HR does
  // not hold - as HR every purge answered 403 and a failed attempt's schedule was still on the page for the
  // retry, reading "3 working days" twice.
  const admin = await as("super");
  await purgeAll(admin);
  // THE GATE. A roster entry and a work pattern decide nothing until the org says days are resolved per
  // person (`settings/attendance.schedule_source`), and both the grid and the payroll build read it - so a
  // spec that skipped it would be testing a screen the server disagrees with. Restored at the end.
  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "resolved" }));

  const stamp = Date.now() % 100000;
  const shiftName = `E2E Sched Shift ${stamp}`;
  const patternName = `E2E Sched MWF ${stamp}`;

  // ---- A four-hour morning shift -------------------------------------------------------------------------
  // Four hours is the case the org-wide full day could not describe: against a 480-minute bar every day of it
  // reads as under hours. Left blank, the shift's own span is its full day - which is what the editor's
  // placeholder says before anything is typed.
  await gotoRoute(page, "settings/shifts");
  // `.first()`: with an empty catalog the page offers the same action twice - the header button and the empty
  // state's - so which of them exists depends on what other specs have left behind. The header one is always
  // there, and it is the first in the document.
  await page.getByRole("button", { name: "New shift" }).first().click();
  const shiftDialog = page.getByRole("dialog");
  await shiftDialog.getByLabel("Name").fill(shiftName);
  await shiftDialog.getByLabel("Start").fill("09:00");
  await shiftDialog.getByLabel("End").fill("13:00");
  // The derived full day is the span less the break: 240 minutes, offered rather than stored.
  await expect(shiftDialog.getByLabel("Counts as a full day at")).toHaveAttribute("placeholder", "240");
  await expect(shiftDialog.getByLabel("Half a day at")).toHaveAttribute("placeholder", "120");
  await shiftDialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, /Shift added/)).toBeVisible();

  // ---- A Mon/Wed/Fri schedule built from it --------------------------------------------------------------
  await gotoRoute(page, "settings/work-patterns");
  await page.getByRole("button", { name: "New schedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(patternName);
  // The brush decides which shift a clicked day gets; the preset decides which days are worked.
  await dialog.getByLabel("Shift to place").click();
  // `force`, because the option is a MOVING TARGET while it is being clicked: the popover animates in and the
  // list re-renders as the shift catalogue refetches behind it, so Playwright's stability wait can time out on
  // an element it has already resolved correctly. Dispatching on the resolved option is exact - it is matched
  // by name, so force cannot land it on a different shift.
  const brush = page.getByRole("option", { name: new RegExp(shiftName) });
  await expect(brush).toBeVisible();
  await brush.click({ force: true });
  await dialog.getByRole("button", { name: "Mon/Wed/Fri" }).click();

  // Three working days, and the four in between are rest days - which is the whole claim the schedule makes.
  await expect(dialog.getByRole("button", { name: `Week 1 Mon, ${shiftName}` })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Week 1 Tue, rest day" })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByRole("button", { name: `Week 1 Wed, ${shiftName}` })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Week 1 Thu, rest day" })).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, /Schedule added/)).toBeVisible();

  // It reads back as the week it is, so a name is never the only thing telling two schedules apart. Read off
  // this schedule's own card once the dialog has gone: the closing dialog says "3 working days per week" too.
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const card = page.locator("div").filter({ has: page.getByText(patternName, { exact: true }) }).last();
  await expect(card.getByText("3 working days", { exact: true })).toBeVisible();

  // ---- Assigned to somebody, from the roster --------------------------------------------------------------
  await gotoRoute(page, "schedule", "Schedule");
  // Whose week this is about. Taken off the grid rather than assumed, so the assertions below name the row the
  // assignment actually landed on.
  const anyCell = page.getByRole("button", { name: /, (no shift|not working)$/ }).first();
  await expect(anyCell).toBeVisible();
  const person = ((await anyCell.getAttribute("aria-label")) ?? "").split(",")[0]!;

  await page.getByRole("button", { name: "Assign a schedule" }).click();
  const assign = page.getByRole("dialog");
  await assign.getByRole("radio", { name: new RegExp(patternName) }).click();
  await assign.getByPlaceholder("Search people").fill(person);
  // By NAME, not `.first()`: the end-date toggle is a checkbox in this dialog too, and it comes first.
  await assign.getByRole("checkbox", { name: person }).check();
  await assign.getByRole("button", { name: /^Assign/ }).click();
  await expect(toast(page, /Schedule assigned|people scheduled/)).toBeVisible();

  // ---- What the grid now says about that person -------------------------------------------------------------
  // The cells they were never rostered on are drawn from the SCHEDULE, which is the difference between an
  // empty roster and a person who has one: the shift shows on their working days, and the days between read
  // as not working rather than as unfilled.
  const worked = page.getByRole("button", { name: new RegExp(`^${escapeRe(person)}, .*, ${escapeRe(shiftName)} from their schedule$`) });
  await expect(worked.first()).toBeVisible();
  const rest = page.getByRole("button", { name: new RegExp(`^${escapeRe(person)}, .*, not working$`) });
  await expect(rest.first()).toBeVisible();

  // And it survives a reload, so it is a row rather than a rendering.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(worked.first()).toBeVisible();

  // ---- A roster entry still beats the schedule ---------------------------------------------------------------
  // The most specific layer: cover on a rest day is the edit a scheduler actually makes, and it has to win
  // over the pattern rather than being refused by it.
  await rest.first().click();
  const cellDialog = page.getByRole("dialog");
  await cellDialog.getByRole("radio", { name: new RegExp(shiftName) }).click();
  await cellDialog.getByRole("button", { name: /^Assign/ }).click();
  await expect(toast(page, /Shift assigned|days scheduled/)).toBeVisible();
  // Rostered, so it is drawn solid rather than "from their schedule".
  await expect(page.getByRole("button", { name: new RegExp(`^${escapeRe(person)}, .*, ${escapeRe(shiftName)}$`) }).first()).toBeVisible();

  await purgeAll(admin);
  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "org" }));
});

// THE GRID HAS TO AGREE WITH THE PAYROLL BUILD, which is the whole reason the schedule is resolved in the
// browser at all. Payroll stops docking a part-timer's rest days the moment they are on a schedule; an
// Attendance page still drawing those days as absences tells them they missed work nobody asked them for -
// the drift `web/src/lib/attendance.ts` imports the server's own rules to prevent.
test("the attendance grid stops calling a schedule's rest days absences", async ({ as }) => {
  const page = await as("hr");
  // As super, for the reason the test above gives: the sweep is a FORCED purge and `?force` needs admin on
  // the collection. As HR every purge answers 403 and the sweep leaves the rows it was meant to clear.
  const admin = await as("super");
  await purgeAll(admin);
  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "resolved" }));

  const stamp = Date.now() % 100000;
  const me = await personId(page, "hr");

  // A Monday-only schedule, built through the API: this test is about the GRID, and the editor that draws a
  // cycle is covered by the test above.
  const shift = await apiPost(page, "/v1/shifts", { name: `E2E Sched Shift ${stamp}`, start: "09:00", end: "13:00", break_minutes: 0 });
  const shiftPath = ((await shift.json()) as { path: string }).path;
  const days = [null, shiftPath, null, null, null, null, null]; // stored weekday 0=Sun, so index 1 is Monday
  const pattern = await apiPost(page, "/v1/work-patterns", { name: `E2E Sched MonOnly ${stamp}`, cycle_weeks: 1, days });
  const patternPath = ((await pattern.json()) as { path: string }).path;
  // Backdated, so the window the page opens on is inside the assignment and holds days that have passed -
  // a future day is never an absence, so a forward-dated schedule would prove nothing.
  const from = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  await apiPost(page, "/v1/work-pattern-assignments", { employee: `employees/${me}`, pattern: patternPath, start_date: from });

  // DIFFERENTIAL, because "no absences" on its own is a claim the page can satisfy by having nothing to show.
  // The absences are counted on the SAME window with the resolver off and then on: what the schedule is worth
  // is the days that stop being absences, and a test that only looked at the second number would pass just as
  // happily against a grid that had never heard of schedules.
  // "Absent" is the status pill's own label (STATUS_UI in web/src/lib/attendance.ts) - the word the employee
  // actually reads.
  const absences = page.getByRole("main").getByText("Absent", { exact: true });

  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "org" }));
  await gotoRoute(page, "attendance", "Attendance");
  await expect(absences.first()).toBeVisible(); // the org's week owes Tue-Fri, and none of them was worked
  const before = await absences.count();

  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "resolved" }));
  await gotoRoute(page, "attendance", "Attendance");
  await expect(absences).toHaveCount(0); // on a Monday-only schedule none of those days was ever owed
  expect(before).toBeGreaterThan(0);

  await purgeAll(admin);
  await patchSettings(page, "attendance", (v) => ({ ...v, schedule_source: "org" }));
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Drop every row this spec creates, in dependency order: assignments, then the catalogs they point at.
 *
 * Only assignments that point at THIS spec's shifts and schedules. `schedule` and `scheduleSpread` roster
 * people at the same time, and a sweep of every assignment in the org - which is what this was, harmlessly,
 * while HR's forced purges were all refused - would delete theirs mid-run.
 */
async function purgeAll(page: import("@playwright/test").Page) {
  const ours = async (collection: string, prefix: string) => {
    const res = await page.request.get(`/v1/${collection}?max_page_size=100`);
    if (!res.ok()) return [];
    const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
    return results.filter((x) => (x.name ?? "").startsWith(prefix)).map((x) => x.path);
  };
  const patterns = await ours("work-patterns", "E2E Sched");
  const shifts = await ours("shifts", "E2E Sched Shift");
  for (const [collection, field, targets] of [["work-pattern-assignments", "pattern", patterns], ["shift-assignments", "shift", shifts]] as const) {
    if (!targets.length) continue;
    const res = await page.request.get(`/v1/${collection}?max_page_size=100`);
    if (!res.ok()) continue;
    const { results = [] } = (await res.json()) as { results?: ({ path: string } & Record<string, unknown>)[] };
    for (const r of results.filter((x) => targets.includes(String(x[field] ?? "")))) await purge(page, r.path);
  }
  for (const path of [...patterns, ...shifts]) await purge(page, path);
}
