import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// "Something new landed here while you were away."
//
// Every tab bar in the app can carry a count of rows that appeared since the caller last looked at that tab.
// It is a whole mechanism and it is invisible from anywhere but a browser: the reference point is a per-user
// preferences row with a localStorage cache, a tab never seen before is BASELINED to now (so a first visit
// never badges the whole backlog), the counts arrive from one `GET /v1/activity-counts` for the entire bar
// rather than by fetching each collection, and visiting a tab is what clears it.
//
// The two shapes both exist, so both are walked: a workspace's tab bar (sibling routes) and a page's own
// sub-tabs (scopes of one collection, counted from the rows the page already holds).
test.describe("new-activity badges", () => {
  test("a workspace tab counts what arrived while its neighbour was open, and the visit clears it", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");
    const author = await as("super");
    const name = `E2E badge vendor ${Date.now()}`;

    // The baseline is MADE, not assumed. A first visit baselines a tab to now - but this desk is a seeded
    // person the whole suite signs in as, and its reference point survives in a preferences row, so a vendor
    // some earlier spec wrote has the tab already badged before this test starts. Visiting the tab is what
    // sets the reference, so the way to a known-empty badge is to look at it.
    await gotoRoute(page, "expenses", "Expenses");
    const vendors = page.getByRole("navigation", { name: "Sections in this workspace" }).getByRole("link", { name: /^Vendors/ });
    await expect(vendors).toBeVisible({ timeout: 30_000 });
    await vendors.click();
    await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible({ timeout: 30_000 });
    await gotoRoute(page, "expenses", "Expenses");
    await expect(vendors).toHaveText("Vendors", { timeout: 30_000 });

    // A row arrives in the neighbouring tab's collection, written by somebody else - a badge that only its
    // own author's browser can raise is worthless.
    const made = await author.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: name } });
    expect(made.status(), await made.text()).toBe(200);
    const vendor = (await made.json()) as { path: string };

    // The count comes back on the next load, for the whole bar at once.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(vendors).toHaveText(/^Vendors\d+$/, { timeout: 30_000 });

    // Visiting is what clears it - there is no "mark as read" here, because looking at the tab IS reading it.
    await vendors.click();
    await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible({ timeout: 30_000 });
    const expenses = page.getByRole("navigation", { name: "Sections in this workspace" }).getByRole("link", { name: /^Expenses/ });
    await expect(expenses).toHaveText("Expenses");

    // And it stays cleared from cold: the reference the next visit measures against is stored, not held in
    // the page that cleared it.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await gotoRoute(page, "expenses", "Expenses");
    await expect(vendors).toHaveText("Vendors", { timeout: 30_000 });

    await purge(author, vendor.path);
  });

  test("a page's own sub-tab counts new rows in its scope", async ({ as }) => {
    test.setTimeout(180_000);
    const desk = await as("hr");
    const requester = await as("employee");
    const subject = `E2E badge ticket ${Date.now()}`;

    // Baseline, then away: the "All" tab is a scope of the tickets the page already reads, so its badge is
    // counted in the browser rather than asked for.
    await gotoRoute(desk, "tickets", "Support");
    const all = desk.getByRole("tab", { name: /^All/ });
    await expect(all).toBeVisible({ timeout: 30_000 });
    await expect(all).toHaveText("All");
    await gotoRoute(desk, "dashboard");

    const made = await requester.request.post("/v1/tickets", {
      headers: SPA_HEADERS,
      data: { subject, category: "it", description: "Raised by the e2e suite, to light up a tab." },
    });
    expect(made.status(), await made.text()).toBe(200);
    const ticket = (await made.json()) as { path: string };

    await gotoRoute(desk, "tickets", "Support");
    // A number, not "1": several specs share this desk and raise their own tickets, so what is asserted is
    // that the arrival was counted at all.
    await expect(all).toHaveText(/^All\d+$/, { timeout: 30_000 });

    // Visiting is what clears it - the tab this desk is now looking at cannot also be advertising that
    // something new landed on it. (What the table itself lists is `tickets.spec.ts`'s business.)
    await all.click();
    await expect(all).toHaveAttribute("aria-selected", "true");
    await expect(all).toHaveText("All", { timeout: 30_000 });

    await purge(desk, ticket.path);
  });
});
