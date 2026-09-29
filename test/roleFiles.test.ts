import { describe, it, expect } from "vitest";
import { GRANTS, EVERYONE_GRANT, ROLE_FILES } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { compileGrant, mergeGrants } from "../src/domain/compileGrants";
import { MAX_CLONE_RULES } from "../src/services/accessRules";

// The seeded roles are one JSON file each (bootstrap/authz/roles/). The loader already refuses a malformed file;
// this pins what the least-privilege review of the employee role decided, so a later edit that quietly undoes
// one of those decisions fails here with the reason, instead of shipping.
const SELF = { employeeCode: "04-1c-0a9" };
const OWN = "04-1c-0a9-0";
const OTHER = "07-2a-0b1-0";
const employee = mergeGrants(GRANTS.employee, EVERYONE_GRANT);
const can = (m: string, p: string) => decide(employee, resolveRequest(m, p, false), SELF).allow;

describe("role files", () => {
  it("one file per seeded role, exactly one given to new accounts, and it is assignable", () => {
    expect(ROLE_FILES.map((f) => f.role)).toEqual(["everyone", "employee", "team_lead", "manager", "hr_admin", "payroll_admin", "super_admin", "it_admin", "project_manager"]);
    expect(ROLE_FILES.filter((f) => f.provisioned).map((f) => f.role)).toEqual(["employee"]);
  });

  it("every seeded role can be cloned: the role editor's \"Start from\" copies one in a single request", () => {
    // The seeded ROWS, which is what a clone reads: a role file inherits (a manager is an employee plus the
    // department), so the compiled grant is larger than the file's own list.
    for (const [role, grant] of Object.entries({ ...GRANTS, everyone: EVERYONE_GRANT })) {
      expect(compileGrant(grant).length, `${role} holds more rules than cloneAccessRules copies`).toBeLessThanOrEqual(MAX_CLONE_RULES);
    }
  });

  it("a manager is an employee plus the department: every employee rule reaches a manager", () => {
    for (const p of Object.keys(GRANTS.employee.levels)) expect(GRANTS.manager.levels[p], p).toBeDefined();
    for (const p of GRANTS.employee.allow) expect(GRANTS.manager.allow, p).toContain(p);
  });

  it("nothing a file lists as excluded is granted by that file", () => {
    for (const f of ROLE_FILES) {
      const lanes = { levels: new Set(f.levels.map((r) => r.pattern)), allow: new Set(f.allow.map((r) => r.pattern)) };
      // Only exact patterns are checked; an excluded entry that names a family (`a | b`) is prose about several.
      // `lane` narrows it when the same pattern is right in one lane and wrong in the other (`cards.**` is the
      // board read-write level, and excluded only as a wildcard VERB).
      for (const x of f.excluded as { pattern: string; lane?: "levels" | "allow" }[]) {
        if (/[ |(]/.test(x.pattern)) continue;
        for (const lane of x.lane ? [x.lane] : (["levels", "allow"] as const)) {
          expect(lanes[lane].has(x.pattern), `${f.role} excludes ${x.pattern} but grants it in ${lane}`).toBe(false);
        }
      }
    }
  });
});

describe("settings are owned per key", () => {
  const as = (role: keyof typeof GRANTS) => (m: string, p: string) => decide(mergeGrants(GRANTS[role], EVERYONE_GRANT), resolveRequest(m, p, false), SELF).allow;
  const GOVERNANCE = ["access-approval", "access-review", "payroll-approval", "sign-in", "ai", "attachments"];
  const PAYROLL = ["ctc", "tax-config", "professional-tax", "overtime", "gratuity", "loan-perquisite", "payslip", "payroll-gl", "payroll-variance", "payroll-recovery"];
  const HR = ["organization", "attendance", "punctuality", "leave_caps", "holidays", "performance", "ats", "esign", "ticket-categories", "reimbursements", "expenses"];

  it("nobody but super admin flips a governance switch - least of all the people it restrains", () => {
    for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
      for (const k of GOVERNANCE) expect(as(role)("PATCH", `/v1/settings/${k}`), `${role} ${k}`).toBe(false);
    }
    for (const k of GOVERNANCE) expect(as("super_admin")("PATCH", `/v1/settings/${k}`), k).toBe(true);
  });
  it("pay configuration is payroll's, HR policy is HR's, and everyone reads both", () => {
    for (const k of PAYROLL) {
      expect(as("payroll_admin")("PATCH", `/v1/settings/${k}`), `payroll ${k}`).toBe(true);
      expect(as("hr_admin")("PATCH", `/v1/settings/${k}`), `hr ${k}`).toBe(false);
    }
    for (const k of HR) {
      expect(as("hr_admin")("PATCH", `/v1/settings/${k}`), `hr ${k}`).toBe(true);
      expect(as("payroll_admin")("PATCH", `/v1/settings/${k}`), `payroll ${k}`).toBe(false);
    }
    for (const k of [...PAYROLL, ...HR, ...GOVERNANCE]) expect(as("employee")("GET", `/v1/settings/${k}`), k).toBe(true);
  });
  it("pay catalogues and payout formats are payroll's; HR reads them", () => {
    for (const col of ["pay-components", "pay-periods", "bank-formats"]) {
      expect(as("payroll_admin")("POST", `/v1/${col}`), `payroll ${col}`).toBe(true);
      expect(as("hr_admin")("POST", `/v1/${col}`), `hr ${col}`).toBe(false);
    }
  });
  it("HR does not see everyone's tax - payroll's work, and it reveals pay HR does not otherwise read", () => {
    expect(as("hr_admin")("GET", `/v1/employees/${"07-2a-0b1"}/tax`)).toBe(false);
    expect(as("hr_admin")("GET", `/v1/tax-declarations/${OTHER}`)).toBe(false);
    expect(as("payroll_admin")("GET", `/v1/tax-declarations/${OTHER}`)).toBe(true);
  });
});

