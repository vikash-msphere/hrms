// Starter packs for a new role.
//
// `createRole` writes NO access rules - a fresh role is deny-all (`services/roles.ts`), which is the right
// default and a miserable starting point: building a "Recruiter" meant authoring rules across six ATS
// collections one at a time, or cloning `hr_admin` and subtracting, which is the wrong direction for least
// privilege. Copying an existing role (`:clone`) only helps when a role close enough to the target already
// exists.
//
// A template is just a NAMED BUNDLE OF RULE BODIES, replayed through the ordinary `POST /v1/access-rules`
// create path exactly as the JSON import does - so every rule goes through the same validation, the same
// four-eyes queue and the same audit trail, and a template can never write something an admin could not have
// authored by hand. There is deliberately no server-side template resource: it would be a second way to
// author authority, and the value here is the curation, not the mechanism.
//
// A template applies to a PERSON as readily as to a role, and that is also this app's answer to "one person,
// two jobs". A user holds exactly one role (`users.role`), but the engine already unions role rules,
// `everyone` rules and the user's OWN rules into one grant (`loadUserGrant` -> `mergeGrants`), so a team lead
// who also runs the asset register is a `team_lead` role plus the IT template applied to them directly. The
// trade against a real second role is that their copy does not follow the template if the template changes -
// worth knowing, and the reason `roleTemplates` is not a substitute for a `user_roles` table at scale.
//
// Each bundle is written as least-privilege as the app allows: read where read is enough, the row-scoped
// tiers where the work is about your own or your team's records, and the collection gate (`scope: "create"`
// at `read`, which is what lets a list be OPENED - see ensureListGate in AclModal) paired with every scoped
// rule, because a scoped rule alone cannot open the page it scopes.

export type TemplateRule = {
  collection: string;
  // The subject-relative tiers the engine honours, plus `create` (the bare collection gate). `reports`/`org`
  // are the manager chain: no bundled template asks for them today - the seeded `manager` role is written
  // against the department, and these templates mirror the seeded roles - but they are as authorable here as
  // in the modal, and leaving them out of the type made them unsayable rather than undecided.
  scope: "all" | "self" | "dept" | "reports" | "org" | "create";
  level?: "read" | "write" | "admin";
  verb?: string;
  /** A read-gated base field (`policy.redacted_fields`) or a PII sub-resource, for a field-level rule. */
  field?: string;
  /** Denies are how a template subtracts - a field a role must not see, an action it must not take. */
  effect?: "deny";
};

export type RoleTemplate = {
  key: string;
  label: string;
  /** One line on what this person does - shown in the picker, so the choice is made on the job, not the rules. */
  summary: string;
  rules: TemplateRule[];
};

