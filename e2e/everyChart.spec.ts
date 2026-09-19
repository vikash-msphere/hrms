import { readdirSync, readFileSync } from "node:fs";
import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Every chart in the app, drawn - and readable without eyes.
//
// `charts` proves the primitive: the library is fetched on demand, it paints real SVG, and the numbers are
// also in a table underneath. It proves it on two pages. This one is the WIDE version: seventeen pages draw
// charts, each with its own data shaping, and the ways they break are per-page rather than per-primitive - a
// series built from a field that is now undefined, a chart handed an empty array, a caption that stopped
// matching what it draws.
//
// The accessible half is asserted with every one of them, for the reason `charts` gives: the picture is
// `aria-hidden`, so the table IS the chart for anybody who cannot see it, and a chart whose table went
// missing looks perfect on screen. A page whose charts are all empty today (nothing has happened in that
// module yet) is not a failure - what fails is a figure with no picture in it, or a picture with no numbers.
//
// The page list is checked against the source, so a page that starts drawing charts and is never opened here
// fails this spec rather than going quietly uncovered.
type ChartPage = { route: string; heading: string; file: string };

const PAGES: ChartPage[] = [
  { route: "announcements", heading: "Feed", file: "Announcements.tsx" },
  { route: "assets", heading: "Assets", file: "Assets.tsx" },
  { route: "attendance", heading: "Attendance", file: "Attendance.tsx" },
  { route: "boards", heading: "Boards", file: "Boards.tsx" },
  { route: "compliance", heading: "Compliance Calendar", file: "Compliance.tsx" },
  { route: "employees", heading: "Directory", file: "Directory.tsx" },
  { route: "expense-budgets", heading: "Budgets", file: "ExpenseBudgets.tsx" },
  { route: "expenses", heading: "Expenses", file: "Expenses.tsx" },
  { route: "goals", heading: "Goals", file: "Goals.tsx" },
  { route: "leave-requests", heading: "Leaves", file: "Leaves.tsx" },
  { route: "payroll-runs", heading: "Payroll", file: "PayrollRuns.tsx" },
  { route: "payslips", heading: "Payslips", file: "Payslips.tsx" },
  { route: "recruiting-analytics", heading: "Recruiting analytics", file: "RecruitingAnalytics.tsx" },
  { route: "reviews", heading: "Reviews", file: "Reviews.tsx" },
  { route: "team-analytics", heading: "Team analytics", file: "TeamAnalytics.tsx" },
  { route: "tickets", heading: "Support", file: "Tickets.tsx" },
  { route: "timesheets", heading: "Timesheets", file: "Timesheets.tsx" },
];

// The charts this walk cannot reach, and the spec that reaches each one instead. A walk arrives on a page and
// judges what it draws; a chart that only exists after a press is somebody else's subject - but it still has
// to be SOMEBODY's, which is what this list is for. Every entry names a spec that opens it and asserts the
// same two things this file does: a picture with a box, and a table under it.
const ELSEWHERE: Record<string, string> = {
  "ReviewCycles.tsx": "reviewGoals.spec.ts (the cycle's attainment curve, inside the calibration panel)",
  "EmployeeProfile.tsx": "attendanceViews.spec.ts (the attendance tab's hours chart, on somebody's record)",
};

/** Does this source draw charts itself? */
const drawsDirectly = (src: string) => /from "@\/components\/common\/Chart"/.test(src);

