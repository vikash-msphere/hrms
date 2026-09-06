import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// A built payroll run going out of date underneath the person reading it.
//
// A run is BUILT once and then read, checked and approved over the following days - and in those days
// somebody joins, a bonus is awarded, a declaration is verified. The stored numbers are then a snapshot of
// inputs that have moved, and the only thing standing between that and paying the wrong amounts is the
// breakdown saying so, naming what changed, and offering the rebuild.
//
// `test/payroll.test.ts` owns the arithmetic and `runStaleness` itself. What only a browser shows is the
// warning reaching the one screen where the decision is made: the breakdown dialog is where a run is read
// before it is submitted, the banner is rendered from a field carried on the DETAIL read (not the list), and
// the rebuild is offered inside that dialog and has to refresh it in place - a rebuild that silently left
// the stale numbers on screen would be worse than no warning at all.
//
// `payroll.spec.ts` owns the state machine and the quick-run dialog. This run is minted over the wire, on a
// period of its own, so the two specs cannot fight over the same month.
test("a built run says its inputs moved, names what moved, and the rebuild clears it", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const hr = await as("hr");

  // A period no other spec (or run of this one) is working on: far future, and a month per parallel worker.
  const month = 1 + (test.info().parallelIndex % 9);
  const mm = String(month).padStart(2, "0");
  const label = `E2E stale ${Date.now() % 100000}`;
  const period = await create(admin, "pay-periods", {
    display_name: label,
    period_start: `2029-${mm}-01`,
    period_end: `2029-${mm}-28`,
    pay_date: `2029-${mm}-28`,
  });
  const run = await create(admin, "payroll-runs", { pay_period: period.path });

  await gotoRoute(admin, "payroll-runs", "Payroll");
  const row = admin.locator("tbody tr").filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Build" }).click();
  await expect(toast(admin, /Run built/)).toBeVisible({ timeout: 30_000 });

  // An income input touched AFTER the build. A bonus rather than an employee edit because it is the
  // cheapest one to take away again, and it is dated a month past this run so nothing here ever pays it -
  // the run's numbers are not the subject, the fact that it noticed is.
  const bonus = await create(hr, "bonuses", {
    employee: await personPath(hr, "employee"),
    amount: 4321,
    kind: "Incentive",
    reason: label,
    award_date: `2029-${String(month + 1).padStart(2, "0")}-10`,
  });

  // The breakdown is where a run is read before it is submitted, so that is where the warning has to be.
  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Review" }).click();
  const breakdown = admin.getByRole("dialog").filter({ hasText: "Payroll breakdown" });
  await expect(breakdown.getByRole("heading", { name: /Payroll breakdown/ })).toBeVisible({ timeout: 30_000 });
  await expect(breakdown.getByText(/Inputs changed since this run was built/)).toBeVisible({ timeout: 30_000 });
  // Named, not just flagged: "something changed" sends the reader hunting, "Bonuses" tells them where to
  // look and whether they already knew about it.
  await expect(changedLine(breakdown)).toContainText("Bonuses");

  // And the way out is offered on the banner itself, without leaving the dialog - which is the part that has
  // to work in place: the rebuild re-reads the run and re-renders this dialog around the new numbers, and a
  // rebuild that left the stale warning on screen would be worse than no warning at all.
  await breakdown.getByRole("button", { name: "Rebuild now" }).click();

  // Rebuilt, the run is priced on today's inputs and the banner no longer names this one. Asserted as
  // "Bonuses is not on the list" rather than "there is no banner": the suite runs in parallel against one
  // database, and another spec adding an employee or a holiday while this one works is the app being right.
  await expect
    .poll(async () => {
      const line = changedLine(breakdown);
      return (await line.count()) ? await line.first().innerText() : "";
    }, { timeout: 30_000 })
    .not.toContain("Bonuses");

  // The dialog can raise the split-drift prompt over itself when a pay component moved since the build, so
  // it is closed with a loop rather than one press (see payroll.spec.ts).
  await expect(async () => {
    const open = admin.getByRole("dialog");
    if (!(await open.count())) return;
    const later = open.getByRole("button", { name: /Later|Cancel|No/ });
    if (await later.count()) await later.first().click();
    else await admin.keyboard.press("Escape");
    await expect(admin.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });

  // Everything this spec brought, back out - the run before the bonus, because a run holds the payouts it
  // paid and this one has been rebuilt over that bonus twice.
  await purge(admin, run.path);
  await purge(admin, period.path);
  await purge(admin, bonus.path);
});

type Page = import("@playwright/test").Page;

/** The banner's "Changed: …" line, which is the half of the warning that is actionable. */
function changedLine(dialog: import("@playwright/test").Locator) {
  return dialog.getByText(/^Changed: /);
}

/** Mint a row over the wire, for setup this spec is not about. */
async function create(page: Page, collection: string, data: Record<string, unknown>): Promise<{ path: string; etag: string }> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { path: string; etag: string };
}
