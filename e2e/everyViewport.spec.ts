import { readFileSync } from "node:fs";
import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Every page, at every width the app claims to support.
//
// `phone` measures six routes at one phone size, and `everyPage` measures every route at one desktop size.
// Between them sits the range where responsive layouts actually break: the tablet, the small laptop, the
// half-screen window somebody has the app open in beside their calendar. A grid that is fine at 390 and fine
// at 1440 can still push a toolbar off the edge at 820, and nothing here has ever looked.
//
// So this walks every route the app can render at four widths and asks the one question a layout engine can
// answer and a source scan cannot: does the PAGE scroll sideways. Wide things are allowed to scroll inside
// their own box (a table, a board, a code block) - that is the convention `responsiveCoverage` pins in the
// source - but the document itself never should.
//
// The route list is the same one `everyPage` gates against `renderPage()`, read from that spec so the two
// cannot drift apart: a page added to the app fails `everyPage` first, and arrives here for free.
const WIDTHS: { label: string; width: number; height: number }[] = [
  { label: "phone", width: 390, height: 844 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "laptop", width: 1024, height: 768 },
  { label: "half-screen", width: 1280, height: 900 },
];

test("no page scrolls sideways at any supported width", async ({ as }) => {
  // Every route at four widths, in one browser: long by design, like the sweeps it sits beside.
  test.setTimeout(900_000);
  const page = await as("super");
  // This walk opens more pages than any other spec in the lane - fifty-odd routes, four times over - so it is
  // the one most likely to catch the lane's own load rather than a fault in a page: the dev Worker answering
  // 503 while sixteen browsers hammer it, telemetry rate-limited at 429, a parallel writer's 409. None of
  // them say anything about whether a layout scrolls sideways, which is the only question here.
  allowConsoleErrors(page, /status of (503|429|409)/i);
  const routes = readRoutes();
  expect(routes.length, "no routes were read from everyPage's table").toBeGreaterThan(20);

  const failures: string[] = [];
  for (const { label, width, height } of WIDTHS) {
    await page.setViewportSize({ width, height });
    for (const route of routes) {
      try {
        await gotoRoute(page, route);
        // The route's own reads have to land before the layout means anything: a page measured while its
        // table is still a skeleton is measuring the skeleton.
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        // Measured until it SETTLES, not once. A page is briefly too wide while it is still arriving - a
        // widget that mounts on view, a font swapping, a grid that lays out before its scroll box is styled -
        // and a single reading taken in that window reports a layout nobody ever sees. What matters is where
        // the page comes to rest: 1px of slack for sub-pixel rounding, anything more is a real sideways
        // scroll of the whole document.
        const overflow = await settledOverflow(page);
        if (overflow > 1) {
          // Named, not just counted: "167px too wide" sends somebody hunting through a page of nested
          // flexbox, and the element that actually sticks out is one DOM walk away.
          const culprits = await offenders(page, width);
          failures.push(`${route} at ${label} (${width}px): the page is ${overflow}px too wide${culprits.length ? ` - widest: ${culprits.join(" | ")}` : ""}`);
        }
      } catch (e) {
        failures.push(`${route} at ${label}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  expect(failures, `pages that scroll sideways:\n${failures.join("\n")}`).toEqual([]);
});

/** How much wider than its viewport the document is, once it has stopped moving. */
async function settledOverflow(page: import("@playwright/test").Page): Promise<number> {
  let last = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (now <= 1) return now;
    last = now;
    await page.waitForTimeout(500);
  }
  return last;
}

/**
 * The elements sticking out past the viewport, widest first.
 *
 * Only the ones whose own PARENT stays inside: an element pushed out by its container drags every ancestor
 * out with it, and a list of forty nested divs says nothing. The innermost offender is the one to look at.
 */
async function offenders(page: import("@playwright/test").Page, width: number): Promise<string[]> {
  return page.evaluate((vw) => {
    const out: { label: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      const parent = el.parentElement;
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > vw + 1) continue;
      const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
      out.push({ label: `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> right=${Math.round(r.right)}`, right: r.right });
    }
    return out.sort((a, b) => b.right - a.right).slice(0, 3).map((o) => o.label);
  }, width);
}

/** The routes `everyPage` walks - its table is the one that is gated against `renderPage()`. */
function readRoutes(): string[] {
  const src = readFileSync(new URL("./everyPage.spec.ts", import.meta.url), "utf8");
  const table = src.slice(src.indexOf("const PAGES: PageCase[] = ["), src.indexOf("];", src.indexOf("const PAGES")));
  return [...table.matchAll(/route: "([a-z0-9-]+)"/g)].map((m) => m[1]!);
}