// `read` on the bare collection = may open the list. `write` on it = may also create. Both are the 1-token
// pattern, which is why they share the `create` scope here (services/accessRules.ts buildPattern).
const list = (collection: string): TemplateRule => ({ collection, scope: "create", level: "read" });
const create = (collection: string): TemplateRule => ({ collection, scope: "create", level: "write" });
const all = (collection: string, level: "read" | "write" | "admin" = "read"): TemplateRule => ({ collection, scope: "all", level });
const verb = (collection: string, v: string): TemplateRule => ({ collection, scope: "all", verb: v });

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: "recruiter",
    label: "Recruiter",
    summary: "Runs the hiring pipeline: requisitions, candidates, interviews and offers - without seeing offer money.",
    rules: [
      create("job-requisitions"), all("job-requisitions", "write"),
      create("candidates"), all("candidates", "write"),
      create("applications"), all("applications", "write"),
      verb("applications", "advance"),
      create("interviews"), all("interviews", "write"),
      verb("interviews", "invite"),
      list("interview-feedback"), all("interview-feedback"),
      // Offers are READ only, and the money is denied outright: a recruiter schedules and advances, but
      // extending an offer and setting its number is the hiring manager's and HR's call. The field deny is
      // what makes "read the offer, not the salary" expressible at all (policy.redacted_fields).
      list("offers"), all("offers"),
      { collection: "offers", scope: "all", field: "base_comp", effect: "deny" },
      list("departments"), all("departments"),
      list("employees"), all("employees"),
    ],
  },
  {
    key: "auditor",
    label: "Auditor (read-only)",
    summary: "Reads everything across the org and changes nothing. No export, no unmasking.",
    rules: [
      // Deliberately enumerated rather than `**`: the super wildcard is not authorable through the ACL, and
      // an auditor who can read every collection should still not be able to grant themselves anything.
      ...["employees", "departments", "compensation", "positions", "payroll-runs", "payslips", "bonuses",
        "settlements", "loans", "tax-declarations", "expenses", "reimbursements", "expense-budgets",
        "leave-requests", "leave-balances", "attendance", "time-entries", "assets", "stocktakes",
        "compliance-events", "background-checks", "transitions", "org-documents", "audit"]
        .flatMap((c) => [list(c), all(c, "read")]),
    ],
  },
  {
    key: "team_lead",
    label: "Team lead",
    summary: "Sees and approves their own department's leave, timesheets and expenses. No PII, no pay.",
    rules: [
      list("employees"), { collection: "employees", scope: "dept", level: "read" },
      list("leave-requests"), { collection: "leave-requests", scope: "dept", level: "read" },
      { collection: "leave-requests", scope: "dept", verb: "approve" },
      { collection: "leave-requests", scope: "dept", verb: "reject" },
      list("leave-balances"), { collection: "leave-balances", scope: "dept", level: "read" },
      list("attendance"), { collection: "attendance", scope: "dept", level: "read" },
      // The marks that decide what a short day COUNTED as, read-only - the seeded `manager` role holds exactly
      // this (grants.ts `attendance-day-marks.my-dept.**`: read). Without it the attendance a team lead does
      // hold shows counts with no explanation of why HR scored a day the way they did, and re-valuing a day
      // stays a pay decision, which is not this bundle's.
      list("attendance-day-marks"), { collection: "attendance-day-marks", scope: "dept", level: "read" },
      list("time-entries"), { collection: "time-entries", scope: "dept", level: "read" },
      { collection: "time-entries", scope: "dept", verb: "approve" },
      { collection: "time-entries", scope: "dept", verb: "reject" },
      list("expenses"), { collection: "expenses", scope: "dept", level: "read" },
      { collection: "expenses", scope: "dept", verb: "approve" },
      { collection: "expenses", scope: "dept", verb: "reject" },
      list("goals"), { collection: "goals", scope: "dept", level: "write" },
      list("check-ins"), { collection: "check-ins", scope: "dept", level: "write" },
      // The review half of the same job, which this bundle simply did not carry: goals and 1:1s were here and
      // the cycle they feed was not, so a team lead built from this template could open a report's Performance
      // tab and see no reviews - and could not write the manager assessment the cycle waits on them for. READ
      // plus the manager's own stage verbs, exactly the seeded `manager` role's shape (grants.ts): the verdict
      // is written through the stage verbs, never by editing the review row.
      list("reviews"), { collection: "reviews", scope: "dept", level: "read" },
      { collection: "reviews", scope: "dept", verb: "submitManager" },
      { collection: "reviews", scope: "dept", verb: "nominate" },
      { collection: "reviews", scope: "dept", verb: "nudge" },
      { collection: "reviews", scope: "dept", verb: "pdf" },
    ],
  },
  {
    key: "it_asset_manager",
    label: "IT / asset manager",
    summary: "Owns the asset register, the tags and the stocktakes, and issues what people ask for.",
    rules: [
      create("assets"), all("assets", "write"),
      verb("assets", "printTag"), verb("assets", "reissueTag"), verb("assets", "batchCreate"),
      create("asset-categories"), all("asset-categories", "write"),
      create("stocktakes"), all("stocktakes", "write"),
      verb("stocktakes", "recordFound"), verb("stocktakes", "close"),
      list("asset-requests"), all("asset-requests", "write"),
      verb("asset-requests", "approve"), verb("asset-requests", "reject"), verb("asset-requests", "issue"),
      list("employees"), all("employees"),
    ],
  },
  {
    key: "benefits_admin",
    label: "Benefits administrator",
    summary: "Maintains the plan catalogue and enrols people; sees dependants, not pay.",
    rules: [
      create("benefit-plans"), all("benefit-plans", "write"),
      list("benefit-enrollments"), all("benefit-enrollments", "write"),
      list("dependents"), all("dependents", "read"),
      list("employees"), all("employees"),
    ],
  },
  {
    key: "front_desk",
    label: "Front desk / attendance",
    summary: "Watches attendance and fixes punches. No leave decisions, no pay, no PII.",
    rules: [
      list("attendance"), all("attendance", "read"),
      // Read of the day marks for the same reason the team lead gets them, and read only for the reason this
      // bundle's own summary gives: a mark is what a day is PAID as, and that decision stays HR's.
      list("attendance-day-marks"), all("attendance-day-marks", "read"),
      list("attendance-regularizations"), all("attendance-regularizations", "write"),
      verb("attendance-regularizations", "approve"), verb("attendance-regularizations", "reject"),
      list("shifts"), all("shifts"),
      list("shift-assignments"), all("shift-assignments", "write"),
      list("holidays"), all("holidays"),
      list("employees"), all("employees"),
    ],
  },
];

/**
 * The create-body for one template rule, in the exact shape `POST /v1/access-rules` validates.
 *
 * A deny carries no level - the validator rejects `effect: deny` with one, because a deny blocks the target
 * rather than granting a tier of it - so the level is omitted there and a field/verb names what is blocked.
 */
export function templateRuleBody(subjectKind: "role" | "user", subject: string, r: TemplateRule): Record<string, unknown> {
  const deny = r.effect === "deny";
  return {
    subject_kind: subjectKind,
    subject,
    collection: r.collection,
    scope: r.scope,
    ...(r.field ? { field: r.field } : {}),
    ...(deny ? { effect: "deny" } : {}),
    ...(r.verb ? { verb: r.verb } : deny ? {} : { level: r.level ?? "read" }),
  };
}

/** How many rules a template will try to author - shown before it is applied. */
export const templateSize = (t: RoleTemplate): number => t.rules.length;
