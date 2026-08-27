import { SPA_HEADERS, allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Writing through a dialog, and what happens to the list behind it.
//
// The Worker side of a create is already pinned by test/collectionFactory.test.ts (paging, `?id`, `If-Match`,
// lifecycle verbs) and the conflict lane by the same file. What none of that can see is the client half: that
// the dialog's submit builds the right payload, that the row shows up in the table WITHOUT the page being
// reloaded (the resource store invalidating its cached collection - see lib/resourceStore.ts, and
// test/resourceStoreCache.test.ts for the unit-level rules), and that a lost race tells the person what
// happened and lets them finish.
test.describe("write dialogs", () => {
  test("a create lands in the table without a reload, and survives one", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors");

    // A marker on the live JS context. It survives every in-app render and dies on a document load, so it is
    // the difference between "the store invalidated and re-rendered" and "the page reloaded itself" - which
    // would look identical in the table and is the failure this test exists to catch.
    await page.evaluate(() => {
      (window as unknown as { __e2eAlive?: boolean }).__e2eAlive = true;
    });

    const name = `E2E vendor ${Date.now()}`;
    await page.getByRole("button", { name: "New vendor" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Vendor or supplier name").fill(name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __e2eAlive?: boolean }).__e2eAlive === true),
      "the row appeared because the page reloaded, not because the store invalidated",
    ).toBe(true);

    // And it was really written, not just optimistically painted.
    await page.reload();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  });

  test("a lost race says so and the second press goes through", async ({ as }) => {
    const page = await as("super");
    // The provoked 409 is logged by the browser itself; that is the point of the test, not a defect.
    allowConsoleErrors(page, /409|Conflict/i);

    const title = `E2E goal ${Date.now()}`;
    const created = await page.request.post("/v1/goals", { headers: SPA_HEADERS, data: { title } });
    expect(created.status(), await created.text()).toBe(200);
    const goal = (await created.json()) as { path: string; etag: string };

    await gotoRoute(page, "goals");
    await page.getByText(title, { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Edit goal")).toBeVisible();

    // Somebody else edits the goal while this dialog sits open, so the etag the dialog holds is now stale.
    const bumped = await page.request.patch(`/v1/${goal.path}`, {
      headers: { ...SPA_HEADERS, "If-Match": goal.etag },
      data: { description: "moved on by somebody else" },
    });
    expect(bumped.status(), await bumped.text()).toBe(200);

    // First press loses the race. It has to say what happened in the form - not "etag mismatch", and not a
    // silently swallowed failure that leaves the person pressing a dead button.
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByText(/Somebody else changed this goal while you had it open/)).toBeVisible();

    // Second press takes the fresh etag and wins, with what was typed still in the form.
    await dialog.getByRole("button", { name: "Save changes" }).click();
    // `exact`: the app also announces the toast to screen readers ("Notification Goal updated"), and both
    // carry the phrase.
    await expect(page.getByText("Goal updated", { exact: true })).toBeVisible();
  });
});
