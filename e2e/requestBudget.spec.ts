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
    const page = await as("super");
    const seen: { method: string; path: string }[] = [];
    page.on("request", (r) => {
      const { pathname } = new URL(r.url());
      if (pathname.startsWith("/v1")) seen.push({ method: r.method(), path: pathname });
    });

    await gotoRoute(page, "dashboard");
    // Give anything late (prefetch, deferred widgets) a chance to fire before counting.
    await page.waitForLoadState("networkidle").catch(() => {});

    const boot = [...seen];
    expect(boot.length, `cold boot made ${boot.length} /v1 requests:\n${format(boot)}`).toBeLessThanOrEqual(8);
    // Everything except identity goes through the batch. A plain collection GET on boot means a page (or a
    // shared component) has started reading around the store again.
    const unbatched = boot.filter((r) => r.method === "GET" && r.path !== "/v1/users/me");
    expect(unbatched, `these boot reads bypassed /v1/batch:run:\n${format(unbatched)}`).toEqual([]);
    expect(boot.some((r) => r.path === "/v1/batch:run")).toBe(true);

    // Moving to another page re-uses the shell and the store; it costs its own reads, not a fresh boot.
    seen.length = 0;
    await gotoRoute(page, "employees");
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(seen.length, `navigation made ${seen.length} /v1 requests:\n${format(seen)}`).toBeLessThanOrEqual(4);
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
      const seen: { method: string; path: string }[] = [];
      page.on("request", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.startsWith("/v1")) seen.push({ method: r.method(), path: pathname });
      });
      await gotoRoute(page, "dashboard");
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(seen.length, `${role}'s dashboard made ${seen.length} /v1 requests:\n${format(seen)}`).toBeLessThanOrEqual(8);
    }
  });
});

const format = (rows: { method: string; path: string }[]) => rows.map((r) => `  ${r.method} ${r.path}`).join("\n");
