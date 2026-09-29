// Loads the day-one role files (bootstrap/authz/roles/*.json) into the Grant shape the rule compiler takes.
// SEED DATA ONLY: bootstrap/authz/accessRules.ts compiles these into `access_rules` rows once, and from then on
// the rows are the policy, edited in Access Management. The running app never imports this file
// (test/bootstrapBoundary.test.ts).
//
// One file per role, each rule carrying the reason it exists (roles/README.md has the format). A role may
// `extends` another, which unions the parent's rules in first - so a manager's file lists only what a manager
// holds beyond an employee, and an employee rule changed in one place changes for both.
import type { Grant, Level } from "../../src/domain/permissions";
import { EMPTY_GRANT, SUPER_GRANT, isSuperGrant } from "../../src/domain/grants";
import { mergeGrants } from "../../src/domain/compileGrants";
import everyoneFile from "./roles/everyone.json" with { type: "json" };
import employeeFile from "./roles/employee.json" with { type: "json" };
import teamLeadFile from "./roles/team_lead.json" with { type: "json" };
import managerFile from "./roles/manager.json" with { type: "json" };
import hrAdminFile from "./roles/hr_admin.json" with { type: "json" };
import payrollAdminFile from "./roles/payroll_admin.json" with { type: "json" };
import superAdminFile from "./roles/super_admin.json" with { type: "json" };
import itAdminFile from "./roles/it_admin.json" with { type: "json" };
import projectManagerFile from "./roles/project_manager.json" with { type: "json" };

type Rule = { area?: string; pattern: string; why: string };
export type RoleFile = {
  role: string;
  label: string;
  protected: boolean;
  provisioned: boolean;
  description: string;
  extends?: string;
  relies_on?: string[];
  levels: (Rule & { level: string })[];
  allow: Rule[];
  deny: Rule[];
  excluded: { pattern: string; lane?: "levels" | "allow"; why: string }[];
};

// Seed order: `everyone` first, then the assignable roles narrowest-first. It is also the order the compiled
// rules are numbered in, so appending a role never renumbers the ones before it - which is why it_admin and
// project_manager, added after the rest, sit after super admin rather than beside the roles they resemble.
export const ROLE_FILES: readonly RoleFile[] = [everyoneFile, employeeFile, teamLeadFile, managerFile, hrAdminFile, payrollAdminFile, superAdminFile, itAdminFile, projectManagerFile] as RoleFile[];

const LEVELS: ReadonlySet<string> = new Set(["read", "write", "admin"]);

// A malformed file fails the seed generator and every test that loads a role, rather than seeding a role that
// silently lacks a rule. Each check is a mistake that would otherwise compile into a working-looking row.
function check(f: RoleFile): void {
  const where = `bootstrap/authz/roles/${f.role}.json`;
  if (!f.role || !f.label) throw new Error(`${where}: role and label are required`);
  for (const [lane, rules] of [["levels", f.levels], ["allow", f.allow], ["deny", f.deny]] as const) {
    const seen = new Set<string>();
    for (const r of rules) {
      if (!r.pattern) throw new Error(`${where}: a ${lane} rule has no pattern`);
      if (!r.why?.trim()) throw new Error(`${where}: ${lane} ${r.pattern} has no "why"`);
      if (seen.has(r.pattern)) throw new Error(`${where}: ${lane} lists ${r.pattern} twice`);
      seen.add(r.pattern);
      if (lane === "levels" && !LEVELS.has((r as { level: string }).level)) throw new Error(`${where}: ${r.pattern} has level "${(r as { level: string }).level}"`);
    }
  }
  if (f.extends && !ROLE_FILES.some((p) => p.role === f.extends)) throw new Error(`${where}: extends unknown role "${f.extends}"`);
}
for (const f of ROLE_FILES) check(f);

// A role's own rules over its parent's. A level the child restates replaces the parent's (a manager's
// `boards.**: write` over an employee's `read`); allow and deny lanes union.
function grantOf(f: RoleFile, depth = 0): Grant {
  if (depth > ROLE_FILES.length) throw new Error(`bootstrap/authz/roles: extends cycle at ${f.role}`);
  const parent = f.extends ? grantOf(ROLE_FILES.find((p) => p.role === f.extends)!, depth + 1) : EMPTY_GRANT;
  const levels: Record<string, Level> = { ...parent.levels };
  for (const r of f.levels) levels[r.pattern] = r.level as Level;
  const allow = [...parent.allow, ...f.allow.map((r) => r.pattern).filter((p) => !parent.allow.includes(p))];
  const deny = [...(parent.deny ?? []), ...f.deny.map((r) => r.pattern)];
  const grant: Grant = { levels, allow };
  if (deny.length) grant.deny = deny;
  return grant;
}

const fileOf = (role: string) => ROLE_FILES.find((f) => f.role === role)!;

// The seed grant set, one entry per assignable seeded role. `satisfies` keeps the precise literal keys (so
// `GRANTS.employee` stays a `Grant`); dynamic lookups go through `grantFor`.
export const GRANTS = {
  employee: grantOf(fileOf("employee")),
  team_lead: grantOf(fileOf("team_lead")),
  manager: grantOf(fileOf("manager")),
  hr_admin: grantOf(fileOf("hr_admin")),
  payroll_admin: grantOf(fileOf("payroll_admin")),
  super_admin: grantOf(fileOf("super_admin")),
  it_admin: grantOf(fileOf("it_admin")),
  project_manager: grantOf(fileOf("project_manager")),
} satisfies Record<string, Grant>;

// `everyone` is a rule subject, never a role a user holds, so it stays out of GRANTS and nothing that walks the
// assignable roles sees it.
export const EVERYONE_GRANT: Grant = grantOf(fileOf("everyone"));

// The super file must say exactly what the engine's super wildcard is, or the seeded super admin would differ
// from the system actor that carries SUPER_GRANT.
if (!isSuperGrant(GRANTS.super_admin) || JSON.stringify(GRANTS.super_admin) !== JSON.stringify(SUPER_GRANT)) {
  throw new Error("bootstrap/authz/roles/super_admin.json must be exactly levels ** admin + allow **");
}

// What a caller holding a seeded role decides with, for the unit tests that stand one in: the role's rules
// with `everyone` unioned in, as lib/policyLoad.ts builds it from `access_rules` - except super admin, which
// `everyone` never joins. An unknown role yields `everyone` alone, never throws. The running app never calls
// this; the generators read GRANTS and EVERYONE_GRANT, which stay one subject each.
export function grantFor(role: string): Grant {
  const own = (GRANTS as Record<string, Grant>)[role] ?? EMPTY_GRANT;
  return isSuperGrant(own) ? own : mergeGrants(own, EVERYONE_GRANT);
}
