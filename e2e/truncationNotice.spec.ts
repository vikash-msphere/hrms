import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// A view admitting that it is showing a window.
//
// The server caps a list page, and the views that are not tables - a calendar, a board, a feed - render the
// cached rows without following the cursor. So any of them can be showing the first hundred records of a
// larger collection, and a view that looks complete but is not is worse than a slow one: a leave calendar
// quietly missing somebody's week off, a filter reporting "none" for a record that exists. The notice is the
// app admitting it.
//
// `test/listTruncation.test.ts` owns the server's cap, and `tablePaging` covers the table's own pager, which
// derives the same fact for itself. What only a browser shows is the notice: that a truncated read draws it,
// that it says which view is incomplete, and that a complete one draws NOTHING - a warning on every page is
// a warning nobody reads.
//
// The truncation is injected rather than manufactured: a hundred and one real leave requests would be a
// hundred and one rows every other spec then has to page past. The page's reads are coalesced into one
// `POST /v1/batch:run`, and this adds the `next_page_token` the store reads as "there is more" to the one
// collection under test, leaving every other read untouched.
test("a view whose collection is truncated says so, and one that is not says nothing", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");

  // Untouched first: the seed's leave requests fit in a page, so the calendar must be silent. This is the
  // half that stops the notice becoming furniture.
  await gotoRoute(page, "leave-calendar", "Leave calendar");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(/Showing only the first page/)).toHaveCount(0);

  // Now the same page, with the leave-requests read coming back marked as a window.
  let truncating = true;
  await page.route("**/v1/batch:run", async (route) => {
    if (!truncating) return route.fallback();
    const body = route.request().postDataJSON() as { requests?: { path?: string }[] } | null;
    const requests = body?.requests ?? [];
    if (!requests.some((r) => (r.path ?? "").includes("/leave-requests"))) return route.fallback();

    // The real answer, doctored below - and it can go away underneath this handler: the page reloads and
    // navigates while the notice is being read, and Playwright DISPOSES an in-flight response along with the
    // request that is no longer wanted ("apiResponse.json: Response has been disposed"). There is nothing to
    // doctor then, and nothing about this test's claim in it either, so the real one is let through.
    let json: { responses?: { status: number; body: unknown }[] };
    try {
      const upstream = await route.fetch();
      json = (await upstream.json()) as { responses?: { status: number; body: unknown }[] };
    } catch {
      return route.fallback().catch(() => undefined);
    }
    const responses = (json.responses ?? []).map((r, i) => {
      if (!(requests[i]?.path ?? "").includes("/leave-requests")) return r;
      // The one field that means "there is more of this": the store keeps it on the collection's meta, and
      // every non-table view asks the store rather than counting rows itself.
      const listed = (r.body ?? {}) as Record<string, unknown>;
      return { ...r, body: { ...listed, next_page_token: "e2e-there-is-more" } };
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ responses }) });
  });
  // The page re-reads through the doctored batch; a stale row cache would hide the point of the test.
  allowConsoleErrors(page, /status of (409|429)/i);
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();

  // Said in the reader's terms: which view is incomplete, and what to do about it.
  const notice = page.getByText(/Showing only the first page/);
  await expect(notice.first()).toBeVisible({ timeout: 30_000 });
  await expect(notice.first()).toContainText("this view is incomplete");
  await expect(notice.first()).toContainText("⌘K");

  // And it goes again once the collection fits: the notice is a fact about the data, not a flag somebody
  // turned on and forgot.
  truncating = false;
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(/Showing only the first page/)).toHaveCount(0, { timeout: 30_000 });
});
