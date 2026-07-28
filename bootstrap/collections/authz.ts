// Roles, access rules and policy manifest - reused from the same generators the runtime/tests use, never
// forked. Plus an own-only in-app notifications ACL for `everyone` (the sensible day-one default an admin
// would otherwise set in Access Management). Fixed ids, no Ctx needed.
import { renderAccessRulesSeed } from "../../scripts/genAccessRulesSeed";
import { DEFAULT_POLICY } from "../../src/domain/manifests";
import { T0, q } from "../lib";

export function authz(): string {
  return [
    `INSERT INTO roles (name,label,protected,created_at,updated_at) VALUES
 ('everyone','Everyone',1,${T0},${T0}),
 ('employee','Employee',1,${T0},${T0}),
 ('manager','Manager',1,${T0},${T0}),
 ('hr_admin','HR Admin',1,${T0},${T0}),
 ('payroll_admin','Payroll Admin',1,${T0},${T0}),
 ('super_admin','Super Admin',1,${T0},${T0});`,
    renderAccessRulesSeed(),
    `INSERT INTO access_rules (uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at) VALUES
 ('nsntf0001','everyone','role','notifications','notifications','all','',NULL,'read','allow',${T0},${T0}),
 ('nsntf0002','everyone','role','notifications','notifications.me.**','self','',NULL,'read','allow',${T0},${T0}),
 ('nsntf0003','everyone','role','notifications','notifications.me.**','self','',NULL,'write','allow',${T0},${T0}),
 ('nsntf0004','everyone','role','notifications','notifications.markAllRead','exact','markAllRead','markAllRead',NULL,'allow',${T0},${T0});`,
    `INSERT INTO policy (key,value_json,updated_at) VALUES\n ('manifest',${q(JSON.stringify(DEFAULT_POLICY))},${T0});`,
  ].join("\n");
}
