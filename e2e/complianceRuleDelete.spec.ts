import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Deleting a recurring rule - `complianceRules.spec.ts`'s own cleanup comment says why it never does this
// through the UI itself ("purging a rule does not take its occurrences with it... a spec that only deleted
// the rule would leave a year of filings"), so every run of that spec (and this one) drops both through the
// API. What neither ever proves is that the rule's own row can actually be deleted from the page at all -
// a second, separate `useSoftDelete` instance from the one events use.
test("a recurring rule is deleted from the rules table", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const title = `E2E rule delete ${Date.now() % 100000}`;
  // A genuine 503 on the browser-driven Delete click itself (not the setup POST above, which goes through
  // `page.request` and never touches the browser's own network log) still logs before the retry below picks
  // it back up - allowed here for the same busy-lane reason as the setup retry's own comment.
  allowConsoleErrors(page, /status of 503|status of 500|worker restarted/i);

  // Retried, not a single shot: the dev Worker under this run can restart mid-request on a busy lane (a real,
  // if rare, infrastructure hiccup under 16-worker load, not anything about this collection specifically) -
  // a plain GET/POST that lands in that window comes back 503/"worker restarted", and there is nothing wrong
  // with the request that pressing it again doesn't fix.
  let rulePath = "";
  await expect(async () => {
    const made = await page.request.post("/v1/compliance-rules", {
      headers: SPA_HEADERS,
      data: { title, category: "EPFO", frequency: "monthly", due_day: 15 },
    });
    expect(made.status(), await made.text()).toBe(200);
    rulePath = ((await made.json()) as { path: string }).path;
  }).toPass({ timeout: 30_000 });

  try {
    await gotoRoute(page, "compliance", "Compliance Calendar");
    await page.getByRole("button", { name: "Recurring rules" }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    // One press, patiently waited on rather than re-pressed: a re-click here (an earlier version of this test
    // did exactly that whenever the toast had not yet rendered) fires a SECOND delete on a row the first press
    // already reached the server for - a soft-deleted row 404s the same way a plain GET does (both hit the
    // generic crud factory's notFound-on-deleteTime), and that error toast then replaces the success one the
    // first press already earned, which is what a re-click loop was actually reproducing, not a real failure of
    // the press itself. Either signal - the toast, or the row's own dimmed state outlasting it - proves it.
    await expect(async () => {
      const gotToast = await toast(page, "Compliance rule deleted").count();
      const dimmed = /opacity-60/.test((await row.getAttribute("class")) ?? "");
      expect(gotToast || dimmed).toBeTruthy();
    }).toPass({ timeout: 30_000 });
    // NOT gone from the table: this list is fetched with `showDeleted: true` always (Compliance.tsx), on
    // purpose - a deleted rule stays visible, dimmed, with Restore right there instead of vanishing outright.
    // The row's own opacity + a Restore option (in place of Delete) is what "deleted" looks like here.
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveClass(/opacity-60/);
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Restore" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws
    // notFound on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to check.
    const after = await page.request.get(`/v1/compliance-rules?show_deleted=true&page_size=200`);
    expect(after.ok(), await after.text()).toBe(true);
    const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
    const found = results.find((r) => r.path === rulePath);
    expect(found?.delete_time, "the rule should survive soft-deleted, not be gone entirely").toBeTruthy();
  } finally {
    // The rule's own occurrences are ordinary calendar items once generated (per `complianceRules.spec.ts`'s
    // own comment) - swept separately here for the same reason that spec does it.
    await purge(page, rulePath);
    await sweepOccurrences(page, title);
  }
});

async function sweepOccurrences(page: import("@playwright/test").Page, title: string) {
  const res = await page.request.get("/v1/compliance-events?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  for (const r of results.filter((x) => x.title === title)) await purge(page, r.path);
}
