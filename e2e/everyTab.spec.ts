import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Every tab on every page, opened.
//
// `everyPage` opens each route and sees whatever tab it lands on. That is a fraction of the app: the pages
// that matter most are tabbed - Attendance, Leaves, Expenses, Payroll, Reviews, Documents, Boards - and the
// panels behind the first tab are where the rot is, because they are the surfaces nobody clicks for weeks.
// Each one is its own read, its own shaping, often its own lazy chunk, and a panel that throws on mount takes
// the page down for whoever opens that tab while the tab bar in front of it looks perfectly healthy.
//
// So this is `everyPage`'s three questions, applied one level in: it opened, it drew something, it stayed
// inside the window, and it logged nothing. `profileTabs` does the same for the employee record, whose tabs
// are gated per viewer and so need their own list.
//
// Deliberately NOT asserted: what any particular panel contains. That is the deep specs' business, and a
// sweep that knew what each tab should say would be a sweep nobody could keep true.
const PAGES: { route: string; heading: string }[] = [
  { route: "approvals", heading: "Approvals" },
  { route: "attendance", heading: "Attendance" },
  { route: "leave-requests", heading: "Leaves" },
  { route: "leave-calendar", heading: "Leave calendar" },
  { route: "overtime", heading: "Overtime" },
  { route: "remote-work", heading: "Remote work" },
  { route: "timesheets", heading: "Timesheets" },
  { route: "reimbursements", heading: "Reimbursements" },
  { route: "expenses", heading: "Expenses" },
  { route: "expense-budgets", heading: "Budgets" },
  { route: "loans", heading: "Loans & Advances" },
  { route: "tax-declarations", heading: "Tax Declarations" },
  { route: "payroll-runs", heading: "Payroll" },
  { route: "payslips", heading: "Payslips" },
  { route: "documents", heading: "Documents" },
  { route: "goals", heading: "Goals" },
  { route: "reviews", heading: "Reviews" },
  { route: "check-ins", heading: "1:1s" },
  { route: "boards", heading: "Boards" },
  { route: "tickets", heading: "Support" },
  { route: "assets", heading: "Assets" },
  { route: "stocktakes", heading: "Stocktakes" },
  { route: "transitions", heading: "Onboarding & Offboarding" },
  { route: "background-checks", heading: "Background Verification" },
  { route: "compliance", heading: "Compliance Calendar" },
  { route: "benefits", heading: "Benefits" },
  { route: "events", heading: "Events" },
  { route: "holidays", heading: "Holiday Calendar" },
  { route: "pipeline", heading: "Pipeline" },
  { route: "job-requisitions", heading: "Jobs" },
  { route: "candidates", heading: "Candidates" },
  { route: "interviews", heading: "Interviews" },
  { route: "offers", heading: "Offers" },
  { route: "referrals", heading: "Referrals" },
  { route: "suggestions", heading: "Suggestion Box" },
  { route: "announcements", heading: "Feed" },
  { route: "workflows", heading: "Workflows" },
  { route: "team-analytics", heading: "Team analytics" },
  { route: "recruiting-analytics", heading: "Recruiting analytics" },
];

test("every tab on every page mounts, draws something and logs nothing", async ({ as }) => {
  // Forty pages and every tab on each of them, in one browser, each panel fetching its own data.
  test.setTimeout(900_000);
  const page = await as("super");
  // The shared watchdog fails a test on any console error, and a walk this wide will meet one that is not the
  // app failing: another spec writing the same collection while this reads it raises a 409 in whichever
  // browser lost the race. Excused here for the same reason the sweep's own filter excuses it below.
  allowConsoleErrors(page, /status of 409/i);
  // Where the walk is, so an error caught here names the panel that logged it. Telemetry delivery is filtered
  // for the reason IGNORED_CONSOLE gives in fixtures.ts.
  let current = "";
  const logged: string[] = [];
  page.on("console", (m) => {
    // 429: telemetry delivery, filtered for the reason IGNORED_CONSOLE gives in fixtures.ts.
    // 409: a lost race with another spec writing the same collection while this walk reads it. This sweep is
    // about whether a panel MOUNTS, and a conflict raised by a parallel writer says nothing about that -
    // `writeDialog` is where a lost race is the subject.
    if (m.type() !== "error" || /status of (429|409)/i.test(m.text())) return;
    logged.push(`${current}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

  const failures: string[] = [];
  let opened = 0;

  for (const { route, heading } of PAGES) {
    current = route;
    try {
      await gotoRoute(page, route, heading);
    } catch (e) {
      failures.push(`${route}: never landed - ${(e as Error).message.split("\n")[0]}`);
      continue;
    }

    // The PAGE's own tab bar - the first tablist on it. Addressed by position rather than by name: a tab's
    // label carries live counts ("Requests (3)"), which move while the walk is running, and a panel can bring
    // a tab bar of its own that a name lookup would wander into.
    const tabs = page.getByRole("tablist").first().getByRole("tab");
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      const name = ((await tab.textContent()) ?? `tab ${i + 1}`).trim() || `tab ${i + 1}`;
      current = `${route} · ${name}`;
      try {
        // Re-pressed on a miss, not trusted to one press: these pages re-render as their reads land, and a
        // click that arrives while the tab bar is being replaced selects nothing - which then reads as the
        // tab failing to open. What this walks for is whether the panel MOUNTS once the tab is actually on.
        await expect(async () => {
          if ((await tab.getAttribute("data-state")) !== "active") await tab.click({ timeout: 5_000 });
          await expect(tab).toHaveAttribute("data-state", "active", { timeout: 5_000 });
        }).toPass({ timeout: 30_000 });
        // The panel, not the tab: a tab that highlights over an empty frame is what this walks for. `.first()`
        // because a panel can carry a tab bar of its own.
        const panel = page.getByRole("tabpanel").first();
        await expect(panel).toBeVisible({ timeout: 30_000 });
        const text = ((await panel.textContent()) ?? "").trim();
        if (!text) {
          failures.push(`${route} · ${name}: the panel rendered nothing`);
          continue;
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) failures.push(`${route} · ${name}: the page is ${overflow}px wider than the window`);
        opened++;
      } catch (e) {
        failures.push(`${route} · ${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  // A walk that opened no tabs anywhere is a broken sweep, not a tabless app.
  expect(opened, "no tab was opened on any page").toBeGreaterThan(0);
  const problems = [...failures, ...logged];
  expect(problems, `tabs with problems:\n${problems.join("\n")}`).toEqual([]);
});
