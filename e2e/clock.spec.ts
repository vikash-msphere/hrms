import { SPA_HEADERS, gotoRoute, makeThrowawayPerson, retireThrowawayPerson, test, expect, toast } from "./fixtures";

// One clock, wherever you look at it.
//
// Clocking in is offered in three places at once - the top bar button, the dashboard's "my day" card, and the
// Attendance page - and they are deliberately ONE piece of state (web/src/lib/clock.tsx) rather than three
// components each asking the server. The failure that shape exists to prevent is precisely a cross-component
// one: punch in from the top bar and have the dashboard still say "Not clocked in" until a reload. Only a
// browser can look at two surfaces at the same moment.
test("clocking in from the top bar is immediately true everywhere else", async ({ as }) => {
  const page = await as("employee");
  await gotoRoute(page, "dashboard");

  // Scoped to the header: the dashboard card offers the same action with the same name, and telling them
  // apart is the whole point of this test.
  const bar = page.getByRole("banner");
  const card = page.getByRole("main");
  await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
  await expect(card.getByText("Not clocked in")).toBeVisible();

  await bar.getByRole("button", { name: /^Clock in$/ }).click();
  await expect(toast(page, "Clocked in")).toBeVisible();

  // Both surfaces, with no reload and no second read of the server.
  await expect(bar.getByRole("button", { name: /^Clock out/ })).toBeVisible();
  await expect(card.getByText("Clocked in", { exact: true })).toBeVisible();
  await expect(card.getByText("Not clocked in")).toHaveCount(0);

  // And the Attendance page, arrived at while on the clock, starts from the same state rather than its own.
  await gotoRoute(page, "attendance", "Attendance");
  await expect(bar.getByRole("button", { name: /^Clock out/ })).toBeVisible();

  // Clock out again, so a rerun starts where this one did.
  await bar.getByRole("button", { name: /^Clock out/ }).click();
  await expect(toast(page, "Clocked out")).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
});

// On the clock, the top bar shows the DAY's total - what was worked earlier today plus this session, the break
// between them left out - not just how long this session has run (TopBar.tsx OnTheClock, lib/clock.tsx
// `workedToday`). Two hours worked earlier today (filed as a correction and approved, the way a past session
// gets onto the record), then a fresh clock-in: the chip reads two hours, where this session alone is none.
test("on the clock, the top bar shows everything worked today, not just this session", async ({ as }) => {
  test.setTimeout(120_000);
  const admin = await as("super");
  // Today as the org counts it, which is what the chip totals.
  const attendance = (await (await admin.request.get("/v1/settings/attendance", { headers: SPA_HEADERS })).json()) as { value?: { timezone?: string } };
  const tz = attendance.value?.timezone ?? "UTC";
  const dayOf = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const start = new Date(Date.now() - 130 * 60_000);
  const end = new Date(Date.now() - 10 * 60_000);
  test.skip(dayOf(start) !== dayOf(new Date()), "the two earlier hours would fall before the org's midnight");

  // A login of its own: punching one of the seeded five would race the test above on the same person.
  const person = await makeThrowawayPerson(admin, "DayTotal");
  try {
    const page = await as({ email: person.email });
    const filed = await page.request.post("/v1/attendance-regularizations", {
      headers: SPA_HEADERS,
      data: { date: dayOf(new Date()), sessions: [{ clock_in: start.toISOString(), clock_out: end.toISOString() }], reason: "E2E earlier today" },
    });
    expect(filed.status(), await filed.text()).toBe(200);
    const approved = await admin.request.post(`/v1/${((await filed.json()) as { path: string }).path}:approve`, { headers: SPA_HEADERS });
    expect(approved.status(), await approved.text()).toBe(200);

    await gotoRoute(page, "dashboard");
    const bar = page.getByRole("banner");
    await bar.getByRole("button", { name: /^Clock in$/ }).click();
    const clockOut = bar.getByRole("button", { name: /^Clock out/ });
    await expect(clockOut).toHaveAccessibleName("Clock out (worked 2h 0m today)", { timeout: 30_000 });
    await expect(bar.getByText("2h 0m", { exact: true })).toBeVisible();

    await clockOut.click();
    await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
  } finally {
    await retireThrowawayPerson(admin, person.path);
  }
});
