import { allowConsoleErrors, gotoRoute, personId, test, expect, type Role } from "./fixtures";

// Somebody else's bank account, on somebody else's record.
//
// The employee record is one page with eleven tabs, and two of them are the org's most sensitive data:
// Identity (government IDs) and Bank details. They are NOT covered by a broad grant on `employees` - the
// model deliberately splits them out as sub-resources (`employees.*.bank-account` and friends, see
// src/domain/grants.ts), so HR holding `employees.*` write for the directory still reaches nobody's PII, and
// a manager reading their team's roster reaches nobody's either. Only the owner (via `OWN_PII`) and super do.
//
// `profileTabs` walks the tabs an ADMIN is offered, and the fallback an owner gets on their own record.
// Nobody has ever opened a COLLEAGUE's record as anybody else - which is precisely where the field-precise
// split either holds or quietly does not. Three ways it can fail, and all three are checked: the tab is
// offered, the URL serves the panel anyway, or the read behind it answers.
const PRIVATE_TABS = ["Identity", "Bank details"] as const;

/** Who each viewer looks at: a colleague, never themselves - the owner rule is a different test. */
const SUBJECT: Record<string, Role> = {
  hr: "employee",
  manager: "employee", // in the manager fixture's own department: the case a my-dept grant comes closest to admitting
  payroll: "employee",
  employee: "hr",
};

test.describe("another person's PII", () => {
  for (const viewer of Object.keys(SUBJECT) as Role[]) {
    test(`${viewer} is not offered a colleague's identity or bank tabs`, async ({ as }) => {
      test.setTimeout(180_000);
      // The subject's id comes from an admin's directory, not the viewer's: an ordinary employee's list is
      // scoped to their own row, so they cannot look anybody else up - which is not the same as being unable
      // to TYPE the URL, and typing it is exactly what this test does next.
      const admin = await as("super");
      const subject = await personId(admin, SUBJECT[viewer]!);

      const page = await as(viewer);
      await gotoRoute(page, `employees/${subject}`);
      // Either the record renders (they may read the base record) or it refuses outright - and refusal has
      // two correct shapes: the ROUTE wall (a viewer with no path to the page at all) and the per-object
      // DataState error (a viewer who reaches the page but whose item-GET the middleware denies - a plain
      // employee opening a colleague's own profile, e.g., which grants.ts documents as deliberate: "A 1-token
      // pattern matches only the collection, so item-GET of someone else stays denied"). All three are
      // correct answers to "may I look at this person at all"; what follows is about the PII either way.
      await expect(profileOrDenied(page)).toBeVisible({ timeout: 30_000 });

      for (const tab of PRIVATE_TABS) {
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
          `${viewer} was offered "${tab}" on a colleague's record`,
        ).toHaveCount(0);
      }

      // And the URL is not a way round the tab bar.
      for (const segment of ["identity", "bank"]) {
        await gotoRoute(page, `employees/${subject}/${segment}`);
        await expect(profileOrDenied(page)).toBeVisible({ timeout: 30_000 });
        for (const tab of PRIVATE_TABS) {
          await expect(
            page.getByRole("tab", { name: tab, exact: true }),
            `…/${segment} served "${tab}" to ${viewer}`,
          ).toHaveCount(0);
        }
      }

      // The read itself, which is the gate the UI is only reflecting.
      const bank = await page.request.get(`/v1/employees/${subject}/bank-account`);
      expect(bank.status(), `${viewer} could read a colleague's bank account`).toBe(403);
    });
  }

  test("the owner and the admin still reach it, so the rule above is a rule and not a broken page", async ({ as }) => {
    test.setTimeout(180_000);
    const owner = await as("employee");
    // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this
    // suite (complianceRuleDelete.spec.ts et al.). What this test reads is which tabs are offered and what
    // the PII endpoints answer - both asserted directly below, and neither told by a console line.
    allowConsoleErrors(owner, /status of 500|status of 503/i);
    const own = await personId(owner, "employee");
    await gotoRoute(owner, `employees/${own}`);
    for (const tab of PRIVATE_TABS) {
      await expect(owner.getByRole("tab", { name: tab, exact: true })).toBeVisible({ timeout: 30_000 });
    }
    expect((await owner.request.get(`/v1/employees/${own}/bank-account`)).status()).toBe(200);

    const admin = await as("super");
    await gotoRoute(admin, `employees/${own}`);
    for (const tab of PRIVATE_TABS) {
      await expect(admin.getByRole("tab", { name: tab, exact: true })).toBeVisible({ timeout: 30_000 });
    }
    expect((await admin.request.get(`/v1/employees/${own}/bank-account`)).status()).toBe(200);
  });
});

/** The page rendered, the route wall, or the per-object DataState error - any of the three is "not the PII". */
function profileOrDenied(page: import("@playwright/test").Page) {
  return page
    .getByRole("tab", { name: "Profile", exact: true })
    .or(page.getByText("You don't have access to this"))
    .or(page.getByText("Couldn't load this data"))
    .first();
}
