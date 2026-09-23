// Roles, access rules and policy manifest - reused from the same generators the runtime/tests use, never
// forked. Plus two own-only ACLs for `everyone` (the sensible day-one defaults an admin would otherwise set
// in Access Management): in-app notifications, and the assets a person is holding. Fixed ids, no Ctx needed.
//
// The `markAllRead` rule is a COLLECTION-level custom method, so it is encoded broad (scope all, match_code
// NULL) exactly as compileGrant encodes a 2-token verb pattern: a match_code would file it in the per-object
// lane, which a verb carrying no object id never reaches, leaving the capability unreachable.
//
// Both blocks follow the same privacy-correct shape: the 1-token `<collection>` rule is the LIST capability
// only (it matches the bare collection, never an object), so the breadth of what the list returns is decided
// by the object rule beside it - here `self`, i.e. your own rows and nobody else's.
import { renderAccessRulesSeed, seedRuleId } from "../../scripts/genAccessRulesSeed";
import { DEFAULT_POLICY } from "../../src/domain/manifests";
import { T0, q } from "../lib";

// These four ids are minted by the same helper the compiled block uses, from a range far past it: a rule id
// must be a real 13-char base32 internal id or the wire codec cannot tokenize it (a paged list cursor does),
// which is what a hand-written short id did to GET /v1/access-rules.
const nid = (n: number) => seedRuleId(900_000 + n);

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
 (${q(nid(1))},'everyone','role','notifications','notifications','all','',NULL,'read','allow',${T0},${T0}),
 (${q(nid(2))},'everyone','role','notifications','notifications.me.**','self','',NULL,'read','allow',${T0},${T0}),
 (${q(nid(3))},'everyone','role','notifications','notifications.me.**','self','',NULL,'write','allow',${T0},${T0}),
 (${q(nid(4))},'everyone','role','notifications','notifications.markAllRead','all','',NULL,NULL,'allow',${T0},${T0});`,
    // The assets you are HOLDING: the list call, and the one verb only the holder can perform - scanning the
    // tag on something handed to you. Without these the custody loop has no employee side at all.
    //
    // Neither rule is a licence to read the inventory. `assets` is a 1-token pattern: it matches the bare
    // collection key (the LIST call) and never the 2-token item key, so it says nothing about which rows come
    // back - actorScope probes an ITEM read to settle that, finds nothing broad, and resolves the breadth to
    // `own`, which the list binds as `assigned_to = me`.
    //
    // The verb is scoped `**` rather than `me` because an asset's code is FLAT (allocFlatCode) - it is not
    // minted under its holder's employee code, and ownership moves between people anyway, so a `me` pattern
    // could never match an asset and the rule would be silently inert. Holder-only is therefore enforced where
    // the ownership actually lives: acknowledgeAsset refuses anyone but `assigned_to` (403), the same way own-
    // signature reads are enforced.
    `INSERT INTO access_rules (uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at) VALUES
 (${q(nid(5))},'everyone','role','assets','assets','all','',NULL,'read','allow',${T0},${T0}),
 (${q(nid(6))},'everyone','role','assets','assets.**.acknowledge','all','',NULL,NULL,'allow',${T0},${T0});`,
    `INSERT INTO policy (key,value_json,updated_at) VALUES\n ('manifest',${q(JSON.stringify(DEFAULT_POLICY))},${T0});`,
  ].join("\n");
}
