import { SPA_HEADERS, allowConsoleErrors, gotoRoute, inDays, nextWeekday, purge, test, expect } from "./fixtures";

// Saying no, on every kind of request that can be said no to.
//
// The approvals inbox drives a dozen collections through ONE row component, and the reject path is the half
// that gets less use and therefore rots: it is a separate dialog (a one-click reject is exactly what nobody
// wants), it carries a note back to the requester where the API takes one, and it has to work identically
// whichever collection the row came from. `test/approvals*.test.ts` owns which rows appear. What only a
// browser has is the decision itself: the dialog, the note, the row leaving the inbox, and the requester's
// own page saying rejected afterwards.
//
// One spec across several collections on purpose: the failure this protects against is in the shared row, so
// covering one collection and trusting the rest is how the other eleven break quietly.
const KINDS: { collection: string; label: string; tab: string; note: boolean; make: (page: import("@playwright/test").Page, mark: string) => Promise<string> }[] = [
  {
    collection: "overtime-requests",
    label: "overtime",
    tab: "Overtime",
    note: true,
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
    note: true,
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
];

test("a request of each kind is rejected from the inbox, with the reason it takes", async ({ as }) => {
  test.setTimeout(240_000);
  const employee = await as("employee");
  const manager = await as("manager");
  // The inbox is shared: another browser deciding in the same instant makes the server answer this one with
  // a conflict, which the loop below simply files again.
  allowConsoleErrors(manager, /status of 409/);

  for (const kind of KINDS) {
    // A mark of its own on every request, so the row this spec rejects is unmistakably the one it filed -
    // the inbox is shared with every other spec that files something for this person.
    const mark = `${Date.now()}`;
    const path = await kind.make(employee, mark);

    await gotoRoute(manager, "approvals", "Approvals");
    // Reloaded, not just navigated: the shared read cache serves the inbox it fetched a moment ago, and the
    // request this iteration just filed would not be in it - a hash change does not clear an in-memory cache.
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

    // Rejecting is never one click: the dialog names who and what, and takes the reason where the API relays
    // one back to the requester.
    await row.getByRole("button", { name: "Reject" }).click();
    const dialog = manager.getByRole("dialog");
    await expect(dialog.getByText("Reject this request?")).toBeVisible({ timeout: 30_000 });
    // The name is looked up, not carried on the row - the dialog asks the resource store who this request
    // belongs to - so on a busy lane it arrives a moment after the dialog does.
    await expect(dialog.getByText(/Eve Employee/)).toBeVisible({ timeout: 30_000 });
    if (kind.note) {
      const note = dialog.getByRole("textbox");
      await expect(note, `${kind.collection}: takes a note but offers no field`).toHaveCount(1);
      await note.fill(`E2E: not this ${kind.label}, sorry.`);
    }
    await dialog.getByRole("button", { name: "Reject request" }).click();
    await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });


    // The decision is the row's own: it leaves the inbox, and the request itself says rejected from cold.
    // Polled: a decision can lose a race with another browser working the same inbox, in which case the app
    // says so and the reader presses again - so the state is read until it settles rather than once.
    await expect
      .poll(async () => {
        const after = await manager.request.get(`/v1/${path}`);
        if (!after.ok()) return "unreadable";
        const state = ((await after.json()) as { state?: string }).state;
        if (state !== "REJECTED" && (await manager.getByRole("button", { name: "Reject" }).count())) {
          // Still pending: press again on the same row, which is what the conflict message asks for.
          const again = manager.locator("div").filter({ hasText: mark }).filter({ has: manager.getByRole("button", { name: "Reject" }) }).last();
          if (await again.count()) {
            await again.getByRole("button", { name: "Reject" }).click();
            const box = manager.getByRole("dialog");
            if (await box.getByRole("button", { name: "Reject request" }).count()) {
              await box.getByRole("button", { name: "Reject request" }).click();
            }
          }
        }
        return state;
      }, { timeout: 60_000, message: `${kind.collection} after reject` })
      .toBe("REJECTED");

    await purge(manager, path);
  }
});