test.describe("every chart", () => {
  test("the page list covers every page that draws a chart", () => {
    const dir = new URL("../web/src/pages/", import.meta.url);
    // A page can draw through a SHARED COMPONENT rather than importing the primitive itself - the attendance
    // history is one component on two surfaces (the reader's own page and an employee's record), and it
    // carries the hours chart with it. A scan that only read the page file called both of them chart-free,
    // which is how a page silently leaves this walk: not by deleting a chart, but by moving one.
    const componentDir = new URL("../web/src/components/", import.meta.url);
    const componentDraws = new Map<string, boolean>();
    const drawsVia = (spec: string): boolean => {
      const file = spec.replace(/^@\/components\//, "");
      const cached = componentDraws.get(file);
      if (cached !== undefined) return cached;
      let answer = false;
      try {
        answer = drawsDirectly(readFileSync(new URL(`${file}.tsx`, componentDir), "utf8"));
      } catch { /* an import that is not a component file of ours */ }
      componentDraws.set(file, answer);
      return answer;
    };
    const drawing = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => {
        const src = readFileSync(new URL(f, dir), "utf8");
        if (drawsDirectly(src)) return true;
        return [...src.matchAll(/from "(@\/components\/[\w/-]+)"/g)].some((m) => drawsVia(m[1]!));
      });
    const covered = new Set([...PAGES.map((p) => p.file), ...Object.keys(ELSEWHERE)]);
    expect(drawing.filter((f) => !covered.has(f)), "these pages draw charts that no browser test opens").toEqual([]);
    expect(PAGES.map((p) => p.file).filter((f) => !drawing.includes(f)), "these pages are listed here but draw no charts").toEqual([]);
    expect(Object.keys(ELSEWHERE).filter((f) => !drawing.includes(f)), "these pages are excused here but draw no charts").toEqual([]);
  });

  test("every chart draws a picture and carries its numbers in a table", async ({ as }) => {
    // Seventeen pages in one browser, each fetching its own data before it can draw anything.
    test.setTimeout(600_000);
    const page = await as("super");
    allowConsoleErrors(page, /status of 503/i);
    // Which page the walk is on, so an error caught here names it. Telemetry delivery is filtered for the
    // reason IGNORED_CONSOLE gives in fixtures.ts. A 503 is the same rare dev-Worker-restart hiccup documented
    // elsewhere in this suite (complianceRuleDelete.spec.ts et al.) landing on one of seventeen navigations in
    // one run - a page that genuinely fails to draw its charts still fails via `failures` below regardless.
    let current = "";
    const logged: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error" || /status of 429|status of 503/i.test(m.text())) return;
      logged.push(`${current}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

    const failures: string[] = [];
    let drawn = 0;
    for (const { route, heading } of PAGES) {
      current = route;
      await gotoRoute(page, route, heading);
      // Charts are rendered by one primitive as `<figure><figcaption>…</figcaption>…</figure>`, so the figures
      // on the page ARE its charts - no page-specific selector to keep in step.
      const figures = page.locator("figure").filter({ has: page.locator("figcaption") });
      // A page's charts arrive with its DATA, and `gotoRoute` returns as soon as the <h1> is up - a beat
      // before the first read lands. Counting there is a race the sweep loses WHOLESALE rather than one page
      // at a time: seventeen pages judged empty in 2.6 seconds, reported as "no page drew a single chart"
      // about an app that draws them all (2026-09-15, when one dropped `batch:run` was enough to start it).
      // So each page gets a bounded chance to paint its first chart before it is judged. A page that has
      // nothing to chart waits this out and still counts as zero, which is what the sweep already allows for.
      await figures.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
      // A page can legitimately draw nothing (a module with no data yet), so the count is not asserted; what
      // is asserted is that whatever it DID draw is whole.
      const count = await figures.count();
      for (let i = 0; i < count; i++) {
        const figure = figures.nth(i);
        // A chart inside a tab panel that is not open has no box by design (its container is display:none),
        // and measuring it would fail the sweep for a chart nobody asked to see. `everyTab` is what opens
        // those; this walk judges what the page draws on arrival.
        if (!(await figure.isVisible())) continue;
        // `textContent`, not `innerText`: the caption is `sr-only` (clipped to a pixel), and what it says
        // is a DOM fact rather than a rendered one.
        const caption = ((await figure.locator("figcaption").first().textContent()) ?? "").trim();
        try {
          // The picture, with real pixels: an SVG the library never painted has no box.
          //
          // Polled, not measured once. Being ATTACHED is not being painted: `Chart` is lazy and frappe-charts
          // sizes its SVG a frame or more after it lands in the DOM, so a single `boundingBox()` taken the
          // instant the element attaches reads 0x0 on a loaded machine and reports a chart that draws
          // perfectly well as one that drew nothing (seen on `goals · Goals by state`, 2026-09-15). The window
          // stays short on purpose: a chart that has not painted within it is still a failure, which is the
          // thing this sweep exists to catch.
          const svg = figure.locator("svg").first();
          await expect(svg).toBeAttached({ timeout: 30_000 });
          const box = await expect
            .poll(async () => {
              const b = await svg.boundingBox();
              return (b?.width ?? 0) > 0 && (b?.height ?? 0) > 0;
            }, { timeout: 5_000 })
            .toBe(true)
            .then(() => svg.boundingBox())
            .catch(() => null);
          if ((box?.width ?? 0) <= 0 || (box?.height ?? 0) <= 0) {
            failures.push(`${route} · ${caption}: the chart drew no picture`);
            continue;
          }
          // And the numbers, captioned the same way, for a reader who cannot see it.
          const table = figure.locator("table");
          if ((await table.count()) === 0) {
            failures.push(`${route} · ${caption}: the picture has no table under it`);
            continue;
          }
          const tableCaption = ((await table.locator("caption").first().textContent()) ?? "").trim();
          if (tableCaption !== caption) {
            failures.push(`${route} · ${caption}: the table is captioned "${tableCaption}"`);
          }
          if ((await table.locator("tbody tr").count()) === 0) {
            failures.push(`${route} · ${caption}: the table has no rows, so the chart is unreadable`);
          }
          drawn++;
        } catch (e) {
          failures.push(`${route} · ${caption}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }

    // A run that drew nothing anywhere is a broken sweep, not a healthy app.
    expect(drawn, "no page drew a single chart").toBeGreaterThan(0);
    const problems = [...failures, ...logged];
    expect(problems, `charts with problems:\n${problems.join("\n")}`).toEqual([]);
  });
});
