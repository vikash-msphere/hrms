import { fileLeave, gotoRoute, test, expect, toast } from "./fixtures";

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
    // Its own pending request, so the spec still works on a database whose seeded queue earlier runs have
    // already cleared.
    await fileLeave(await as("employee"), `E2E approval ${Date.now()}`);
    await gotoRoute(page, "approvals");

    // The per-row Approve buttons. `exact` keeps the bulk bar's "Approve selected" out of the count, and the
    // confirm dialog's own "Approve" only exists while the dialog is open (never while counting below).
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve.first()).toBeVisible();
    const waiting = await approve.count();
    expect(waiting, "the request filed above should be waiting here").toBeGreaterThan(0);

    // Asking first.
    await approve.first().click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Approve this request?")).toBeVisible();

    // Backing out decides nothing.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await approve.count()).toBe(waiting);

    // Going through with it decides, says so, and takes the row out of the queue.
    await approve.first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(toast(page, "Approved")).toBeVisible();
    await expect(approve).toHaveCount(waiting - 1);
  });
});
