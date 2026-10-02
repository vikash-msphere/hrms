import { SPA_HEADERS, allowConsoleErrors, confirmDelete, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting an event - `events.spec.ts` covers RSVPs but never removes an event, and no other event spec
// (`eventInvite`, `eventRepeat`, `eventIcs`) does either. Shares the generic `useSoftDelete` mechanism
// `undo.spec.ts` proves once (on vendors); this is this page's own copy.
test("an event is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.) - the retry below is what actually recovers from it.
  allowConsoleErrors(page, /status of 503/i);
  const title = `E2E delete event ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/events", {
    headers: SPA_HEADERS,
    data: { title, start_time: "2032-06-01T10:00:00.000Z", end_time: "2032-06-01T11:00:00.000Z" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "events", "Events");
  const row = page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await confirmDelete(page);
  // One press, patiently waited on rather than re-pressed: a transient 500/503 on a busy lane leaves the toast
  // never arriving, and re-pressing Delete on a row already soft-deleted 404s the same way a plain GET does
  // (both hit the generic crud factory's notFound-on-deleteTime) - either the toast, or the row's own
  // disappearance outlasting it, proves the press landed.
  await expect(async () => {
    const gotToast = await toast(page, "Event deleted").count();
    const gone = (await page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).count()) === 0;
    expect(gotToast || gone).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  await expect(page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws notFound
  // on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/events?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((r) => r.path === path);
  expect(found?.delete_time, "the event should survive soft-deleted, not be gone entirely").toBeTruthy();
});
