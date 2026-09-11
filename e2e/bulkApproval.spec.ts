import { allowConsoleErrors, fileLeave, gotoRoute, test, expect } from "./fixtures";

// Clearing a queue several at a time.
//
// The bulk bar is pure browser state: a selection set that survives scrolling, a bar that appears with it, a
// count that has to agree with what is ticked, one confirmation for the whole batch, and then N decisions
// whose results are merged into a single summary. The server sees only ordinary approve calls - there is
// nothing there to test. A bulk decision is also the most expensive thing in the app to get wrong, because
// it is several people's requests at once.
test("several requests can be decided together, once confirmed", async ({ as }) => {
  const page = await as("super");
  // Two browsers deciding from one shared inbox can collide; the server says 409 and the batch is pressed
  // again below, so the console line that comes with it is expected rather than a failure.
  allowConsoleErrors(page, /status of 409/);
  // Two of its own, so a bulk of two is always available however many runs have cleared the seeded queue.
  const employee = await as("employee");
  const mine = [await fileLeave(employee, `E2E bulk a ${Date.now()}`), await fileLeave(employee, `E2E bulk b ${Date.now()}`)];
  await gotoRoute(page, "approvals");

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve.first()).toBeVisible();
  expect(await approve.count(), "the two requests filed above should be waiting here").toBeGreaterThanOrEqual(2);

  // Tick THIS spec's two, found by the day each was filed on: the queue is shared, so ticking the top two
  // rows is ticking whatever another spec has waiting - which the batch would then decide.
  for (const path of mine) {
    const filed = await page.request.get(`/v1/${path}`);
    expect(filed.ok(), await filed.text()).toBe(true);
    const startDate = ((await filed.json()) as { start_date: string }).start_date;
    const [year, , day] = startDate.split("-");
    // Day, the SPECIFIC month, then year: dates render day-first ("18 Jan 2027" - lib/utils.ts pins the
    // format so the browser and the server agree). A wildcard month here only constrains on day-of-month and
    // year, which the far-future days `fileLeave` hands out do not keep unique from each other ACROSS
    // months - two different fileLeave calls (in this run or a concurrent spec's own) routinely land on the
    // same day-of-month in the same year, and the wildcard would then just as happily match somebody else's
    // request, ticking (or reading back) a row this spec never filed.
    const month = new Date(`${startDate}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
    const row = page.locator("li, div").filter({ hasText: new RegExp(`${Number(day)}\\s+${month}\\s+${year}`) }).filter({ has: approve }).last();
    await expect(row, `nothing waiting for ${path}`).toBeVisible({ timeout: 30_000 });
    await row.getByRole("checkbox", { name: /Select .*'s request/ }).check();
  }

  // The bar appears with the selection and counts it.
  await expect(page.getByText("2 selected")).toBeVisible();

  // One confirmation for the batch, naming the number - a bulk decision must never be a single click either.
  await page.getByRole("button", { name: "Approve selected" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Approve 2 requests?")).toBeVisible();
  await confirm.getByRole("button", { name: "Approve all" }).click();

  // Both leave the queue, and the summary says what happened rather than leaving it to be inferred.
  // The batch is done when the SELECTION is gone - not when the queue reaches a particular size (a number
  // other specs are moving in the same seconds) and not when a toast is on screen (they live five seconds,
  // which a loaded machine can miss; the summary copy is pinned in `undo`).
  await expect(page.getByText("2 selected")).toHaveCount(0, { timeout: 30_000 });

  // And it decided BOTH, which is the whole claim of a bulk decision. Polled: a batch is several writes, and
  // one of them can lose a race with another browser and be retried by the app.
  for (const path of mine) {
    await expect
      .poll(async () => {
        const after = await page.request.get(`/v1/${path}`);
        return after.ok() ? ((await after.json()) as { state?: string }).state : "unreadable";
      }, { timeout: 30_000, message: `${path} after the batch` })
      .toBe("APPROVED");
  }
});
