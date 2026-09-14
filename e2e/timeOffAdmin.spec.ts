import { gotoRoute, inDays, purge, expect, test } from "./fixtures";

// The two smaller time-off surfaces: an exit's notice period, and cashing leave in.
//
// Both are ordinary request/decide flows, and both are pages nothing else in the lane opens. The reason
// they earn a spec is that each has one rule that lives in the form: a notice period is recorded against a
// person and a date (HR's record of an exit, not a request), and an encashment can only be asked for on a
// leave type the org marked encashable AND only up to the days that are actually left - which the form says
// before it is sent.
test.describe("time off admin", () => {
  test("a notice period is recorded against an employee", async ({ as }) => {
    // Longer than the 45s the picker retry below budgets itself: at the default, that retry would be killed
    // mid-flight and reported as the whole test timing out rather than ever using the time it was given.
    test.setTimeout(120_000);
    const page = await as("hr");
    const note = `E2E notice ${Date.now()}`;

    await gotoRoute(page, "notice-periods", "Notice Periods");
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const form = page.getByRole("dialog");

    // Re-typed on a miss, and given room: the picker's search is debounced and answered by a fetch, which on
    // a lane with sixteen browsers on it takes longer than the 5s a bare expect allows - and a keystroke that
    // landed while the list was still mounting is swallowed, leaving nothing to wait for at all.
    const eve = page.getByRole("option", { name: /Eve Employee/ });
    await expect(async () => {
      if (!(await eve.count())) {
        await form.getByLabel("Employee").click({ timeout: 8_000 }).catch(() => undefined);
        await page.getByPlaceholder(/Search|Select/).last().fill("Eve", { timeout: 8_000 });
      }
      await expect(eve).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    await page.keyboard.press("Enter");
    // A notice period is an EXIT: it needs the last working day, and the form refuses to record one
    // without it (and refuses a day before the notice was given).
    const record = form.getByRole("button", { name: "Record", exact: true });
    await expect(record).toBeDisabled();
    // By role: a checkbox further down the form ("start offboarding on their last working day") shares the
    // words, and only one of the two is the date.
    await form.getByRole("textbox", { name: "Last working day" }).fill(inDays(45));
    await form.getByLabel("Notes").fill(note);
    await expect(record).toBeEnabled();
    await record.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const row = page.locator("tbody tr").filter({ hasText: "Eve Employee" }).first();
    await expect(row).toBeVisible();

    await purgeNewest(page, "notice-periods");
  });

  // Encashments are not a page of their own: they are the Leaves page's third tab, because "cash some of
  // this in" is a thing you decide while looking at your balance. HR records and decides them - the seeded
  // policy gives an employee READ on their own and nothing more - so HR is who files one here.
  test("an encashment is recorded against an encashable type, up to the days left", async ({ as }) => {
    const page = await as("hr");
    await gotoRoute(page, "leave-requests", "Leaves");
    await page.getByRole("tab", { name: /^Encashments/ }).click();
    await page.getByRole("button", { name: "New encashment" }).first().click();
    const form = page.getByRole("dialog");

    // The type picker offers only what the org marked encashable, and says so when nothing is.
    await form.getByLabel("Leave type").click();
    const options = page.getByRole("option");
    const count = await options.count();
    if (count === 0) {
      // A perfectly good answer: the org has no encashable types, and the form says that rather than
      // offering an empty picker.
      await expect(form.getByText(/No leave types are marked encashable/)).toBeVisible();
      return;
    }
    await options.first().click();

    // Days: the form prices the ask against the balance rather than letting the server refuse it later.
    await form.getByLabel("Days to encash").fill("1");
    const submit = form.getByRole("button", { name: "Request encashment" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await purgeNewest(page, "leave-encashments");
  });
});


/** Drop the newest row of a collection - the one the test just made. */
async function purgeNewest(page: import("@playwright/test").Page, collection: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (newest) await purge(page, newest.path);
}
