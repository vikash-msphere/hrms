import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// Somebody who has exited leaves the rosters: the Directory and the org chart show the people still here.
//
// The employees list itself still carries the leaver (pages need the row to name them on old approvals), so
// this is a browser-only fact: `isCurrentEmployee` (web/src/lib/employees.ts) is what drops them. The case with
// teeth is an exited MANAGER. Nobody rewrites their reports' `manager_id` when they leave, and hiding the
// manager used to turn their whole team into top-level roots; the chart now draws the team under the next
// manager up and tells whoever can edit it which people still need a new manager.
test("an exited manager leaves the directory and the org chart, and their report is flagged for a new manager", async ({ as }) => {
  test.setTimeout(150_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const made: string[] = [];
  const hire = async (first: string, manager?: string) => {
    const res = await page.request.post("/v1/employees", {
      headers: SPA_HEADERS,
      data: { first_name: first, last_name: `Exit${stamp}`, work_email: `e2e.${first.toLowerCase()}.${stamp}@example.com`, ...(manager ? { manager } : {}) },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { path } = (await res.json()) as { path: string };
    made.push(path);
    return path;
  };

  try {
    const skip = await hire("E2eSkip");
    const leaverPath = await hire("E2eGone", skip);
    await hire("E2eStays", leaverPath);
    const leaver = `E2eGone Exit${stamp}`;
    const report = `E2eStays Exit${stamp}`;

    // The exit itself, through the API - `noticePeriodMarkExited.spec.ts` presses the button. Marking the
    // notice exited is the path that terminates the employee.
    const lwd = new Date().toISOString().slice(0, 10);
    const np = await page.request.post("/v1/notice-periods", { headers: SPA_HEADERS, data: { employee: leaverPath, notice_date: lwd, last_working_day: lwd } });
    expect(np.status(), await np.text()).toBe(200);
    const notice = (await np.json()) as { path: string; etag: string };
    const done = await page.request.patch(`/v1/${notice.path}`, { headers: { ...SPA_HEADERS, "If-Match": notice.etag }, data: { status: "completed" } });
    expect(done.status(), await done.text()).toBe(200);

    // The record now says so, on the wire.
    const got = (await (await page.request.get(`/v1/${leaverPath}`)).json()) as { status?: string; end_date?: string; disabled?: boolean };
    expect(got.status).toBe("terminated");
    expect(got.end_date).toBe(lwd);
    expect(got.disabled).toBe(true);

    // Directory: the report is listed, the leaver is not.
    await gotoRoute(page, "employees", "Directory");
    await page.getByPlaceholder("Search people…").fill(`Exit${stamp}`);
    await expect(page.locator("tbody tr").filter({ hasText: report })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator("tbody tr").filter({ hasText: leaver })).toHaveCount(0);

    // Org chart: the leaver is gone, and the report is named as owing a new manager.
    await gotoRoute(page, "org-chart", "Org Chart");
    await expect(page.getByText(/report(s)? to someone who has left/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: report, exact: true }).first()).toBeVisible();
    await page.getByPlaceholder("Find someone…").fill(leaver);
    await expect(page.getByText("0 matches").first()).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder("Find someone…").fill(report);
    await expect(page.getByText(/\d+ of \d+ match/).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    // Reports first, so no delete leaves a live row pointing at a deleted manager mid-cleanup.
    for (const path of [...made].reverse()) {
      const got = await page.request.get(`/v1/${path}`);
      if (!got.ok()) continue;
      const { etag } = (await got.json()) as { etag: string };
      await page.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});
