import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The charts, actually drawn.
//
// Every chart in the app goes through one primitive (`components/common/Chart.tsx`), which lazy-imports
// frappe-charts on first render - ~25KB most pages never draw - and then paints SVG into a host div. Nothing
// outside a browser can tell you any of that happened: `lib/chartTheme.ts` is unit-testable and the numbers
// are the page's own, but a broken dynamic import, a chart constructed against a host that is not in the
// document yet, or a library upgrade that renames its entry point all fail at exactly one moment - when
// somebody opens a page with a chart on it.
//
// The accessible half is asserted with it, because it is the half that silently rots: the picture is
// `aria-hidden`, so the table underneath it IS the chart for anyone not looking at pixels, and a chart whose
// table went missing looks perfect on screen.
test("a chart page loads the library on demand and draws real SVG", async ({ as }) => {
  const page = await as("super");

  // The queue charts only draw once there is a queue to chart (`rows.length > 2`), so this brings its own.
  const stamp = Date.now();
  const raised: string[] = [];
  for (const [i, category] of ["it", "facilities", "hr"].entries()) {
    const res = await page.request.post("/v1/tickets", {
      headers: SPA_HEADERS,
      data: { category, subject: `E2E chart ticket ${i + 1} ${stamp}`, description: "Raised by the chart spec.", priority: "medium" },
    });
    expect(res.status(), await res.text()).toBe(200);
    raised.push(((await res.json()) as { path: string }).path);
  }

  // A page with no chart on it: the library has not been fetched, which is the whole point of loading it lazily.
  await gotoRoute(page, "vendors", "Vendors");
  expect(await chartLibRequests(page)).toBe(0);

  await gotoRoute(page, "tickets", "Support");

  // The picture. `figure > svg` is the primitive's own shape - the host div the library paints into lives
  // inside the figure - so this is the library having run, not a placeholder or a skeleton.
  const queue = page.locator("figure").filter({ has: page.locator("figcaption", { hasText: "Visible tickets by state" }) });
  const svg = queue.locator("svg").first();
  await expect(svg).toBeAttached();
  // Measured by POLLING, not once: the primitive refuses to draw into a box with no width and rebuilds itself
  // when the box gets one (`Chart.tsx`'s ResizeObserver), so on a busy machine the first painted SVG can be
  // measured in the frame before the card has been laid out - and the rebuild that follows replaces the node.
  await expect
    .poll(async () => {
      const b = await svg.boundingBox();
      return Math.min(b?.width ?? 0, b?.height ?? 0);
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Fetched by the chart, not by the shell.
  await expect.poll(() => chartLibRequests(page)).toBeGreaterThan(0);

  // The numbers, for a reader who cannot see the picture. The `<table>` is `sr-only`, so it is asserted
  // through the accessibility tree rather than by visibility.
  const table = queue.locator("table");
  await expect(table.locator("caption")).toHaveText("Visible tickets by state");
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(0);

  // The second card is a different chart type through the same primitive - the axis path as well as the
  // donut one, since they take different branches inside the library.
  const byCategory = page.locator("figure").filter({ has: page.locator("figcaption", { hasText: "Open tickets by category" }) });
  await expect(byCategory.locator("svg").first()).toBeAttached();

  for (const ticket of raised) await purge(page, ticket);
});

// The shape every "top N" chart eventually meets: an org with exactly one of the thing.
//
// frappe cannot draw a line series through a single x - it emits `d="Mundefined,undefined"` and
// `cx="undefined"`, which the browser rejects, so the series is silently missing and the console fills with
// SVG parse errors. `components/common/Chart.tsx` draws a one-point chart as columns for that reason. The
// budgets page is where it shows: its chart is "the biggest caps in view", and one cap is one point.
test("a chart with a single data point draws without the browser rejecting it", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "expense-budgets", "Budgets");

  const chart = page.locator("figure").filter({ has: page.locator("figcaption", { hasText: "Spend against the cap" }) });
  await expect(chart.locator("svg").first()).toBeAttached();
  // The numbers are still all there for a reader who cannot see it - the point is not dropped, only drawn
  // differently.
  expect(await chart.locator("table tbody tr").count()).toBeGreaterThan(0);
  // A rejected attribute is a console error, which the `as` fixture fails the test on - so getting here with
  // the chart attached IS the assertion. Said out loud so the next reader does not delete it as redundant.
});

/** How many times this page has fetched the charting library. Its module name carries "frappe" in both the
 *  dev server's optimized deps and the built bundle's chunk name. */
async function chartLibRequests(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() =>
    performance.getEntriesByType("resource").filter((r) => /frappe/i.test(r.name)).length
  );
}