describe("HR and payroll are employees first", () => {
  it("both file their own leave, claims and tickets, and see only their own", () => {
    for (const role of ["hr_admin", "payroll_admin"] as const) {
      const g = mergeGrants(GRANTS[role], EVERYONE_GRANT);
      const ok = (m: string, p: string) => decide(g, resolveRequest(m, p, false), SELF).allow;
      expect(ROLE_FILES.find((f) => f.role === role)!.extends, role).toBe("employee");
      for (const col of ["leave-requests", "reimbursements", "tickets", "goals"]) expect(ok("POST", `/v1/${col}`), `${role} ${col}`).toBe(true);
      expect(ok("POST", `/v1/leave-requests/${OWN}:cancel`), `${role} cancel own leave`).toBe(true);
    }
  });
  it("payroll's own four-eyes switch is not payroll's to turn off", () => {
    expect(decide(GRANTS.payroll_admin, resolveRequest("PATCH", "/v1/settings/payroll-approval", false), SELF).allow).toBe(false);
    expect(decide(GRANTS.payroll_admin, resolveRequest("POST", `/v1/payroll-runs/${OTHER}:approve`, false), SELF).allow).toBe(false);
  });
});

describe("team lead: leads their direct reports on goals and 1:1s, decides none of their requests", () => {
  // The lead is 04-1c-0a9; 04-1c-0b2 reports to them; 04-1c-0c3 is in the same department and does not.
  const self = { employeeCode: "04-1c-0a9", reportCodes: ["04-1c-0b2"] };
  const lead = mergeGrants(GRANTS.team_lead, EVERYONE_GRANT);
  const ok = (m: string, p: string) => decide(lead, resolveRequest(m, p, false), self).allow;
  const REPORT = "04-1c-0b2-0";
  const PEER = "04-1c-0c3-0";

  it("is an employee first", () => {
    expect(ROLE_FILES.find((f) => f.role === "team_lead")!.extends).toBe("employee");
    for (const p of GRANTS.employee.allow) expect(GRANTS.team_lead.allow, p).toContain(p);
  });
  it("sets, agrees and coaches a report's goals, and runs their 1:1s - a report's, not a department peer's", () => {
    for (const [m, p] of [["PATCH", `/v1/goals/${REPORT}`], ["POST", `/v1/goals/${REPORT}:approve`], ["POST", `/v1/goals/${REPORT}:requestChanges`], ["POST", `/v1/goals/${REPORT}:comment`], ["PATCH", `/v1/check-ins/${REPORT}`]] as const) {
      expect(ok(m, p), `${m} ${p}`).toBe(true);
      expect(ok(m, p.replace(REPORT, PEER)), `${m} ${p} for a non-report`).toBe(false);
    }
  });
  it("approves no request, and reads none of a report's leave, attendance, review or presence", () => {
    for (const col of ["leave-requests", "attendance-regularizations", "overtime-requests", "remote-work-requests", "late-early-requests", "asset-requests", "time-entries", "expenses"]) {
      expect(ok("POST", `/v1/${col}/${REPORT}:approve`), `${col} approve`).toBe(false);
    }
    for (const p of [`/v1/leave-requests/${REPORT}`, `/v1/attendance/${REPORT}`, `/v1/reviews/${REPORT}`, "/v1/employees/04-1c-0b2/presence"]) expect(ok("GET", p), p).toBe(false);
    expect(ok("POST", `/v1/reviews/${REPORT}:submitManager`)).toBe(false);
    expect(ok("POST", `/v1/goals/${REPORT}:setContributors`)).toBe(false); // scores in a review - the manager's
  });
  it("holds nothing a manager does not, so it is never a way around the manager", () => {
    // Asked of a manager whose department contains the report: every lead grant is covered by `my-dept`.
    const mgr = mergeGrants(GRANTS.manager, EVERYONE_GRANT);
    const mgrSelf = { employeeCode: "04-1c-0a9" };
    for (const [m, p] of [["PATCH", `/v1/goals/${REPORT}`], ["POST", `/v1/goals/${REPORT}:approve`], ["PATCH", `/v1/check-ins/${REPORT}`]] as const) {
      expect(decide(mgr, resolveRequest(m, p, false), mgrSelf).allow, `${m} ${p}`).toBe(true);
    }
  });
});

