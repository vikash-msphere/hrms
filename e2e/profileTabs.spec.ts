import { readFileSync } from "node:fs";
import { allowConsoleErrors, gotoRoute, personId, test, expect } from "./fixtures";

// Every tab on an employee's record, opened.
//
// The record page is one route, so `everyPage` walks it once and sees the Profile tab. Everything else on it
// - a panel per tab, each its own read, each with its own access gate - is behind a tab nothing in the lane
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
  "employment",
  "leave",
  "attendance",
  "identity",
  "performance",
  "posts",
  "compensation",
  "documents",
  "activity",
] as const;

/**
 * The tabs an admin must be offered on somebody else's record. Every one of them is either unconditional or
 * gated on a grant super holds, so an absence is a real failure - including `leave` and `attendance`, which
 * are exactly the two that exist on SOMEBODY ELSE's record and not on one's own.
 */
const REQUIRED = TABS;

/** The tab bar's labels, which are what a browser can actually click. */
const LABEL: Record<(typeof TABS)[number], string> = {
  profile: "Profile",
  employment: "Employment",
  leave: "Leave",
  attendance: "Attendance",
  identity: "Identity",
  performance: "Performance",
  posts: "Posts",
  compensation: "Compensation",
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
    // Every panel in one browser, several of them their own lazy chunk.
    test.setTimeout(300_000);
    const page = await as("super");
    // Every panel's worth of reads on a busy lane: the same transient 5xx the per-panel collector below
    // tolerates has to be tolerated by the suite-wide gate too, or the run fails on it after the walk passed.
    allowConsoleErrors(page, /status of 503|status of 500/i);
    // Which tab the walk is on, so an error caught here names the panel that logged it rather than "somewhere
    // on the record page". Telemetry delivery is filtered for the reason IGNORED_CONSOLE gives in fixtures.ts.
    let current = "";
    const logged: string[] = [];
    page.on("console", (m) => {
      // 5xx as well as the 429 telemetry rate limit: a dev Worker restarting mid-request answers whatever was
      // in flight with a 503 or a 500, the same rare hiccup ~20 specs in this suite tolerate by name through
      // `allowConsoleErrors`. This test collects its own console lines (to name the panel), so it needs the
      // same exception - what it proves is that every panel MOUNTS, and each of those is asserted below.
      if (m.type() !== "error" || /status of (429|500|502|503|504)/i.test(m.text())) return;
      logged.push(`${current}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

    // Somebody else's record, not super's own: `identity` (which carries the bank panel too) is offered to an
    // OWNER as well as to an admin, and driving it on your own record proves only the ownership half.
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
      if (!offered.has(label)) continue;
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

  test("no tab on the record scrolls sideways at a phone or tablet width", async ({ as }) => {
    // The walk above measures overflow, but only at the desktop project's 1440px, where every card header on
    // the record has room to lay its title and its action button out in one row. Narrow is where those rows
    // stop fitting, and nothing in the lane looked: `everyViewport` walks every route at four widths but
    // lands on whichever tab a route opens with, which on the record page is always Profile. So the record's
    // other panels - the ones with the buttons on them - were measured at one width only, and the
    // Compensation tab's "Revise" button hung off the right edge of a phone with the whole page panning to
    // follow it.
    test.setTimeout(300_000);
    const page = await as("super");
    allowConsoleErrors(page, /status of (503|500|429)/i);
    const id = await personId(page, "hr");

    const failures: string[] = [];
    for (const { label: size, width, height } of [
      { label: "phone", width: 390, height: 844 },
      { label: "tablet", width: 768, height: 1024 },
    ]) {
      await page.setViewportSize({ width, height });
      await gotoRoute(page, `employees/${id}`);
      await expect(page.getByRole("tab", { name: "Profile", exact: true })).toBeVisible({ timeout: 30_000 });
      const offered = new Set((await page.getByRole("tab").allInnerTexts()).map((t) => t.trim()).filter(Boolean));

      for (const key of TABS) {
        const label = LABEL[key];
        if (!offered.has(label)) continue;
        const tab = page.getByRole("tab", { name: label, exact: true });
        try {
          // The tab bar itself scrolls sideways at these widths, so the tab has to be brought into view
          // before it can be pressed. Re-pressed on a miss for the reason `everyTab` gives: these panels
          // re-render as their reads land, and a click that arrives mid-replacement selects nothing. The
          // scroll is inside the retry for the same reason - a re-render between it and the click detaches
          // the element it just scrolled to, and a scroll left outside fails the whole walk on that.
          await expect(async () => {
            await tab.scrollIntoViewIfNeeded({ timeout: 5_000 });
            if ((await tab.getAttribute("data-state")) !== "active") await tab.click({ timeout: 5_000 });
            await expect(tab).toHaveAttribute("data-state", "active", { timeout: 5_000 });
          }).toPass({ timeout: 30_000 });
          await expect(page.getByRole("tabpanel").first()).toBeVisible({ timeout: 30_000 });
          // Measured until it settles rather than once: a panel is briefly too wide while its reads are still
          // arriving, and a single reading taken in that window reports a layout nobody ever sees.
          const overflow = await settledOverflow(page);
          if (overflow > 1) {
            const culprits = await offenders(page, width);
            failures.push(`${key} at ${size} (${width}px): the record is ${overflow}px wider than the window${culprits.length ? ` - widest: ${culprits.join(" | ")}` : ""}`);
          }
          // The tab band also holds the tab's settings gears, and those never widen the DOCUMENT - they take
          // their width out of the scrolling tab strip beside them, so the check above cannot see them. The
          // Compensation tab carries four, which at 390px is 184px of the 358 the band has: the strip was
          // crushed into what was left and its last tab sat under the first gear.
          const clash = await bandClash(page);
          if (clash) failures.push(`${key} at ${size} (${width}px): ${clash}`);
        } catch (e) {
          failures.push(`${key} at ${size}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }

    expect(failures, `record tabs that scroll sideways:\n${failures.join("\n")}`).toEqual([]);
  });

  test("the open tab is in the URL, so a record link lands on the section somebody meant", async ({ as }) => {
    const page = await as("super");
    const id = await personId(page, "hr");
    await gotoRoute(page, `employees/${id}`);

    // Documents: on every viewer's record, and far enough from Profile that landing on the wrong one is
    // obvious rather than subtle.
    await page.getByRole("tab", { name: "Documents", exact: true }).click();
    await expect.poll(() => page.url()).toContain(`/employees/${id}/documents`);

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
    await expect(page.getByRole("tab", { name: "Identity", exact: true })).toBeVisible({ timeout: 30_000 });

    const offered = new Set((await page.getByRole("tab").allInnerTexts()).map((t) => t.trim()).filter(Boolean));
    // A segment no viewer has (a stale link, a typo, a route key that was renamed), plus whichever real tabs
    // this person is not offered - the case the guard actually exists for, taken from what the browser drew
    // rather than assumed from the seed.
    // Every tab's presence is decided before the page renders - by a grant, or (for `leave` and `attendance`)
    // by this being the viewer's own record, where those two are deliberately not tabs at all. So both of
    // them land in `hidden` here, and the deep link to either has to fall back like any other.
    const hidden = TABS.filter((t) => !offered.has(LABEL[t]));
    for (const sub of ["bogus", ...hidden]) {
      await gotoRoute(page, `employees/${id}/${sub}`);
      // Profile, not an empty frame and not the panel they may not read.
      await expect(page.getByRole("tab", { name: "Profile", exact: true }), `…/${sub} did not fall back to Profile`)
        .toHaveAttribute("data-state", "active", { timeout: 30_000 });
    }
  });
});

