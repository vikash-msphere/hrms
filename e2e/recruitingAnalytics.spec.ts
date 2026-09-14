import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The recruiting funnel, source effectiveness and offer outcomes - all DERIVED, client-side, from four
// collections nobody writes through this page. `ats.spec.ts` proves the pipeline is reachable end to end;
// nothing proves this READ-ONLY rollup actually adds up what it claims to, or that its tiles go anywhere.
//
// The seeded org already has months of ATS activity, so an assertion on an absolute count or percentage
// would be reading numbers this spec did not put there. Two ways round that: the source-effectiveness table
// is asserted on a source string nobody else uses (so its row is exactly this spec's own two applications,
// nothing blended in), and the "Open jobs" / "Candidates" tiles are asserted as a BEFORE/AFTER delta.
test("the funnel, source table and offer counts reflect what was actually filed, and its tiles navigate", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const source = `e2e_analytics_${stamp}`; // -> "E2e Analytics <stamp>" once sourceLabel title-cases it
  const roleTitle = `E2E Analytics Role ${stamp}`;
  const made: { collection: string; path: string }[] = [];

  try {
    await gotoRoute(page, "recruiting-analytics", "Recruiting analytics");
    // Only a real org is guaranteed the "months of ATS activity" the header comment above describes - a fresh
    // isolated DB (a single spec run alone) starts with none of the three collections this page reads populated
    // at all, and the page's own EmptyState shows instead of the SummaryStrip/charts. Every "before" reading is
    // then 0 by construction rather than something to find on a page that has nothing to show yet.
    const emptyState = page.getByText("No recruiting activity yet");
    const openJobsTile = page.getByRole("button", { name: /Open jobs/ });
    // `gotoRoute` only waits for the page shell - the collection reads behind DataState are a separate async
    // fetch, and checking which of the two mutually-exclusive outcomes landed right after can catch neither.
    await expect(emptyState.or(openJobsTile)).toBeVisible({ timeout: 30_000 });
    const empty = await emptyState.isVisible();
    const openJobsBefore = empty ? 0 : await tileValue(page, "Open jobs");
    const candidatesBefore = empty ? 0 : await tileValue(page, "Candidates");
    const screeningBefore = empty ? 0 : await chartRowValue(page, "Active applications by pipeline stage", "Screening");
    const awaitingBefore = empty ? 0 : await chartRowValue(page, "Offers by outcome", "Awaiting a reply");

    // One open requisition, one candidate per application (an application needs its own person - reusing one
    // would make "hired" and "still active" true of the same candidate at once, which nothing here checks for
    // but is not a story worth telling by accident).
    const req = await post(page, "job-requisitions", { title: roleTitle, status: "open" });
    made.push({ collection: "job-requisitions", path: req.path });
    const candA = await post(page, "candidates", { name: `E2E Analytics Cand A ${stamp}`, email: `e2e.acand.a.${stamp}@example.com` });
    made.push({ collection: "candidates", path: candA.path });
    const candB = await post(page, "candidates", { name: `E2E Analytics Cand B ${stamp}`, email: `e2e.acand.b.${stamp}@example.com` });
    made.push({ collection: "candidates", path: candB.path });

    // Two applications on the same made-up source: one still active on a mid-pipeline stage (funnel), one
    // hired (source conversion). Together they own that source's entire row - total 2, hired 1, 50%.
    // `status` is never taken from the body (createApplication derives it from `stage` alone via
    // statusForStage - a hired-kind stage IS what makes it "hired"), so it is the stage doing the work here.
    const appActive = await post(page, "applications", { candidate: candA.path, requisition: req.path, source, stage: "screening" });
    made.push({ collection: "applications", path: appActive.path });
    const appHired = await post(page, "applications", { candidate: candB.path, requisition: req.path, source, stage: "hired" });
    made.push({ collection: "applications", path: appHired.path });

    // An offer, extended and left hanging: exercises the "awaiting a reply" count without ever answering it -
    // deliberately stopping short of :accept (which converts the candidate to a real employee, seeding a
    // person this spec would then also have to clean up) or :decline. Draft -> extended is its own two verbs
    // (offers.spec.ts owns that walk); this only needs the state it lands in.
    const offer = await post(page, "offers", { application: appHired.path, base_comp: 1_500_000 });
    made.push({ collection: "offers", path: offer.path });
    for (const verb of ["approve", "extend"]) {
      const res = await page.request.post(`/v1/${offer.path}:${verb}`, { headers: SPA_HEADERS });
      expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
    }

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Recruiting analytics" })).toBeVisible({ timeout: 30_000 });

    // The two tiles a fresh requisition and a fresh candidate actually move - a whole-org count, so only the
    // DELTA is this spec's to claim (one open job, two candidates: A and B), and only as a FLOOR: the ATS specs
    // run alongside this one and file their own requisitions, candidates and applications against the same org,
    // so an exact delta asserts that nobody else wrote anything for the length of this test - which is not true
    // and is not what this page is being asked. What this spec owns exactly is the source row below, whose
    // stamped source string belongs to nobody else.
    await expect.poll(() => tileValue(page, "Open jobs"), { timeout: 30_000 }).toBeGreaterThanOrEqual(openJobsBefore + 1);
    await expect.poll(() => tileValue(page, "Candidates"), { timeout: 30_000 }).toBeGreaterThanOrEqual(candidatesBefore + 2);

    // Both `Chart`s render an sr-only <table> mirroring their exact plotted numbers (Chart.tsx's own
    // accessibility fallback) - the one place either chart's actual values are readable at all, frappe-charts
    // itself being canvas/SVG with nothing a locator can read. The still-active application landed on
    // "Screening"; the extended offer is exactly one more reply nobody has given yet.
    // Floors for the same reason as the tiles: both rows count the whole org, and `ats.spec.ts` / `offers.spec.ts`
    // put their own applications on Screening and their own offers out for a reply while this runs.
    await expect.poll(() => chartRowValue(page, "Active applications by pipeline stage", "Screening"), { timeout: 30_000 }).toBeGreaterThanOrEqual(screeningBefore + 1);
    await expect.poll(() => chartRowValue(page, "Offers by outcome", "Awaiting a reply"), { timeout: 30_000 }).toBeGreaterThanOrEqual(awaitingBefore + 1);

    // The source table: this row belongs to nobody else, so its three numbers are exact, not a delta.
    // Scoped to the table that actually has a "Conversion" column - a bare `tbody tr` also matches the bar
    // Chart's own sr-only mirror table just above it (same source label, no % column), which the same source
    // string then matches twice over. Filtered on THIS run's own stamp, not just "E2e Analytics", so a prior
    // retry's still-cleaning-up row (a different stamp, same label prefix) cannot count as a second match either.
    const sourceTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Conversion" }) });
    const sourceRow = sourceTable.locator("tbody tr").filter({ hasText: String(stamp) });
    await expect(sourceRow).toBeVisible({ timeout: 30_000 });
    await expect(sourceRow.locator("td").nth(1)).toHaveText("2");
    await expect(sourceRow.locator("td").nth(2)).toHaveText("1");
    await expect(sourceRow.locator("td").nth(3)).toContainText("50%");

    // The tile is the same "awaiting a reply" number read a second way (SummaryStrip's own aggregate, not
    // the chart's) - it only exists once that count is above zero, which this offer now guarantees.
    // Anchored, and requiring the COUNT that follows the label: the donut beside these tiles has a slice of
    // the same name and its rows are pressable too, so a bare /Awaiting a reply/ now matches both and the
    // strict-mode violation names neither. The tile reads "Awaiting a reply <n> extended, no answer"; the
    // chart's row is exactly the label. Both controls existing is correct - they are two ways to the same
    // offers - so the locator is what has to say which one this line means, and this line means the tile.
    await expect(page.getByRole("button", { name: /^Awaiting a reply\s+\d/ })).toBeVisible({ timeout: 30_000 });

    // A tile is a door, not just a number: it lands on the page that owns the rows it counted, already
    // focused on the same slice.
    await page.getByRole("button", { name: /Candidates/ }).click();
    await expect.poll(() => page.url()).toContain("#/candidates");
    await gotoRoute(page, "recruiting-analytics", "Recruiting analytics");
    await page.getByRole("button", { name: /Open jobs/ }).click();
    await expect.poll(() => page.url()).toContain("#/job-requisitions?focus=open");
  } finally {
    // Children before parents (offer -> applications -> candidates -> requisition): a purge cascade is only
    // declared where the app actually wants one, and nothing says applications/offers are it - an FK still
    // pointing at a row this loop just deleted 409s rather than cascading.
    for (const m of [...made].reverse()) await purge(page, m.path).catch(() => undefined);
  }
});