describe("project manager: runs boards and sprints, and the direct reports' goals", () => {
  // The PM is 04-1c-0a9; 04-1c-0b2 reports to them; 04-1c-0c3 is in the same department and does not.
  const self = { employeeCode: "04-1c-0a9", reportCodes: ["04-1c-0b2"] };
  const pm = mergeGrants(GRANTS.project_manager, EVERYONE_GRANT);
  const ok = (m: string, p: string) => decide(pm, resolveRequest(m, p, false), self).allow;
  const REPORT = "04-1c-0b2-0";
  const PEER = "04-1c-0c3-0";

  it("is an employee first", () => {
    expect(ROLE_FILES.find((f) => f.role === "project_manager")!.extends).toBe("employee");
    for (const p of GRANTS.employee.allow) expect(GRANTS.project_manager.allow, p).toContain(p);
  });
  it("manages every board, private ones included, which a plain employee cannot", () => {
    for (const [m, p] of [["POST", "/v1/boards"], ["PATCH", "/v1/boards/ve-0a"], ["PATCH", "/v1/boards/vp-0a"], ["POST", "/v1/boards/vp-0a:share"], ["POST", "/v1/sprints/ve-0a-001:activate"], ["POST", "/v1/sprints/vp-0a-001:complete"]] as const) {
      expect(ok(m, p), `${m} ${p}`).toBe(true);
      expect(can(m, p), `employee ${m} ${p}`).toBe(false);
    }
    expect(ok("POST", "/v1/cards/vp-0a-001:move")).toBe(true);
    expect(ok("GET", "/v1/cards/vp-0a-001")).toBe(true);
  });
  it("sets, agrees and coaches a report's goals - a report's, not a department peer's", () => {
    for (const [m, p] of [["PATCH", `/v1/goals/${REPORT}`], ["POST", `/v1/goals/${REPORT}:approve`], ["POST", `/v1/goals/${REPORT}:requestChanges`], ["POST", `/v1/goals/${REPORT}:comment`]] as const) {
      expect(ok(m, p), `${m} ${p}`).toBe(true);
      expect(ok(m, p.replace(REPORT, PEER)), `${m} ${p} for a non-report`).toBe(false);
    }
  });
  it("approves no request, runs no 1:1 or review, and credits no contributor", () => {
    for (const col of ["leave-requests", "attendance-regularizations", "overtime-requests", "remote-work-requests", "late-early-requests", "asset-requests", "time-entries", "expenses"]) {
      expect(ok("POST", `/v1/${col}/${REPORT}:approve`), `${col} approve`).toBe(false);
    }
    expect(ok("PATCH", `/v1/check-ins/${REPORT}`)).toBe(false);
    expect(ok("GET", `/v1/reviews/${REPORT}`)).toBe(false);
    expect(ok("POST", `/v1/goals/${REPORT}:setContributors`)).toBe(false);
  });
});

