import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Deleting something, finding it again, and putting it back.
//
// Nearly every collection in this app soft-deletes: the row stays, marked. `undo.spec.ts` covers the toast
// you get in the ten seconds after pressing Delete. This is the other half, the one people actually need -
// the delete somebody did last week. It is entirely a browser story: deleted rows are NOT loaded with the
// page (they are fetched only when the State filter asks for "Deleted"), the row then offers Restore instead
// of Edit, and restoring puts it back in the live list. A collection whose deleted rows cannot be reached is
// a collection where every mistake is permanent, which is exactly what soft-delete exists to prevent.
test("a deleted row is found under Deleted and restored", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const title = `E2E trash ${Date.now()}`;

  const made = await page.request.post("/v1/compliance-events", {
    headers: SPA_HEADERS,
    data: { title, due_date: "2027-03-31", category: "tax" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const event = (await made.json()) as { path: string };

  await gotoRoute(page, "compliance", "Compliance Calendar");
  const row = page.locator("tbody tr").filter({ hasText: title });
  await expect(row).toHaveCount(1);

  // Deleted from the row's own menu. The row leaves the live list at once - that is what the reader is told.
  await row.getByRole("button", { name: /actions/i }).first().click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog");
  if (await confirm.getByRole("button", { name: /Delete/ }).count()) {
    await confirm.getByRole("button", { name: /Delete/ }).last().click();
  }
  await expect(page.locator("tbody tr").filter({ hasText: title })).toHaveCount(0, { timeout: 30_000 });

  // Gone, not lost. Deleted rows are not in the page's data at all until the State filter asks for them, so
  // this filter is a FETCH, not a client-side narrowing - which is the part that quietly breaks.
  // The column's filter, not its sort: the header carries both, and only the funnel opens the value list.
  await page.getByRole("button", { name: "Filter by state" }).first().click();
  // Its options are plain buttons in a popover rather than a listbox - the table draws its own list so a long
  // one can scroll inside the column header.
  await page.getByRole("button", { name: "Deleted", exact: true }).click();
  const deleted = page.locator("tbody tr").filter({ hasText: title });
  await expect(deleted).toHaveCount(1, { timeout: 30_000 });

  // And back: a deleted row offers Restore where a live one offers Edit.
  await deleted.getByRole("button", { name: /actions/i }).first().click();
  await page.getByRole("menuitem", { name: "Restore" }).click();

  // Live again, which the page proves by showing it with the deleted filter cleared.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("tbody tr").filter({ hasText: title })).toHaveCount(1, { timeout: 30_000 });

  await purge(page, event.path);
});