/**
 * Whether anything in the record's tab band sits on top of the tab strip, or squeezes it to nothing.
 *
 * The band is the strip plus whatever gears the open tab has. Both are laid out by the same flex row, so
 * neither can overlap the other in the box sense - what goes wrong is subtler and invisible to a document
 * measurement: the gears are `shrink-0` and the strip is a scroll box that shrinks to zero, so on a narrow
 * screen the gears take their width out of the strip and the strip's right edge ends up under them.
 *
 * Two questions, then. Do the two boxes intersect (a real overlap, if anything is ever positioned), and is
 * the strip still wide enough to be a tab bar rather than a sliver. `null` when the band is clean, or when
 * the open tab has no gears at all.
 */
async function bandClash(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => {
    // The record's tab strip is the one inside the header card's last band; a panel can hold sub-tabs of its
    // own, and the first tablist in the document is always the record's.
    const list = document.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) return "the record's tab strip is not in the page";
    const band = list.parentElement;
    if (!band) return null;
    const gears = Array.from(band.querySelectorAll<HTMLElement>("button")).filter((b) => !list.contains(b));
    if (gears.length === 0) return null;

    const strip = list.getBoundingClientRect();
    for (const g of gears) {
      const r = g.getBoundingClientRect();
      if (r.width === 0) continue;
      const overlapX = Math.min(r.right, strip.right) - Math.max(r.left, strip.left);
      const overlapY = Math.min(r.bottom, strip.bottom) - Math.max(r.top, strip.top);
      if (overlapX > 1 && overlapY > 1) {
        return `the "${g.getAttribute("aria-label") ?? "settings"}" gear overlaps the tab strip by ${Math.round(overlapX)}x${Math.round(overlapY)}px`;
      }
    }
    // A strip narrower than about three tabs is not scrollable-but-fine, it is a sliver with the gears having
    // eaten the row. 180px is roughly three of the record's tabs.
    if (strip.width < 180) {
      return `the ${gears.length} settings gear(s) leave the tab strip only ${Math.round(strip.width)}px wide`;
    }
    return null;
  });
}

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
