/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { callerScopes } from "../src/domain/access";
import { capabilitiesOf } from "../src/domain/permissions";
import { grantFor } from "../bootstrap/authz/grants";
import type { Role } from "../src/env";

// WHAT A CAPABILITY STRING CANNOT SAY, and the gate that keeps the profile pages from asking it anyway.
//
// `capabilitiesOf` strips the scope token, so the self-service grant EVERY employee holds on attendance,
// goals, reviews, payslips, the board and their own tax arrives at the SPA spelled exactly like an org-wide
// one. Gating a panel about ANOTHER PERSON on that string is true for everybody, about everybody: the tabs
// render on every colleague's record, and the Edit/Verify affordances inside them offer to write another
// person's PII. The rows still come back scoped (the list services bind `applyScope`), so nothing leaked -
// but an affordance that is visible and cannot work is what "hide, never disable" exists to rule out.
//
// `callerScopes` is the missing half: the breadth the grant ACTUALLY reaches, per collection and per
// field-precise employee sub-resource, computed the same way a list's breadth is. Two suites here - the
// breadths themselves, and a source scan that fails if a per-record surface goes back to the stripped string.

const code = "04-1c-0a9"; // dept "04-1c"
const actorFor = (role: Role) => ({ grant: grantFor(role), employeeCode: code });

describe("capabilitiesOf - manager-chain scopes strip like every other scope token", () => {
  it("a rule scoped to the reporting line yields the plain capability the SPA gates on", () => {
    const caps = capabilitiesOf({
      levels: { "leave-requests.my-reports.**": "read", "goals.my-org.**": "write" },
      allow: ["leave-requests.my-reports.approve", "goals.my-org.comment"],
    });
    expect(caps).toContain("leave-requests.read");
    expect(caps).toContain("leave-requests.approve");
    expect(caps).toContain("goals.write");
    expect(caps).toContain("goals.comment");
    expect(caps.some((c) => c.includes("my-reports") || c.includes("my-org"))).toBe(false);
  });
});

describe("callerScopes - the breadth a capability string drops", () => {
  it("an employee reaches NOTHING of somebody else's, for every self-service collection", () => {
    const { read, write } = callerScopes(actorFor("employee"));
    // Each of these is held self-scoped by every employee and strips to a bare `<collection>.read`.
    for (const c of ["attendance", "attendance-day-marks", "goals", "reviews", "payslips", "leave-requests", "personal-documents", "expenses", "reimbursements"]) {
      expect(read[c], `${c} must not be readable beyond own`).toBeUndefined();
    }
    // ...and the stripped capability says the opposite for every one of them, which is the whole point.
    const caps = capabilitiesOf(grantFor("employee"));
    for (const c of ["attendance", "goals", "reviews", "payslips"]) {
      expect(caps).toContain(`${c}.read`);
    }
    // The employee record's sensitive sub-resources: self-service write, and no reach at all past self.
    for (const sub of ["tax", "bank-account", "identity", "personal-info"]) {
      expect(read[`employees.${sub}`], `employees.${sub} read`).toBeUndefined();
      expect(write[`employees.${sub}`], `employees.${sub} write`).toBeUndefined();
    }
    expect(capabilitiesOf(grantFor("employee"))).toContain("employees.tax.write"); // the string that lied
  });

  it("the collections an employee IS granted org-wide report it, so the board stays public", () => {
    const { read } = callerScopes(actorFor("employee"));
    // The announcement feed is the company's. Boards and their tasks reach past own rows through the two
    // org-visible code segments (`boards.ve-*.**`, domain/boardAccess.ts) - subtree rules, which report as
    // `dept` (a branch of the codes, not the whole org: private boards are not in it). Either way not `own`,
    // so the board stays public to everyone it is visible to.
    expect(read.cards).toBe("dept");
    expect(read.announcements).toBe("all");
    expect(read.boards).toBe("dept");
    // The suggestion box is the company's too (the everyone role reads every suggestion).
    expect(read.suggestions).toBe("all");
  });

  it("a manager reaches their department, and only where the grant says so", () => {
    const { read, write } = callerScopes(actorFor("manager"));
    expect(read.attendance).toBe("dept");
    expect(read["attendance-day-marks"]).toBe("dept");
    expect(read["leave-requests"]).toBe("dept");
    expect(read.goals).toBe("dept");
    expect(write.goals).toBe("dept"); // `goals.my-dept.**` is a write grant
    expect(write["attendance-day-marks"]).toBeUndefined(); // read only: re-valuing a day is a pay decision
    expect(read.reviews).toBe("dept"); // the team's reviews - the manager runs the stage verbs on them
    expect(read.payslips).toBeUndefined(); // pay is payroll's, not the line manager's
    // Dept membership does not open the PII sub-resources (grants.ts: `employees.my-dept` is 2-token).
    for (const sub of ["tax", "bank-account", "identity", "personal-info"]) {
      expect(read[`employees.${sub}`], `employees.${sub}`).toBeUndefined();
    }
  });

  it("payroll reaches everyone's tax and payslips, and still not their bank or identity", () => {
    const { read, write } = callerScopes(actorFor("payroll_admin"));
    expect(read["employees.tax"]).toBe("all"); // `employees.*.tax.**`
    expect(write["employees.tax"]).toBe("all");
    expect(read.payslips).toBe("all");
    expect(write.payslips).toBeUndefined(); // read grant only
    expect(read.compensation).toBe("all");
    expect(read["employees.bank-account"]).toBeUndefined();
    expect(read["employees.identity"]).toBeUndefined();
  });

  it("the activity trail reports its OWN breadth, which the stripped capability also drops", () => {
    // The per-entity trail is a second gate, ANDed with reading the record, and it is scoped independently
    // (`activity.<code>.<collection>`, middleware/authz.ts). `activity.me.**` and `activity.**` strip to the
    // same `activity.employees.read`, so the Activity tab gated on the string rendered on every colleague's
    // record for a caller granted only their own trail.
    for (const role of ["employee", "manager", "payroll_admin", "hr_admin"] as Role[]) {
      // Private by default: no seeded role holds activity at all, so no key for any of them.
      expect(callerScopes(actorFor(role)).read["activity.employees"], `${role} activity.employees`).toBeUndefined();
    }
    // Super's `**` is the one grant that reaches it, and it reaches everybody's.
    expect(callerScopes(actorFor("super_admin")).read["activity.employees"]).toBe("all");
  });

  it("a caller with no employee code fails closed on every relative tier", () => {
    const { read } = callerScopes({ grant: grantFor("employee"), employeeCode: null });
    // Nothing self-relative can match, so only the grants that name no person survive - the org-visible board
    // segments among them, which are subtree rules on board codes and need no employee code.
    expect(read.attendance).toBeUndefined();
    expect(read.goals).toBeUndefined();
    expect(read.cards).toBe("dept");
  });

  it("`own` is omitted rather than sent, so an absent key is the fail-closed answer", () => {
    const { read, write } = callerScopes(actorFor("employee"));
    expect(Object.values(read)).not.toContain("own");
    expect(Object.values(write)).not.toContain("own");
  });
});

