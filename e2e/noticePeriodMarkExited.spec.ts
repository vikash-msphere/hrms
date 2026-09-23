import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// "Mark exited" - the row action that actually ends someone's employment.
//
// `noticePeriodStartOffboarding.spec.ts` proves the "Start offboarding" checkbox links a real transition, but
// never presses the row menu's own decision. This is the one thing that matters about it: unlike every other
// notice-period status change, moving to "completed" calls `terminateForOffboarding` directly
// (src/services/noticePeriods.ts), which sets the employee `terminated`/`disabled` AND disables their sign-in
// account - a real, mostly-irreversible action nothing else in the suite has ever triggered. It needs its own
// disposable employee for exactly that reason: this cannot be run against a seeded person every other spec
// still needs active.
test("marking a notice period exited terminates the employee and disables their sign-in", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const first = "E2eExit";
  const last = `Leaver${stamp}`;
  const fullName = `${first} ${last}`;

  const madeEmp = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: `e2e.exit.${stamp}@example.com` },
  });
  expect(madeEmp.status(), await madeEmp.text()).toBe(200);
  const employee = (await madeEmp.json()) as { path: string };

  // The auto-provisioned login this employee got when created - `userAccessPanel.spec.ts` names the same
  // fact. Confirmed BEFORE the exit, so "disabled afterwards" is a real change, not a coincidence of a fresh
  // account's default.
  const before = await findUser(page, employee.path);
  expect(before, "the new employee has no auto-provisioned login to check").toBeTruthy();
  expect(before!.status).not.toBe("disabled");

  try {
    await gotoRoute(page, "notice-periods", "Notice Periods");
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill(fullName);
    await expect(page.getByRole("option", { name: new RegExp(fullName) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");

    const noticeDate = await form.getByLabel("Notice given").inputValue();
    await form.getByLabel("Last working day").fill(addDays(noticeDate, 10));
    const submit = form.getByRole("button", { name: "Record", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(toast(page, "Notice recorded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    const row = page.locator("tbody tr").filter({ hasText: fullName }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Mark exited" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText(`Mark ${fullName} as exited?`)).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText(/disables their login/)).toBeVisible();
    await confirm.getByRole("button", { name: "Mark exited", exact: true }).click();
    await expect(toast(page, "Marked exited")).toBeVisible({ timeout: 30_000 });

    // The real, otherwise-invisible effect: the login this spec confirmed was active a moment ago is disabled.
    await expect
      .poll(async () => (await findUser(page, employee.path))?.status, { timeout: 30_000 })
      .toBe("disabled");
  } finally {
    // Plain soft-delete, not a purge: the auto-provisioned login is an undeclared reference `users` has no
    // delete route for at all, so `?force=true` here would 409 rather than clean up.
    const got = await page.request.get(`/v1/${employee.path}`);
    if (got.ok()) {
      const { etag } = (await got.json()) as { etag: string };
      await page.request.delete(`/v1/${employee.path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});

// The OTHER status a "serving" notice period can move to - and unlike "Mark exited", this one asks nothing
// first (the confirm in `setStatus` gates only on `status === "completed"`) and touches no employee record at
// all: it just calls off the notice. Never pressed anywhere before this either.
test("withdrawing a notice period asks nothing and just calls it off", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const first = "E2eWithdraw";
  const last = `Notice${stamp}`;
  const fullName = `${first} ${last}`;

  const madeEmp = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: `e2e.withdraw.${stamp}@example.com` },
  });
  expect(madeEmp.status(), await madeEmp.text()).toBe(200);
  const employee = (await madeEmp.json()) as { path: string };

  try {
    await gotoRoute(page, "notice-periods", "Notice Periods");
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill(fullName);
    await expect(page.getByRole("option", { name: new RegExp(fullName) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    const noticeDate = await form.getByLabel("Notice given").inputValue();
    await form.getByLabel("Last working day").fill(addDays(noticeDate, 10));
    await form.getByRole("button", { name: "Record", exact: true }).click();
    await expect(toast(page, "Notice recorded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    const row = page.locator("tbody tr").filter({ hasText: fullName }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Withdraw notice" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0); // no confirmation for this one
    await expect(toast(page, "Notice withdrawn")).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Withdrawn/i, { timeout: 30_000 });
  } finally {
    // Plain soft-delete, not a purge: same reason as above - the auto-provisioned login is an undeclared
    // reference `users` has no delete route for, so `?force=true` here would 409 rather than clean up.
    const got = await page.request.get(`/v1/${employee.path}`);
    if (got.ok()) {
      const { etag } = (await got.json()) as { etag: string };
      await page.request.delete(`/v1/${employee.path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});

// The third row action - a plain `useSoftDelete` instance, unlike the two above - and, unlike them, never
// state-gated: it is offered on a notice period regardless of status. Never pressed anywhere either.
test("a notice period record is deleted from the list", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const first = "E2eDeleteNotice";
  const last = `Record${stamp}`;
  const fullName = `${first} ${last}`;

  const madeEmp = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: `e2e.deletenotice.${stamp}@example.com` },
  });
  expect(madeEmp.status(), await madeEmp.text()).toBe(200);
  const employee = (await madeEmp.json()) as { path: string };

  try {
    await gotoRoute(page, "notice-periods", "Notice Periods");
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill(fullName);
    await expect(page.getByRole("option", { name: new RegExp(fullName) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    const noticeDate = await form.getByLabel("Notice given").inputValue();
    await form.getByLabel("Last working day").fill(addDays(noticeDate, 10));
    await form.getByRole("button", { name: "Record", exact: true }).click();
    await expect(toast(page, "Notice recorded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    const row = page.locator("tbody tr").filter({ hasText: fullName }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(toast(page, "Notice period deleted")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("tbody tr").filter({ hasText: fullName })).toHaveCount(0, { timeout: 30_000 });
  } finally {
    const got = await page.request.get(`/v1/${employee.path}`);
    if (got.ok()) {
      const { etag } = (await got.json()) as { etag: string };
      await page.request.delete(`/v1/${employee.path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});

async function findUser(page: import("@playwright/test").Page, employeePath: string): Promise<{ status?: string } | undefined> {
  const res = await page.request.get("/v1/users?page_size=200");
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { employee?: string; status?: string }[] };
  return results.find((u) => u.employee === employeePath);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
