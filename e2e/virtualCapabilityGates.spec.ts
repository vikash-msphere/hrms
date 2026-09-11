import { hasCapability, canSeeActivity } from "../web/src/lib/perm";
import {
  ROLES,
  SPA_HEADERS,
  accessRules,
  allowConsoleErrors,
  capabilitiesOf,
  gotoRoute,
  makeThrowawayPerson,
  purge,
  retireThrowawayPerson,
  userPath,
  test,
  expect,
  type Role,
} from "./fixtures";

// The two capabilities that are not a collection at all.
//
// Most of the model is "who can read this table". Two of the most consequential switches are neither: `export`
// is one app-wide capability behind the Export control on EVERY table (so granting a table read does not
// hand out the ability to walk out with it), and `activity` is an independent gate ANDed with record access
// behind the little clock icon on rows and profiles. Both are pure chrome - there is no page to wall off, no
// row to hide - so a browser is the only place either gate can be observed at all, and a regression in one
// would be invisible everywhere else: the button simply appears for people it was meant to be kept from.
test.describe("virtual capability gates", () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    test(`the Export control follows the export capability for ${role}`, async ({ as }) => {
      test.setTimeout(120_000);
      const page = await as(role);
      // The Directory is the one table every seeded role can open (self-scoped for an employee, org-wide for
      // the rest), so the same assertion is meaningful for all five.
      await gotoRoute(page, "employees", "Directory");
      const expected = hasCapability(await capabilitiesOf(page), "export.read");
      const control = page.getByRole("button", { name: "Export", exact: true });
      await expect(control).toHaveCount(expected ? 1 : 0);
    });
  }

  test("the per-record activity icon appears only once the activity gate is granted", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Trail");
    const subject = await userPath(admin, person.email);
    const theirs = await as({ email: person.email });
    allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);
    let claim = "";

    try {
      // A record of their own to look at the history of. Filing a claim is self-service for every employee,
      // so this needs no grant - which is the point: reading the RECORD and reading its TRAIL are separate
      // permissions, and this person starts with only the first.
      const filed = await theirs.request.post("/v1/reimbursements", {
        headers: SPA_HEADERS,
        data: { amount: 125, description: `E2E activity gate ${Date.now()}` },
      });
      expect(filed.status(), await filed.text()).toBe(200);
      claim = ((await filed.json()) as { path: string }).path;

      const caps = await capabilitiesOf(theirs);
      expect(canSeeActivity(caps, "reimbursements"), "the throwaway person already holds an activity grant").toBe(false);

      await gotoRoute(theirs, "reimbursements", "Reimbursements");
      // Description is a `defaultHidden` column on this table (DataTable's own "Toggle columns" popover) -
      // switched on here since that's the only field carrying this row's own unique text.
      await theirs.getByRole("button", { name: "Columns" }).click();
      await theirs.getByText("Description", { exact: true }).click();
      await theirs.keyboard.press("Escape");
      const row = theirs.locator("tbody tr").filter({ hasText: "E2E activity gate" });
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Their own claim, on their own page, and no way to open its trail.
      await expect(row.getByRole("button", { name: "Activity" })).toHaveCount(0);

      // The gate, granted on its own - no change at all to what records they can read.
      const granted = await admin.request.post("/v1/access-rules", {
        headers: SPA_HEADERS,
        data: { subject_kind: "user", subject, collection: "activity", scope: "all", level: "read", effect: "allow" },
      });
      expect(granted.status(), await granted.text()).toBe(200);
      expect(canSeeActivity(await capabilitiesOf(theirs), "reimbursements")).toBe(true);

      // A real reload, not just a re-navigation: `theirs` already loaded this page once above, and the SPA's
      // cached capabilities survive a same-hash re-navigation - only a genuine reload re-fetches them (the
      // capability check above is already server-true; the UI has not caught up to it yet).
      await theirs.reload();
      await gotoRoute(theirs, "reimbursements", "Reimbursements");
      const again = theirs.locator("tbody tr").filter({ hasText: "E2E activity gate" });
      const trail = again.getByRole("button", { name: "Activity" });
      await expect(trail).toBeVisible({ timeout: 30_000 });

      // And it opens onto the record's own history, lazily - the feed is not fetched until it is asked for.
      await trail.click();
      const feed = theirs.getByRole("dialog");
      await expect(feed).toBeVisible({ timeout: 30_000 });
      await expect(feed.getByText(/created|Created/).first()).toBeVisible({ timeout: 30_000 });
    } finally {
      for (const rule of await accessRules(admin)) {
        if (rule.subject === subject) {
          await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
        }
      }
      if (claim) await purge(admin, claim);
      await retireThrowawayPerson(admin, person.path);
    }
  });
});
