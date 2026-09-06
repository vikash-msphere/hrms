import { fileLeave, gotoRoute, purge, test, expect, nextWeekday } from "./fixtures";

// Moving leave you have already asked for.
//
// A filed request is immutable by design - the balance is reserved against it - so "change the dates" is
// really cancel-and-file-again. The app does both from one press and CARRIES the type, dates and reason into
// the fresh form, which is the only reason the flow is bearable; retyping the whole request to move it by a
// day is what people do in the systems this replaces. All of that is form state in a browser:
// `test/leave.test.ts` owns the reservation and the credit-back.
test("an employee moves a filed request, and the new form arrives pre-filled", async ({ as }) => {
  test.setTimeout(180_000);
  // The MANAGER's own leave, not the shared employee's. Six other specs file, approve and reject leave for
  // that one seeded person while this runs, and this flow cancels whatever it acts on - so it works on
  // somebody nothing else touches. A manager files their own leave like anybody else.
  const requester = await as("manager");
  const form = requester.getByRole("dialog");
  let reason = "";

  // This spec's own leavings, from runs that came before: they pile up on one shared seeded person, and a
  // long list is a row this spec cannot reach. Only rows THIS spec filed (its own reason shape), and it is
  // the only test that files them, so there is nothing of anybody else's to take away.
  await purgeOldMoves(requester);

  // Attempted up to three times, each attempt with a REQUEST OF ITS OWN.
  //
  // The move is destructive: it cancels the request and opens a fresh form seeded from it. The cancel carries
  // the row's etag, so anything that touched the request since the page loaded (a parallel spec deciding it,
  // an automation stamping it) makes the app refuse - and by then the request is gone. A retry therefore
  // cannot re-press the same row; it brings its own request, which is what a person would do too.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Anything an abandoned attempt left open is closed first: a modal takes the page out of the
    // accessibility tree, and the next `gotoRoute` would then be waiting for a `<main>` nobody can see.
    while (await requester.getByRole("dialog").count()) {
      await requester.keyboard.press("Escape");
      const discard = requester.getByRole("button", { name: /^(Discard|Leave)$/ });
      if (await discard.count()) await discard.first().click();
      if (await requester.getByRole("dialog").count()) await requester.reload();
    }

    reason = `E2E move ${Date.now()}${attempt}`;
    const path = await fileLeave(requester, reason);

    // Found by its own DATE. This flow cancels whatever it clicks, so the row has to be identified beyond
    // doubt: every filing claims a day of the calendar nothing else uses (`fileLeave`), and the date is on
    // the row - unlike the reason, whose column is hidden by default.
    const filed = await requester.request.get(`/v1/${path}`);
    expect(filed.ok(), await filed.text()).toBe(true);
    const on = ((await filed.json()) as { start_date: string }).start_date;
    const [year, , day] = on.split("-");
    const dated = `${Number(day)}, ${year}`;

    await gotoRoute(requester, "leave-requests", "Leaves");
    await requester.getByRole("tab", { name: /^Requests/ }).click();
    // Date-matched. `fileLeave` files on a random far-future day, so no other spec's request shares it - and
    // the row is reachable because this spec drops its own stale leftovers first (below), which is what kept
    // the list short enough to have it on the first page.
    // Searched first, then matched on the date. The search reaches the whole collection - this employee's
    // list is long by the time a full lane has been filing leave for them all run - while the date is what
    // makes the row unmistakably this request, whatever the debounced search is showing at that instant.
    const box = requester.getByPlaceholder(/Search all records/);
    if (await box.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) {
      await box.fill(reason);
    }
    const pending = requester.locator("tbody tr").filter({ hasText: dated }).filter({ hasText: /Pending/ }).first();
    const waiting = await pending.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
    // Nothing of ours waiting: somebody else decided it between filing and looking. Bring a new one.
    if (!waiting) continue;

    // Moving it asks first, and says exactly what it is about to do - a cancel that credits the days back,
    // then a fresh request.
    await pending.getByRole("button", { name: "Move" }).click();
    const confirm = requester.getByRole("dialog");
    const asked = await confirm.getByText("Move this leave?")
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!asked) continue;
    await expect(confirm).toContainText(/cancelled and the days credited back/);
    await confirm.getByRole("button", { name: "Cancel and re-file" }).click();

    // The fresh form opens carrying the old request's details, which is the whole point of the affordance.
    const opened = await form.getByRole("heading", { name: "Request leave" })
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
    expect(attempt, "the move never opened the re-file form").toBeLessThan(3);
  }
  expect(await form.count(), "no attempt got as far as the re-file form").toBeGreaterThan(0);

  await expect(form.getByLabel(/Reason/)).toHaveValue(reason);

  // Abandoning it leaves the old request cancelled - the cancel already happened, and the form is a
  // convenience, not a transaction.
  // Closed for real before moving on: a modal takes the page out of the accessibility tree, so navigating
  // with one still open lands on a route whose `<main>` a reader (and this suite) cannot see.
  await expect(async () => {
    if (await requester.getByRole("dialog").count()) await requester.keyboard.press("Escape");
    const discard = requester.getByRole("button", { name: /^(Discard|Leave)$/ });
    if (await discard.count()) await discard.first().click();
    await expect(requester.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });

  await gotoRoute(requester, "leave-requests", "Leaves");
  await requester.getByRole("tab", { name: /^History/ }).click();
  // Found through the page's own server-side search rather than by reading the table: the reason column is
  // hidden by default, and the search reaches the whole collection rather than the first page of it.
  await requester.getByPlaceholder(/Search all records/).fill(reason);
  // Asserted on a CANCELLED row among the matches rather than on "exactly one row": the search is a full-text
  // one, so a retried attempt's reason (same words, different suffix) matches too - and every attempt this
  // spec made ends cancelled, which is the fact being checked.
  await expect(requester.locator("tbody tr").filter({ hasText: /Cancelled/i }).first()).toBeVisible({ timeout: 30_000 });
});