describe("boards: visibility is the code segment, and nobody but super admin and the PM reaches a private one", () => {
  const as = (role: keyof typeof GRANTS) => (m: string, p: string) => decide(mergeGrants(GRANTS[role], EVERYONE_GRANT), resolveRequest(m, p, false), SELF).allow;

  it("everyone sees and works an edit board, sees a view board, and reaches no private one", () => {
    expect(can("GET", "/v1/boards/ve-0a")).toBe(true);
    expect(can("POST", "/v1/cards/ve-0a-001:move")).toBe(true);
    expect(can("PATCH", "/v1/cards/ve-0a-001")).toBe(true);
    expect(can("GET", "/v1/boards/vr-0a")).toBe(true);
    expect(can("GET", "/v1/cards/vr-0a-001")).toBe(true);
    expect(can("POST", "/v1/cards/vr-0a-001:move")).toBe(false);
    expect(can("PATCH", "/v1/cards/vr-0a-001")).toBe(false);
    for (const p of ["/v1/boards/vp-0a", "/v1/cards/vp-0a-001", "/v1/sprints/vp-0a-001"]) expect(can("GET", p), p).toBe(false);
  });
  it("HR and managers create boards but manage none by role, and see no private board", () => {
    for (const role of ["hr_admin", "manager"] as const) {
      const ok = as(role);
      expect(ok("POST", "/v1/boards"), `${role} create`).toBe(true);
      expect(ok("PATCH", "/v1/boards/ve-0a"), `${role} rename`).toBe(false);
      expect(ok("POST", "/v1/boards/ve-0a:configure"), `${role} configure`).toBe(false);
      expect(ok("POST", "/v1/sprints/ve-0a-001:activate"), `${role} sprint`).toBe(false);
      expect(ok("GET", "/v1/boards/vp-0a"), `${role} private`).toBe(false);
    }
  });
  it("no role holds a self or team token on boards, cards or sprints - they match by code, and these are board codes", () => {
    for (const f of ROLE_FILES) {
      for (const r of [...f.levels, ...f.allow, ...f.deny]) {
        const [ns, scope] = r.pattern.split(".");
        if (["boards", "cards", "sprints"].includes(ns!)) expect(["me", "my-dept", "my-reports", "my-org"], `${f.role} ${r.pattern}`).not.toContain(scope);
      }
    }
  });
});

