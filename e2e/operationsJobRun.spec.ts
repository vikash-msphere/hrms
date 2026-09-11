import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The Operations page has two run buttons, not one: the cron cards' "Run now" (operations.spec.ts covers that)
// and, below them, a per-row "Run"/"Retry" on a single BACKGROUND JOB - the thing a payroll publish or an
// automation actually enqueues. That row action has its own capability gate (`operations.<code>.run`, super
// only) and its own optimistic update (the row's status/result cells, not a whole-page reload), so it needs
// its own proof: publishing a payroll run enqueues a real `payslip.generateRun` job, and clicking that job's
// own "Run" button - not the cron card's - is what drains it and reads back its result in place.
//
// The job is drained automatically by the 5-minute cron too (payrollPublish.spec.ts waits that out), so this
// spec races it on purpose: publish, then go straight to Operations and click Run within seconds, well inside
// that window.
test("a queued background job is run from its own row, and reads back its result", async ({ as }) => {
  test.setTimeout(120_000);
  const admin = await as("super");

  const { period } = await freshPeriod(admin);
  const run = await approvedRun(admin, period);
  const published = await admin.request.post(`/v1/${run.path}:publish`, { headers: SPA_HEADERS });
  // 202, not 200: publishing is long-running, so it answers with the Operation to poll rather than the run
  // (routes/payrollRuns.ts, and `'202': Accepted; returns a long-running operation` in openapi.yaml).
  expect(published.status(), await published.text()).toBe(202);
  const job = (await published.json()) as { path: string };
  expect(job.path).toMatch(/^operations\//);

  // Fresh off the publish, before the cron has a chance at it.
  const before = await admin.request.get(`/v1/${job.path}`);
  expect(((await before.json()) as { metadata?: { status?: string } }).metadata?.status).toBe("queued");

  await gotoRoute(admin, "settings/operations");
  await expect(admin.locator("h1").first()).toHaveText("System operations");

  // Keyed by the job's own id (Operations.tsx's `#op-job-<id>`), not "the freshest Generaterun row": the cron
  // (or another spec's own publish) can enqueue a same-kind job that lands newer than this one, and `.first()`
  // on a page ordered newest-first would silently watch THAT row instead of this test's own.
  const row = admin.locator(`#op-job-${job.path.split("/")[1]}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("Queued")).toBeVisible();

  const runBtn = row.getByRole("button", { name: "Run" });
  await expect(runBtn).toBeVisible();
  await runBtn.click();
  // Through `toast()`: a bare text match also catches the live-region announcement the toaster
  // renders for screen readers, which is a second element with the same words.
  await expect(toast(admin, "Job ran")).toBeVisible({ timeout: 30_000 });

  // Payslip generation is RESUMABLE: a press writes 25 payslips and re-queues itself for the rest
  // (services/payroll.ts#processPayslipRunJob, batch = 25), so on a full roster the row comes back Queued
  // with a Run button rather than finishing in one press. Draining it is what the button is for - keep
  // pressing while it is still offered, exactly as an admin would. Each server round trip (and the toast that
  // comes with it) genuinely takes longer on a busy lane than a fixed 250ms - a click landing on a toast
  // still sliding over the row (the toast region can overlap it) or on a row mid-re-render is retried rather
  // than counted as the press, and the whole drain gets real wall-clock room instead of a fixed 12 attempts.
  await expect(async () => {
    for (let press = 0; press < 30 && (await runBtn.count()); press++) {
      await runBtn.click({ timeout: 5_000 });
      await admin.waitForTimeout(300);
    }
    await expect(row.getByText("Done")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  // Read back IN PLACE: the row now shows Done and the generated-count result, not a page reload.
  await expect(row.getByText("Done")).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(/Payslips Generated/i);
  // A finished job offers no further action.
  await expect(row.getByRole("button", { name: /Run|Retry/ })).toHaveCount(0);

  const after = await admin.request.get(`/v1/${job.path}`);
  const afterBody = (await after.json()) as { metadata?: { status?: string }; response?: { payslips_generated?: number } };
  expect(afterBody.metadata?.status).toBe("done");
  expect(afterBody.response?.payslips_generated).toBeGreaterThan(0);
});

/**
 * A pay period nothing has run yet, in a year no other spec's payroll flow touches (2022 is
 * `payrollPublish`, 2023 `payslips`, 2029 `payrollStale`).
 *
 * AFTER the seeded compensation, which is the part that is easy to get wrong: every seeded row is effective
 * from 2021 or 2022, so a run built for an earlier year has nobody to pay. `:build` answers 200 with no
 * items - an empty run is a legitimate thing to have - and it is `:approve` that then refuses, which reads
 * as the approval being broken rather than the year being before anyone was on the payroll.
 */
async function freshPeriod(page: import("@playwright/test").Page): Promise<{ period: string; label: string }> {
  const periods = await page.request.get("/v1/pay-periods?page_size=200");
  const { results: ps = [] } = (await periods.json()) as { results?: { path: string; period_start?: string }[] };
  const runs = await page.request.get("/v1/payroll-runs?page_size=200");
  const { results: rs = [] } = (await runs.json()) as { results?: { pay_period?: string }[] };
  const taken = new Set(rs.map((r) => r.pay_period));

  for (let month = 11; month >= 0; month--) {
    const start = `2024-${String(month + 1).padStart(2, "0")}-01`;
    const label = `E2E job-run ${start.slice(0, 7)}`;
    const existing = ps.find((p) => p.period_start === start);
    if (existing) {
      if (taken.has(existing.path)) continue;
      return { period: existing.path, label };
    }
    const end = new Date(Date.UTC(2024, month + 1, 0)).toISOString().slice(0, 10);
    const made = await page.request.post("/v1/pay-periods", {
      headers: SPA_HEADERS,
      data: { display_name: label, period_start: start, period_end: end, pay_date: end },
    });
    expect(made.status(), await made.text()).toBe(200);
    return { period: ((await made.json()) as { path: string }).path, label };
  }
  throw new Error("e2e: every month of 2024 has been published - give this spec another year");
}

/** A run for that period, walked to APPROVED over the wire. */
async function approvedRun(page: import("@playwright/test").Page, period: string): Promise<{ path: string }> {
  const made = await page.request.post("/v1/payroll-runs", { headers: SPA_HEADERS, data: { pay_period: period } });
  expect(made.status(), await made.text()).toBe(200);
  const run = (await made.json()) as { path: string };
  for (const verb of ["build", "submit", "approve"]) {
    const res = await page.request.post(`/v1/${run.path}:${verb}`, { headers: SPA_HEADERS });
    expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
  }
  return { path: run.path };
}
