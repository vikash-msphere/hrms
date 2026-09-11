import * as XLSX from "xlsx";
import { SPA_HEADERS, allowConsoleErrors, gotoRoute, withAllowedBank, test, expect, toast } from "./fixtures";

// An approved run's "Bank file · <bank>" download - `payroll.spec.ts` already proves the two other download
// menu items (statutory report, PF ECR), but never this one, and this one carries the sharpest guard in the
// whole export: `buildBankFile` (src/services/bankFile.ts) refuses to write a bulk-payment file at all if any
// payable employee has no bank account on file, rather than silently skipping them or leaving the column
// blank - a dropped or misrouted payout is worse than none. Seeded employees carry no bank details (that is
// entered per-employee, never by seed), so this is exactly the state a real org would be in the first time it
// tries the button, and it is a real safety rail worth proving rather than assuming.
test("a bank file is refused, by name, for every payable employee missing an account on file", async ({ as }) => {
  // Longer than the three run-transition retries in `approvedRun` can budget between them.
  test.setTimeout(300_000);
  const admin = await as("super");
  // The refusal IS the subject of this spec: the bank-file request comes back 409 and the page says so in a
  // toast, and the browser logs every failed fetch as a resource error. Opted out by status, so any OTHER
  // console error here still fails the spec.
  allowConsoleErrors(admin, /status of 409/);
  const bankName = `E2E Payout Bank ${Date.now() % 100000}`;
  const dropBank = await withAllowedBank(admin, bankName);

  // A minimal, valid template + mapping - enough for `buildBankFile` to have a format to read, without which
  // "Bank file" would not even be offered (`canBankFile` needs `banks.length > 0`, not a configured format;
  // the format's own absence is `bankFormats.test.ts`'s failure mode, not this one's).
  const template = XLSX.write(
    (() => { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet([["Account No"]]), "Payments"); return b; })(),
    { type: "buffer", bookType: "xlsx" },
  ) as Buffer;
  const uploaded = await admin.request.post(`/v1/bank-formats/${encodeURIComponent(bankName)}:uploadTemplate?file_name=template.xlsx&content_type=application/octet-stream`, {
    headers: { ...SPA_HEADERS, "Content-Type": "application/octet-stream" },
    data: template,
  });
  expect(uploaded.status(), await uploaded.text()).toBe(200);
  const tpl = (await uploaded.json()) as { r2_key: string; file_name: string };
  const formatted = await admin.request.patch(`/v1/bank-formats/${encodeURIComponent(bankName)}`, {
    headers: SPA_HEADERS,
    data: { sheet: "Payments", header_row: 1, data_start_row: 2, columns: [{ col: 1, header: "Account No", source: "account_number" }], template_name: tpl.file_name, r2_key: tpl.r2_key },
  });
  expect(formatted.status(), await formatted.text()).toBe(200);

  const { period, label } = await freshPeriod(admin);
  const run = await approvedRun(admin, period);

  await gotoRoute(admin, "payroll-runs", "Payroll");
  const row = admin.locator("tbody tr").filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  const item = admin.getByRole("menuitem", { name: `Bank file · ${bankName}` });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();

  await expect(toast(admin, "Couldn't generate bank file")).toBeVisible({ timeout: 30_000 });
  await expect(toast(admin, /have no bank account on file/)).toBeVisible();

  // Leaves nothing behind: the run is unpublished (deletable) and the bank comes back off the org's list.
  // SPA_HEADERS on a DELETE like every other mutation: without `X-Requested-By` the CSRF gate refuses it 403
  // (src/middleware/csrf.ts), and the run this spec built is left behind on the period it claimed.
  const removed = await admin.request.delete(`/v1/${run.path}`, { headers: SPA_HEADERS });
  expect(removed.status(), await removed.text()).toBeLessThan(300);
  await dropBank();
});

/**
 * A pay period nothing has run yet, in a year no other payroll-lane spec touches (2022 is `payrollPublish`,
 * 2023 `payslips`, 2024 `operationsJobRun`, 2029 `payrollStale`), and AFTER the seeded compensation - every
 * seeded row is effective from 2021 or 2022, so a run built for an earlier year has nobody to pay, builds
 * empty, and is then refused at `:approve` for having no items.
 */
async function freshPeriod(page: import("@playwright/test").Page): Promise<{ period: string; label: string }> {
  const periods = await page.request.get("/v1/pay-periods?page_size=200");
  const { results: ps = [] } = (await periods.json()) as { results?: { path: string; period_start?: string }[] };
  const runs = await page.request.get("/v1/payroll-runs?page_size=200");
  const { results: rs = [] } = (await runs.json()) as { results?: { pay_period?: string }[] };
  const taken = new Set(rs.map((r) => r.pay_period));

  for (let month = 11; month >= 0; month--) {
    const start = `2025-${String(month + 1).padStart(2, "0")}-01`;
    const label = `E2E bank-file ${start.slice(0, 7)}`;
    const existing = ps.find((p) => p.period_start === start);
    if (existing) {
      if (taken.has(existing.path)) continue;
      return { period: existing.path, label };
    }
    const end = new Date(Date.UTC(2025, month + 1, 0)).toISOString().slice(0, 10);
    const made = await page.request.post("/v1/pay-periods", {
      headers: SPA_HEADERS,
      data: { display_name: label, period_start: start, period_end: end, pay_date: end },
    });
    expect(made.status(), await made.text()).toBe(200);
    return { period: ((await made.json()) as { path: string }).path, label };
  }
  throw new Error("e2e: every month of 2025 has been used - give this spec another year");
}

/** A run for that period, walked to APPROVED over the wire. */
async function approvedRun(page: import("@playwright/test").Page, period: string): Promise<{ path: string }> {
  const made = await page.request.post("/v1/payroll-runs", { headers: SPA_HEADERS, data: { pay_period: period } });
  expect(made.status(), await made.text()).toBe(200);
  const run = (await made.json()) as { path: string };
  for (const verb of ["build", "submit", "approve"]) {
    // Retried, because `:build` prices whatever is payable at the instant it runs and REFUSES if the payables
    // moved under it - "payables changed while the run was building (reimbursements) - nothing was paid;
    // build the run again". On a lane where sixteen specs are writing reimbursements that is the guard doing
    // its job, and building again is exactly what it asks for; the bank file this spec is about is unaffected
    // by which attempt priced the run.
    await expect(async () => {
      const res = await page.request.post(`/v1/${run.path}:${verb}`, { headers: SPA_HEADERS });
      expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
    }).toPass({ timeout: 60_000 });
  }
  return { path: run.path };
}
