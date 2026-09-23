import { readFileSync } from "node:fs";
import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Every page in the app, opened.
//
// The rest of the browser lane is deep: one spec per behaviour that only a browser can show. This one is
// WIDE. It walks every route the app can render and asks the three questions that are true of all of them -
// did it mount, did it land on the page it claims to be, and did it stay inside the window - because the way
// a React page dies is not subtle: a component throws on mount, a hook order changes, a lazy chunk fails to
// resolve, and the page is a blank frame with a red console. Nothing outside a browser sees any of it, and a
// page nobody opened in a week is exactly where it hides.
//
// The route list is checked against `renderPage()` in web/src/App.tsx, so a page shipped without a line here
// fails this spec rather than going quietly uncovered. That is the point: this is the floor under the whole
// lane, and it has to stay complete on its own.
type PageCase = {
  route: string;
  /** The `<h1>` the route must land on. `null` where the page's heading is per-viewer (the dashboard greets
   *  you by name), in which case any h1 counts. */
  heading: string | null;
};

const PAGES: PageCase[] = [
  { route: "dashboard", heading: null },
  { route: "approvals", heading: "Approvals" },
  { route: "notifications", heading: "Notifications" },
  // Per-viewer, like the dashboard: `/profile` and `/employees/<id>` are ONE page now, and its `<h1>` is the
  // person's own name rather than a page title - the same heading whichever address you arrive by.
  { route: "profile", heading: null },
  { route: "employees", heading: "Directory" },
  { route: "org-chart", heading: "Org Chart" },
  { route: "attendance", heading: "Attendance" },
  { route: "leave-requests", heading: "Leaves" },
  { route: "leave-calendar", heading: "Leave calendar" },
  { route: "goals", heading: "Goals" },
  { route: "team-goals", heading: "Team goals" },
  { route: "boards", heading: "Boards" },
  { route: "reviews", heading: "Reviews" },
  { route: "transitions", heading: "Onboarding & Offboarding" },
  { route: "check-ins", heading: "1:1s" },
  { route: "benefits", heading: "Benefits" },
  { route: "schedule", heading: "Schedule" },
  { route: "timesheets", heading: "Timesheets" },
  { route: "loans", heading: "Loans & Advances" },
  { route: "tax-declarations", heading: "Tax Declarations" },
  { route: "announcements", heading: "Feed" },
  { route: "kudos", heading: "Feed" },
  { route: "holidays", heading: "Holiday Calendar" },
  { route: "events", heading: "Events" },
  { route: "documents", heading: "Documents" },
  { route: "compliance", heading: "Compliance Calendar" },
  { route: "background-checks", heading: "Background Verification" },
  { route: "overtime", heading: "Overtime" },
  { route: "remote-work", heading: "Remote work" },
  { route: "delegations", heading: "Approval delegation" },
  { route: "notice-periods", heading: "Notice Periods" },
  { route: "suggestions", heading: "Suggestion Box" },
  // The moderation queue. It had its own spec from the day it was built and was still missing here, which is
  // the gap this gate exists to catch: a dedicated spec proves one page works, and this table is what proves
  // no page was forgotten.
  { route: "moderation", heading: "Flagged posts" },
  { route: "payslips", heading: "Payslips" },
  { route: "reimbursements", heading: "Reimbursements" },
  { route: "expenses", heading: "Expenses" },
  { route: "vendors", heading: "Vendors" },
  { route: "expense-budgets", heading: "Budgets" },
  { route: "card-transactions", heading: "Card charges" },
  { route: "referrals", heading: "Referrals" },
  { route: "pipeline", heading: "Pipeline" },
  { route: "job-requisitions", heading: "Jobs" },
  { route: "candidates", heading: "Candidates" },
  { route: "interviews", heading: "Interviews" },
  { route: "offers", heading: "Offers" },
  { route: "recruiting-analytics", heading: "Recruiting analytics" },
  { route: "team-analytics", heading: "Team analytics" },
  { route: "tickets", heading: "Support" },
  { route: "assets", heading: "Assets" },
  { route: "stocktakes", heading: "Stocktakes" },
  { route: "payroll-runs", heading: "Payroll" },
  { route: "pay-periods", heading: "Payroll" },
  { route: "tables", heading: "Tables" },
  { route: "workflows", heading: "Workflows" },
  { route: "activity", heading: "Activity" },
  { route: "settings", heading: "Settings" },
  // The routes that survive as deep links into a Settings panel: their heading is the panel's, not the
  // page's, which is exactly what would break if one of them stopped resolving.
  { route: "departments", heading: "Departments" },
  { route: "leave-types", heading: "Leave types" },
  { route: "pay-components", heading: "Pay components" },
  { route: "users", heading: "Users" },
  { route: "operations", heading: "System operations" },
];

