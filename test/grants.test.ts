import { describe, it, expect } from "vitest";
import { GRANTS, grantFor } from "../src/domain/grants";
import { ACCESS_VERBS } from "../src/http/accessHint";
import { ROLES } from "../src/db/schema";
import { resolveRequest, decide, capabilitiesOf } from "../src/domain/permissions";
import type { Role } from "../src/env";

// Representative behaviour checks per role (the exhaustive route×role parity is step 1.5).
const SELF = { employeeCode: "04-1c-0a9" }; // dept 04-1c
const ok = (role: Role, m: string, p: string, force = false) => decide(grantFor(role), resolveRequest(m, p, force), SELF).allow;

describe("GRANTS - policy integrity", () => {
  it("covers exactly the ROLES list (no missing or extra role)", () => {
    expect(Object.keys(GRANTS).sort()).toEqual([...ROLES].sort());
  });

  it("PII sub-resources are super-only by default; everyone keeps OWN PII; base record still readable", () => {
    const OTHER = "07-2a-0b1"; // not under SELF's dept (04-1c)
    const SELFCODE = "04-1c-0a9";
    for (const sub of ["bank-account", "identity", "personal-info"]) {
      // Others' PII: denied to employee/manager/hr/payroll; only super reaches it (via ** in config).
      for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
        expect(ok(role, "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(false);
      }
      expect(ok("super_admin", "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(true);
      // Own PII: every role keeps self-service (write implies read).
      for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
        expect(ok(role, "PATCH", `/v1/employees/${SELFCODE}/${sub}`)).toBe(true);
      }
    }
    // The base record is still readable by the broad readers (PII exclusion did not remove base access).
    expect(ok("hr_admin", "GET", `/v1/employees/${OTHER}`)).toBe(true);
    expect(ok("payroll_admin", "GET", `/v1/employees/${OTHER}`)).toBe(true);
    // Manager reads a dept member's base record but NOT their PII (checked above).
    expect(ok("manager", "GET", "/v1/employees/04-1c-0b2")).toBe(true); // dept member base
  });

  it("protected fields are gated by the resource-write grant (field-level body AC)", () => {
    // employee cannot set role/department/comp on their own record (mass-assignment / self-escalation)
    expect(ok("employee", "PATCH", "/v1/employees/04-1c-0a9/department")).toBe(false);
    expect(ok("employee", "PATCH", "/v1/users/04-1c-0a9/role")).toBe(false);
    expect(ok("employee", "PATCH", "/v1/compensation/04-1c-0a9/base_pay")).toBe(false);
    // HR sets employee fields; only super sets a user's role; payroll sets pay amounts
    expect(ok("hr_admin", "PATCH", "/v1/employees/0a/department")).toBe(true);
    expect(ok("hr_admin", "PATCH", "/v1/users/0a/role")).toBe(false);
    expect(ok("super_admin", "PATCH", "/v1/users/0a/role")).toBe(true);
    expect(ok("payroll_admin", "PATCH", "/v1/compensation/0a/base_pay")).toBe(true);
  });
});

describe("GRANTS - employee (self-service only)", () => {
  it("reads open collections + own data; cannot touch others or admin surfaces", () => {
    expect(ok("employee", "GET", "/v1/holidays")).toBe(true);
    // operations are employee-owned: may list (rows scoped in the route) + read own, never another's
    expect(ok("employee", "GET", "/v1/operations")).toBe(true); // may LIST
    expect(ok("employee", "GET", "/v1/operations/04-1c-0a9-0")).toBe(true); // own (under self code)
    expect(ok("employee", "GET", "/v1/operations/07-2a-0b1-0")).toBe(false); // another's -> denied (BOLA)
    expect(ok("employee", "GET", "/v1/settings/holidays")).toBe(true);
    expect(ok("employee", "GET", "/v1/preferences")).toBe(true);
    expect(ok("employee", "POST", "/v1/preferences")).toBe(true);
    expect(ok("employee", "POST", "/v1/leave-requests")).toBe(true);
    expect(ok("employee", "GET", "/v1/payslips/04-1c-0a9-0")).toBe(true); // own
    expect(ok("employee", "GET", "/v1/employees")).toBe(true); // may LIST the directory (rows scoped in service)
    expect(ok("employee", "GET", "/v1/employees/07-2a-0b1")).toBe(false); // but cannot GET another's record
    expect(ok("employee", "PATCH", "/v1/employees/04-1c-0a9/bank-account")).toBe(true); // own
    expect(ok("employee", "PATCH", "/v1/employees/07-2a-0b1")).toBe(false); // someone else's record
    expect(ok("employee", "POST", "/v1/holidays")).toBe(false); // config.write
    expect(ok("employee", "GET", "/v1/users")).toBe(false); // admin only
    expect(ok("employee", "POST", "/v1/payroll-runs")).toBe(false); // payroll only
  });
});

describe("GRANTS - manager", () => {
  it("approves leave and reads own dept subtree", () => {
    expect(ok("manager", "POST", "/v1/leave-requests/04-1c-0b2-0:approve")).toBe(true);
    expect(ok("manager", "POST", "/v1/holidays")).toBe(false); // still not config.write
  });
});

describe("GRANTS - hr_admin", () => {
  it("writes employees/config but cannot force-purge or list users", () => {
    expect(ok("hr_admin", "POST", "/v1/employees")).toBe(true);
    expect(ok("hr_admin", "PATCH", "/v1/employees/07-2a-0b1")).toBe(true);
    expect(ok("hr_admin", "DELETE", "/v1/employees/07-2a-0b1")).toBe(true); // soft delete = write
    expect(ok("hr_admin", "DELETE", "/v1/employees/07-2a-0b1", true)).toBe(false); // force purge = admin (super only)
    expect(ok("hr_admin", "POST", "/v1/holidays")).toBe(true);
    expect(ok("hr_admin", "GET", "/v1/users")).toBe(false); // admin only
    expect(ok("hr_admin", "POST", "/v1/payroll-runs")).toBe(false);
  });
});

describe("GRANTS - payroll_admin", () => {
  it("runs payroll and reads employees, but cannot approve runs or write employee records", () => {
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs/0a:submit")).toBe(true); // can submit/lock/publish
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs/0a:approve")).toBe(false); // approve is super-only (deny)
    expect(ok("payroll_admin", "GET", "/v1/employees/07-2a-0b1")).toBe(true); // employee.read.all
    expect(ok("payroll_admin", "POST", "/v1/employees")).toBe(false); // not employee.write
    expect(ok("payroll_admin", "POST", "/v1/holidays")).toBe(false);
  });
});

describe("GRANTS - super_admin", () => {
  it("can do everything including force-purge and user admin", () => {
    expect(ok("super_admin", "DELETE", "/v1/employees/07-2a-0b1", true)).toBe(true);
    expect(ok("super_admin", "GET", "/v1/users")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/payroll-runs/0a:publish")).toBe(true);
  });
});

describe("GRANTS - the goal-setting handshake (owner proposes, dept manager agrees)", () => {
  // A LEVEL grant carries no custom methods (decide() consults `allow` patterns only for a verb key), so
  // `goals.me.**: write` and `goals.my-dept.**: write` say nothing about propose/approve/requestChanges.
  // All three shipped ungranted: the verbs, their notifications, events and audit actions existed and only
  // super_admin's `**` could reach them, so the drawer hid every button and the handshake was dead. These
  // assertions are what stops the next stage verb arriving the same way.
  const OWN = "/v1/goals/04-1c-0a9-0"; // a goal under SELF's own employee code
  const REPORT = "/v1/goals/04-1c-0b2-0"; // a goal owned by someone in SELF's dept subtree
  const OTHER = "/v1/goals/07-2a-0b1-0"; // another department's

  it("lets the owner submit their own draft, and nobody submit somebody else's", () => {
    for (const role of ["employee", "manager", "super_admin"] as const) {
      expect(ok(role, "POST", `${OWN}:propose`)).toBe(true);
    }
    expect(ok("employee", "POST", `${OTHER}:propose`)).toBe(false);
    expect(ok("manager", "POST", `${OTHER}:propose`)).toBe(false);
  });

  it("lets a manager agree or send back a report's goal, scoped to their own dept", () => {
    for (const verb of [":approve", ":requestChanges"]) {
      expect(ok("manager", "POST", `${REPORT}${verb}`)).toBe(true);
      expect(ok("super_admin", "POST", `${REPORT}${verb}`)).toBe(true);
      // `my-dept`, not `*`: agreeing another department's goals is somebody else's call.
      expect(ok("manager", "POST", `${OTHER}${verb}`)).toBe(false);
      // The owner does not agree their own goal - that is the whole point of the handshake.
      expect(ok("employee", "POST", `${OWN}${verb}`)).toBe(false);
      // HR administers cycles; agreeing a goal is the manager's, and HR holds `goals.**` at READ.
      expect(ok("hr_admin", "POST", `${REPORT}${verb}`)).toBe(false);
    }
  });
});

describe("GRANTS - personal-documents:generateLetter (HR + super only)", () => {
  // The letter-generation custom method resolves to the verb key personal-documents.generateLetter; only
  // hr_admin (broad personal-documents.** allow) and super_admin (**) may invoke it.
  it("allows hr_admin and super_admin, denies employee/manager/payroll", () => {
    for (const p of ["/v1/personal-documents:generateLetter", "/v1/personal-documents:previewLetter"]) {
      expect(ok("hr_admin", "POST", p)).toBe(true);
      expect(ok("super_admin", "POST", p)).toBe(true);
      for (const role of ["employee", "manager", "payroll_admin"] as const) {
        expect(ok(role, "POST", p)).toBe(false);
      }
    }
  });
});

describe("GRANTS - positions (role history): HR writes, super reads/writes; others have no access", () => {
  it("records of designation/department changes are HR + super only", () => {
    expect(ok("hr_admin", "POST", "/v1/positions")).toBe(true);
    expect(ok("hr_admin", "GET", "/v1/positions")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/positions")).toBe(true);
    for (const role of ["employee", "manager", "payroll_admin"] as const) {
      expect(ok(role, "GET", "/v1/positions")).toBe(false);
      expect(ok(role, "POST", "/v1/positions")).toBe(false);
    }
  });
});

describe("GRANTS - bonuses (awards): HR writes, payroll reads (they pay out through the run), others have no access", () => {
  it("one-off awards are HR + super; payroll sees but cannot award", () => {
    expect(ok("hr_admin", "POST", "/v1/bonuses")).toBe(true);
    expect(ok("super_admin", "GET", "/v1/bonuses")).toBe(true);
    expect(ok("payroll_admin", "GET", "/v1/bonuses")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/bonuses")).toBe(false);
    for (const role of ["employee", "manager"] as const) {
      expect(ok(role, "GET", "/v1/bonuses")).toBe(false);
      expect(ok(role, "POST", "/v1/bonuses")).toBe(false);
    }
  });
});

describe("GRANTS - settlements (FnF): HR writes, super reads/writes; others have no access", () => {
  it("full-and-final settlements are HR + super only", () => {
    expect(ok("hr_admin", "POST", "/v1/settlements")).toBe(true);
    expect(ok("super_admin", "GET", "/v1/settlements")).toBe(true);
    for (const role of ["employee", "manager", "payroll_admin"] as const) {
      expect(ok(role, "GET", "/v1/settlements")).toBe(false);
      expect(ok(role, "POST", "/v1/settlements")).toBe(false);
    }
  });
});

describe("GRANTS - leave-encashments (cashout): HR records + decides, payroll/employee read own-scoped", () => {
  it("HR + super create and decide; payroll sees payout rows; employees list (own rows via scope); managers denied", () => {
    expect(ok("super_admin", "POST", "/v1/leave-encashments")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/leave-encashments")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(true);
    expect(ok("payroll_admin", "GET", "/v1/leave-encashments")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/leave-encashments")).toBe(false);
    expect(ok("payroll_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(false);
    // Employees (and managers, who inherit) may call the list endpoint (rows scoped to own by applyScope)
    // but cannot create or decide.
    for (const role of ["employee", "manager"] as const) {
      expect(ok(role, "GET", "/v1/leave-encashments")).toBe(true);
      expect(ok(role, "POST", "/v1/leave-encashments")).toBe(false);
      expect(ok(role, "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(false);
    }
  });
});

describe("capabilitiesOf (scope-stripped tier-1 set)", () => {
  it("expands the ladder and strips scope", () => {
    const caps = capabilitiesOf(GRANTS.employee);
    expect(caps).toContain("holidays.read");
    expect(caps).toContain("leave-requests.read"); // from leave-requests write (ladder)
    expect(caps).toContain("leave-requests.write");
    expect(caps).toContain("leave-requests.cancel"); // allow verb
    expect(caps).toContain("employees.read"); // can list the directory
    expect(caps).toContain("employees.bank-account.write"); // own sub-resource (structural token kept)
    expect(caps).not.toContain("employees.write"); // must NOT imply directory write (would show wrong buttons)
    expect(caps).not.toContain("payroll-runs.write"); // employee has no payroll
  });
  it("manager gains approve; hr gains employee write", () => {
    expect(capabilitiesOf(GRANTS.manager)).toContain("leave-requests.approve");
    expect(capabilitiesOf(GRANTS.hr_admin)).toContain("employees.write");
    expect(capabilitiesOf(GRANTS.payroll_admin)).toContain("payroll-runs.write");
  });
  it("super_admin is the ** wildcard", () => {
    const caps = capabilitiesOf(GRANTS.super_admin);
    expect(caps).toContain("**.admin");
    expect(caps).toContain("**.**");
  });
});


// Every verb the UI can offer is reachable by somebody - or is on the list of ones deliberately withheld.
//
// A level grant carries NO custom methods, so a verb has to be named in `allow` even for a caller who already
// writes the row. That is easy to forget, and forgetting it is silent in both directions: the server answers
// 403, and the UI's `<AccessAction>` hides the affordance, so the feature is simply not there. Five verbs had
// shipped that way - `goals` watch/unwatch/setContributors and `reviews` suggestFeedback/assignReviewer:
// built, wired, documented DONE, and reachable by nobody but super_admin.
//
// This is an EXACT match against the withheld list rather than "nothing is unreachable", so it fails both
// ways: a new verb that nobody was granted fails, and a verb that gains a grant without leaving the list
// fails too (the list stops describing the policy). Two reasons a verb belongs on it:
//   - ACL-ONLY collections, which seed nothing for any role by design (see [[no-access-control-via-code]]):
//     access arrives as per-object rules the user writes in the ACL UI, where a `<col>.**` rule is a wildcard
//     verb allow and therefore already covers verbs added later.
//   - SUPER-ONLY verbs, withheld on purpose and documented where they are withheld - the bank file and the
//     statutory report expose the employer debit account and every account number, and payroll approval is
//     deliberately not the payroll operator's own.
describe("ACCESS_VERBS - every offered verb is reachable, or is withheld on purpose", () => {
  const WITHHELD = [
    // ACL-only collections: kanban, the ops console, keys, and the access system itself.
    "access-rules:approve", "access-rules:clone", "access-rules:preview", "access-rules:reject",
    "access-rules:requestAccess", "api-keys:revoke",
    "boards:configure", "boards:metrics",
    "cards:addTodos", "cards:assign", "cards:block", "cards:comment", "cards:move", "cards:prioritize",
    "cards:promoteTodo", "cards:removeTodo", "cards:toggleTodo", "cards:unblock", "cards:unwatch",
    "cards:watch",
    "cron-runs:run", "operations:run", "sprints:activate", "sprints:complete",
    "letterheads:deleteImage", "letterheads:duplicate", "letterheads:image", "letterheads:preview",
    "letterheads:uploadImage",
    "referrals:award", "suggestions:downvote", "suggestions:merge", "suggestions:upvote",
    // Company/department-wide group award (one bonus row per in-scope employee). HR's `bonuses.**` LEVEL
    // covers recording a single award; this collection-level verb is left to the ACL for now, deliberately,
    // because it writes money for a whole population at once.
    "bonuses:award",
    // Super-only on purpose, each documented at the point it is withheld (src/domain/grants.ts): the bank
    // file and the statutory report expose the employer debit account and every account number, payroll
    // approval is deliberately not the run operator's own act, and previewPayslip renders another employee's
    // full pay breakdown before the run is published.
    "payroll-runs:approve", "payroll-runs:bankFile", "payroll-runs:previewPayslip",
    "payroll-runs:statutoryReport",
  ];
  const NON_SUPER = ["employee", "manager", "hr_admin", "payroll_admin"] as const;
  // Three object codes: own, a dept member's, and a flat-coded row - so a `me` / `my-dept` / `*` rule all get
  // a chance to match. A verb reachable under any of them is reachable.
  const CODES = ["04-1c-0a9", "04-1c-0b2", "0a"];

  it("matches the withheld list exactly", () => {
    const unreachable: string[] = [];
    for (const [collection, verbs] of Object.entries(ACCESS_VERBS)) {
      for (const verb of verbs) {
        // Standard levels ride the level ladder, not `allow`; only custom methods need naming.
        if (["update", "delete", "upload", "download"].includes(verb)) continue;
        const reachable = NON_SUPER.some((role) => CODES.some((code) => ok(role, "POST", `/v1/${collection}/${code}:${verb}`)));
        if (!reachable) unreachable.push(`${collection}:${verb}`);
      }
    }
    expect(unreachable.sort()).toEqual([...WITHHELD].sort());
  });

  it("reaches the goal and review verbs that had been granted to nobody", () => {
    expect(ok("employee", "POST", "/v1/goals/04-1c-0a9-0:watch")).toBe(true);
    expect(ok("employee", "POST", "/v1/goals/04-1c-0a9-0:unwatch")).toBe(true);
    expect(ok("employee", "POST", "/v1/reviews/04-1c-0a9-0:suggestFeedback")).toBe(true);
    expect(ok("manager", "POST", "/v1/goals/04-1c-0b2-0:setContributors")).toBe(true);
    expect(ok("manager", "POST", "/v1/goals/04-1c-0b2-0:watch")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/reviews/07-2a-0b1-0:assignReviewer")).toBe(true);
    // Crediting a share of a goal scores in the CONTRIBUTOR's review, so it stays a manager's act: the
    // owner cannot hand out credit on their own goal, and HR reads goals rather than re-crediting them.
    expect(ok("employee", "POST", "/v1/goals/04-1c-0a9-0:setContributors")).toBe(false);
    expect(ok("employee", "POST", "/v1/reviews/04-1c-0a9-0:assignReviewer")).toBe(false);
    // Following somebody else's goal is a per-object ACL grant, not a role baseline: the notifications carry
    // that goal's title to whoever follows it.
    expect(ok("employee", "POST", "/v1/goals/07-2a-0b1-0:watch")).toBe(false);
  });

  it("lets a payslip be VIEWED by whoever may already download it", () => {
    // The weaker act must not be the denied one. Both halves, for the employee on their own slip and for the
    // run operator on the slips the run produced.
    for (const verb of ["preview", "download"]) {
      expect(ok("employee", "POST", `/v1/payslips/04-1c-0a9-0:${verb}`)).toBe(true);
      expect(ok("payroll_admin", "POST", `/v1/payslips/07-2a-0b1-0:${verb}`)).toBe(true);
      // Still nobody else's, for an employee.
      expect(ok("employee", "POST", `/v1/payslips/07-2a-0b1-0:${verb}`)).toBe(false);
    }
  });

  it("gives the asset administrator the stocktakes that walk their own register", () => {
    // The collection was seeded at no level at all, so this is the page being reachable, not just its verbs.
    expect(ok("hr_admin", "GET", "/v1/stocktakes")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/stocktakes")).toBe(true);
    for (const verb of ["recordFound", "close", "restore"]) {
      expect(ok("hr_admin", "POST", `/v1/stocktakes/0a:${verb}`)).toBe(true);
    }
    // Counting the inventory is not self-service.
    expect(ok("employee", "GET", "/v1/stocktakes")).toBe(false);
    expect(ok("employee", "POST", "/v1/stocktakes/0a:recordFound")).toBe(false);
  });
});