describe("everyone: what every account needs, and nothing about anybody else", () => {
  // A role an admin builds in Access Management with no rules of its own: it decides with `everyone` alone.
  const bare = (m: string, p: string) => decide(EVERYONE_GRANT, resolveRequest(m, p, false), SELF).allow;

  it("a role with no rules still loads the app: who am I, preferences, exports, the batch transport", () => {
    for (const [m, p] of [["GET", "/v1/users/me"], ["GET", "/v1/preferences"], ["PATCH", "/v1/preferences/theme"], ["GET", "/v1/operations"], ["GET", `/v1/operations/${OWN}`], ["POST", "/v1/batch:run"]] as const) {
      expect(bare(m, p), `${m} ${p}`).toBe(true);
    }
  });
  it("own notifications and held assets, and never another person's", () => {
    expect(bare("PATCH", `/v1/notifications/${OWN}`)).toBe(true);
    expect(bare("PATCH", `/v1/notifications/${OTHER}`)).toBe(false);
    expect(bare("GET", `/v1/operations/${OTHER}`)).toBe(false);
    expect(bare("GET", "/v1/assets/a1")).toBe(false); // a flat code: an item read would be every asset
    expect(bare("POST", "/v1/notifications")).toBe(false);
  });
  it("carries none of an employee's HR self-service", () => {
    for (const [m, p] of [["GET", "/v1/employees/04-1c-0a9"], ["POST", "/v1/leave-requests"], ["GET", `/v1/payslips/${OWN}`], ["GET", "/v1/holidays"]] as const) {
      expect(bare(m, p), `${m} ${p}`).toBe(false);
    }
  });
  it("no role file repeats an everyone rule, so each rule has one home", () => {
    const everyone = ROLE_FILES.find((f) => f.role === "everyone")!;
    const mine = new Set([...everyone.levels, ...everyone.allow].map((r) => r.pattern));
    for (const f of ROLE_FILES.filter((x) => x.role !== "everyone" && x.role !== "super_admin")) {
      for (const r of [...f.levels, ...f.allow]) expect(mine.has(r.pattern), `${f.role} repeats ${r.pattern}`).toBe(false);
    }
  });
});

describe("employee: what the review found missing is granted", () => {
  it("signs own generated letter (the Documents page offers it; the service enforces owner-only)", () => {
    expect(can("POST", `/v1/personal-documents/${OWN}:sign`)).toBe(true);
    expect(can("POST", `/v1/personal-documents/${OTHER}:sign`)).toBe(false);
  });
  it("drafts where the employee is the author, not where they are not", () => {
    for (const c of ["reviews", "goals", "cards"]) expect(can("POST", `/v1/${c}:draft`), c).toBe(true);
    // An employee posts only kudos, and kudos is never drafted - so no announcements draft either.
    expect(can("POST", "/v1/announcements:draft")).toBe(false);
    expect(can("POST", "/v1/suggestions:draft")).toBe(false);
    expect(can("POST", "/v1/job-requisitions:draft")).toBe(false);
  });
  it("RSVPs to an event (the service refuses anyone not on the attendee list)", () => {
    expect(can("POST", "/v1/events/0x:respond")).toBe(true);
  });
});

describe("employee: what the review found too broad is not granted", () => {
  it("a requester cannot work their own ticket as the help desk would", () => {
    for (const v of ["assign", "route", "prioritize", "start", "resolve", "triage", "decideTriage", "addTodos"]) {
      expect(can("POST", `/v1/tickets/${OWN}:${v}`), v).toBe(false);
    }
    for (const v of ["comment", "cancel", "close", "reopen", "attach"]) expect(can("POST", `/v1/tickets/${OWN}:${v}`), v).toBe(true);
  });
  it("card verbs are named, so a verb added later is not granted by a wildcard", () => {
    expect(GRANTS.employee.allow).not.toContain("cards.**");
    expect(can("POST", `/v1/cards/${OTHER}:someFutureVerb`)).toBe(false);
  });
  it("posting to the company board stays HR's; kudos stays open", () => {
    expect(can("POST", "/v1/announcements:post")).toBe(false);
    expect(can("POST", "/v1/announcements:giveKudos")).toBe(true);
  });
});