// ---- the drift gate ------------------------------------------------------------------------------------
//
// A source scan, because the defect is a CALL SHAPE rather than a value: `usePermission("<x>.read")` on a
// surface that is about one named employee. The set of dangerous capabilities is derived from the seeded
// employee grant rather than listed by hand - every capability a plain employee holds is one whose stripped
// string says yes about everybody, so adding a self-service grant automatically widens this gate.

const sources = import.meta.glob(
  [
    "../web/src/pages/EmployeeProfile.tsx",
    "../web/src/components/common/Employee*.tsx",
    "../web/src/components/common/AttendanceHistory.tsx",
    // The org chart is a per-person surface too, one node per employee: its overlays mark OTHER people
    // ("who is off today"), and that toggle was gated on the `leave-requests.read` every employee holds for
    // their own requests, so it rendered for all of them and could only ever mark their own node.
    "../web/src/pages/OrgChart.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("per-record surfaces ask the engine about the SUBJECT, not the caller", () => {
  // Every capability the seeded `employee` role holds: the ones that cannot tell own from everyone's. Derived
  // rather than listed, so a new self-service grant widens this gate on its own.
  const selfService = new Set(capabilitiesOf(grantFor("employee")));
  // The caller-level hooks. Correct on a page ("is there anybody but me I could do this for"), wrong on a
  // surface about a named person - they report a TIER, which cannot say whether THIS person is in the team.
  const CALLER_LEVEL = ["useCanReadOthers", "useCanWriteOthers"];
  // The shape that came before, kept named so it cannot quietly return: it took `isSelf` as an argument, which
  // is the client asserting a policy ("your own record is always yours") that belongs in `access_rules`.
  const RETIRED = ["useCanReadFor", "useCanWriteFor"];
  // MANY-SUBJECT surfaces, where a caller-level tier is the honest question and `access.subject` does not
  // exist to ask. The org chart draws every node at once, so "may I see somebody's leave" has no somebody -
  // the toggle asks whether ANY other person's leave is visible, and the server then decides which nodes get
  // marked. The stripped-capability half of this gate still applies to them, which is the half that was the
  // original defect here (`leave-requests.read` is held by every employee for their own requests).
  const MANY_SUBJECT: Record<string, string> = {
    "OrgChart.tsx": "one node per employee - no single subject for the engine to answer about",
  };

  it("scans the files it means to scan", () => {
    const names = Object.keys(sources).map((p) => p.split("/").pop());
    expect(names).toContain("EmployeeProfile.tsx");
    expect(names).toContain("AttendanceHistory.tsx");
    expect(names.length).toBeGreaterThan(5);
  });

  for (const [path, src] of Object.entries(sources)) {
    const file = path.split("/").slice(-1)[0]!;
    it(`${file} gates on access.subject alone`, () => {
      // Comments out first: these files EXPLAIN the trap, quoting the very calls they must not make.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const stripped = [...code.matchAll(/usePermission\(\s*"([^"]+)"/g)].map((m) => m[1]!).filter((cap) => selfService.has(cap));
      const banned = MANY_SUBJECT[file] ? RETIRED : [...CALLER_LEVEL, ...RETIRED];
      const tiers = banned.filter((h) => new RegExp(`\\b${h}\\(`).test(code));
      expect(
        [...stripped, ...tiers],
        `${file} decides a per-record panel with ${[...stripped, ...tiers].join(", ")}. A stripped capability ` +
          `is true for every employee about everybody, and a breadth is a tier that names nobody - neither can ` +
          `say whether THIS person is the caller, their report, or the subject of a share. Use ` +
          `useSubjectCanRead / useSubjectCanWrite (web/src/lib/perm.ts), which read the server's answer for ` +
          `this person (src/domain/access.ts subjectScopes).`,
      ).toEqual([]);
    });
  }
});
