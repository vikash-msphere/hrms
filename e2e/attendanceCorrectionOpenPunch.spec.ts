import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Adding this morning's missed clock-in while still at work.
//
// The punch people miss is the morning one, and they notice it mid-day: they know when they came in and cannot
// know when they will leave. So on a day with nothing punched yet, the fix next to the clock adds a clock-in and
// may leave the clock-out blank, which files a request with no `clock_out` on that session ("still clocked
// in").
//
// `test/attendanceRegularizationFlow.test.ts` owns what approving such a request does to the day's punches.
// What only a browser shows is that the form accepts a clock-in alone for today, says so, and files it that
// way. As the project-manager login: no spec clocks this person, so today has no punches and the link opens
// the add rather than the fix of an existing clock-in. The request is withdrawn at the end, so the day is
// never rewritten.
test("an employee still at work adds the clock-in they missed this morning", async ({ as }) => {
  const page = await as("pm");
  const reason = `E2E morning punch ${Date.now() % 1_000_000}`;
  await gotoRoute(page, "attendance", "Attendance");

  await page.getByRole("button", { name: "Missed or wrong punch?" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Add missing clock-in/ })).toBeVisible();
  await expect(dialog.getByText(/Leave the clock-out blank/)).toBeVisible();

  // In at midnight, which is never later than now, and no clock-out.
  await dialog.getByLabel("Clock in", { exact: true }).fill("00:00");

  // A blank clock-out on today's in/out is a running session, not a missing time.
  await expect(dialog.getByText("Still clocked in - clock out as usual.")).toBeVisible();
  await expect(dialog.getByText("Add the clock-out time")).toHaveCount(0);

  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: "Submit request" }).click();
  await expect(toast(page, /Correction requested/)).toBeVisible();

  // Filed with the session left open, and listed that way in the requester's own history.
  const res = await page.request.get("/v1/attendance-regularizations?page_size=200");
  expect(res.ok(), await res.text()).toBe(true);
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string; sessions: { clock_in: string; clock_out?: string }[] }[] };
  const filed = results.find((r) => r.reason === reason);
  expect(filed, `the correction "${reason}" was not filed`).toBeTruthy();
  expect(filed!.sessions).toHaveLength(1);
  expect(filed!.sessions[0]!.clock_out).toBeUndefined();
  await expect(page.getByText(new RegExp(`still clocked in · ${reason}`))).toBeVisible();

  await page.request.post(`/v1/${filed!.path}:cancel`, { headers: SPA_HEADERS });
});
