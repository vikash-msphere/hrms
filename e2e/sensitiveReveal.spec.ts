import { allowConsoleErrors, gotoRoute, personId, test, expect } from "./fixtures";

// The audit trail's honesty, on the two panels that share a tab with something else.
//
// Reading somebody else's bank account or tax details writes an `employees.read.sensitive` row naming the
// reader (domain/auditAccess.ts, off AUDIT.sensitive_subresources). While each had a tab to itself that row
// meant something: opening the tab was going to look. They share a tab now, so an eager panel would fire the
// read - and the row - for every admin who opened Identity or Compensation on their way to the card next to
// it, and a reviewer asking "who went looking at this person's account number" would get back everyone.
//
// `RevealCard` answers that by not mounting the panel until it is asked for. That claim is invisible to the
// tab walk in `profileTabs` (a closed card renders perfectly good text), and it is exactly the kind of thing
// that regresses silently the next time somebody tidies the tab - so it is asserted on the wire, where the
// only evidence that matters is whether the request went out at all.
//
// As super on a COLLEAGUE's record: the owner is never audited for their own data (auditAccess.ts - "not an
// abuse signal"), so their cards open eagerly and this rule does not apply to them.
test.describe("sensitive panels that share a tab", () => {
  for (const { tab, panel, url, opens } of [
    // `opens` is TEXT the real panel draws - either shape it can be in, since whether the seeded person has
    // an account on file is not this spec's business.
    { tab: "Identity", panel: "Bank details", url: "/bank-account", opens: /No bank details on file\.|Account number/ },
    { tab: "Compensation", panel: "Income tax (TDS)", url: "/tax", opens: /Joined mid-year\?|Regime|FY /i },
  ]) {
    test(`${panel} is not read until it is asked for`, async ({ as }) => {
      test.setTimeout(120_000);
      const page = await as("super");
      // A dev Worker restart mid-request on a busy lane, the same hiccup documented across this suite. What
      // this test reads is which requests went out, which no console line tells it.
      allowConsoleErrors(page, /status of (500|503)/i);
      const id = await personId(page, "hr");

      // Every request for the sub-resource behind this card, from before the page is even asked for.
      //
      // TWO SHAPES, and the batch one is the one that actually fires: reads in the same tick are coalesced
      // into a single `POST /v1/batch:run` carrying their paths in its body (lib/getCoalescer.ts), so a
      // listener watching only for a GET whose url ends in the sub-resource sees nothing whatever the page
      // does - and "no request went out" passes for the wrong reason. The needle keeps the trailing quote so
      // `/tax` does not match a `tax-declarations` path sharing the batch.
      const reads: string[] = [];
      page.on("request", (r) => {
        const at = r.url();
        if (at.includes("/v1/employees/") && at.endsWith(url)) reads.push(at);
        else if (at.endsWith("/v1/batch:run") && (r.postData() ?? "").includes(`${url}"`)) reads.push(`batch ${url}`);
      });

      await gotoRoute(page, `employees/${id}`);
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const tabPanel = page.getByRole("tabpanel").first();
      // The closed card is on screen - so the panel HAS rendered, and "no request" below is a fact about this
      // card rather than about a tab that had not opened yet.
      await expect(tabPanel.getByText(panel, { exact: true })).toBeVisible({ timeout: 30_000 });
      // And the card it shares the tab with has had time to do its own reads, which is the window in which an
      // eager neighbour would have fired this one too.
      await expect(tabPanel.getByRole("button", { name: "Show", exact: true })).toBeVisible({ timeout: 30_000 });
      expect(reads, `${panel} was read before anybody asked for it`).toEqual([]);

      // Asked for: now it reads, and the real panel is what stands there afterwards.
      await tabPanel.getByRole("button", { name: "Show", exact: true }).click();
      await expect.poll(() => reads.length, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(tabPanel.getByRole("button", { name: "Show", exact: true })).toHaveCount(0);
      await expect(tabPanel.getByText(opens).first()).toBeVisible({ timeout: 30_000 });
    });
  }
});
