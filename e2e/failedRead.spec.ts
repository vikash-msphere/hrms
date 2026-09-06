import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// What a page does when the read behind it fails.
//
// Every list in the app is one component's `DataState`: skeletons while it loads, the rows when it lands, and
// - the case nobody ever sees in development - a panel that says the read failed and offers to try again.
// That third branch is the difference between "the server had a moment" and "this feature is broken": without
// it a failed read is an empty table, which reads as "there is nothing here" and sends somebody to raise a
// ticket about missing data.
//
// It cannot be provoked from the server (the app would have to actually break), so the failure is injected in
// the browser: the page's reads are coalesced into one `POST /v1/batch:run`, and this rewrites the sub-response
// for the collection under test into a 500 while leaving every other read alone - the shell, the nav and the
// caller's own identity keep working, which is exactly the situation the panel is drawn for.
//
// `offline` covers the whole network going away (a bar, and a re-read when it returns). This is the other
// shape: one read failing while everything else is fine.
test("a failed read says so on the panel, and Try again recovers it", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // A failed request is logged by the browser. That IS the scenario.
  allowConsoleErrors(page, /Failed to load resource|500|Internal Server Error/i);

  // Break exactly one collection's read, and only while `breaking` is true - the same route handler then
  // hands the page a healthy answer for the retry below.
  let breaking = true;
  await page.route("**/v1/batch:run", async (route) => {
    if (!breaking) return route.fallback();
    const body = route.request().postDataJSON() as { requests?: { path?: string }[] } | null;
    const requests = body?.requests ?? [];
    if (!requests.some((r) => (r.path ?? "").includes("/vendors"))) return route.fallback();

    // The real answer, with the one sub-response swapped for a failure: everything else on the page has to
    // keep working, or this would be testing an offline app rather than a broken read.
    const upstream = await route.fetch();
    const json = (await upstream.json()) as { responses?: { status: number; body: unknown }[] };
    const responses = (json.responses ?? []).map((r, i) =>
      (requests[i]?.path ?? "").includes("/vendors")
        ? { status: 500, body: { type: "/errors/internal", title: "Internal Server Error", status: 500 } }
        : r,
    );
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ responses }) });
  });

  await gotoRoute(page, "vendors", "Vendors");

  // The panel, not an empty table: the reader is told the read failed rather than that there are no vendors.
  await expect(page.getByText("Couldn't load this data")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // And the page around it is intact - this is one panel failing, not the app falling over.
  await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible();

  // The offer works: with the read healthy again, the same button reloads the panel in place. A "Try again"
  // that needs a page reload to work is a button that lies.
  breaking = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Couldn't load this data")).toHaveCount(0, { timeout: 30_000 });
  // The table is back in its place - asserted on the footer every DataTable draws, which says either how many
  // rows there are or that there are none. Either answer is the panel working; neither is the failure state.
  await expect(page.getByText(/^Showing \d+-\d+ of|^No records$/).first()).toBeVisible({ timeout: 30_000 });
});
