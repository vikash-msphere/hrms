import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";
import { extractPdfText } from "./pdfText";

// The other end of payroll: what the person being paid sees.
//
// `payroll.spec.ts` drives a run up to Publish and deliberately stops there - publishing cannot be undone.
// This spec starts on the far side of that line, with a run published over the wire for a long-past period
// (so it never collides with the month `payroll.spec` works in), and covers the surface no other spec reaches:
// an employee's own payslip list, the figures it summarises, and the two browser-only paths - a PDF PREVIEWED
// in a viewer and a PDF DOWNLOADED to disk through a synthetic `<a download>`.
test("a published run reaches the employee as a payslip they can read and download", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const employee = await as("employee");

  // A run for January 2023: inside the seeded compensation history, so there is somebody to pay, and years
  // away from the month `payroll.spec` works in - published runs are permanent, so a colliding period would
  // break the next spec that asks for one.
  const period = await ensurePeriod(admin);
  const run = await ensureRun(admin, period);
  await publish(admin, run);
  // Payslip PDFs are rendered by the background job the drainer runs; without that tick there is a payslip
  // row and no file behind it.
  await admin.request.post("/v1/cron-runs:run", { headers: SPA_HEADERS, data: { cron: "*/5 * * * *" } });

  await gotoRoute(employee, "payslips", "Payslips");

  // Their own payslip, and the figures the page exists to summarise: the latest net pay is the number
  // somebody opens this page for.
  await expect(employee.getByText("Latest net pay")).toBeVisible({ timeout: 60_000 });
  await expect(employee.locator("tbody tr").first()).toBeVisible();

  // In-browser preview is NOT offered here, and that is the policy rather than a gap: the seeded grants give
  // an employee `payslips.me.download` and no `preview`, and an affordance the caller cannot use is not
  // rendered at all (hide, never disable). So the button is absent rather than present-and-failing.
  await expect(employee.getByRole("button", { name: "View latest" })).toHaveCount(0);

  // And downloaded: the chain from a blob to a named file is entirely the browser's, so a broken content type
  // or a revoked object URL loses the payslip with the server none the wiser.
  const download = employee.waitForEvent("download", { timeout: 90_000 });
  await employee.getByRole("button", { name: "Download latest payslip" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/i);
  const path = await file.path();
  expect(path, "the download produced a file").toBeTruthy();

  // The file itself, not just its name: the KPI above claims a net pay figure, and the PDF the browser just
  // saved has to actually carry that same number, not merely be A file of the right extension.
  const net = await latestNet(employee);
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const text = (await extractPdfText(bytes)).replace(/[,\s]/g, "");
  expect(text).toContain(String(Math.round(net)));
});

/** The `net` figure on this person's own most recent payslip - the number the KPI and the PDF both claim. */
async function latestNet(page: import("@playwright/test").Page): Promise<number> {
  const res = await page.request.get("/v1/payslips?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { net: number; create_time?: string }[] };
  const latest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (!latest) throw new Error("e2e: no payslip on file for this employee");
  return latest.net;
}

/** The pay period this spec pays, created once and reused by later runs of the lane. */
async function ensurePeriod(page: import("@playwright/test").Page): Promise<string> {
  const list = await page.request.get("/v1/pay-periods?page_size=200");
  const { results = [] } = (await list.json()) as { results?: { path: string; period_start?: string }[] };
  const found = results.find((p) => p.period_start === "2023-01-01");
  if (found) return found.path;
  const made = await page.request.post("/v1/pay-periods", {
    headers: SPA_HEADERS,
    data: { display_name: "E2E January 2023", period_start: "2023-01-01", period_end: "2023-01-31", pay_date: "2023-01-31" },
  });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}

/** A built, submitted and approved run for that period - or the one a previous lane run left behind. */
async function ensureRun(page: import("@playwright/test").Page, period: string): Promise<{ path: string; state: string }> {
  const list = await page.request.get("/v1/payroll-runs?page_size=200");
  const { results = [] } = (await list.json()) as { results?: { path: string; pay_period?: string; state?: string }[] };
  const found = results.find((r) => r.pay_period === period);
  if (found) return { path: found.path, state: found.state ?? "" };

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

/** Publish it, unless a previous lane run already did. */
async function publish(page: import("@playwright/test").Page, run: { path: string; state: string }) {
  if (run.state === "PUBLISHED") return;
  const res = await page.request.post(`/v1/${run.path}:publish`, { headers: SPA_HEADERS });
  expect(res.status(), await res.text()).toBeLessThan(300);
}
