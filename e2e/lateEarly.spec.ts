import { allowConsoleErrors, gotoRoute, nextWeekday, patchSettings, personPath, test, expect } from "./fixtures";

// Late arrival and early departure requests, in a browser.
//
// The rules are pure and pinned in test/punctuality.test.ts; filing, deciding and payroll are pinned against
// the database in test/lateEarlyRequests.test.ts and test/lateEarlyPayroll.test.ts. What only a browser can
// show is the WIRING: that the form prices a request before it is sent, that the approver's inbox offers the
// decision and settles the row, and that a policy HR saves in Settings is the policy the form then enforces.
test.describe("late arrival and early departure", () => {
  test("an employee asks to come in late, and HR approves it from the inbox", async ({ as }) => {
    test.setTimeout(150_000);
    const employee = await as("employee");
    const stamp = Date.now();
    const reason = `E2E late arrival ${stamp}`;
    // A working day inside the default 90-day filing window, different on every attempt: a retry asking for
    // the same day and kind again would be refused, correctly, as a second live request.
    const day = nextWeekday(2 + (Math.floor(stamp / 1000) % 45));

    await gotoRoute(employee, "late-early", "Late arrival & early departure");
    await employee.getByRole("button", { name: "Request", exact: true }).first().click();
    const dialog = employee.getByRole("dialog");
    await dialog.getByLabel("Day", { exact: true }).fill(day);
    await dialog.getByLabel("I'll be in by").fill("10:30");
    await dialog.getByLabel("Reason").fill(reason);
    // Priced against the shift before anything is sent: 10:30 is an hour and a half past a 09:00 start.
    await expect(dialog.getByText("1h 30m", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    const mine = await personPath(employee, "employee");
    let path = "";
    await expect
      .poll(async () => {
        const res = await employee.request.get(`/v1/late-early-requests?employee=${mine}&state=PENDING`);
        if (!res.ok()) return "unreadable";
        const row = ((await res.json()) as { results?: { path: string; reason?: string; minutes?: number }[] }).results?.find((r) => r.reason === reason);
        path = row?.path ?? "";
        return row ? row.minutes : "missing";
      }, { timeout: 30_000 })
      .toBe(90);

    const hr = await as("hr");
    // A decision can lose a race with another browser working the same shared inbox; the press is repeated.
    allowConsoleErrors(hr, /status of 409/);
    await gotoRoute(hr, "approvals");
    const approve = hr.getByRole("button", { name: "Approve", exact: true });
    const row = hr.locator("li, div").filter({ hasText: reason }).filter({ has: approve }).last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      if (!(await row.count())) return;
      await row.getByRole("button", { name: "Approve", exact: true }).click();
      await hr.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(row).toHaveCount(0, { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });

    await expect
      .poll(async () => {
        const res = await employee.request.get(`/v1/${path}`);
        return res.ok() ? ((await res.json()) as { state?: string }).state : "unreadable";
      }, { timeout: 30_000 })
      .toBe("APPROVED");
  });

  test("the policy HR saves is the policy the request form enforces", async ({ as }) => {
    test.setTimeout(150_000);
    const hr = await as("hr");
    const was = await hr.request.get("/v1/settings/punctuality");
    const before = was.ok() ? ((await was.json()) as { value?: Record<string, unknown> }).value ?? {} : {};
    try {
      await gotoRoute(hr, "settings/late-early");
      await hr.getByLabel("Longest single request (minutes)").fill("60");
      await hr.getByRole("button", { name: "Save policy" }).click();
      await expect
        .poll(async () => {
          const res = await hr.request.get("/v1/settings/punctuality");
          return res.ok() ? ((await res.json()) as { value?: { requests?: { max_minutes?: number } } }).value?.requests?.max_minutes : null;
        }, { timeout: 30_000 })
        .toBe(60);

      const employee = await as("employee");
      await gotoRoute(employee, "late-early", "Late arrival & early departure");
      // Told the rule before asking...
      await expect(employee.getByText(/up to 1h each/)).toBeVisible({ timeout: 30_000 });
      await employee.getByRole("button", { name: "Request", exact: true }).first().click();
      const dialog = employee.getByRole("dialog");
      await dialog.getByLabel("Day", { exact: true }).fill(nextWeekday(3));
      await dialog.getByLabel("I'll be in by").fill("10:30");
      await dialog.getByLabel("Reason").fill(`E2E policy ${Date.now()}`);
      // ...and held to it before sending.
      await expect(dialog.getByText(/can be at most 1h/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Send request" })).toBeDisabled();
    } finally {
      await patchSettings(hr, "punctuality", () => before);
    }
  });
});
