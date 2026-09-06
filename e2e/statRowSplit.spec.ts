import { gotoRoute, test, expect } from "./fixtures";

// Seven segments, at a width that can only hold four across: four then three, not four then three-and-a-gap.
//
// `lib/statRows.ts` is pure arithmetic (which row size each item gets, at each container-width rung) and pins
// itself against a unit test. What no unit test can see is the thing it exists FOR: a browser laying out a
// wrapping flex row and the split actually landing where the container-query breakpoint says it should, with
// the SHORT row stretched to the full width rather than left at its naive per-item share with a hole after it
// - the exact defect the module's own doc comment names ("4+3, never 4+3-and-a-gap"). The Assets summary
// strip is the one place in the app with a genuinely unfiltered seven (`test/` pins the count; this pins the
// pixels).
test("the Assets summary strip splits seven segments 4-then-3, both rows filling the width", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  await gotoRoute(page, "assets", "Assets");

  const strip = page.locator(".stat-row").first();
  await expect(strip).toBeVisible({ timeout: 30_000 });

  // The cap is read off the CONTAINER's width (a CSS container query), not the viewport's - find a viewport
  // that puts it inside [720, 1000), the one rung STRIP_CAPS gives a cap of 4 for. Content width scales 1:1
  // with viewport width (the sidebar and page padding are both fixed), so one measured correction lands it.
  await page.setViewportSize({ width: 1300, height: 900 });
  let box = await strip.boundingBox();
  if (!box) throw new Error("e2e: the summary strip has no layout box");
  if (box.width < 720 || box.width >= 1000) {
    const target = 860; // the middle of the [720, 1000) rung
    await page.setViewportSize({ width: Math.round(1300 + (target - box.width)), height: 900 });
    box = await strip.boundingBox();
    if (!box) throw new Error("e2e: the summary strip lost its layout box after resizing");
  }
  expect(box.width, `container landed at ${box.width}px, outside the cap-4 rung`).toBeGreaterThanOrEqual(720);
  expect(box.width).toBeLessThan(1000);

  const tiles = strip.locator("button");
  // Total, plus the six asset bands (Awaiting scan/Assigned/In stock/In repair/No tag/Unseen) - a stray
  // "Yours to confirm" tile (this caller has custody to confirm) would change the count and the split with
  // it, so this fails loudly rather than silently checking the wrong split.
  await expect(tiles).toHaveCount(7);

  const boxes: { x: number; y: number; width: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const b = await tiles.nth(i).boundingBox();
    if (!b) throw new Error(`e2e: tile ${i} has no layout box`);
    boxes.push(b);
  }

  // Group by row (rounded top, to absorb sub-pixel rounding across sibling cells).
  const rows = new Map<number, typeof boxes>();
  for (const b of boxes) {
    const key = Math.round(b.y);
    const row = rows.get(key);
    if (row) row.push(b);
    else rows.set(key, [b]);
  }
  const ordered = [...rows.entries()].sort(([a], [b]) => a - b).map(([, cells]) => cells);
  expect(ordered.length, "seven segments at a cap of 4 should wrap to exactly two rows").toBe(2);
  expect(ordered.map((r) => r.length)).toEqual([4, 3]);

  // Both rows reach the container's own right edge - the "stretched" half of the claim. A naive fixed-4-column
  // layout would leave the second row at 3/4 width with a bare corner after it.
  const containerRight = box.x + box.width;
  for (const row of ordered) {
    const last = row.reduce((a, b) => (b.x > a.x ? b : a));
    expect(last.x + last.width, "a row did not stretch to the container's edge").toBeGreaterThan(containerRight - 2);
  }
});
