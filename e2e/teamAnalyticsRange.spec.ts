import { gotoRoute, test, expect } from "./fixtures";

// The reporting window lives in the URL (`?range=&from=&to=`), same as the department filter beside it - a
// narrowed report is meant to be a link somebody can send and a reload comes back to. Nothing has ever picked
// a preset or typed a custom pair and read the URL back.
//
// `lib/analytics.ts`'s own `rangeFor("last_month")` is the ground truth this asserts against - re-derived
// here rather than imported, since that module pulls in `lib/attendance.ts`, which fails e2e/tsconfig.json's
// stricter `noUncheckedIndexedAccess` (a real, pre-existing gap there - `addMonths`'s `ymd.split("-")` reads as
// possibly-undefined - but not what this spec is about). The two are the same one-line calendar step either
// way: last month is never more than a year/month rollback from this one.
test.describe("team analytics: the reporting window", () => {
  test("a preset writes its exact from/to, and a custom pair does the same by hand", async ({ as }) => {
    test.setTimeout(60_000);
    const page = await as("super");
    await gotoRoute(page, "team-analytics", "Team analytics");

    const today = new Date();
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const lastMonth = { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };

    await page.getByLabel("Reporting window", { exact: true }).click();
    await page.getByRole("option", { name: "Last month", exact: true }).click();
    await expect.poll(() => page.url()).toContain("range=last_month");
    await expect.poll(() => new URL(page.url().replace("#", "")).searchParams.get("from")).toBe(lastMonth.from);
    await expect.poll(() => new URL(page.url().replace("#", "")).searchParams.get("to")).toBe(lastMonth.to);

    // A reload comes back to the SAME window, from the URL alone - not local component state.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Team analytics" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Reporting window", { exact: true })).toHaveText(/Last month/);

    // Custom: picking it reveals the two date boxes (hidden for every preset), and each one's own value lands
    // in the matching URL param, not the other one's.
    await page.getByLabel("Reporting window", { exact: true }).click();
    await page.getByRole("option", { name: "Custom", exact: true }).click();
    const from = page.getByLabel("From", { exact: true });
    const to = page.getByLabel("To", { exact: true });
    await expect(from).toBeVisible({ timeout: 15_000 });
    await from.fill("2025-01-01");
    await to.fill("2025-01-15");
    await expect.poll(() => new URL(page.url().replace("#", "")).searchParams.get("from")).toBe("2025-01-01");
    await expect.poll(() => new URL(page.url().replace("#", "")).searchParams.get("to")).toBe("2025-01-15");
    await expect.poll(() => new URL(page.url().replace("#", "")).searchParams.get("range")).toBe("custom");
  });
});
