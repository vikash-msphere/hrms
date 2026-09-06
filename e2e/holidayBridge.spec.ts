import { gotoRoute, purge, test, expect } from "./fixtures";

// A holiday on its own says almost nothing about the break it buys - a Friday holiday is one day off, but the
// weekend sitting right after it turns that into three, and one day of leave on the Thursday before turns
// three into four. `test/holidayBreaks.test.ts` owns the arithmetic (lib/holidayBreaks.ts) that finds the
// cheapest such trade; what only a browser shows is the suggestion actually landing in front of an employee -
// the "3-day break" badge on the holiday itself, and a button that opens the leave form with exactly the day
// the maths picked already filled in, not a blank form somebody has to work the dates out for themselves.
//
// The holiday goes a full year out: the seed's seven fixed dates all sit in one specific year, and this is
// the cheapest way to be certain nothing already on the calendar collides with the date this spec picks.
test("a short holiday break offers the day of leave that would extend it, prefilled into the request", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const name = `E2E Bridge Holiday ${Date.now()}`;
  const friday = nextYearFriday();
  const thursday = addDaysYmd(friday, -1);

  await gotoRoute(hr, "holidays", "Holiday Calendar");
  await hr.getByRole("button", { name: "Add holiday" }).first().click();
  const form = hr.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Date", { exact: true }).fill(friday);
  await form.getByRole("button", { name: "Add holiday", exact: true }).click();
  await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // The default calendar view, not the table - the bridge suggestion is drawn only there, and only for an
    // employee: an admin account with no employee record has no leave to spend on one.
    await gotoRoute(employee, `holidays?year=${friday.slice(0, 4)}`, "Holiday Calendar");
    const card = employee.locator("li").filter({ hasText: name });
    await expect(card).toBeVisible({ timeout: 30_000 });

    // A Friday holiday plus the weekend right after it is three days off - short of a proper break, and
    // exactly the case the badge and the suggestion both exist for.
    await expect(card.getByText("3-day break")).toBeVisible();

    const label = `${weekdayShort(thursday)} ${Number(thursday.slice(8, 10))}`;
    const bridgeBtn = card.getByRole("button", { name: new RegExp(`Take ${label} off`) });
    await expect(bridgeBtn).toBeVisible();
    await expect(bridgeBtn).toBeEnabled(); // disabled only when the balance can't cover it

    await bridgeBtn.click();
    const dialog = employee.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Request leave" })).toBeVisible({ timeout: 30_000 });
    // The one day the arithmetic picked, already in the form - not a blank range for the reader to work out.
    await expect(dialog.getByLabel("Start date")).toHaveValue(thursday);
    await expect(dialog.getByLabel("End date")).toHaveValue(thursday);

    await employee.keyboard.press("Escape");
    const discard = employee.getByRole("dialog");
    const discardBtn = discard.getByRole("button", { name: /Discard|Leave/ });
    if (await discardBtn.count()) await discardBtn.first().click();
  } finally {
    await purge(hr, await holidayPath(hr, name));
  }
});

/** The first Friday of next calendar year - far from anything the seed already puts on the calendar. */
function nextYearFriday(): string {
  const year = new Date().getUTCFullYear() + 1;
  for (let d = 1; d < 15; d++) {
    const day = new Date(Date.UTC(year, 0, d));
    if (day.getUTCDay() === 5) return day.toISOString().slice(0, 10);
  }
  throw new Error("e2e: no Friday found in the first two weeks of next year");
}

function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Matches the page's own `weekdayOf`: a short weekday name, parsed as UTC. */
function weekdayShort(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

async function holidayPath(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.get("/v1/holidays?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
  const row = results.find((h) => (h.name ?? h.display_name) === name);
  if (!row) throw new Error(`e2e: the holiday "${name}" is not on the calendar`);
  return row.path;
}
