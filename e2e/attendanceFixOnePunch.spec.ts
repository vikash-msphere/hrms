import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Fixing one punch of a day's log, from the punch itself.
//
// Most corrections are one time: "my 11:02 clock-in should be 9:00", "I never clocked out". Each time in a
// day's punch log is its own button that opens a request about that punch alone - the other punches stay as
// recorded without the person having to look at them - and the request then reads as that one change
// ("Clock-in … → …") wherever it is listed, the approver's queue included.
//
// `test/attendanceRegularizationFlow.test.ts` owns what approval does to the day, and `test/correctionDiff`
// how a change is described. What only a browser shows is the time being the way in, the neighbouring punch
// bounding it, and the untouched punch going up unchanged.
//
// As the payroll login: nobody else's spec clocks this person, so the punch made here is the only one on its
// day that anything reads. The request is withdrawn at the end, so the day itself is never rewritten.
test("an employee fixes one clock-in from the punch log, and the rest of the day goes up unchanged", async ({ as }) => {
  const page = await as("payroll");
  const reason = `E2E one punch ${Date.now() % 1_000_000}`;

  // A punch to fix: in and straight back out.
  const punchIn = await page.request.post("/v1/attendance/me:clockIn", { headers: SPA_HEADERS });
  expect(punchIn.status(), await punchIn.text()).toBe(200);
  const punchOut = await page.request.post("/v1/attendance/me:clockOut", { headers: SPA_HEADERS });
  expect(punchOut.status(), await punchOut.text()).toBe(200);
  const recordedOut = ((await punchOut.json()) as { clock_out: string }).clock_out;

  await gotoRoute(page, "attendance", "Attendance");
  // The history is newest first, so the first day is today's.
  await page.getByRole("button", { name: /^Expand \d{4}-\d{2}-\d{2}$/ }).first().click();
  await page.getByRole("button", { name: /^Fix clock-in / }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Fix clock-in/ })).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Submit request" });
  // Nothing to file until the time actually changes.
  await expect(submit).toBeDisabled();

  // The punch it runs into is named: a clock-in can't move past its own clock-out.
  const time = dialog.getByLabel("Should be", { exact: true });
  await time.fill("23:59");
  await expect(dialog.getByText(/^Must be before your .+ clock-out$/)).toBeVisible();
  await expect(submit).toBeDisabled();

  // Midnight is never later than now and never after the clock-out.
  await time.fill("00:00");
  await expect(dialog.getByText(/clock-out$/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Forgot to clock in" }).click();
  await expect(dialog.getByLabel("Reason")).toHaveValue("Forgot to clock in");
  await dialog.getByLabel("Reason").fill(reason);
  await submit.click();
  await expect(toast(page, /Correction requested/)).toBeVisible();

  // Filed as the whole day with only that clock-in moved: the clock-out is the recorded one, to the minute.
  const res = await page.request.get("/v1/attendance-regularizations?page_size=200");
  expect(res.ok(), await res.text()).toBe(true);
  type Reg = { path: string; reason?: string; sessions: { clock_in: string; clock_out?: string }[]; recorded_sessions?: { clock_in: string; clock_out?: string }[] };
  const { results = [] } = (await res.json()) as { results?: Reg[] };
  const filed = results.find((r) => r.reason === reason);
  expect(filed, `the correction "${reason}" was not filed`).toBeTruthy();
  const minute = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 60000) : undefined);
  const first = filed!.sessions[0]!;
  expect(minute(first.clock_out)).toBe(minute(recordedOut));
  expect(filed!.recorded_sessions?.length).toBe(filed!.sessions.length);

  // ...and it is listed as the change it makes, not as a new day.
  // (`\s`, because Intl may put a narrow no-break space before the day period.)
  await expect(page.getByText(new RegExp(`Clock-in .+ → 12:00\\s?AM.* · ${reason}`, "i"))).toBeVisible();

  await page.request.post(`/v1/${filed!.path}:cancel`, { headers: SPA_HEADERS });
});
