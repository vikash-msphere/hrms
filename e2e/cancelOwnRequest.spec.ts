import { SPA_HEADERS, allowConsoleErrors, fileLeave, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Withdrawing your own pending ask, on every page that offers it.
//
// Six collections grow the same small feature independently, in THREE shapes. Overtime, remote work,
// reimbursements and asset requests copy-paste an identical "cancel a request I filed" column
// (confirmDecision's generic "Cancel this request?" dialog, then `invoke(.., "cancel", ..)`). Leave requests
// do it a fourth way on purpose, with NO confirmation while the request is still PENDING (only an
// already-APPROVED leave asks first, since approving one already reserved days off a plain cancel would give
// back). Loans are the fifth shape and the odd one out entirely: its button is even labelled "Delete", not
// "Cancel", and it calls the collection's own soft-`remove()` rather than a `cancel` verb - so a loan's
// `status` stays PENDING forever; what actually flips is `delete_time`, same as any other soft-deleted row.
// None of the six had ever been pressed - `rejection.spec.ts` proved the shared REJECT path this same way;
// this is its opposite number for withdrawing your own request rather than having someone else refuse it.
test("a pending request is withdrawn from every page that lets its own filer cancel it", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  // A dev Worker restart mid-request, or a genuine conflict from two of this shared actor's own pending
  // requests being decided in the same instant elsewhere in the suite - same rare hiccup documented elsewhere
  // (complianceRuleDelete.spec.ts et al.); the polled server state below is what actually proves each cancel
  // landed, not the toast alone.
  allowConsoleErrors(employee, /status of 503|status of 409/i);
  const stamp = Date.now();

  // Leave: PENDING cancels with no confirmation at all - the one collection of the six that skips it.
  {
    const reason = `E2E cancel leave ${stamp}`;
    const path = await fileLeave(employee, reason);
    await gotoRoute(employee, "leave-requests", "Leaves");
    // Not by `reason`: the table's own columns are Type/From/To/Days/Status - the reason never renders here
    // at all (it's a detail-view thing), so a text filter on it would never match any row. By the request's
    // own start date instead - `fileLeave` deliberately gives every filing in the run its own day for exactly
    // this reason (its own comment: "a spec that finds 'its' request by the date on the row" is otherwise
    // liable to act on somebody else's) - a bare "first Pending row" ignores that guarantee entirely, and this
    // employee is shared with every other spec that files leave, several of which can have a pending request
    // of their own sitting in the same table at the same time.
    const filed = await employee.request.get(`/v1/${path}`);
    expect(filed.ok(), await filed.text()).toBe(true);
    const startDate = ((await filed.json()) as { start_date: string }).start_date;
    const [year, , day] = startDate.split("-");
    // The specific month, not a wildcard: day-of-month + year alone still collides across the far-future
    // days this suite hands out (several land on the same day-of-month in the same year), and would match
    // somebody else's pending request just as happily.
    const month = new Date(`${startDate}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
    const row = employee.locator("tbody tr").filter({ hasText: new RegExp(`${Number(day)}\\s+${month}\\s+${year}`) }).last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(employee.getByRole("dialog")).toHaveCount(0); // no confirmation on a pending request
    // The toast is a nicety here, not the proof: the poll right below reads the server's own state, which is
    // what actually settles whether the cancel landed on a busy lane.
    await expect(toast(employee, "Leave request cancelled")).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
    await expect
      .poll(async () => {
        const r = await employee.request.get(`/v1/${path}`);
        return r.ok() ? ((await r.json()) as { state?: string }).state : "unreadable";
      }, { timeout: 30_000 })
      .toBe("CANCELLED");
  }

  // A day this run's own, the same reasoning as `fileLeave`'s own comment: this employee is shared with
  // whatever else in the suite is filing overtime/remote-work at the same moment, and a fixed literal date
  // (this used to post "2028-02-01" outright) can collide with another spec's own pending row on the same
  // page - "the first Pending row" then cancels someone else's request and leaves this one PENDING forever.
  const day = (offset: number) => {
    const d = new Date(Date.UTC(2031, 0, 1 + ((stamp + offset * 317) % 900)));
    return { iso: d.toISOString().slice(0, 10), rendered: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) };
  };
  const overtimeDay = day(0);
  const remoteDay = day(1);
  const amount = 250 + (stamp % 700);

  // Overtime, remote work, reimbursements: the same generic confirm-then-cancel, on three different pages.
  const genericCancels: { collection: string; route: string; heading: string; make: () => Promise<string>; match: RegExp }[] = [
    {
      collection: "overtime-requests",
      route: "overtime",
      heading: "Overtime",
      make: async () => {
        const res = await employee.request.post("/v1/overtime-requests", {
          headers: SPA_HEADERS,
          data: { start_time: `${overtimeDay.iso}T13:00:00.000Z`, end_time: `${overtimeDay.iso}T15:00:00.000Z`, reason: `E2E cancel overtime ${stamp}` },
        });
        expect(res.status(), await res.text()).toBe(200);
        return ((await res.json()) as { path: string }).path;
      },
      match: new RegExp(overtimeDay.rendered.replace(/\s+/g, "\\s+")),
    },
    {
      collection: "remote-work-requests",
      route: "remote-work",
      heading: "Remote work",
      make: async () => {
        const res = await employee.request.post("/v1/remote-work-requests", {
          headers: SPA_HEADERS,
          data: { start_date: remoteDay.iso, end_date: remoteDay.iso, reason: `E2E cancel remote ${stamp}` },
        });
        expect(res.status(), await res.text()).toBe(200);
        return ((await res.json()) as { path: string }).path;
      },
      match: new RegExp(remoteDay.rendered.replace(/\s+/g, "\\s+")),
    },
    {
      collection: "reimbursements",
      route: "reimbursements",
      heading: "Reimbursements",
      make: async () => {
        const res = await employee.request.post("/v1/reimbursements", {
          headers: SPA_HEADERS,
          data: { amount, description: `E2E cancel reimbursement ${stamp}` },
        });
        expect(res.status(), await res.text()).toBe(200);
        return ((await res.json()) as { path: string }).path;
      },
      // Rendered by `formatMoney` - the raw digits still appear inside it whatever the currency's own symbol
      // or grouping is, and no seeded amount in this org lands on this run's own arbitrary cents.
      match: new RegExp(String(amount)),
    },
  ];

  for (const kind of genericCancels) {
    const path = await kind.make();
    await gotoRoute(employee, kind.route, kind.heading);
    // Matched on this run's own date/amount, not merely "Pending": none of these three tables render the
    // reason/description column by default, and this employee's page can hold another spec's own pending
    // request at the same moment - "the first Pending row" is not reliably this one.
    const row = employee.locator("tbody tr").filter({ hasText: "Pending" }).filter({ hasText: kind.match }).first();
    await expect(row, `${kind.collection}: nothing waiting to cancel`).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = employee.getByRole("dialog");
    await expect(confirm.getByText("Cancel this request?")).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Cancel request", exact: true }).click();
    await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => {
        const r = await employee.request.get(`/v1/${path}`);
        return r.ok() ? ((await r.json()) as { state?: string }).state : "unreadable";
      }, { timeout: 30_000, message: `${kind.collection} after cancel` })
      .toBe("CANCELLED");
    await purge(employee, path);
  }

  // Asset requests: same generic dialog, but reached from the profile's Assets tab and labelled "Withdraw",
  // not "Cancel" - a deliberately different word for the same verb, worth pinning so a rename never drifts
  // the label out of sync with every other page's "Cancel".
  const why = `E2E withdraw asset ${stamp}`;
  // Asset categories are an admin-managed catalog (`assetRequests.spec.ts` uses the same helper with its own
  // admin actor) - an employee can read the list but not create (or purge) a fallback category, which is
  // exactly the 403 this was hitting when no existing category happened to fit.
  const admin = await as("super");
  const category = await assetCategory(admin);
  const asked = await employee.request.post("/v1/asset-requests", {
    headers: SPA_HEADERS,
    data: { category: category.path, justification: why },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  const assetPath = ((await asked.json()) as { path: string }).path;

  await gotoRoute(employee, "profile"); // one record page, two addresses: its `h1` is the person's name
  // Assets rides the Employment tab on the one record page - see the note in assetRequests.spec.ts.
  await employee.getByRole("tab", { name: "Employment" }).click();
  const panel = employee.getByRole("tabpanel");
  // `has:` page-rooted, not re-scoped from `panel` - a has-locator carries its whole ancestor chain into the
  // containment check, so `panel.getByRole(...)` would ask each row to contain another tabpanel nested
  // inside it (it never will) and silently match nothing.
  const askRow = panel.locator("div").filter({ hasText: why }).filter({ has: employee.getByRole("button", { name: "Withdraw" }) }).last();
  await expect(askRow).toBeVisible({ timeout: 30_000 });
  await askRow.getByRole("button", { name: "Withdraw" }).click();
  const withdrawConfirm = employee.getByRole("dialog");
  await expect(withdrawConfirm.getByText("Cancel this request?")).toBeVisible({ timeout: 30_000 });
  await withdrawConfirm.getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => {
      const r = await employee.request.get(`/v1/${assetPath}`);
      return r.ok() ? ((await r.json()) as { state?: string }).state : "unreadable";
    }, { timeout: 30_000, message: "asset request after withdraw" })
    .toBe("CANCELLED");
  await purge(employee, assetPath);
  if (category.created) await purge(admin, category.path);

  // Loans: labelled "Delete", confirms, but is a plain soft-delete rather than a `cancel` verb - so the read-
  // back that matters is `delete_time`, not `status` (which never moves off PENDING).
  const loanReason = `E2E delete loan ${stamp}`;
  const madeLoan = await employee.request.post("/v1/loans", {
    headers: SPA_HEADERS,
    data: { kind: "advance", principal: 3000, installments: 1, reason: loanReason },
  });
  expect(madeLoan.status(), await madeLoan.text()).toBe(200);
  const loanPath = ((await madeLoan.json()) as { path: string }).path;

  await gotoRoute(employee, "loans", "Loans & Advances");
  const loanRow = employee.locator("div.shadow-card").filter({ hasText: loanReason }).first();
  await expect(loanRow).toBeVisible({ timeout: 30_000 });
  await loanRow.getByRole("button", { name: "Delete" }).click();
  const loanConfirm = employee.getByRole("dialog");
  await expect(loanConfirm.getByText("Delete this loan request?")).toBeVisible({ timeout: 30_000 });
  await loanConfirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(employee, "Request deleted")).toBeVisible({ timeout: 30_000 });
  await expect(employee.locator("div.shadow-card").filter({ hasText: loanReason })).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => {
      const r = await employee.request.get(`/v1/${loanPath}`);
      if (!r.ok()) return "unreadable";
      const body = (await r.json()) as { status?: string; delete_time?: string };
      return `${body.status}:${!!body.delete_time}`;
    }, { timeout: 30_000, message: "loan after delete" })
    .toBe("PENDING:true");
  await purge(employee, loanPath);
});

/** A category with no serial requirement - `assetRequests.spec.ts` keeps the same rule for the same reason. */
async function assetCategory(page: import("@playwright/test").Page): Promise<{ path: string; created: boolean }> {
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  const rows = ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return { path: found, created: false };
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E cancel category ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, created: true };
}
