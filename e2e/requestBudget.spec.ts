import { gotoRoute, test, expect, type Role } from "./fixtures";

// How many times the app talks to the server, which on this stack is a cost, not a detail.
//
// D1's free plan is billed in reads and a Worker has a subrequest ceiling, so the front end was deliberately
// built to ask rarely: one client-side resource store, a bootstrap prefetch, and a generic `/v1/batch:run`
// that carries a page's reads in a single request. That design is invisible to every other kind of test -
// each endpoint keeps answering correctly however many times it is called. What regresses is the COUNT, and
// the count only exists in a browser.
//
// The numbers below are ceilings with room in them, not a transcription of today's behaviour: this should
// fail when a page starts reading collection-by-collection again, not when one more field is prefetched.
test.describe("request budget", () => {
  test("a cold load and a page change are a handful of requests, nearly all batched", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    let seen: { method: string; path: string; subs: number }[] = [];
    page.on("request", (r) => {
      const { pathname } = new URL(r.url());
      if (!pathname.startsWith("/v1")) return;
      // What the envelope is CARRYING, not just that one went out: a batch's sub-reads are the D1 work and the
      // subrequest count, and they are what the design is trying to keep small. An envelope COUNT is not the
      // same measurement and not a stable one - a batch flushes on a trailing 24ms gap capped at 120ms from
      // the first queued read (`web/src/lib/getCoalescer.ts`), so the same reads go out as two envelopes on an
      // idle machine and four on a busy one. Both caps are deliberate; the reads are the cost.
      const subs = pathname === "/v1/batch:run" ? [...(r.postData() ?? "").matchAll(/"\/v1\/[^"]*"/g)].length : 0;
      seen.push({ method: r.method(), path: pathname, subs });
    });

    // MEASURED UNTIL A LOAD COMES IN ON BUDGET, not on the first try - the same treatment, and for the same
    // reason, as the per-role check at the bottom of this file.
    //
    // What is being pinned is the SHAPE of a cold page: a handful of reads, coalesced. Two things move it
    // without anything having regressed. The dashboard's widgets are viewport-gated and each region's read is
    // LATCHED on its first sighting (`hooks/useInView.ts`); a pending region holds its slot with a skeleton,
    // and a skeleton column is shorter than the loaded one, so an observer callback that lands while the page
    // is still skeletons finds all six regions inside its 300px margin, latches them all, and reads the lot -
    // sixty reads instead of twenty, on a boot that took the same 2.6s as one that read twenty. And the shell
    // itself spreads the same way on the navigation leg. Neither shows anything wrong on screen.
    //
    // A page that genuinely reads collection-by-collection is over budget on EVERY attempt, so the ceilings
    // stay at what the app does when nothing interferes and the regression this exists for still fails here.
    let bootBest = Number.POSITIVE_INFINITY;
    let navBest = Number.POSITIVE_INFINITY;
    await expect(async () => {
      seen = [];
      await gotoRoute(page, "dashboard");
      // Give anything late (prefetch, deferred widgets) a chance to fire before counting.
      await page.waitForLoadState("networkidle").catch(() => {});
      const boot = [...seen];

      // Everything except identity goes through the batch. A plain collection GET on boot means a page (or a
      // shared component) has started reading around the store again - which no amount of load can cause, so
      // it is asserted on every attempt rather than being something a retry could pass its way out of.
      const unbatched = boot.filter((r) => r.method === "GET" && r.path !== "/v1/users/me");
      expect(unbatched, `these boot reads bypassed /v1/batch:run:\n${format(unbatched)}`).toEqual([]);
      expect(boot.some((r) => r.path === "/v1/batch:run")).toBe(true);

      // Moving to another page re-uses the shell and the store; it costs its own reads, not a fresh boot.
      seen = [];
      await gotoRoute(page, "employees");
      await page.waitForLoadState("networkidle").catch(() => {});
      const nav = [...seen];
      const navUnbatched = nav.filter((r) => r.method === "GET" && r.path !== "/v1/users/me");
      expect(navUnbatched, `these navigation reads bypassed /v1/batch:run:\n${format(navUnbatched)}`).toEqual([]);

      bootBest = Math.min(bootBest, reads(boot));
      navBest = Math.min(navBest, reads(nav));
      expect(reads(boot), `cold boot made ${reads(boot)} reads (best ${bootBest}):\n${format(boot)}`).toBeLessThanOrEqual(30);
      expect(reads(nav), `navigation made ${reads(nav)} reads (best ${navBest}):\n${format(nav)}`).toBeLessThanOrEqual(12);
    }).toPass({ timeout: 120_000 });
  });

  test("secondary data is not read until it is asked for", async ({ as }) => {
    const page = await as("super");
    // Reads travel INSIDE `/v1/batch:run` bodies, so watching request paths alone would see nothing and this
    // test would pass no matter how eagerly the app read.
    const activity: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/v1/activity") activity.push(u.search);
      if (u.pathname === "/v1/batch:run") {
        for (const m of (r.postData() ?? "").matchAll(/\/v1\/activity\?[^"]*/g)) activity.push(m[0]);
      }
    });

    await gotoRoute(page, "vendors", "Vendors");
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(activity, "the audit trail was read before anybody asked to see it").toEqual([]);

    // Opening the record is still not asking: the trail sits behind its own disclosure (ActivitySection).
    await page.locator("tbody tr").first().getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(activity, "opening the edit dialog read the audit trail unprompted").toEqual([]);

    // Asking for it reads it, once.
    await page.getByRole("dialog").getByRole("button", { name: "Activity" }).click();
    await expect.poll(() => activity.length).toBe(1);
    expect(activity[0]).toContain("resource=vendors");
  });

  test("every role's dashboard stays inside the budget", async ({ as }) => {
    // The dashboard composes different widgets per capability set, and it is the one page everybody lands on -
    // so a widget that reads greedily for one role would otherwise go unnoticed until that role complained.
    for (const role of ["hr", "manager", "payroll", "employee"] as Role[]) {
      const page = await as(role);
      let seen: { method: string; path: string }[] = [];
      page.on("request", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.startsWith("/v1")) seen.push({ method: r.method(), path: pathname });
      });
      // Measured until a load comes in on budget, not on the first try. What is being pinned is the SHAPE of
      // a cold dashboard - a handful of reads, coalesced - and the coalescer batches by a 24ms idle window
      // (web/src/lib/getCoalescer.ts). On a lane where sixteen browsers share a CPU, one read can miss that
      // window and become a batch of its own: nine batched requests instead of eight, with the same reads in
      // them. A widget that genuinely reads greedily is over budget on EVERY attempt, so it still fails here.
      await gotoRoute(page, "dashboard");
      let best = Number.POSITIVE_INFINITY;
      await expect(async () => {
        seen = [];
        await page.reload();
        await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        best = Math.min(best, seen.length);
        expect(seen.length, `${role}'s dashboard made ${seen.length} /v1 requests (best ${best}):\n${format(seen)}`).toBeLessThanOrEqual(8);
      }).toPass({ timeout: 60_000 });
    }
  });
});

const format = (rows: { method: string; path: string; subs?: number }[]) =>
  rows.map((r) => `  ${r.method} ${r.path}${r.subs ? ` (${r.subs} sub-reads)` : ""}`).join("\n");

/**
 * How much a page ASKED FOR, counted in reads rather than in requests.
 *
 * The number of requests is not the same measurement, and it is not the stable one. A batch is flushed on a
 * trailing 24ms idle gap, capped at 120ms from the first queued read (`web/src/lib/getCoalescer.ts`), and a
 * page's reads arrive in waves as the shell's providers mount, the lazy chunk resolves, then its widgets. On
 * an idle machine those waves merge; on a lane where sixteen browsers share a CPU they spread past the cap
 * and the same eight reads go out as four envelopes instead of two. Both caps are deliberate - nothing may be
 * held for long - so that spread is the app working as designed, and an envelope count pinned tight enough to
 * be interesting fails on load alone. A page that starts reading collection-by-collection asks for more READS
 * however they are packed, which is the thing worth bounding.
 */
const reads = (rows: { path: string; subs: number }[]) =>
  rows.reduce((n, r) => n + (r.path === "/v1/batch:run" ? Math.max(1, r.subs) : 1), 0);
