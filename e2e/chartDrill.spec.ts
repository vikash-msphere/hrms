import { readdirSync, readFileSync } from "node:fs";
import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Clicking a chart filters the list under it.
//
// The mechanism is entirely `components/common/Chart.tsx`'s: frappe has no click API, so the primitive
// resolves the press out of the SVG itself - `data-point-index` on a bar or a dot, a slice's place in the
// library's own component store for pie/donut/percentage, `data-date` on a heatmap square. None of that is
// checkable outside a browser, and all of it is the kind of thing a library upgrade quietly renames.
//
// Two things are asserted here that no other spec can see:
//
// * The press RESOLVES, on both paths (an axis unit and an aggregation slice), lands the pick in the URL,
//   and narrows the list to it. The URL matters: it is what makes a narrowed page shareable and what the
//   back button undoes.
// * The press TOGGLES. The library's own `data-select` refused to fire twice for the same point, so a filter
//   could be turned on from the picture and never off - the single worst thing about the old behaviour, and
//   invisible to any test that only ever clicks once.

test.describe("chart drill-through", () => {
  // Every chart in the app either filters something or says why it does not. A picture beside a list that
  // cannot be pressed is the state this whole change exists to leave behind, so a NEW chart has to opt out
  // deliberately rather than by being forgotten - the same bargain `everyChart.spec.ts` strikes for coverage.
  //
  // Keyed by a distinctive phrase from the chart's own `ariaLabel`, because that is the one prop that has to
  // be there and has to describe what is drawn.
  const EXEMPT: Record<string, string> = {
    "Cumulative flow": "a point is a count on a past day, not a set of cards anything can be narrowed to",
    "Sprint burndown": "a point is the points still open on a past day - a number, not a set of cards",
    "How this payroll run's cost divides": "each slice is a component of every line's cost, so one slice is the whole table",
    "Weighted goal attainment across the cycle": "a point is the cycle's attainment on a date - a percentage, not a set of reviews",
  };

  test("every chart is either a filter or a declared exception", () => {
    const dir = new URL("../web/src/", import.meta.url);
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(new URL(rel, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${rel}${e.name}/`);
        else if (e.name.endsWith(".tsx")) files.push(`${rel}${e.name}`);
      }
    };
    walk("");

    const unpressable: string[] = [];
    const staleExemptions = new Set(Object.keys(EXEMPT));
    let seen = 0;
    for (const rel of files) {
      const src = readFileSync(new URL(rel, dir), "utf8");
      // Each `<Chart …/>` element's own text. The lookahead keeps `<ChartCard>` out of it; the close is the
      // primitive's own formatting, a `/>` on its own line, which every call site in the app uses.
      for (const m of src.matchAll(/<Chart(?=[\s\n])/g)) {
        const rest = src.slice(m.index);
        const end = rest.search(/\n\s*\/>/);
        if (end < 0) continue;
        const block = rest.slice(0, end);
        seen++;
        const aria = /ariaLabel=\{?["`]([^"`]+)/.exec(block)?.[1] ?? "(no ariaLabel)";
        // A select callback, direct or spread in from `lib/chartFocus.ts` (`{...cf.chart("state")}`).
        const pressable = /onSelect(Day)?=/.test(block) || /\{\.\.\.[\w.]*[cC]hart\(/.test(block);
        if (pressable) continue;
        const excuse = Object.keys(EXEMPT).find((k) => aria.includes(k));
        if (excuse) { staleExemptions.delete(excuse); continue; }
        unpressable.push(`${rel} · "${aria}"`);
      }
    }

    expect(seen, "no <Chart> found at all - the scan is broken, not the app").toBeGreaterThan(20);
    expect(unpressable, `these charts filter nothing and claim no reason:\n${unpressable.join("\n")}`).toEqual([]);
    expect([...staleExemptions], "these exemptions name charts that no longer exist").toEqual([]);
  });

  test("a bar and a slice each narrow the list, and pressing the same one again clears it", async ({ as }) => {
    const page = await as("super");

    // The queue charts only draw once there is a queue to chart (`rows.length > 2`), and the point of this
    // spec is two DIFFERENT categories to press between - so it brings its own.
    const stamp = Date.now();
    const raised: string[] = [];
    for (const [i, category] of ["it", "facilities", "hr"].entries()) {
      const res = await page.request.post("/v1/tickets", {
        headers: SPA_HEADERS,
        data: { category, subject: `E2E drill ticket ${i + 1} ${stamp}`, description: "Raised by the chart drill spec.", priority: "medium" },
      });
      expect(res.status(), await res.text()).toBe(200);
      raised.push(((await res.json()) as { path: string }).path);
    }

    try {
      await gotoRoute(page, "tickets", "Support");

      // ---- The axis path: a bar carries `data-point-index`, which IS the label index ----------------------
      const byCategory = page.locator("figure").filter({ has: page.locator("figcaption", { hasText: "Open tickets by category" }) });
      const bars = byCategory.locator("svg [data-point-index]");
      // Polled: the primitive refuses to draw into a box with no width and rebuilds when it gets one, so the
      // first marks can appear a frame after the SVG does.
      await expect.poll(() => bars.count(), { timeout: 15_000 }).toBeGreaterThan(1);

      await bars.first().click();
      await expect.poll(() => page.url()).toContain("slice=category%3A");
      // The way back, said in words against the list - not only as a dimmed slice.
      const showAll = page.getByRole("button", { name: "Show all" });
      await expect(showAll).toBeVisible();
      // And the picture says which mark it is: the others are dimmed, the picked one is not.
      expect(await bars.first().evaluate((el) => (el as SVGElement).style.opacity)).toBe("");
      expect(await bars.nth(1).evaluate((el) => (el as SVGElement).style.opacity)).toBe("0.3");

      // Pressing the SAME bar clears - the half the library could not do at all.
      await bars.first().click();
      await expect.poll(() => page.url()).not.toContain("slice=");
      await expect(showAll).toBeHidden();

      // ---- The aggregation path: a donut slice carries nothing, and is resolved by its place in the
      // library's own store, then mapped back through its label ------------------------------------------
      const byState = page.locator("figure").filter({ has: page.locator("figcaption", { hasText: "Visible tickets by state" }) });
      const slices = byState.locator("svg path");
      await expect.poll(() => slices.count(), { timeout: 15_000 }).toBeGreaterThan(0);

      // Pressed ON THE RING, not at the element's centre. A donut slice's bounding box is the whole circle, so
      // Playwright's default click point - the centre of that box - is the HOLE. With several states drawn
      // that still lands on a neighbouring arc and the drill happens by luck; when every visible ticket is in
      // one state the slice is a single full ring (`A 30 30 0 1 0` twice, i.e. 360°) and the centre is over
      // nothing at all, so the press resolved no index and the URL never took a slice. The app is right here -
      // a reader clicks the ring they can see - so this clicks where the ink is.
      // Pressed with a REAL pointer, at a point taken off the path's own centreline.
      //
      // A donut slice is a stroked arc, not a filled shape, so its bounding box is the whole circle and every
      // point derived from that box - the centre Playwright aims at by default, or any fraction of it - can
      // land in the hole, where the `<svg>` takes the press instead. Guessing an offset would bake this
      // chart's radius and stroke width into the spec. `getPointAtLength` gives a point ON the path, and the
      // stroke is centred on it, so it is in the ink whatever the chart's size - and `getScreenCTM` maps it to
      // where the pointer has to go. A synthetic `dispatchEvent` would pass this line without proving a person
      // can press the slice at all, which is the one thing worth proving here.
      const at = await slices.first().evaluate((el) => {
        const p = el as unknown as SVGPathElement;
        const pt = p.getPointAtLength(p.getTotalLength() / 8);
        const m = p.getScreenCTM();
        if (!m) return null;
        return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
      });
      if (!at) throw new Error("e2e: the donut slice has no screen geometry to press");
      await page.mouse.click(at.x, at.y);
      await expect.poll(() => page.url()).toContain("slice=state%3A");
      await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();

      // A reload keeps it: the pick is in the URL, which is what makes a narrowed page shareable.
      await page.reload();
      await expect.poll(() => page.url()).toContain("slice=state%3A");
      await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();

      await page.getByRole("button", { name: "Show all" }).click();
      await expect.poll(() => page.url()).not.toContain("slice=");
    } finally {
      for (const ticket of raised) await purge(page, ticket);
    }
  });
});
