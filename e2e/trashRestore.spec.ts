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
  // one can scroll inside the column header. Each option carries its row count ("Deleted 0" here, because the
  // trash is exactly what has not been fetched yet), so the name is matched on the value and not on the
  // figure beside it.
  await page.getByRole("button", { name: /^Deleted\b/ }).click();
  // Closed explicitly, not assumed: the popover picking a value does not always dismiss it before the next
  // action, and its own open content sitting over the table can intercept a click aimed at a row underneath -
  // as can a live admin-notification toast landing at the same spot (`super` gets those org-wide in real time,
  // and this run shares the page with the rest of the suite still generating them).
  await page.keyboard.press("Escape");
  const deleted = page.locator("tbody tr").filter({ hasText: title });
  await expect(deleted).toHaveCount(1, { timeout: 30_000 });

  // And back: a deleted row offers Restore where a live one offers Edit. The press is inside the retry and
  // gated on the RECORD, not on the menu having been clicked: a press that detached mid-click, or one whose
  // request met a restarting dev Worker, leaves the row deleted - and the reload below then looks for a live
  // row that was never restored, which reads as the restore feature being broken rather than a lost press.
  await expect(async () => {
    if (!(await isDeleted(page, event.path))) return;
    await deleted.getByRole("button", { name: /actions/i }).first().click({ timeout: 10_000 });
    const restore = page.getByRole("menuitem", { name: "Restore" });
    await expect(restore).toBeVisible({ timeout: 5_000 });
    await restore.click({ timeout: 8_000 });
    await expect.poll(() => isDeleted(page, event.path), { timeout: 10_000 }).toBe(false);
  }).toPass({ timeout: 60_000 });

  // Live again, which the page proves by showing it once the Deleted view is left. The filter is cleared the
  // way the table offers it rather than by reloading or re-navigating: those both come back to the SAME
  // "Deleted" view (the filter rides in the table's own URL state, and a same-route navigation does not remount
  // the page), which would hide the row that WAS restored and show one that had not been - passing for
  // exactly the wrong reason. Clearing asks the server for the live list, which is the claim being made here.
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page.locator("tbody tr").filter({ hasText: title })).toHaveCount(1, { timeout: 30_000 });

  await purge(page, event.path);
});

/** Whether the row is still in the trash, asked of the record itself rather than of the table it is filtered
 *  out of. `?show_deleted` because a plain read of a soft-deleted row is what the page itself has to ask for. */
async function isDeleted(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}?show_deleted=true`);
  if (!res.ok()) return true; // unreadable: treat as "not restored yet" and let the retry ask again
  return !!((await res.json()) as { delete_time?: string }).delete_time;
}
