import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The same idea, asked twice.
//
// A suggestion box collects duplicates - and left alone they split the vote, so the thing fifteen people want
// shows up as two rows of seven and eight and is answered as unpopular. Folding one into the other moves its
// votes and closes it pointing at the survivor. The whole of that decision is made in the triage dialog: the
// picker offers the rows it could be folded into (never itself, never one already merged), choosing one says
// in words what will happen to the votes, and the submit button changes its mind about what it is doing -
// merging IS the response, so the status half of the form goes away.
//
// `suggestions` covers the anonymity and the ordinary response; `suggestionVotes` covers the arrows.
// `test/` owns the vote transfer. What only a browser shows is the dialog changing shape around the choice,
// and the folded row afterwards saying where its idea went instead of looking like it was lost.
test("a duplicate is folded into another suggestion, and says where it went", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const keeper = `E2E keeper ${stamp}`;
  const duplicate = `E2E duplicate ${stamp}`;

  // Both written over the wire: the composer is `suggestions`' subject, and this spec starts once two rows
  // that are the same idea exist.
  const keeperPath = await file(page, keeper);
  const duplicatePath = await file(page, duplicate);

  try {
    await gotoRoute(page, "suggestions", "Suggestion Box");
    const card = page.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: duplicate }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Respond" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(duplicate).first()).toBeVisible();
    // The picker of things this could be a duplicate OF. Searched by name rather than picked off a list: the
    // board carries every other spec's suggestions too.
    await dialog.getByLabel("Duplicate of").click();
    await dialog.getByPlaceholder("Search suggestions…").fill(keeper);
    await dialog.getByRole("button", { name: new RegExp(`^${escapeRe(keeper)}`) }).first().click();

    // What the choice means, said before it is made - and the submit changing from answering to merging.
    await expect(dialog.getByText(new RegExp(`closes pointing at|votes? move to`))).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The folded row, on the board the submitter reads: not gone, and not silently unanswered - it names the
    // suggestion its idea is now part of.
    const folded = page.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: duplicate }).first();
    await expect(folded).toContainText(/Merged into/i, { timeout: 30_000 });
    await expect(folded).toContainText(keeper);

    // And from cold, because a merge that lives in the page's state is a duplicate still splitting the vote.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(
      page.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: duplicate }).first(),
    ).toContainText(/Merged into/i, { timeout: 30_000 });
  } finally {
    await purge(page, duplicatePath);
    await purge(page, keeperPath);
  }
});

/** A suggestion on the board. Returns its wire path. */
async function file(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.post("/v1/suggestions", {
    headers: SPA_HEADERS,
    data: { title, body: "Filed by the merge spec." },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Titles carry a timestamp, not regex metacharacters - but building a pattern out of data deserves this. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
