import { fileLeave, gotoRoute, test, expect } from "./fixtures";

// Who is away, drawn on a month.
//
// The leave calendar is a rendering, so nothing outside a browser can check it: an approved absence has to
// appear on the days it covers, the month has to move without losing the view, the person filter has to
// narrow it to one name, and the whole thing has to leave as an `.ics` for the calendar people actually
// live in. `test/leave.test.ts` owns what the rows mean.
test("an approved absence is drawn on the calendar, filtered, and exported", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const hr = await as("hr");

  // An absence to draw: filed by the employee and approved, since only decided leave belongs on a calendar
  // everyone reads.
  const reason = `E2E calendar ${Date.now()}`;
  const leave = await fileLeave(employee, reason);
  const approved = await hr.request.post(`/v1/${leave}:approve`, { headers: { "X-Requested-By": "hrms-spa" } });
  expect(approved.status(), await approved.text()).toBe(200);

  // Opened ON the day the leave falls: the calendar takes the date in its URL, which is how a link from a
  // holiday, a request or a notification lands somebody on the right month rather than on this one.
  const day = await leaveStart(hr, leave);
  await gotoRoute(hr, `leave-calendar?d=${day}`, "Leave calendar");
  await expect(hr.getByText("Eve Employee").first()).toBeVisible();

  // The person filter: one name out of a hundred, which is how a manager reads a team calendar.
  const filter = hr.getByLabel("Filter the calendar by person");
  await expect(filter).toBeVisible();
  await filter.fill("Eve");
  await expect(hr.getByText("Eve Employee").first()).toBeVisible();

  // It leaves as a real calendar file, built in the browser - and only while there is something to export,
  // which is why this happens on the month the leave is in.
  const [download] = await Promise.all([
    hr.waitForEvent("download"),
    hr.getByRole("button", { name: "Download as calendar file" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.ics$/);
  const path = await download.path();
  if (!path) throw new Error("the export produced no file");
  const { readFile } = await import("node:fs/promises");
  const ics = (await readFile(path)).toString("utf8");
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("BEGIN:VEVENT");

  // The month moves, and one press comes back to today - a calendar you can get lost in is a calendar
  // people stop using. An empty month also disables the export, which is the honest state for it.
  await hr.getByRole("button", { name: "Next month" }).click();
  await hr.getByRole("button", { name: "Today", exact: true }).click();
  // `exact`: the page also carries a print-only "Leave · <month>" caption, which is hidden on screen.
  const thisMonth = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  await expect(hr.getByText(thisMonth, { exact: true })).toBeVisible();

  // Cancelled, not purged: a filed request is never deleted (services/leaveRequests.ts - the three decisions
  // consume or release the balance a create reserved), so `purge` could only ever be a 403 here, and the
  // absence stayed on that day of the calendar for every later run. The person who filed it may cancel it.
  await employee.request.post(`/v1/${leave}:cancel`, { headers: { "X-Requested-By": "hrms-spa" } });
});

/** The first day the leave covers - the month the calendar has to be looking at. */
async function leaveStart(page: import("@playwright/test").Page, path: string): Promise<string> {
  const res = await page.request.get(`/v1/${path}`);
  expect(res.status(), await res.text()).toBe(200);
  const { start_date } = (await res.json()) as { start_date: string };
  return start_date;
}