test.describe("every page", () => {
  test("the route table covers every page the app can render", () => {
    const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    // Only `renderPage()`'s own switch: the rest of the file has switches of its own.
    const body = app.slice(app.indexOf("function renderPage()"), app.indexOf("function renderWithWorkspace()"));
    const routed = [...body.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]!);
    const covered = new Set(PAGES.map((p) => p.route));
    const missing = routed.filter((r) => !covered.has(r));
    expect(missing, "these routes render a page that no browser test ever opens").toEqual([]);
  });

  test("every page renders for an admin, on its own heading and inside the window", async ({ as }) => {
    // Fifty-odd routes in one browser: the walk is long by design, and the default per-test budget is for a
    // spec that does one thing.
    test.setTimeout(600_000);
    const page = await as("super");
    allowConsoleErrors(page, /status of 409|status of 503/i);
    // Which route the walk is on, so a console error the fixture catches at teardown can be traced to the
    // page that logged it rather than to "somewhere in fifty-odd routes".
    let current = "";
    const logged: string[] = [];
    // Telemetry delivery is filtered out for the same reason the shared watchdog filters it (see
    // IGNORED_CONSOLE in fixtures.ts): every browser in the lane posts through the `/diag` relay to the real
    // Sentry project, and a rate-limited send is not this page failing to render. A 409/503 is the same rare
    // dev-Worker-restart-or-concurrent-write hiccup documented elsewhere in this suite
    // (complianceRuleDelete.spec.ts et al.) landing on one of fifty-odd navigations in one run - a page that
    // genuinely fails to render still fails via `failures` below regardless of what its console logged.
    page.on("console", (m) => {
      if (m.type() !== "error" || /status of 429|status of 409|status of 503/i.test(m.text())) return;
      logged.push(`${current}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

    const failures: string[] = [];
    for (const { route, heading } of PAGES) {
      current = route;
      await gotoRoute(page, route);
      const h1 = page.locator("h1").first();
      try {
        if (heading) await expect(h1).toHaveText(heading, { timeout: 15_000 });
        else await expect(h1).toBeVisible({ timeout: 15_000 });
        // A page wider than the window is a layout that has broken out of its container - the desktop half
        // of what `phone` measures at 390px.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) failures.push(`${route}: the page is ${overflow}px wider than the window`);
      } catch (e) {
        failures.push(`${route}: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    // One list, so a walk that hits several pages reports all of them rather than the first - and so a
    // console error is attributed to the route that logged it.
    const problems = [...failures, ...logged];
    expect(problems, `pages with problems:\n${problems.join("\n")}`).toEqual([]);
  });

  test("an ordinary employee gets a page or a wall on every route, never a broken frame", async ({ as }) => {
    test.setTimeout(600_000);
    const page = await as("employee");
    allowConsoleErrors(page, /status of 409|status of 503/i);
    const failures: string[] = [];

    for (const { route, heading } of PAGES) {
      await gotoRoute(page, route);
      // Either the page rendered, or the route gate refused it. Both are correct answers; a blank <main> is
      // not, and neither is a page that renders under a caller who may not read it.
      const wall = page.getByText("You don't have access to this");
      const landed = heading ? page.getByRole("heading", { level: 1, name: heading }) : page.locator("h1");
      try {
        await expect(wall.or(landed).first()).toBeVisible({ timeout: 15_000 });
      } catch {
        failures.push(`${route}: neither the page nor the access wall appeared`);
      }
    }

    expect(failures, `routes that answered with nothing:\n${failures.join("\n")}`).toEqual([]);
  });
});
