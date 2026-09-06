import { SPA_HEADERS, purge, gotoRoute, test, expect } from "./fixtures";

// "Who's celebrating soon" on somebody's dashboard.
//
// The celebrations feed is a computed answer, not a table: the server walks every active employee, works out
// how many days away the next occurrence of their start date (and, from the encrypted blob, their birthday)
// is, and hands back day+month only. The card then has to turn that into a face, a reason and a when.
// `test/celebrations.test.ts` owns the arithmetic. What nothing else can show is the card: whether a person
// whose anniversary is days away actually appears on it, said in words a reader understands.
//
// The celebrant is made for this spec rather than borrowed from the seed: a joiner whose anniversary lands
// inside the window is a fact this test needs to be true, and moving a seeded person's start date to arrange
// it would change what every other spec is told about them (tenure, probation, accrual).
test("a joiner whose anniversary is days away is on the celebrations card", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now();
  const last = `Celebrant${stamp % 1_000_000}`;

  // Three days from now, two years ago: inside the 30-day window the feed answers for, and far enough past
  // the join day to count as an anniversary at all (the feed skips the joining year).
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const startDate = `${soon.getUTCFullYear() - 2}-${String(soon.getUTCMonth() + 1).padStart(2, "0")}-${String(soon.getUTCDate()).padStart(2, "0")}`;

  const created = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: {
      first_name: "E2E",
      last_name: last,
      work_email: `e2e.celebrant.${stamp}@example.com`,
      job_title: "E2E Tester",
      start_date: startDate,
      // No `status`: it is not on the wire at all (the record ships active, and leaving is the :exit lane's
      // business), and the write schema is strict - so sending it fails the whole create.
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "dashboard");
    // The card by its own anchor, which is what the celebrations metric drills through to - so this is the
    // element the app itself calls the celebrations card, not "some list with a name in it". The dashboard
    // mounts its lower widgets on view, so it has to be scrolled to rather than waited for.
    const card = page.locator("#dash-celebrations");
    for (let nudge = 0; nudge < 12 && !(await card.isVisible()); nudge++) {
      await page.mouse.wheel(0, 1_500);
      await page.waitForTimeout(250);
    }
    await expect(card).toBeVisible({ timeout: 60_000 });

    // The row for this person: the card's rows carry a face, the name and the reason, and it is the reason
    // that has to be right - a name on a list says nothing about why it is being celebrated, and the years
    // are counted for the UPCOMING occurrence rather than today.
    const row = card.locator("div.flex.items-center.gap-3").filter({ hasText: `E2E ${last}` }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveText(/2-year anniversary/);
  } finally {
    await purge(page, path);
  }
});
