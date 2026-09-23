import { gotoRoute, inDays, purge, toast, expect, test } from "./fixtures";

// A repeating event, and the dates it promises before the cron ever runs.
//
// The cron that actually creates the next occurrence runs hours later (src/services/events.ts,
// `nextOccurrence`), so the form's own preview - "Then 28 Aug · 4 Sep · 11 Sep" - is the only chance anyone has
// to catch a wrong repeat before it is saved. `test/eventRepeatDrift.test.ts` pins the stepping
// (lib/eventRepeat.ts) against the server's copy; this is the one place the preview itself is read.
test("a repeat previews its next dates, changes them when the cadence changes, and survives a reload", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const title = `E2E repeating event ${Date.now()}`;
  const start = inDays(14);

  await gotoRoute(page, "events", "Events");
  await page.getByRole("button", { name: "New event" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Start date").fill(start);

  // No preview until a cadence is chosen - a one-off event has nothing to preview.
  await expect(form.getByText(/^Then /)).toHaveCount(0);

  await form.getByLabel("Repeats").click();
  await page.getByRole("option", { name: "Weekly" }).click();
  const weekly = await previewDates(form);
  expect(weekly.length, "three occurrences previewed").toBe(3);
  expect(daySteps(weekly), "a weekly repeat steps in days, so the weekday sticks").toEqual([7, 7]);

  // Switching cadence recomputes the preview live, off the same start date.
  await form.getByLabel("Repeats").click();
  await page.getByRole("option", { name: "Monthly" }).click();
  const monthly = await previewDates(form);
  expect(monthly.length).toBe(3);
  expect(monthDaySteps(monthly), "a monthly repeat steps the calendar field, so the date-of-month sticks").toEqual([1, 1]);
  // The weekly preview's first date is 7 days out; the monthly one is roughly a month - a different schedule
  // shown for the same start date proves the preview reacts to the select rather than to the form opening.
  expect(monthly[0]!.getTime()).not.toBe(weekly[0]!.getTime());

  await form.getByRole("button", { name: "Create event" }).click();
  await expect(toast(page, "Event created")).toBeVisible();

  // Reopening the saved event reads the cadence back off the select, and the preview is there again -
  // proof the choice round-tripped through the server rather than only living in the form's local state.
  const row = page.locator("tbody tr").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByRole("heading", { name: "Edit event" })).toBeVisible();
  await expect(edit.getByLabel("Repeats")).toHaveText("Monthly");
  await expect(edit.getByText(/^Then /)).toBeVisible();

  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  await purge(page, await eventPath(page, title));
});

/** The dates printed after "Then ", in order - the preview line reads "Then 28 Aug 2026 · 4 Sep 2026 · …". */
async function previewDates(scope: import("@playwright/test").Locator): Promise<Date[]> {
  const text = await scope.getByText(/^Then /).innerText();
  const dates = text
    .replace(/^Then\s*/, "")
    .split("·")
    .map((d) => new Date(d.trim()))
    .filter((d) => !Number.isNaN(+d));
  expect(dates.length, `could not read dates out of "${text}"`).toBeGreaterThan(0);
  return dates;
}

/** Whole days between each printed date and the next. */
function daySteps(dates: Date[]): number[] {
  return dates.slice(1).map((d, i) => Math.round((+d - +dates[i]!) / 86_400_000));
}

/** Months between each printed date and the next, by calendar field rather than elapsed days. */
function monthDaySteps(dates: Date[]): number[] {
  return dates.slice(1).map((d, i) => {
    const prev = dates[i]!;
    return (d.getFullYear() - prev.getFullYear()) * 12 + (d.getMonth() - prev.getMonth());
  });
}

async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/events?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((e) => (e.title ?? e.display_name) === title);
  if (!row) throw new Error(`e2e: the event "${title}" is not in the collection`);
  return row.path;
}
