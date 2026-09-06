import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// A count called off rather than closed.
//
// Closing a stocktake freezes a report: what was sighted, what is missing, what turned up somewhere else.
// Abandoning one is the other ending - the walk was started by mistake, or superseded - and the two must not
// be confused, because a closed count is evidence and an abandoned one produces nothing. So the question the
// browser asks has to say which is which, and say what happens to the sightings already made (they stay on
// the assets; they were real).
//
// `stocktakes` covers opening a count, scanning a tag into it and closing it into a frozen report.
// `test/` owns the arithmetic. What only a browser shows is this second ending: the affordance beside Close,
// the question that distinguishes them, and the count leaving the list.
test("a count is abandoned, with the question saying what that costs", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const label = `E2E abandoned ${Date.now() % 1_000_000}`;
  // The count is hard-purged at the end while the page is still watching it, so a read already in flight comes
  // back 404. That is this spec's own housekeeping, not the app failing.
  allowConsoleErrors(page, /status of 404/i);

  // A count of this spec's own, opened over the wire - starting one is `stocktakes`' subject.
  const created = await page.request.post("/v1/stocktakes", {
    headers: SPA_HEADERS,
    data: { label },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "stocktakes", "Stocktakes");
    // Scoped to THIS count's row: the list holds every count running in the org, and the button being pressed
    // here throws one away.
    const row = page.locator("div.rounded-lg.border").filter({ hasText: label }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Both endings are offered while a count is open, which is the point: the destructive one is the quiet
    // icon beside the one people mean.
    // "Close" in the row, "Close count" on the count's own page - the row has the label beside it.
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Abandon count" }).click();

    // The question names the count and says what abandoning costs - "close it instead if you want the
    // numbers" is the sentence that stops somebody throwing away an afternoon's walk.
    const ask = page.getByRole("dialog").filter({ hasText: `Abandon "${label}"?` });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText(/nothing is lost|Close it instead/)).toBeVisible();
    await ask.getByRole("button", { name: "Abandon", exact: true }).click();

    // Not running any more, and gone on the server: an abandoned count is not a closed one with an empty
    // report. Asserted on what the row OFFERS rather than on the words on the page - the page keeps a table of
    // finished counts too, so "the label is nowhere on screen" would be a different (and wrong) claim.
    const gone = page.locator("div.rounded-lg.border").filter({ hasText: label });
    await expect(gone.getByRole("button", { name: "Close count" })).toHaveCount(0, { timeout: 30_000 });
    await expect(gone.getByRole("button", { name: "Abandon count" })).toHaveCount(0);
    await expect.poll(() => deleted(page, path), { timeout: 30_000 }).toBe(true);
  } finally {
    await purge(page, path);
  }
});

/** Whether the count has been taken off the list - soft-deleted, or gone entirely. */
async function deleted(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}`);
  if (res.status() === 404) return true;
  if (!res.ok()) return false;
  return !!((await res.json()) as { delete_time?: string }).delete_time;
}