/**
 * A `Chart`'s own plotted number for one label, read off its sr-only accessible `<table>` (Chart.tsx builds
 * one alongside every chart, captioned with the same `ariaLabel` the chart itself carries) rather than the
 * canvas/SVG frappe-charts draws, which has nothing a locator can read.
 */
async function chartRowValue(page: import("@playwright/test").Page, caption: string, rowLabel: string): Promise<number> {
  const table = page.locator("table").filter({ has: page.locator("caption", { hasText: caption }) });
  const row = table.locator("tbody tr").filter({ has: page.getByRole("rowheader", { name: rowLabel, exact: true }) });
  // A category with nothing in it is not plotted, so it has no row - and an absent row IS zero, not a page that
  // failed to load. Waiting 15s for it to appear and then throwing is how a "before" reading taken while the org
  // happened to have no offer out for a reply failed the whole spec. Every caller either polls for the value it
  // expects or is establishing a baseline, so both are answered correctly by 0.
  if ((await row.count()) === 0) return 0;
  const text = await row.locator("td").first().innerText();
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** The SummaryStrip tile's own number - its value span is `tabular-nums`, the one span of the three that is. */
async function tileValue(page: import("@playwright/test").Page, label: string): Promise<number> {
  const tile = page.getByRole("button", { name: new RegExp(label) });
  // Same as `chartRowValue`: the strip drops a tile whose count is zero, so an absent tile is a zero to read,
  // not an error to raise.
  if ((await tile.count()) === 0) return 0;
  const text = await tile.locator("span.tabular-nums").innerText();
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** POST straight to the collection - this spec is about the analytics READ, not any of the four write forms. */
async function post(page: import("@playwright/test").Page, collection: string, data: Record<string, unknown>): Promise<{ path: string }> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { path: string };
}
