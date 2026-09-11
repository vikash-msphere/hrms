import { hasCapability } from "../web/src/lib/perm";
import { ROLES, allowConsoleErrors, capabilitiesOf, gotoRoute, test, expect, type Role } from "./fixtures";

// "Hide, never disable", applied to the buttons rather than the pages.
//
// `boot`/`navMatrix` cover the ROUTE half of the rule. This is the half a person meets first: the "New X"
// button at the top of a page they CAN open. Every one of them is wrapped in `<AccessAction create>`, which
// renders nothing unless the caller holds `<collection>.write` (web/src/components/access/AccessAction.tsx) -
// one central gate, which is exactly why nothing else notices when it stops applying to a page. The two
// failures it guards are opposite and both bad: a button offered to somebody whose press can only 403, and a
// button withheld from somebody who was granted the collection and now believes the grant did not take.
//
// `test/webAccessCoverage.test.ts` proves the wrappers EXIST in the source. It cannot prove the gate answers
// correctly for a real caller, because the answer comes from the capability set the server issues at run
// time - which is what this reads (`/v1/users/me`) and holds the rendered page to, for every seeded role.
type Gate = {
  route: string;
  /** The `<h1>` the route lands on, so a spec never asserts a missing button on the wrong page. */
  heading: string;
  /** The button's own visible text - which is often shorter than the AccessAction label beside it. */
  button: string;
  /** The capability `AccessAction` checks: `<collection>.write` for a create gate, `<collection>.<verb>` for a
   *  custom-method one. */
  capability: string;
};

const GATES: Gate[] = [
  // Self-service collections: every role holds these, so the interesting answer is that the button is THERE.
  { route: "reimbursements", heading: "Reimbursements", button: "New claim", capability: "reimbursements.write" },
  { route: "goals", heading: "Goals", button: "New goal", capability: "goals.write" },
  { route: "check-ins", heading: "1:1s", button: "New 1:1", capability: "check-ins.write" },
  { route: "loans", heading: "Loans & Advances", button: "Request loan", capability: "loans.write" },
  { route: "tax-declarations", heading: "Tax Declarations", button: "Add declaration", capability: "tax-declarations.write" },
  { route: "tickets", heading: "Support", button: "New ticket", capability: "tickets.write" },
  // Administered collections: the ones an ordinary employee must not be offered a way into.
  { route: "referrals", heading: "Referrals", button: "Refer someone", capability: "referrals.write" },
  { route: "transitions", heading: "Onboarding & Offboarding", button: "Start process", capability: "transitions.write" },
  { route: "job-requisitions", heading: "Jobs", button: "New job", capability: "job-requisitions.write" },
  { route: "candidates", heading: "Candidates", button: "Add candidate", capability: "candidates.write" },
  { route: "interviews", heading: "Interviews", button: "Schedule interview", capability: "interviews.write" },
  { route: "offers", heading: "Offers", button: "New offer", capability: "offers.write" },
  { route: "assets", heading: "Assets", button: "Add asset", capability: "assets.write" },
  // A CUSTOM METHOD rather than a create gate: the same wrapper, gated on the verb's own capability. Worth a
  // line of its own because the two paths through AccessAction are different code.
  { route: "assets", heading: "Assets", button: "Add many", capability: "assets.batchCreate" },
];

test.describe("create and method gates", () => {
  test("the table names a button the app still renders", async ({ as }) => {
    // A gate whose button was renamed would otherwise pass forever as "correctly hidden" for everybody.
    // Super holds every capability, so on super every button in the table must be on screen - which is the
    // cheapest way to keep the table honest.
    test.setTimeout(300_000);
    const page = await as("super");
    const missing: string[] = [];
    for (const gate of GATES) {
      await gotoRoute(page, gate.route, gate.heading);
      if (!(await page.getByRole("button", { name: gate.button, exact: true }).count())) {
        missing.push(`${gate.route}: no button named "${gate.button}" (renamed, moved, or removed)`);
      }
    }
    expect(missing, `the gate table has gone stale:\n${missing.join("\n")}`).toEqual([]);
  });

  for (const role of Object.keys(ROLES) as Role[]) {
    test(`${role} is offered exactly the create and method buttons they hold`, async ({ as }) => {
      test.setTimeout(300_000);
      const page = await as(role);
      // Every gated route in one page, back to back - on a busy lane, a dev Worker restart mid-request on any
      // one of that many navigations reads as a plain 503, no different from the same rare hiccup documented
      // elsewhere in this suite (complianceRuleDelete.spec.ts et al.); a genuinely wrong gate still fails the
      // `wrong` assertion below, so this only excuses the transient network noise, never a real mismatch.
      allowConsoleErrors(page, /status of 503/i);
      await gotoRoute(page, "dashboard");
      const caps = await capabilitiesOf(page);

      const wrong: string[] = [];
      for (const gate of GATES) {
        await gotoRoute(page, gate.route);
        // A route this caller may not read answers with the wall, and a wall has no buttons to judge - the
        // route half of the rule is `navMatrix`'s business, not this spec's.
        if (await page.getByText("You don't have access to this").count()) continue;
        await expect(page.getByRole("heading", { level: 1, name: gate.heading })).toBeVisible({ timeout: 30_000 });

        const expected = hasCapability(caps, gate.capability);
        const button = page.getByRole("button", { name: gate.button, exact: true });
        // Presence, not enabledness: a caller who may not act must not be shown a dead control, so the
        // assertion is on the count. (`New ticket` is disabled for an account with no employee record - that
        // is a data gate, not an access one, and it is still correctly PRESENT.)
        const shown = (await button.count()) > 0;
        if (shown !== expected) {
          wrong.push(`${gate.route} · "${gate.button}": ${shown ? "offered without" : "withheld despite"} ${gate.capability}`);
        }
      }
      expect(wrong, `buttons that disagree with the caller's capabilities:\n${wrong.join("\n")}`).toEqual([]);
    });
  }
});
