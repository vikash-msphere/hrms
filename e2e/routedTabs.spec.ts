import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// The tab you are on is part of the address.
//
// Four request pages share one shell (Leave, Reimbursements, Overtime, Remote work), and its sub-tab lives in
// the path: picking a tab writes `/<page>/<tab>`, and the URL is what the page reads back. That is the
// third of the app's URL-state mechanisms - `?focus=` for a narrowed metric (`kpiFocus`), `?setting=` for an
// inline panel (`settingsSheet`), and this one - and the only one nothing drives.
//
// It matters for two reasons a browser is the only witness to: a link to "my history" has to open on the
// history rather than on whatever the default is, and a metric card that points at a tab can only mark itself
// active if the page and the URL agree about which tab is open. When they drifted apart, the card fired no
// navigation at all.
//
// Driven on two of the four pages, because the claim is about the shared shell rather than one page's wiring.
test.describe("the sub-tab in the URL", () => {
  test("picking a tab writes it to the URL, and the URL survives a reload", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("employee");
    // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
    // (complianceRuleDelete.spec.ts et al.) - the retry below on the reload is what actually recovers from it.
    allowConsoleErrors(page, /status of 500|status of 503/i);
    await gotoRoute(page, "leave-requests", "Leaves");
    // Untouched, the page is on its default tab and the URL says nothing about tabs.
    expect(page.url()).not.toContain("leave-requests/");

    const history = page.getByRole("tab", { name: /^History/ });
    await history.click();
    await expect(history).toHaveAttribute("data-state", "active", { timeout: 30_000 });
    await expect.poll(() => page.url()).toContain("/leave-requests/history");

    // From cold, which is what a pasted link is: the tab is read off the URL on mount, not just written to
    // it on click. Retried: a transient 500 on a request the bootstrap needs can leave the reload showing
    // nothing at all rather than the app, on a lane busy enough to hit the same rare Worker restart documented
    // elsewhere in this suite - a second reload is what a person hitting a blank page would do too.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: /^History/ })).toHaveAttribute("data-state", "active", { timeout: 30_000 });
  });

  test("the same shell answers the same way on another of its pages", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("employee");

    // Straight to the tab, the way a colleague's link arrives - on a different page of the four, so a shell
    // that only works where somebody happened to test it fails here.
    await gotoRoute(page, "reimbursements/history", "Reimbursements");
    await expect(page.getByRole("tab", { name: /^History/ })).toHaveAttribute("data-state", "active", { timeout: 30_000 });

    // And back to the first tab, which has to put the URL back rather than leaving a stale "history" behind
    // for the next copied link.
    const requests = page.getByRole("tab").first();
    await requests.click();
    await expect(requests).toHaveAttribute("data-state", "active");
    await expect.poll(() => page.url()).not.toContain("/history");
  });
});
