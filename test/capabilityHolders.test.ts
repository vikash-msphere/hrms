import { describe, it, expect } from "vitest";
import { GRANTS } from "../bootstrap/authz/grants";
import { holdsCapability, holdsForAnyone, holdsVerbForAnyone } from "../src/services/capabilityHolders";

// WHO gets told, pinned against the real seeded grants.
//
// These predicates choose notification recipients: the tax verifiers when a prior-employer declaration is
// filed, the suggestion reviewers when an idea comes in, the access admins when somebody hits a wall. All
// three used to be answered from a hardcoded array of role names, and the failure mode of getting them wrong
// is SILENCE - no error, no log, just a queue nobody is told about. Neither notification has a test that
// exercises it end to end, so the predicate itself is what gets held down here.
//
// Read against domain/grants.ts, which is what scripts/seed.sql is generated from, so a Budget-day edit to the
// seeded rules that drops one of these capabilities fails here rather than in a month of unverified
// declarations.

describe("recipient predicates: who handles this", () => {
  it("tax verification alerts go to the roles that may write ANYONE's tax, and to nobody else", () => {
    const verifies = holdsForAnyone("employees.*.tax", "write");
    // Payroll, not HR: everyone's TDS projection is payroll's work, and a projection reveals pay HR does not
    // otherwise see (bootstrap/authz/roles/hr_admin.json excludes it).
    expect(verifies(GRANTS.hr_admin)).toBe(false);
    expect(verifies(GRANTS.payroll_admin)).toBe(true);
    expect(verifies(GRANTS.super_admin)).toBe(true);
    // THE ONE THAT MATTERS. `employees.me.tax.**: write` is in OWN_PII, so every employee in the org can write
    // their own tax sub-resource - and `capabilitiesOf` is scope-stripped, so the coarse test reports
    // `employees.tax.write` for all of them. Asked that way, "notify the tax verifiers" is a mail to the whole
    // company on every declaration. A manager holds the same self-scoped grant and no more.
    expect(verifies(GRANTS.employee)).toBe(false);
    expect(verifies(GRANTS.manager)).toBe(false);
    expect(holdsCapability("employees.tax.write")(GRANTS.employee)).toBe(true); // ...which is why the coarse test is wrong here
  });

  it("suggestion triage alerts go to the roles holding the respond verb on anyone's suggestion", () => {
    const responds = holdsVerbForAnyone("suggestions.*", "respond");
    expect(responds(GRANTS.hr_admin)).toBe(true);
    expect(responds(GRANTS.super_admin)).toBe(true);
    expect(responds(GRANTS.employee)).toBe(false);
    expect(responds(GRANTS.manager)).toBe(false);
    expect(responds(GRANTS.payroll_admin)).toBe(false);
  });

  it("access-admin alerts go to the roles that may write access rules", () => {
    // Coarse on purpose: `access_rules` rows carry no `code`, so there is no scope to be narrow in - "for some
    // scope" and "for every row" are the same sentence about that collection.
    const admins = holdsCapability("access-rules.write");
    expect(admins(GRANTS.super_admin)).toBe(true);
    expect(admins(GRANTS.employee)).toBe(false);
    expect(admins(GRANTS.manager)).toBe(false);
  });
});