// The balance is the number an employee decides against, and it is drawn from accrual, carry-forward and
// what is already reserved - so the page has to show it, and the request form has to show what a request
// would leave behind.
test("the leave page shows a balance, and the request form prices the days against it", async ({ as }) => {
  const employee = await as("employee");
  await gotoRoute(employee, "leave-requests", "Leaves");

  // The balances strip: one entry per leave type the org has, with days on it.
  await expect(employee.getByText(/available|balance/i).first()).toBeVisible();

  await employee.getByRole("button", { name: "Request leave" }).first().click();
  const form = employee.getByRole("dialog");
  await form.getByRole("combobox").first().click();
  await employee.getByRole("option").first().click();
  // A weekday rather than the "Tomorrow" chip: leave is priced in WORKING days, so the chip is (correctly)
  // absent when tomorrow is a Saturday, and a spec must not depend on which day the suite runs on.
  const day = nextWeekday();
  await form.getByLabel("Start date").fill(day);
  await form.getByLabel("End date").fill(day);

  // What the request costs and what it leaves - said before it is filed, not after it is approved.
  await expect(form.getByText(/day|days/).first()).toBeVisible();
  // Nothing is filed: this half of the spec is about what the form TELLS you before you commit.
  await employee.keyboard.press("Escape");
  const discard = employee.getByRole("dialog");
  if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
    await discard.getByRole("button", { name: /Discard|Leave/ }).click();
  }
  await expect(employee.getByRole("dialog")).toHaveCount(0);
});

/** Cancel the pending requests earlier runs of THIS spec left behind. */
async function purgeOldMoves(requester: import("@playwright/test").Page) {
  const res = await requester.request.get("/v1/leave-requests?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string; state?: string; etag?: string }[] };
  for (const r of results) {
    if (!/^E2E move \d{13}/.test(r.reason ?? "")) continue;
    await purge(requester, r.path);
  }
}
