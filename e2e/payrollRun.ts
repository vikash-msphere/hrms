import { SPA_HEADERS, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Approve a submitted payroll run, REBUILDING it first on every attempt.
 *
 * `:approve` refuses a run whose income inputs moved since it was built - "this run was built before its
 * inputs changed (...); rebuild it before approving" - with no override, deliberately: approving a stale run
 * pays the wrong money. The probe behind it is narrowed to what could price THIS run (services/payroll.ts
 * `runStaleness`), but the org-wide pay catalogs genuinely apply to everybody and stay unnarrowed, and so
 * does an edit to anyone the run pays - all of which other specs are doing throughout a parallel lane.
 *
 * So the refusal here is the gate working, not a defect, and retrying the approve ALONE can only ask the same
 * closed question again: the run stays stale until something rebuilds it. A submitted run is still in an
 * editable state (`isEditable` covers DRAFT and REVIEW), so rebuilding is exactly what the refusal asks for,
 * and it is idempotent. Which attempt priced the run is immaterial to every spec that uses this - they are
 * about what happens on the far side of approval.
 *
 * The build is retried for its own reason too: it prices whatever is payable at the instant it runs and
 * refuses if the payables moved under it ("payables changed while the run was building").
 */
export async function approvePayrollRun(page: Page, path: string): Promise<void> {
  await expect(async () => {
    const rebuilt = await page.request.post(`/v1/${path}:build`, { headers: SPA_HEADERS });
    expect(rebuilt.status(), `rebuild: ${await rebuilt.text()}`).toBeLessThan(300);
    const res = await page.request.post(`/v1/${path}:approve`, { headers: SPA_HEADERS });
    expect(res.status(), `approve: ${await res.text()}`).toBeLessThan(300);
  }).toPass({ timeout: 90_000 });
}
