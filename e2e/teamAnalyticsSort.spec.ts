import { gotoRoute, test, expect } from "./fixtures";

// The table's own header buttons are the only sort control on the page - three clicks cycle desc -> asc ->
// off (`toggleSort`), and nothing has ever pressed one. Which measure ends up first (the overview tab, in
// `HIGHLIGHT_METRICS` order, filtered to whatever the server actually sent) is not this spec's to predict, so
// it sorts whichever column landed first rather than naming one - the ordering claim holds for any of them.
//
// "First" still needs to mean something sortable: seed attendance/leave/goals activity is dated relative to a
// FIXED anchor baked into scripts/genSeed.ts (not to today), and no `range` picker choice re-anchors it to the
// real clock - so whichever measure HIGHLIGHT_METRICS puts first (punctuality, most often) can be null for
// every single person while a later column has plenty to rank. The spec already declines to name the measure;
// it also has to decline to assume the FIRST one is the one with numbers, and try columns until one qualifies.
test.describe("team analytics: column sort", () => {
  test("a header click sorts its column, a second reverses it, a third clears it", async ({ as }) => {
    test.setTimeout(60_000);
    const page = await as("super");
    await gotoRoute(page, "team-analytics", "Team analytics");

    // Scoped to the roster table specifically: the page also carries a "Measure to compare" Chart just above
    // it, whose own sr-only accessible mirror table (Chart.tsx) is ALSO a `<table>` with a `<thead><th>` row -
    // a bare page-wide `thead th`/`tbody tr` matches both, and the chart's headers (no sort button on any of
    // them) can shift every index by however many columns that chart happens to have. "Person" is the one
    // header only the real roster carries.
    const rosterTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Person" }) });
    const bodyRows = rosterTable.locator("tbody tr");
    await expect(bodyRows.first()).toBeVisible({ timeout: 30_000 });
    const headerCount = await rosterTable.locator("thead th").count();

    // Column index i (0 is "Person") -> its values across people rows, "Team" (the trailing, unsorted rollup
    // row) dropped rather than assumed to sit last.
    const columnValues = async (i: number) => {
      const people = await rosterTable.locator("tbody tr td:first-child").allInnerTexts();
      const cells = await rosterTable.locator(`tbody tr td:nth-child(${i + 1})`).allInnerTexts();
      return cells
        .filter((_, r) => people[r]?.trim() !== "Team")
        .map((t) => t.match(/-?\d+(\.\d+)?/)?.[0])
        .filter((v): v is string => v !== undefined)
        .map(Number);
    };

    let col = -1;
    for (let i = 1; i < headerCount; i++) {
      if ((await columnValues(i)).length > 1) { col = i; break; }
    }
    expect(col, "no column has more than one person with a number to rank").toBeGreaterThan(0);

    const header = rosterTable.locator("thead th").nth(col);
    const sortButton = header.getByRole("button");
    const values = () => columnValues(col);

    // First click sorts desc (`toggleSort`'s own first branch) - the header swaps its unsorted hint (Info)
    // for the down arrow, not just any icon (which the hint already was).
    await sortButton.click();
    await expect(header.locator("svg.lucide-arrow-down")).toBeVisible({ timeout: 15_000 });
    // The icon flips as soon as the sort STATE does, which can still be a beat ahead of the re-sorted rows
    // actually landing (an async re-fetch, not a pure client re-order) - polled rather than read once right
    // after the icon, which can catch the table between clearing the old order and drawing the new one.
    await expect.poll(() => values().then((v) => v.length), { timeout: 15_000 }).toBeGreaterThan(1);
    const desc = await values();
    expect(desc.length, "no numeric values to rank in this column").toBeGreaterThan(1);
    for (let i = 1; i < desc.length; i++) expect(desc[i - 1]).toBeGreaterThanOrEqual(desc[i]!);

    await sortButton.click();
    await expect(header.locator("svg.lucide-arrow-up")).toBeVisible({ timeout: 15_000 });
    const asc = await values();
    for (let i = 1; i < asc.length; i++) expect(asc[i - 1]).toBeLessThanOrEqual(asc[i]!);

    // Off: the header falls back to its unsorted hint icon (Info), not an arrow either direction.
    await sortButton.click();
    await expect(header.locator("svg.lucide-arrow-up, svg.lucide-arrow-down")).toHaveCount(0, { timeout: 15_000 });
  });
});
