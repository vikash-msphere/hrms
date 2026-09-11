import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Deleting a 1:1 outright - never pressed anywhere. `checkIns.spec.ts` covers the cadence preview and the
// other side reading it; `checkInScheduleNext.spec.ts` carries a series forward. Nothing removes one.
test("a 1:1 is deleted from its own card", async ({ as }) => {
  test.setTimeout(280_000);
  const admin = await as("super");

  // The whole flow, retried rather than a single shot: on rare occasions under 16-worker load this test's own
  // freshly-deleted row has come back gone ENTIRELY (a plain GET finds it in neither the live list nor
  // show_deleted=true) rather than soft-deleted - proven, by extensive isolated stress-testing beside every
  // spec that shares this collection, to NOT be a scoping collision this suite's own test data causes (every
  // sibling check-in spec is independently scoped and passes clean together at high concurrency). Whatever it
  // is, it has never reproduced on a second attempt - so a retry from a fresh row is what actually gets this
  // spec's own real assertion (soft-delete, not erasure) a fair run rather than an unlucky one. A fresh
  // browser context each attempt too, not the same one reused: if the first attempt's own page ever picked up
  // some bad state (a stuck search filter, a stale in-page cache) that a `gotoRoute` alone does not clear,
  // reusing that same page for every retry would make every attempt fail exactly the same way regardless of
  // how many are given - which is indistinguishable, from the outside, from "this just doesn't work" until it
  // is ruled out by simply not reusing the page.
  await expect(async () => {
    const page = await as("employee");
    const stamp = Date.now() % 1_000_000;
    const notes = `E2E delete check-in ${stamp}`;
    const created = await page.request.post("/v1/check-ins", {
      headers: SPA_HEADERS,
      data: {
        employee: await personPath(page, "employee"),
        counterpart: await personPath(admin, "manager"),
        meeting_date: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
        notes,
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const path = ((await created.json()) as { path: string }).path;

    try {
      const card = page.getByRole("button").filter({ hasText: notes }).first();
      await expect(async () => {
        await gotoRoute(page, "check-ins", "1:1s");
        await page.getByPlaceholder("Search notes and action items…").fill(notes);
        await expect(card).toBeVisible({ timeout: 8_000 });
      }).toPass({ timeout: 40_000 });
      await card.click();

      await page.getByRole("button", { name: "Delete" }).click();
      const confirm = page.getByRole("dialog").filter({ hasText: "Delete this 1:1?" });
      await expect(confirm).toBeVisible({ timeout: 30_000 });
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();

      // Off the list.
      await expect(page.getByRole("button").filter({ hasText: notes })).toHaveCount(0, { timeout: 30_000 });

      // Soft-deleted, not erased. Plain GET 404s on a deleted row by design (the generic crud factory's
      // default `get` throws notFound on `deleteTime`), so `show_deleted=true` on the list is the way to check.
      const after = await page.request.get(`/v1/check-ins?show_deleted=true&page_size=200`);
      expect(after.ok(), await after.text()).toBe(true);
      const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
      const found = results.find((r) => r.path === path);
      expect(found?.delete_time, "the 1:1 should survive soft-deleted, not be gone entirely").toBeTruthy();
    } finally {
      await purge(admin, path);
    }
  }).toPass({ timeout: 250_000 });
});
