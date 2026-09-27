// Roles, access rules and the policy manifest, as one block: the seeded authority a fresh database starts
// with. All of it is the seed data in bootstrap/authz/ (roles.ts, grants.ts, policy.ts), rendered by the same
// renderer the local demo seed uses. Fixed ids, no Ctx needed.
import { renderAuthzSeed } from "../authz/accessRules";
import { DEFAULT_POLICY } from "../authz/policy";
import { T0, q } from "../lib";

export function authz(): string {
  return [
    renderAuthzSeed(),
    `INSERT INTO policy (key,value_json,updated_at) VALUES\n ('manifest',${q(JSON.stringify(DEFAULT_POLICY))},${T0});`,
  ].join("\n");
}
