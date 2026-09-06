import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// The press that pays everybody.
//
// Publishing is the payroll machine's point of no return: every employee in the run is notified, payslips are
// generated in the background, and the run can never be edited or deleted again. `payroll` therefore walks
// the machine to APPROVED and stops, and `payslips` reads the far side of the line after publishing over the
// WIRE - which leaves the one press a person actually makes undriven.
//
// This drives it, on a month of its OWN: publishing cannot be undone, so the spec claims a fresh 2022 period
// each run rather than re-using one, and stays years away from the months `payroll` and `payslips` work in.
// What only a browser shows: the verb is offered only in the APPROVED state, the question spells out what
// cannot be undone, backing out really leaves the run approved, the row says it is generating payslips while
// the background job runs, and the verb is gone from the menu afterwards.
test("an approved run is published from the page, after the question says it cannot be undone", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");

  // A month of this spec's OWN, years before anything the seed or the other payroll specs touch. Publishing
  // is one-way, so a period cannot be reused: each run of this spec claims a fresh one and leaves it
  // published, which is the same footprint `payslips` already leaves for January 2023.
  const { period, label } = await freshPeriod(admin);
  const run = await approvedRun(admin, period);

  await gotoRoute(admin, "payroll-runs", "Payroll");
  // The table before the row: on a cold page the rows arrive after the shell, and "no row matched" and "no
  // rows yet" are different failures.
  await expect(admin.locator("tbody tr").first()).toBeVisible({ timeout: 60_000 });
  const row = admin.locator("tbody tr").filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });

  // Offered because the run is approved: the row's action menu carries the verbs its state allows, and
  // nothing else. (The menu itself is the icon button whose only name is its `sr-only` "Actions".)
  const openMenu = async () => {
    await row.hover();
    await row.getByRole("button", { name: "Actions" }).click();
  };
  await openMenu();
  await expect(admin.getByRole("menuitem", { name: "Publish" })).toBeVisible({ timeout: 30_000 });

  // Backing out. This is the press somebody makes while reading the question, and it has to leave the run
  // exactly as it was.
  await admin.getByRole("menuitem", { name: "Publish" }).click();
  const ask = admin.getByRole("dialog").filter({ hasText: "Publish this payroll run?" });
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask.getByText(/every employee in the run is notified/)).toBeVisible();
  await expect(ask.getByText(/can't be edited or deleted/)).toBeVisible();
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(admin.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  expect(await state(admin, run.path), "backing out published the run anyway").toBe("APPROVED");

  // And through with it: publishing hands off to a background operation, and the page follows it rather than
  // leaving somebody looking at a run that says APPROVED until they reload.
  await openMenu();
  await admin.getByRole("menuitem", { name: "Publish" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  // While the background job runs, the row says so IN PLACE OF its menu - which is the honest thing to draw
  // for a run that is half published, and the reason the menu is not re-opened until it has finished.
  await expect(row).toContainText(/Generating payslips/i, { timeout: 30_000 });
  await expect.poll(() => state(admin, run.path), { timeout: 180_000 }).toBe("PUBLISHED");
  await expect(row).toContainText(/Published/i, { timeout: 60_000 });

  // A published run offers no way back - the verb is gone from the menu, not disabled in it.
  await admin.reload();
  await expect(admin.locator("tbody tr").first()).toBeVisible({ timeout: 60_000 });
  await openMenu();
  await expect(admin.getByRole("menuitem", { name: "Review" })).toBeVisible({ timeout: 30_000 });
  await expect(admin.getByRole("menuitem", { name: "Publish" })).toHaveCount(0);
});

/**
 * A pay period nothing has run yet, in a year nothing else in the lane works in.
 *
 * Walked backwards from 2022-12 until it finds a month with no run against it: publishing cannot be undone,
 * so this spec can never re-use the month it published last time.
 */
async function freshPeriod(page: import("@playwright/test").Page): Promise<{ period: string; label: string }> {
  const periods = await page.request.get("/v1/pay-periods?page_size=200");
  const { results: ps = [] } = (await periods.json()) as { results?: { path: string; period_start?: string }[] };
  const runs = await page.request.get("/v1/payroll-runs?page_size=200");
  const { results: rs = [] } = (await runs.json()) as { results?: { pay_period?: string }[] };
  const taken = new Set(rs.map((r) => r.pay_period));

  for (let month = 11; month >= 0; month--) {
    const start = `2022-${String(month + 1).padStart(2, "0")}-01`;
    const label = `E2E publish ${start.slice(0, 7)}`;
    const existing = ps.find((p) => p.period_start === start);
    if (existing) {
      if (taken.has(existing.path)) continue; // already run (and, by now, published)
      return { period: existing.path, label };
    }
    const end = new Date(Date.UTC(2022, month + 1, 0)).toISOString().slice(0, 10);
    const made = await page.request.post("/v1/pay-periods", {
      headers: SPA_HEADERS,
      data: { display_name: label, period_start: start, period_end: end, pay_date: end },
    });
    expect(made.status(), await made.text()).toBe(200);
    return { period: ((await made.json()) as { path: string }).path, label };
  }
  throw new Error("e2e: every month of 2022 has been published - give this spec another year");
}

/** A run for that period, walked to APPROVED over the wire. */
async function approvedRun(page: import("@playwright/test").Page, period: string): Promise<{ path: string; state: string }> {
  const made = await page.request.post("/v1/payroll-runs", { headers: SPA_HEADERS, data: { pay_period: period } });
  expect(made.status(), await made.text()).toBe(200);
  const run = (await made.json()) as { path: string };
  // No bodies: these verbs take none, and the contract proxy rejects a request that carries one anyway.
  for (const verb of ["build", "submit", "approve"]) {
    const res = await page.request.post(`/v1/${run.path}:${verb}`, { headers: SPA_HEADERS });
    expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
  }
  return { path: run.path, state: "APPROVED" };
}

/** The run's state, as the server holds it. */
async function state(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { state?: string }).state?.toUpperCase();
}
