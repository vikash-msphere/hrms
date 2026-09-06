import { allowConsoleErrors, fileLeave, gotoRoute, test, expect } from "./fixtures";

// Deciding somebody else's request, from the queue that does it in bulk.
//
// Two things here are only true in a browser. The first is the friction: test/confirmCoverage.test.ts proves
// every decision verb SITS BEHIND a confirmation in the source, by walking back from each `invoke(…)` call
// site - it cannot prove the dialog opens, that backing out really abandons the decision, or that pressing
// through really sends it. The second is the settle: an approved request has to leave the queue by itself,
// because the list is client state that the decision has to invalidate.
//
// The Worker side - who may approve what, and what approving does to the leave balance - is
// test/approvalsSummary.test.ts and test/leave.test.ts. Nothing about it is re-asserted here.
test.describe("approvals", () => {
  test("an approval asks first, abandons cleanly, and settles the row", async ({ as }) => {
    const page = await as("super");
    // A decision can lose a race with another browser working the same shared inbox; the server says 409 and
    // the press below is repeated, so the console line that comes with it is expected.
    allowConsoleErrors(page, /status of 409/);
    // Its own pending request, so the spec still works on a database whose seeded queue earlier runs have
    // already cleared.
    await fileLeave(await as("employee"), `E2E approval ${Date.now()}`);
    await gotoRoute(page, "approvals");

    // The per-row Approve buttons. `exact` keeps the bulk bar's "Approve selected" out of the count, and the
    // confirm dialog's own "Approve" only exists while the dialog is open (never while counting below).
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve.first()).toBeVisible();
    // Counted, but never compared to a LATER count of the same shared queue: other specs file and decide
    // things in these same seconds. What each step below asserts is its own row, or a change in this row.
    expect(await approve.count(), "the request filed above should be waiting here").toBeGreaterThan(0);
    const first = approve.first();
    const rowText = await first.locator("xpath=ancestor::*[self::li or self::div][1]").innerText().catch(() => "");

    // One row, held onto by its own text: `.first()` twice is two different rows when another spec decides
    // something in between, and then this spec is asserting about somebody else's request.
    const line = rowText.split("\n")[0]!.trim();
    const row = page.locator("li, div").filter({ hasText: line }).filter({ has: approve }).last();

    // Asking first.
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Approve this request?")).toBeVisible();

    // Backing out decides nothing.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Nothing was decided: that same row is still offering the decision.
    await expect(row.getByRole("button", { name: "Approve", exact: true })).toBeVisible();

    // Going through with it decides, says so, and takes the row out of the queue.
    await expect(async () => {
      if (!(await row.count())) return;
      await row.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(row).toHaveCount(0, { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    // The decided row leaves the queue. Asserted on THAT row rather than on the size of a queue this spec
    // does not have to itself - and on the row rather than on the toast, which lives five seconds and is
    // gone by the time a loaded machine gets here (the toast copy is pinned in `undo` and `holidays`).
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  });
});
