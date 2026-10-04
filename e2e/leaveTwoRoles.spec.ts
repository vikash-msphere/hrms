import { SPA_HEADERS, allowConsoleErrors, gotoRoute, test, expect, toast, ownWeekday } from "./fixtures";

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
  const reason = `E2E two-roles ${Date.now()}`;
  const manager = await as("manager");
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.).
  allowConsoleErrors(manager, /status of 503/i);

  // The day this spec will ask for. A weekday of its OWN: several specs ask for leave for this same person at
  // once, and two requests on one day overlap - which the form is right to refuse, leaving the submit disabled
  // forever. Claimed here rather than at the form because the cleanup below is written in terms of it.
  const day = ownWeekday();

  // Start from a known day. The form refuses a range that overlaps leave the person already has, so a rerun
  // (or a retry after a late failure) would otherwise be blocked by the request the previous attempt filed -
  // the test would fail on its own leftovers rather than on the app.
  const admin = await as("super");
  // Resolved, never hardcoded: a record's public id is derived from WIRE_ID_KEY, so it is not the same string
  // on another machine.
  const me = (await (await employee.request.get("/v1/users/me")).json()) as { employee: string };
  // Asked for at the SERVER, as one person and one day: the only leave that can block the filing below is
  // leave covering `day`. Cancelling every future request this person had took out the far-future days other
  // specs file for the same person (fixtures `fileLeave`) seconds earlier - their calendars then drew an
  // absence that no longer existed, and this spec's tidying failed theirs. Narrowing also reaches leftovers
  // sitting past a 100-row page.
  for (const state of ["PENDING", "APPROVED"]) {
    const res = await admin.request.get(
      `/v1/leave-requests?state=${state}&employee=${encodeURIComponent(me.employee)}&from=${day}&to=${day}&page_size=100`,
    );
    const rows = ((await res.json()) as { results?: { path: string }[] }).results ?? [];
    for (const row of rows) await admin.request.post(`/v1/${row.path}:cancel`, { headers: SPA_HEADERS });
  }

  // What the manager has waiting before any of this, so the assertion is about THIS request and not about
  // whatever the seed happens to contain.
  await gotoRoute(manager, "approvals");
  // Counted after the page has stopped fetching, and NOT asserted to be non-empty: on a database earlier runs
  // have already worked through, this manager's queue starts empty, and that is a fine place to start.
  await manager.waitForLoadState("networkidle").catch(() => {});
  const managerQueue = manager.getByRole("button", { name: "Approve", exact: true });

  // The employee files a day off.
  await gotoRoute(employee, "leave-requests", "Leaves");
  // `.first()`: with nothing in the Requests tab the page offers the same action twice - once in the header,
  // once as the empty state's call to action.
  await employee.getByRole("button", { name: "Request leave" }).first().click();
  const form = employee.getByRole("dialog");
  // By heading: the dialog's submit button carries the same words.
  await expect(form.getByRole("heading", { name: "Request leave" })).toBeVisible();

  // Leave type is a listbox rather than a native select - picked by the most balance left, not whatever the
  // org lists first (`fixtures.ts fileLeave`'s own reasoning: on a database the suite has been running
  // against all session, the first-listed type is the one likeliest to have run dry for this shared employee,
  // and the form is right to refuse a type with nothing left in it).
  const bestType = await bestLeaveTypeName(employee);
  await form.getByRole("combobox").first().click();
  // Not exact: the option's own text also appends "· N left" (RequestLeaveDialog.tsx), and a type with none
  // left renders `disabled` rather than absent - `.first()` here can silently click straight through a
  // disabled option, leaving the combobox with no real selection and Submit correctly refusing to enable.
  await employee.getByRole("option", { name: new RegExp(`^${bestType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  // A quick pick rather than typed dates: it sets both ends and the sessions in one press, and it is what a
  // person actually uses.
  // A weekday rather than the "Tomorrow" chip: leave is priced in WORKING days, so the chip is (correctly)
  // absent when tomorrow is a Saturday, and a spec must not depend on which day the suite runs on. `day` was
  // claimed at the top of the test, where the cleanup is written in terms of it.
  await form.getByLabel("Start date").fill(day);
  await form.getByLabel("End date").fill(day);
  // A reason of its own: it is how this request is told apart from the ones other specs file for the same
  // person in the same seconds - on their list, and in the manager's shared inbox.
  await form.getByLabel(/Reason/).fill(reason);
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
  // This employee's OWN pending row, found by the reason typed into it: several specs share this person, so
  // "exactly one pending request" is a fact about the suite rather than about the app.
  await employee.getByRole("searchbox", { name: "Search all records" }).fill(reason);
  await expect(employee.locator("tbody tr").filter({ hasText: /Pending/ })).toHaveCount(1);

  // The manager's queue grew by exactly this one, and it is the employee's. A reload, not a navigation: the
  // manager is already on this page, and one person's write cannot invalidate a cache in somebody else's
  // browser - the resource store only hears about writes made in this browser (lib/resourceStore.ts). Coming
  // back to a stale queue and refreshing it is exactly what the manager does in real life.
  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  // The row for THIS request. A count-delta would be a coin toss: the inbox is shared, and other specs file
  // and decide things in the same seconds.
  const row = manager.locator("li, div").filter({ hasText: reason }).filter({ has: managerQueue }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await manager.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  // The outcome rather than the toast: THIS request leaves the queue it was waiting in. (approval.spec is
  // where the toast and the confirmation copy are pinned.)
  await expect(manager.locator("li, div").filter({ hasText: reason }).filter({ has: managerQueue })).toHaveCount(0, { timeout: 30_000 });

  // And the employee's own page now says so. Approved-but-upcoming leave stays in the live Requests tab
  // (web/src/pages/Leaves.tsx `isLive`), so the row does not move - only its status changes. Retried with a
  // fresh reload: the shared inbox this reason is searched against is written by the rest of this suite's own
  // leave specs constantly under 16-worker load, and the search has occasionally read mid a refetch rather
  // than the settled result a single reload usually lands on.
  await expect(async () => {
    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    await employee.getByRole("tab", { name: /^Requests/ }).click();
    await employee.getByRole("searchbox", { name: "Search all records" }).fill(reason);
    await expect(employee.locator("tbody tr").filter({ hasText: /Approved/ })).toHaveCount(1, { timeout: 10_000 });
    await expect(employee.locator("tbody tr").filter({ hasText: /Pending/ })).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
});

/** The leave type with the most balance left for this caller - see `fixtures.ts fileLeave` for why "first". */
async function bestLeaveTypeName(page: import("@playwright/test").Page): Promise<string> {
  const [types, balances] = await Promise.all([
    page.request.get("/v1/leave-types?page_size=100"),
    page.request.get("/v1/leave-balances?page_size=100"),
  ]);
  const all = ((await types.json()) as { results?: { path: string; display_name?: string }[] }).results ?? [];
  const left = new Map(
    (((await balances.json()) as { results?: { leave_type?: string; balance_days?: number }[] }).results ?? [])
      .map((b) => [b.leave_type ?? "", b.balance_days ?? 0] as const),
  );
  const best = [...all].sort((a, b) => (left.get(b.path) ?? 0) - (left.get(a.path) ?? 0))[0];
  if (!best?.display_name) throw new Error("e2e: the org has no leave types to request");
  return best.display_name;
}
