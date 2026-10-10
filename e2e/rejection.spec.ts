import { SPA_HEADERS, allowConsoleErrors, fileLeave, gotoRoute, inDays, nextWeekday, purge, test, expect } from "./fixtures";

// Saying no, on every kind of request that can be said no to.
//
// The approvals inbox drives a dozen collections through ONE row component, and the reject path is the half
// that gets less use and therefore rots: it is a separate prompt (a one-click reject is exactly what nobody
// wants), it will not go without a reason, which is stored on the request for the requester, and it has to
// work identically whichever collection the row came from. `test/approvals*.test.ts` owns which rows appear.
// What only a browser has is the decision itself: the prompt, the reason, the row leaving the inbox, and the
// request saying rejected, and why, afterwards.
//
// One spec across several collections on purpose: the failure this protects against is in the shared row, so
// covering one collection and trusting the rest is how the other eleven break quietly.

// The project the time-entries kind logs against, made by the test before any kind runs.
let ownProject: string | undefined;

const KINDS: {
  collection: string; label: string; tab: string;
  // Who actually holds approve/reject on this collection - a manager for everything dept-owned (the default),
  // but reimbursements are HR's call and loans/advances are payroll's (grants.ts: "HR decides reimbursement
  // claims (no manager involvement)"; loans only ever reach payroll's `loans.**` allow).
  decider?: "hr" | "payroll";
  // Every workflow collection names its own decision field `state` except these two, which (openapi.yaml)
  // call it `status` instead - loans and time-entries, both otherwise identical PENDING/…/REJECTED workflows.
  stateField?: "status";
  make: (page: import("@playwright/test").Page, mark: string) => Promise<string>;
}[] = [
  {
    collection: "leave-requests",
    label: "leave",
    tab: "Leave",
    // `fileLeave` already picks a day nobody else's spec is using and retries past overlap/collision errors -
    // exactly the risk that kept this one out of the table for a while.
    make: (page, mark) => fileLeave(page, `E2E leave to reject ${mark}`),
  },
  {
    collection: "overtime-requests",
    label: "overtime",
    tab: "Overtime",
    make: async (page, mark) => {
      const res = await page.request.post("/v1/overtime-requests", {
        headers: SPA_HEADERS,
        data: { start_time: `${inDays(-3)}T13:00:00.000Z`, end_time: `${inDays(-3)}T15:00:00.000Z`, reason: `E2E overtime to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "remote-work-requests",
    label: "remote work",
    tab: "Remote work",
    make: async (page, mark) => {
      const res = await page.request.post("/v1/remote-work-requests", {
        headers: SPA_HEADERS,
        // A WEEKDAY: remote work is counted in working days, so a request that lands on a Sunday is worth
        // zero days and never reaches an approver.
        data: { start_date: nextWeekday(7), end_date: nextWeekday(7), reason: `E2E remote day to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "attendance-regularizations",
    label: "attendance correction",
    tab: "Attendance",
    make: async (page, mark) => {
      // Far enough back that no other spec's own day-picking scheme (`pendingCorrections.spec.ts`,
      // `regularizationReject.spec.ts`, the fixed `inDays(-40)` in `regularizationCancel.spec.ts`) ever lands
      // here - a second request for a day that already has one is refused, not merged.
      const spread = 900 + ((Date.now() / 1000 / 60) % 40 | 0) + test.info().parallelIndex * 41;
      let day = "";
      for (let back = spread; back < spread + 7; back++) {
        const d = new Date(Date.now() - back * 86_400_000);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { day = d.toISOString().slice(0, 10); break; }
      }
      const res = await page.request.post("/v1/attendance-regularizations", {
        headers: SPA_HEADERS,
        data: { date: day, sessions: [{ clock_in: `${day}T09:00:00.000Z`, clock_out: `${day}T18:00:00.000Z` }], reason: `E2E correction to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "asset-requests",
    label: "asset request",
    tab: "Asset requests",
    make: async (page, mark) => {
      // No categories are seeded at all (every other asset spec takes one out on the same get-or-create,
      // `assetRequests.spec.ts`'s own `assetCategory()` helper) - the test body ensures one exists (as an
      // admin; an employee has no write on the collection) before this ever runs, so this only has to find it.
      const cats = await page.request.get("/v1/asset-categories?page_size=50");
      const { results = [] } = (await cats.json()) as { results?: { path: string }[] };
      if (!results.length) throw new Error("e2e: no asset category to file the request against");
      const res = await page.request.post("/v1/asset-requests", {
        headers: SPA_HEADERS,
        data: { category: results[0]!.path, justification: `E2E asset request to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "expenses",
    label: "expense",
    tab: "Company expenses",
    make: async (page, mark) => {
      // Office Supplies: seeded with no receipt required, so this is about the reject path, not the create
      // form's own (client-side only) receipt gate - `expenseDecisionsAndInvoice.spec.ts` owns that one.
      const cats = await page.request.get("/v1/expense-categories?page_size=200");
      const { results = [] } = (await cats.json()) as { results?: { path: string; display_name?: string }[] };
      const office = results.find((c) => /office supplies/i.test(c.display_name ?? ""));
      if (!office) throw new Error("e2e: seeded 'Office Supplies' expense category not found");
      const made = await page.request.post("/v1/expenses", {
        headers: SPA_HEADERS,
        data: { category: office.path, amount: 777, description: `E2E expense to reject ${mark}` },
      });
      expect(made.status(), await made.text()).toBe(200);
      const row = (await made.json()) as { path: string };
      const submitted = await page.request.post(`/v1/${row.path}:submit`, { headers: SPA_HEADERS });
      expect(submitted.status(), await submitted.text()).toBeLessThan(300);
      return row.path;
    },
  },
  {
    collection: "reimbursements",
    label: "reimbursement",
    tab: "Reimbursements",
    decider: "hr",
    make: async (page, mark) => {
      // Created straight into PENDING - unlike expenses, reimbursements have no draft state to submit out of.
      const res = await page.request.post("/v1/reimbursements", {
        headers: SPA_HEADERS,
        data: { amount: 350, description: `E2E reimbursement to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "loans",
    label: "advance",
    tab: "Loans & advances",
    decider: "payroll",
    stateField: "status",
    make: async (page, mark) => {
      const res = await page.request.post("/v1/loans", {
        headers: SPA_HEADERS,
        data: { kind: "advance", principal: 5000, installments: 1, reason: `E2E advance to reject ${mark}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { path: string }).path;
    },
  },
  {
    collection: "time-entries",
    label: "timesheet entry",
    tab: "Timesheets",
    stateField: "status",
    make: async (page, mark) => {
      // This spec's OWN project, made up front. Never another spec's fixture: "the first active project" took
      // whichever `E2E ...` project a concurrent spec had just created, so the entry landed in THAT spec's
      // "awaiting your approval" band (read by project name) and it re-pressed Approve on a row not its to
      // decide - the 409s. And nothing is seeded to fall back on, so borrowing one also meant that spec could
      // purge it between here and the POST ("no projects seeded").
      if (!ownProject) throw new Error("e2e: the spec's own project was not created");
      const made = await page.request.post("/v1/time-entries", {
        headers: SPA_HEADERS,
        data: { project: ownProject, date: inDays(-2), hours: 2, description: `E2E time entry to reject ${mark}` },
      });
      expect(made.status(), await made.text()).toBe(200);
      const row = (await made.json()) as { path: string };
      const submitted = await page.request.post(`/v1/${row.path}:submit`, { headers: SPA_HEADERS });
      expect(submitted.status(), await submitted.text()).toBeLessThan(300);
      return row.path;
    },
  },
];

test("a request of each kind is rejected from the inbox, and only with a reason", async ({ as }) => {
  test.setTimeout(240_000);
  const employee = await as("employee");
  const decidingManager = await as("manager");
  const hr = await as("hr");
  const payroll = await as("payroll");
  // The inbox is shared: another browser deciding in the same instant makes the server answer this one with
  // a conflict, which the loop below simply files again.
  for (const decider of [decidingManager, hr, payroll]) allowConsoleErrors(decider, /status of 409/);

  // Nothing is seeded in asset-categories at all, and the employee this spec files everything else as has no
  // write on the collection - an admin tops it up once, up front, so the asset-requests kind below always
  // finds one waiting.
  const existingCats = await employee.request.get("/v1/asset-categories?page_size=1");
  if (!((await existingCats.json()) as { results?: unknown[] }).results?.length) {
    const admin = await as("super");
    const madeCat = await admin.request.post("/v1/asset-categories", {
      headers: SPA_HEADERS,
      data: { display_name: `E2E rejection category ${Date.now()}` },
    });
    expect(madeCat.status(), await madeCat.text()).toBe(200);
  }

  // Projects: nothing is seeded and the employee has no write on the catalog, so an admin makes this spec its
  // own one for the time-entries kind to log against (see that kind for why it is never a borrowed one).
  {
    const admin = await as("super");
    const madeProject = await admin.request.post("/v1/projects", {
      headers: SPA_HEADERS,
      data: { name: `E2E rejection project ${Date.now()}` },
    });
    expect(madeProject.status(), await madeProject.text()).toBe(200);
    ownProject = ((await madeProject.json()) as { path: string }).path;
  }

  for (const kind of KINDS) {
    // A mark of its own on every request, so the row this spec rejects is unmistakably the one it filed -
    // the inbox is shared with every other spec that files something for this person.
    const mark = `${Date.now()}`;
    const path = await kind.make(employee, mark);
    const manager = kind.decider === "hr" ? hr : kind.decider === "payroll" ? payroll : decidingManager;

    await gotoRoute(manager, "approvals", "Approvals");
    // Reloaded, not just navigated: the shared read cache serves the inbox it fetched a moment ago, and the
    // request this iteration just filed would not be in it - a route change does not clear an in-memory cache.
    await manager.reload();
    await expect(manager.getByRole("main")).toBeVisible();
    // The inbox is grouped by KIND, one tab each, because the decisions read differently: leave is about
    // cover, overtime about hours, a loan about money. So the kind's own tab is where its rows are.
    await manager.getByRole("tab", { name: new RegExp(`^${kind.tab}`) }).click();
    const row = manager.locator("div").filter({ hasText: mark }).filter({ has: manager.getByRole("button", { name: "Reject" }) }).last();
    await expect(row, `${kind.collection}: nothing to decide`).toBeVisible({ timeout: 30_000 });
    // The row names the requester once the roster has landed (until then the page can only say "Someone",
    // since the request carries an id and not a name). Waited for HERE rather than in the dialog: the dialog
    // is built from what the row knows at the moment it opens, so opening it early is what puts "Someone" in
    // front of the reader - and this spec is about a dialog that says whose request is being refused.
    await expect(row, `${kind.collection}: the requester never resolved`).toContainText(/Eve Employee/, { timeout: 30_000 });

    // Rejecting is never one click: the prompt names who and what, and will not go until it has a reason -
    // the button stays disabled on an empty box.
    const why = `E2E: not this ${kind.label}, sorry.`;
    await row.getByRole("button", { name: "Reject" }).click();
    const dialog = manager.getByRole("dialog");
    await expect(dialog.getByText("Reject this request?")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/Eve Employee/)).toBeVisible({ timeout: 30_000 });
    const submit = dialog.getByRole("button", { name: "Reject", exact: true });
    await expect(submit, `${kind.collection}: rejects with no reason`).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill(why);
    // The prompt closes on the press and the write follows it; a write that loses (a 409 from the other
    // browser the inbox is shared with) toasts, and the poll below presses again on the still-pending row.
    await submit.click();
    await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });


    // The decision is the row's own: it leaves the inbox, and the request itself says rejected from cold.
    // Polled: a decision can lose a race with another browser working the same inbox, in which case the app
    // says so and the reader presses again - so the state is read until it settles rather than once.
    await expect
      .poll(async () => {
        const after = await manager.request.get(`/v1/${path}`);
        if (!after.ok()) return "unreadable";
        const body = (await after.json()) as { state?: string; status?: string; decision_note?: string };
        const state = kind.stateField === "status" ? body.status : body.state;
        if (state !== "REJECTED" && (await manager.getByRole("button", { name: "Reject" }).count())) {
          // Still pending: press again on the same row, which is what the conflict message asks for.
          const again = manager.locator("div").filter({ hasText: mark }).filter({ has: manager.getByRole("button", { name: "Reject" }) }).last();
          if (await again.count()) {
            await again.getByRole("button", { name: "Reject" }).click();
            const box = manager.getByRole("dialog");
            const reason = box.getByRole("textbox", { name: "Reason", exact: true });
            if (await reason.count()) {
              await reason.fill(why);
              await box.getByRole("button", { name: "Reject", exact: true }).click();
            }
          }
        }
        // The reason travels with the decision: a rejected request says why.
        return state === "REJECTED" ? `${state}: ${body.decision_note}` : state;
      }, { timeout: 60_000, message: `${kind.collection} after reject` })
      .toBe(`REJECTED: ${why}`);

    await purge(manager, path);
  }
});
