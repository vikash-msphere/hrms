import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Clearing several tickets at once, on the desk's own "All" tab - a different bulk mechanism entirely from
// `bulkApproval.spec.ts`'s inbox (that one is a hand-rolled selection bar over a card list; this is
// `DataTable`'s own generic `bulkActions`, the same prop `Expenses`/`ExpenseBudgets` build their bulk rows
// from). One press has to resolve every ticket selected, name how many it got, and leave nothing behind that
// a reader has to go re-check by hand.
test("two tickets are resolved together from a bulk selection", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const subjects = [`E2E bulk resolve a ${stamp}`, `E2E bulk resolve b ${stamp}`];

  const tickets: string[] = [];
  for (const subject of subjects) {
    const made = await page.request.post("/v1/tickets", {
      headers: SPA_HEADERS,
      data: { subject, category: "it", description: "Raised by the e2e suite to be bulk-resolved." },
    });
    expect(made.status(), await made.text()).toBe(200);
    tickets.push(((await made.json()) as { path: string }).path);
  }

  try {
    await gotoRoute(page, "tickets", "Support");
    // "All" is a scope CHIP over the desk's one table, not a tab over four (see `tickets.spec.ts`).
    await page.getByRole("button", { name: /^All/ }).click();

    for (const subject of subjects) {
      const row = page.locator("tbody tr").filter({ hasText: subject });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole("checkbox", { name: "Select row" }).check();
    }

    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Move to Resolved", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Resolve the selected tickets?")).toBeVisible();
    await confirm.getByRole("button", { name: "Move to Resolved", exact: true }).click();

    await expect(toast(page, "Resolved 2")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("2 selected")).toHaveCount(0, { timeout: 30_000 });

    for (const subject of subjects) {
      await expect(page.locator("tbody tr").filter({ hasText: subject })).toContainText(/Resolved/i, { timeout: 30_000 });
    }
  } finally {
    for (const path of tickets) await purge(page, path);
  }
});
