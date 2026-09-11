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

  // A period no other spec (or run of this one) is working on: far future, and a YEAR per parallel worker -
  // not a month bucketed by `parallelIndex % 9`, which this file used to do and which any run at 10+ workers
  // (this suite runs 16) collides on by construction, two workers landing on the same month and racing each
  // other's :build with a genuine "one committed run per period" 409 (services/payroll.ts).
  const year = 2035 + test.info().parallelIndex;
  const label = `E2E stale ${Date.now() % 100000}`;
  let period: { path: string; etag: string } | undefined;
  let run: { path: string; etag: string } | undefined;
  let bonus: { path: string; etag: string } | undefined;

  try {
    period = await create(admin, "pay-periods", {
      display_name: label,
      period_start: `${year}-01-01`,
      period_end: `${year}-01-28`,
      pay_date: `${year}-01-28`,
    });
    run = await create(admin, "payroll-runs", { pay_period: period.path });

    await gotoRoute(admin, "payroll-runs", "Payroll");
    const row = admin.locator("tbody tr").filter({ hasText: label }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Gated on the run's own COMPUTED LINES rather than on the toast, and re-pressed on a miss. A build
    // leaves the run in DRAFT (only submitting moves it on), so the row says nothing about it; the toast
    // lives about five seconds and a loaded machine misses it, after which waiting on it waits forever for
    // work that was already done. Its items are what a build actually produces.
    const built = async () => {
      const res = await admin.request.get(`/v1/${run!.path}/items?page_size=1`);
      if (!res.ok()) return false;
      return (((await res.json()) as { results?: unknown[] }).results ?? []).length > 0;
    };
    await expect(async () => {
      if (await built()) return;
      if (!(await admin.getByRole("menuitem", { name: "Build" }).count())) {
        await row.getByRole("button", { name: "Actions" }).click();
      }
      const build = admin.getByRole("menuitem", { name: "Build" });
      if (await build.count()) await build.click({ timeout: 8_000 });
      await expect.poll(built, { timeout: 15_000 }).toBe(true);
    }).toPass({ timeout: 90_000 });

    // An income input touched AFTER the build. A bonus rather than an employee edit because it is the
    // cheapest one to take away again, and it is dated a month past this run so nothing here ever pays it -
    // the run's numbers are not the subject, the fact that it noticed is.
    const beforeBonus = Date.now();
    bonus = await create(hr, "bonuses", {
      employee: await personPath(hr, "employee"),
      amount: 4321,
      kind: "Incentive",
      reason: label,
      award_date: `${year}-02-10`,
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

    // Rebuilt: proven by the run's OWN stamp moving past this bonus, not by "Bonuses is not on the list" - a
    // DIFFERENT spec (compensation.spec.ts awards one too) can land its own bonus anywhere in the org in the
    // same window and re-trigger that exact word for a reason that is none of this test's business (staleness
    // is checked org-wide by design - src/services/payroll.ts runStaleness - not scoped to this run's own
    // roster). What this rebuild actually promises is that IT priced the run after this bonus existed.
    await expect
      .poll(async () => {
        const r = await admin.request.get(`/v1/${run!.path}`);
        if (!r.ok()) return -1;
        // Flat on the wire, not nested: routes/payrollRuns.ts's own `serialize` spreads `runStaleness`'s result
        // straight onto the resource (`{ ...toPayrollRunResource(row), ...row._staleness }`) - `_staleness` is an
        // internal-only carrier between the service and that serializer, gone by the time a GET response exists.
        const builtTime = ((await r.json()) as { built_time?: string }).built_time;
        return builtTime ? new Date(builtTime).getTime() : -1;
      }, { timeout: 30_000 })
      .toBeGreaterThan(beforeBonus);

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
  } finally {
    // Everything this spec brought, back out - the run before the bonus, because a run holds the payouts it
    // paid and this one has been rebuilt over that bonus twice. Unconditional: a failure anywhere above used
    // to leave the period behind uncleaned, and a retry (same worker, same `parallelIndex`, so the same year)
    // would then find its OWN prior attempt still occupying it and 400 on "period overlaps" before the real
    // failure ever got a fair second try.
    if (run) await purge(admin, run.path).catch(() => undefined);
    if (period) await purge(admin, period.path).catch(() => undefined);
    if (bonus) await purge(admin, bonus.path).catch(() => undefined);
  }
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
