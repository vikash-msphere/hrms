import { SPA_HEADERS, gotoRoute, personId, test, expect } from "./fixtures";
import { approvePayrollRun } from "./payrollRun";
import { extractPdfText } from "./pdfText";

// The other end of payroll: what the person being paid sees.
//
// `payroll.spec.ts` drives a run up to Publish and deliberately stops there - publishing cannot be undone.
// This spec starts on the far side of that line, with a run published over the wire for a long-past period
// (so it never collides with the month `payroll.spec` works in), and covers the surface no other spec reaches:
// an employee's own payslip list, the figures it summarises, the two browser-only paths - a PDF PREVIEWED
// in a viewer and a PDF DOWNLOADED to disk through a synthetic `<a download>` - and the same slips read from
// the other end, on the employee's record, where the list is narrowed to one person server-side.
test("a published run reaches the employee as a payslip they can read and download, and payroll finds it on their record", async ({ as }) => {
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

  // Reading it in the app, which is the weaker of the two halves and the one an employee holds outright
  // (`payslips.me.preview` beside `payslips.me.download`): the offered button opens the payslip in a viewer,
  // with nothing saved to disk. The verb has its own scope, so the button is only rendered where the caller
  // holds it - hide, never disable.
  await employee.getByRole("button", { name: "View latest" }).click();
  const viewer = employee.getByRole("dialog");
  await expect(viewer.getByRole("heading", { name: "Payslip" })).toBeVisible({ timeout: 60_000 });
  await expect(viewer.locator("iframe[title='Payslip']")).toBeVisible({ timeout: 60_000 });
  await employee.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

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

  // The other side of the same slips: somebody who runs payroll opening THAT person's record. The list read
  // is the same collection narrowed with `?employee=`, so the check that matters is that it is narrowed -
  // a panel showing the org's newest hundred slips under one person's name is the failure this replaces.
  const empId = await personId(admin, "employee");
  await gotoRoute(admin, `employees/${empId}/compensation`);
  const payslips = admin.locator("#employee-payslips");
  await expect(payslips).toBeVisible({ timeout: 60_000 });
  await expect(payslips.locator("tbody tr").first()).toBeVisible({ timeout: 60_000 });
  // The row offers the PDF, which is the point of putting the list here rather than describing it.
  await expect(payslips.getByRole("button", { name: "PDF" }).first()).toBeVisible();
  // Every row on the card belongs to this employee, which is what the server filter is for.
  const scoped = await admin.request.get(`/v1/payslips?employee=employees/${empId}&page_size=200`);
  expect(scoped.status(), await scoped.text()).toBe(200);
  const { results: mine = [] } = (await scoped.json()) as { results?: { employee?: string }[] };
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every((s) => s.employee === `employees/${empId}`)).toBe(true);

  // And the org-wide list the same person sees on #/payslips names the people it is about. The column is a
  // wire id in the payload and has to be a NAME on the page - an admin cannot tell whose pay a row is from
  // `9f3c...`, and the column is shown by default precisely because this list spans other people.
  const record = await admin.request.get(`/v1/employees/${empId}`);
  expect(record.status(), await record.text()).toBe(200);
  const person = (await record.json()) as { first_name?: string; last_name?: string };
  const fullName = `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim();
  expect(fullName, "the seeded employee has a name to render").toBeTruthy();
  await gotoRoute(admin, "payslips", "Payslips");
  await expect(admin.getByRole("columnheader", { name: "Employee" })).toBeVisible({ timeout: 60_000 });
  // Not `exact`: the cell carries the person's avatar as well as their name, and the avatar's fallback
  // initials are text too - so the cell's accessible name is the initials followed by the name.
  await expect(admin.getByRole("cell", { name: fullName }).first()).toBeVisible({ timeout: 60_000 });
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
  for (const verb of ["build", "submit"]) {
    const res = await page.request.post(`/v1/${run.path}:${verb}`, { headers: SPA_HEADERS });
    expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
  }
  await approvePayrollRun(page, run.path);
  return { path: run.path, state: "APPROVED" };
}

/** Publish it, unless a previous lane run already did. */
async function publish(page: import("@playwright/test").Page, run: { path: string; state: string }) {
  if (run.state === "PUBLISHED") return;
  const res = await page.request.post(`/v1/${run.path}:publish`, { headers: SPA_HEADERS });
  expect(res.status(), await res.text()).toBeLessThan(300);
}
