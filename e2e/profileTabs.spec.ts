import { readFileSync } from "node:fs";
import { gotoRoute, personId, test, expect } from "./fixtures";

// Every tab on an employee's record, opened.
//
// The record page is one route, so `everyPage` walks it once and sees the Profile tab. Everything else on it
// - eleven panels, each its own read, each with its own access gate - is behind a tab nothing in the lane
// clicks. That is a lot of surface to leave unopened: a panel that throws on mount takes the whole record
// down for whoever opens that tab, and the tab bar in front of it looks perfectly healthy.
//
// So this is `everyPage`'s shape applied one level down: mount it, land on its panel, stay inside the window,
// log nothing. Plus the two claims the tab bar itself makes and nothing else checks - the active tab is in
// the URL (so a record link is a link to the SECTION somebody meant), and the URL's tab segment is guarded
// against a viewer who may not have that tab.
//
// The tab list is read out of the page's own source, so a tab shipped without a line here fails the spec
// rather than going quietly uncovered.

/** The tabs the record page can render, as `<AccessTab value="…">` names them. */
const TABS = [
  "profile",
  "contact",
  "employment",
  "leave",
  "identity",
  "bank",
  "tax",
  "compensation",
  "assets",
  "documents",
  "activity",
] as const;

/**
 * The tabs an admin must be offered on somebody else's record.
 *
 * `leave` is deliberately not in here: that tab appears only once the person has a balance or a request, and
 * whether the seeded HR person has either is not this spec's business. Everything else is either
 * unconditional or gated on a grant super holds, so its absence would be a real failure.
 */
const REQUIRED = TABS.filter((t) => t !== "leave");

/** The tab bar's labels, which are what a browser can actually click. */
const LABEL: Record<(typeof TABS)[number], string> = {
  profile: "Profile",
  contact: "Contact",
  employment: "Employment",
  leave: "Leave",
  identity: "Identity",
  bank: "Bank details",
  tax: "Tax",
  compensation: "Compensation",
  assets: "Assets",
  documents: "Documents",
  activity: "Activity",
};

test.describe("the employee record's tabs", () => {
  test("the tab list covers every tab the record page can render", () => {
    const src = readFileSync(new URL("../web/src/pages/EmployeeProfile.tsx", import.meta.url), "utf8");
    const rendered = [...src.matchAll(/<AccessTab value="([a-z-]+)"/g)].map((m) => m[1]!);
    const covered = new Set<string>(TABS);
    expect(rendered.filter((t) => !covered.has(t)), "these tabs are on the record page but in no browser test").toEqual([]);
    // And the other way: a tab deleted from the page should take its line here with it, or the sweep below
    // starts asserting on furniture that no longer exists.
    expect(TABS.filter((t) => !rendered.includes(t)), "these tabs are listed here but the page no longer renders them").toEqual([]);
  });

  test("every tab an admin is offered mounts, on its own panel and inside the window", async ({ as }) => {
    // Eleven panels in one browser, several of them their own lazy chunk.
    test.setTimeout(300_000);
    const page = await as("super");
    // Which tab the walk is on, so an error caught here names the panel that logged it rather than "somewhere
    // on the record page". Telemetry delivery is filtered for the reason IGNORED_CONSOLE gives in fixtures.ts.
    let current = "";
    const logged: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error" || /status of 429/i.test(m.text())) return;
      logged.push(`${current}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

    // Somebody else's record, not super's own: `contact` / `identity` / `bank` are offered to an OWNER as
    // well as to an admin, and driving them on your own record proves only the ownership half.
    const id = await personId(page, "hr");
    await gotoRoute(page, `employees/${id}`);
    await expect(page.getByRole("tab", { name: "Profile", exact: true })).toBeVisible({ timeout: 30_000 });

    const offered = new Set(
      (await page.getByRole("tab").allInnerTexts()).map((t) => t.trim()).filter(Boolean),
    );
    const missing = REQUIRED.filter((t) => !offered.has(LABEL[t]));
    expect(missing, `an admin was not offered these tabs on a colleague's record: ${missing.join(", ")}`).toEqual([]);

    const failures: string[] = [];
    for (const key of TABS) {
      const label = LABEL[key];
      if (!offered.has(label)) continue; // `leave`, on a person with no leave - see REQUIRED.
      current = key;
      const tab = page.getByRole("tab", { name: label, exact: true });
      try {
        await tab.click();
        await expect(tab).toHaveAttribute("data-state", "active", { timeout: 15_000 });
        // The panel, not the tab: a tab that highlights over an empty frame is the failure this walks for.
        // `.first()`: a panel can carry sub-tabs of its own (Documents does), and the outer one is the one
        // this tab bar just opened.
        const panel = page.getByRole("tabpanel").first();
        await expect(panel).toBeVisible({ timeout: 30_000 });
        expect((await panel.innerText()).trim().length, `the ${key} panel rendered nothing`).toBeGreaterThan(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) failures.push(`${key}: the record is ${overflow}px wider than the window`);
      } catch (e) {
        failures.push(`${key}: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    const problems = [...failures, ...logged];
    expect(problems, `tabs with problems:\n${problems.join("\n")}`).toEqual([]);
  });

  test("the open tab is in the URL, so a record link lands on the section somebody meant", async ({ as }) => {
    const page = await as("super");
    const id = await personId(page, "hr");
    await gotoRoute(page, `employees/${id}`);

    // Documents: on every viewer's record, and far enough from Profile that landing on the wrong one is
    // obvious rather than subtle.
    await page.getByRole("tab", { name: "Documents", exact: true }).click();
    await expect.poll(() => page.url()).toContain(`#/employees/${id}/documents`);

    // From cold, through the URL alone - which is the half a click cannot prove: the tab segment is read on
    // mount, not just written on click.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Documents", exact: true })).toHaveAttribute("data-state", "active", { timeout: 30_000 });
  });

  test("a tab segment the viewer has no tab for falls back to Profile", async ({ as }) => {
    // A route walk, one navigation per hidden tab.
    test.setTimeout(180_000);
    const page = await as("employee");
    const id = await personId(page, "employee");

    // Their own record: PII is `OWN_PII`, so the owner is offered the tabs an ordinary colleague is not -
    // which is what makes the guard below a statement about the URL rather than about this person's grants.
    await gotoRoute(page, `employees/${id}`);
    await expect(page.getByRole("tab", { name: "Bank details", exact: true })).toBeVisible({ timeout: 30_000 });

    const offered = new Set((await page.getByRole("tab").allInnerTexts()).map((t) => t.trim()).filter(Boolean));
    // A segment no viewer has (a stale link, a typo, a route key that was renamed), plus whichever real tabs
    // this person is not offered - the case the guard actually exists for, taken from what the browser drew
    // rather than assumed from the seed.
    // `leave` is left out of the probe: it appears once this person's balances arrive, so a tab bar read a
    // moment too early reports it hidden and the deep link then correctly lands on Leave - a race, not a
    // finding. Every other tab's presence is decided by grants, which are known by the time the page renders.
    const hidden = TABS.filter((t) => t !== "leave" && !offered.has(LABEL[t]));
    for (const sub of ["bogus", ...hidden]) {
      await gotoRoute(page, `employees/${id}/${sub}`);
      // Profile, not an empty frame and not the panel they may not read.
      await expect(page.getByRole("tab", { name: "Profile", exact: true }), `…/${sub} did not fall back to Profile`)
        .toHaveAttribute("data-state", "active", { timeout: 30_000 });
    }
  });
});
