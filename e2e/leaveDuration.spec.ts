import { SPA_HEADERS, fileLeave, gotoRoute, ownWeekday, purge, test, expect } from "./fixtures";

// What a request COSTS, said before it is sent.
//
// A day of leave is not a row in a calendar, it is a number taken off a balance - and the request dialog
// computes that number live, in the browser, from the dates, the half-day sessions, the org's working week
// and its holidays. Two of the things it computes are the ones people get wrong:
//
//   - a morning off is half a day, not a day. The sessions control only appears on a single-day request, and
//     the figure beside it is what the person is agreeing to spend.
//   - leave already booked on those dates is a clash, and the form says so and refuses rather than letting
//     the request go and come back rejected.
//
// `test/leave.test.ts` owns the reservation and the accrual; `leaveTwoRoles` and `leaveSelfService` cover
// filing and moving a request. Neither ever looks at what the form says the request is worth.
//
// The manager files their own leave here for the reason `leaveSelfService` gives: half a dozen specs file,
// approve and reject leave for the one shared employee, and a spec that reads a figure off a form needs the
// dates it picked to still be its own.
test.describe("what a leave request costs", () => {
  test("a morning off is charged as half a day", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("manager");
    const admin = await as("super"); // the hard purge is an admin's to make
    const type = await typeWithBalance(page);
    // A weekday nobody else in the run is asking for: the figure only means something if the day is really
    // a working day, and the request only files if nothing of this person's already covers it.
    const day = ownWeekday();

    await gotoRoute(page, "leave-requests", "Leaves");
    await page.getByRole("button", { name: "Request leave" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Request leave" })).toBeVisible();

    // The type with the most days left, so a spent balance is never what fails this test.
    await form.getByLabel("Leave type").click();
    await page.getByRole("option", { name: type }).first().click();
    await form.getByLabel("Start date").fill(day);
    await form.getByLabel("End date").fill(day);

    // A whole day first, so the half below is a CHANGE this control made rather than a number that was
    // always there.
    await expect(form.getByText(/^1 day of leave$/)).toBeVisible({ timeout: 30_000 });

    // The sessions control exists only while the request is one day long - a "morning only" on a fortnight
    // means nothing - and choosing one halves what is being asked for. It is a radio group, so the choice
    // reads back on the control as well as in the figure beside it.
    const morning = form.getByRole("radio", { name: "Morning", exact: true });
    await morning.click();
    await expect(morning).toHaveAttribute("aria-checked", "true");
    await expect(form.getByText(/^0\.5 days of leave$/)).toBeVisible({ timeout: 30_000 });

    await form.getByRole("button", { name: "Request leave", exact: true }).click();
    // The dialog closing is the write landing; a refusal keeps it open with the reason pinned.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // And the half is what was actually filed, read back from the row rather than from the form that sent it.
    const filed = await mine(page, day);
    expect(filed?.days, "the request was not filed as half a day").toBe(0.5);
    if (filed) await purge(admin, filed.path);
  });

  test("leave already booked on those dates is named, and the request cannot be sent", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("manager");
    const admin = await as("super");
    const reason = `E2E clash ${Date.now()}`;
    // Filed over the wire first: the clash is about what this person ALREADY has, so it has to exist before
    // the dialog reads their requests.
    const path = await fileLeave(page, reason);
    const booked = await page.request.get(`/v1/${path}`);
    expect(booked.ok(), await booked.text()).toBe(true);
    const day = ((await booked.json()) as { start_date: string }).start_date;

    try {
      await gotoRoute(page, "leave-requests", "Leaves");
      await page.getByRole("button", { name: "Request leave" }).first().click();
      const form = page.getByRole("dialog");
      await form.getByLabel("Start date").fill(day);
      await form.getByLabel("End date").fill(day);

      // Not a toast after a failed send: the form has the person's own requests and says the clash while the
      // dates are being chosen, which is the only moment the information is useful.
      await expect(form.getByText("You already have leave on these dates")).toBeVisible({ timeout: 30_000 });
      // And it refuses to send - the guard, not just the warning.
      await expect(form.getByRole("button", { name: "Request leave", exact: true })).toBeDisabled();
    } finally {
      await purge(admin, path);
    }
  });
});

/** The display name of the leave type this person has the most days of - the one a request can afford. */
async function typeWithBalance(page: import("@playwright/test").Page): Promise<string> {
  const [types, balances] = await Promise.all([
    page.request.get("/v1/leave-types?page_size=100"),
    page.request.get("/v1/leave-balances?page_size=100"),
  ]);
  const all = ((await types.json()) as { results?: { path: string; display_name?: string }[] }).results ?? [];
  const left = new Map(
    (((await balances.json()) as { results?: { leave_type?: string; balance_days?: number }[] }).results ?? [])
      .map((b) => [b.leave_type ?? "", b.balance_days ?? 0] as const),
  );
  const best = [...all].sort((a, b) => (left.get(b.path) ?? 0) - (left.get(a.path) ?? 0))[0];
  if (!best?.display_name) throw new Error("e2e: the org has no leave types to request");
  return best.display_name;
}

/** This person's request on `day`, as the server recorded it. */
async function mine(page: import("@playwright/test").Page, day: string): Promise<{ path: string; days?: number } | undefined> {
  const res = await page.request.get("/v1/leave-requests?page_size=100", { headers: SPA_HEADERS });
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; start_date?: string; days?: number }[] };
  const row = results.find((r) => r.start_date === day);
  return row && { path: row.path, days: row.days };
}
