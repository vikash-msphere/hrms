import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The one thing no single-page test can show: two people, two front ends, one request.
//
// `test/leave.test.ts` proves the reservation arithmetic and `test/approvalsSummary.test.ts` proves who sees
// what in the queue - both through `app.fetch`, both with one caller at a time. What is left over is whether
// the two UIs agree: the employee files it in theirs, the manager finds it in theirs, decides, and the
// employee's own page tells the truth afterwards. Every step here is a different browser context with its
// own cookie, so the app is genuinely serving two people at once.
//
// The seed makes this a real reporting line: emp@example.com's manager IS mgr@example.com (scripts/seed.sql),
// so the request lands in that manager's queue rather than an admin's.
test("an employee files leave and their manager decides it", async ({ as }) => {
  const employee = await as("employee");
  const manager = await as("manager");

  // Start from a known day. The form refuses a range that overlaps leave the person already has, so a rerun
  // (or a retry after a late failure) would otherwise be blocked by the request the previous attempt filed -
  // the test would fail on its own leftovers rather than on the app.
  const admin = await as("super");
  // Resolved, never hardcoded: a record's public id is derived from WIRE_ID_KEY, so it is not the same string
  // on another machine.
  const me = (await (await employee.request.get("/v1/users/me")).json()) as { employee: string };
  const today = new Date().toISOString().slice(0, 10);
  for (const state of ["PENDING", "APPROVED"]) {
    const res = await admin.request.get(`/v1/leave-requests?state=${state}&page_size=100`);
    const rows = ((await res.json()) as { results?: { path: string; employee: string; start_date: string }[] }).results ?? [];
    for (const row of rows) {
      // Only this employee's, and only leave that has not started - a past absence is history, and cancelling
      // it would be rewriting somebody's year to make a test pass.
      if (row.employee === me.employee && row.start_date >= today) {
        await admin.request.post(`/v1/${row.path}:cancel`, { headers: SPA_HEADERS });
      }
    }
  }

  // What the manager has waiting before any of this, so the assertion is about THIS request and not about
  // whatever the seed happens to contain.
  await gotoRoute(manager, "approvals");
  // Counted after the page has stopped fetching, and NOT asserted to be non-empty: on a database earlier runs
  // have already worked through, this manager's queue starts empty, and that is a fine place to start.
  await manager.waitForLoadState("networkidle").catch(() => {});
  const managerQueue = manager.getByRole("button", { name: "Approve", exact: true });
  const waitingBefore = await managerQueue.count();

  // The employee files a day off.
  await gotoRoute(employee, "leave-requests", "Leaves");
  // `.first()`: with nothing in the Requests tab the page offers the same action twice - once in the header,
  // once as the empty state's call to action.
  await employee.getByRole("button", { name: "Request leave" }).first().click();
  const form = employee.getByRole("dialog");
  // By heading: the dialog's submit button carries the same words.
  await expect(form.getByRole("heading", { name: "Request leave" })).toBeVisible();

  // Leave type is a listbox rather than a native select; take whatever the org has configured first.
  await form.getByRole("combobox").first().click();
  await employee.getByRole("option").first().click();
  // A quick pick rather than typed dates: it sets both ends and the sessions in one press, and it is what a
  // person actually uses.
  await form.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await form.getByRole("button", { name: "Request leave", exact: true }).click();

  await expect(toast(employee, "Leave requested")).toBeVisible();
  // Their own list shows it immediately, waiting on somebody. The tab is chosen explicitly because the page
  // opens on whichever one has something in it, and counted rather than indexed because the cleanup above
  // means exactly one of this employee's requests can be pending - which a count says plainly, whatever the
  // table's sort order happens to be.
  const requestsTab = employee.getByRole("tab", { name: /^Requests/ });
  await requestsTab.click();
  // `tbody tr` rather than `getByRole("row")`: a clickable row is given `role="button"` so it can be operated
  // from the keyboard (DataTable), which takes it out of the table's accessibility tree entirely - and this
  // table's rows open a detail panel.
  await expect(employee.locator("tbody tr").filter({ hasText: /Pending/ })).toHaveCount(1);

  // The manager's queue grew by exactly this one, and it is the employee's. A reload, not a navigation: the
  // manager is already on this page, and one person's write cannot invalidate a cache in somebody else's
  // browser - the resource store only hears about writes made in this browser (lib/resourceStore.ts). Coming
  // back to a stale queue and refreshing it is exactly what the manager does in real life.
  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  await expect(managerQueue).toHaveCount(waitingBefore + 1);
  const row = manager.locator("li, div").filter({ hasText: "Eve Employee" }).filter({ has: managerQueue }).last();
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await manager.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  // The outcome rather than the toast: the decided request leaves the queue it was waiting in. (approval.spec
  // is where the toast and the confirmation copy are pinned.)
  await expect(managerQueue).toHaveCount(waitingBefore);

  // And the employee's own page now says so. Approved-but-upcoming leave stays in the live Requests tab
  // (web/src/pages/Leaves.tsx `isLive`), so the row does not move - only its status changes.
  await employee.reload();
  await expect(employee.getByRole("main")).toBeVisible();
  await employee.getByRole("tab", { name: /^Requests/ }).click();
  await expect(employee.locator("tbody tr").filter({ hasText: /Approved/ })).toHaveCount(1);
  await expect(employee.locator("tbody tr").filter({ hasText: /Pending/ })).toHaveCount(0);
});
