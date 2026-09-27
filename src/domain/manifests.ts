// Body access-control manifests (docs/archive/plan.txt 11C/11R): the SHAPE of the policy manifest and the
// accessors that read one. The manifest itself is data - one `policy` row (key 'manifest'), carried on the auth
// read and edited through the policy API - seeded once from bootstrap/authz/policy.ts. What stays here as code
// is what is coupled to how the app reads its own bodies (SUBRESOURCE_BODY, COLLECTION_FIELD_CAPABILITIES), not
// a choice an org makes.
import type { Level } from "./permissions";
import { COLLECTIONS } from "./collections";

// A non-ownership body reference the middleware validates ("may you reference this target?" = `level` on it).
// Ownership/principal refs (employee, manager, department, owner) are never references: they are path-derived
// or admin-only (re-parent), enforced structurally, so a body value can't smuggle one.
export type RefField = { collection: string; level: Level };

// The base-record fields whose READ is decided per field (`<collection>.<code>.<field>` at `read`), checked as
// the resource is serialized (`http/accessHint.ts` `withAccess`). A 2-token row grant (`employees.*`) has no
// `**` tail and does not reach a listed field.
export function redactedFieldsOf(policy: Policy, collection: string): string[] {
  return policy.redacted_fields?.[collection] ?? [];
}

// Is `field` a valid FIELD-SCOPE access target for `collection` (so a `<col>.*.<field>.**` rule has effect)?
// One of: a protected base field (body-field write-gated, e.g. department); a whole field-bearing sub-resource
// (path-gated, e.g. bank-account); or a single field WITHIN one, written dotted as `<subresource>.<key>`
// (e.g. identity.uan) - read-redacted + write-gated per field. The leaf key is NOT validated: identity keys
// are admin-configurable and bank/personal keys would be a hardcoded list (against the no-hardcoded-policy
// rule); an unknown key is harmlessly inert (never matches a real field path).
// Used by the access-rule validator to reject a field rule on a field that isn't access-controlled (inert).
// The sub-resource set is SUBRESOURCE_BODY (what is actually field-gated), NOT the audit policy - whether a
// read of a sub-resource is worth an audit row is an independent question.
export function isFieldScopeTarget(policy: Policy, collection: string, field: string): boolean {
  // The virtual capabilities whose field slot names a target COLLECTION, not a record field. Checked first
  // because for these the question is "is that a real collection", and none of the record-field tests below
  // can answer it - they all looked for a protected field or a sub-resource of a resource that has neither,
  // so every one of these rules was refused as naming a field that does not exist.
  if (COLLECTION_FIELD_CAPABILITIES.has(collection)) return COLLECTIONS.has(field);
  if ((policy.protected_fields[collection] ?? []).includes(field)) return true;
  if ((policy.redacted_fields?.[collection] ?? []).includes(field)) return true; // read-gated base field

  if (subresourceBodyKey(field) !== null) return true; // whole sub-resource
  const dot = field.indexOf(".");
  if (dot > 0) return field.slice(dot + 1).length > 0 && subresourceBodyKey(field.slice(0, dot)) !== null;
  return false;
}

/**
 * Capabilities whose FIELD slot carries a target COLLECTION instead of a record field, so a rule reads
 * `<capability>.<scope>.<collection>` - "the activity of leave requests", "exporting employees".
 *
 * This is the shape that makes an app-wide capability grantable in pieces without inventing a second scope
 * axis: the id position already says WHOSE records (self / dept / a named department / all), and the field
 * position says WHICH KIND. `activity` was designed this way and documented as such; nothing enforced it, so
 * `isFieldScopeTarget` measured a collection name against the record-field tests, found neither a protected
 * field nor a sub-resource, and refused every rule the per-collection picker in the fine-rules editor could
 * author. The capability was scopeable in the docs and in the client's capability check, and unauthorable in
 * the one place that decides whether a rule may exist.
 *
 * Code-coupled, like SUBRESOURCE_BODY below and for the same reason: which capabilities work this way is a
 * property of how the app reads them, not a policy an org sets.
 */
export const COLLECTION_FIELD_CAPABILITIES: ReadonlySet<string> = new Set([
  "activity", // the per-entity trail, ANDed with reading the record
  "export", // the cross-module CSV/Excel affordance - "may export leave data, not payroll"
]);

// How to find the field map in a sub-resource write body (code-coupled - not org-configurable).
// An empty string means the body IS the field map (flat); otherwise the map lives under that wrapper key.
// Membership also DEFINES which sub-resource paths are per-field write-gated by the authz middleware.
export const SUBRESOURCE_BODY: Record<string, string> = {
  identity: "values",
  "bank-account": "",
  "personal-info": "",
  tax: "values",
};
// The wrapper key for a field-bearing sub-resource's write body, or null if `sub` is not field-gated.
export function subresourceBodyKey(sub: string): string | null {
  return Object.prototype.hasOwnProperty.call(SUBRESOURCE_BODY, sub) ? SUBRESOURCE_BODY[sub]! : null;
}

// Owner refs: body fields that set who a NEW resource is owned by (on create there is no path id, so the
// body owner is an unverified object reference - the BOLA gap). For each, the middleware requires the
// caller may create under that owner: the ref resolves to an employee code and the caller has write on
// `<collection>.<ownerCode>` (own via `me`, or an admin who may write that owner's namespace). `collection`
// is the ref TARGET.
export type OwnerRef = { collection: string };

// Which SUBJECT-RELATIVE scope tiers are meaningful when granting access on a collection, narrowest-first (so
// the ACL UI's default selection is the tightest). These are the tiers an access icon offers IN ADDITION to
// the structural object-anchored ones the UI adds whenever an object is in context: `exact` (this one object)
// and `subtree` (this object + the codes under it - only for container/dept-coded objects, so it's listed
// ONLY for collections whose objects nest). The set is authoritative: the UI reads it (carried on users/me)
// instead of guessing from a parallel hardcoded list, so every access icon offers exactly the relevant
// choices. Over-inclusion is SAFE - a tier the engine can't honor for a collection just yields an inert rule
// (never a security hole). Anything unlisted is "all" only.
// `named-dept` is anchored like `subtree` (it compiles to the same `<code>-*` id token) but it is anchored to
// a department the GRANTOR picks rather than to whatever object the page happens to be showing, and the
// department need not be the subject's own. It is the tier that expresses "HR for the Sales org" - the most
// ordinary shape of delegated HR authority there is, and the one the vocabulary could not say: `dept` is the
// subject's OWN department and nothing else, and `subtree` was only ever offered against the ambient object.
//
// It is DERIVED, never declared (see `supportedScopesOf`): a collection that supports `dept` is
// department-coded by construction, and a collection that is department-coded can be anchored to any
// department. Declaring it per collection would be writing the same fact down twice and letting the copies
// drift.
// `reports` / `org` are the MANAGER CHAIN, which the code hierarchy cannot express (see permissions.ts
// SelfContext). They are offered only where a collection is employee-owned, because that is what makes a
// report's code reach their rows.
export type ScopeTier = "self" | "reports" | "org" | "dept" | "named-dept" | "subtree" | "all";
export function supportedScopesOf(policy: Policy, collection: string): ScopeTier[] {
  return withDerivedTiers(policy.supported_scopes?.[collection] ?? ["all"]);
}

// The one place `named-dept` is added, so the single-collection lookup and the whole-map form that rides
// `users/me` can never disagree about which tiers a collection offers.
function withDerivedTiers(tiers: ScopeTier[]): ScopeTier[] {
  if (!tiers.includes("dept") || tiers.includes("named-dept")) return tiers;
  // Narrowest-first, which is the order the ACL's default selection is taken from: a named department is
  // wider than the subject's own department (it can be any of them) and narrower than org-wide.
  return [...tiers.filter((t) => t !== "all"), "named-dept", ...tiers.filter((t) => t === "all")];
}

// Every collection's grantable tiers, derived - what `GET /v1/users/me` carries as `caller_access.scopes` and
// the ACL's scope chips are built from. The stored manifest is returned tier-for-tier apart from the
// derivation above; nothing here invents a collection the manifest does not list.
export function grantableScopes(policy: Policy): Record<string, ScopeTier[]> {
  const out: Record<string, ScopeTier[]> = {};
  for (const [collection, tiers] of Object.entries(policy.supported_scopes ?? {})) out[collection] = withDerivedTiers(tiers);
  return out;
}

// State-gated visibility: a row that is NOT in its `public_when` state is visible only to callers who hold
// `requires` on the collection (the editors). The middleware decides "may see restricted rows" from the
// grant; a list service binds the column filter (decides nothing); item-GET is gated by the same rule with
// the row state riding the id->code resolve. Pure data - which collections gate, and how, is configurable.
/**
 * A value a `public_when` clause compares against: a boolean flag, one string, or any of several.
 *
 * Booleans were the only shape when this existed for `announcements` (published/disabled). Every other state
 * the app would want to gate is a STRING status - a draft payroll run, a cancelled requisition, an offer in
 * negotiation, a closed ticket, a terminated employee - so a boolean-only rule could not express any of them.
 * The array form is what makes "public while it is extended OR accepted" sayable without two rules.
 */
export type StateValue = boolean | string | string[];
export type StateRule = { requires: Level; public_when: Record<string, StateValue> };

/**
 * Is a row in its collection's PUBLIC state? The one definition, shared by the item gate
 * (domain/access.ts stateReadAllowed) and the list predicate (services/stateFilter.ts), so the lane that
 * decides and the lane that filters can never disagree about what "public" means.
 *
 * A boolean clause coerces (the original semantics, unchanged: a null flag is false). A string clause compares
 * as a string, and a null column never equals one - so an unset status reads as NOT public, which is the
 * fail-closed direction for a gate.
 */
export function isPublicState(state: Record<string, unknown>, rule: StateRule): boolean {
  return Object.entries(rule.public_when).every(([k, want]) => {
    const got = state[k];
    if (typeof want === "boolean") return Boolean(got) === want;
    if (Array.isArray(want)) return got != null && want.includes(String(got));
    return got != null && String(got) === want;
  });
}

// Audit policy: which reads are SENSITIVE enough to record. The middleware audits every authz DENIAL (the
// abuse/enumeration signal) plus an allowed read that touches one of these. meta records field keys, never
// values - the middleware never sees the values.
export type AuditPolicy = {
  sensitive_subresources: string[]; // GET <col>/<id>/<sub> with <sub> here (bank-account/identity/tax)
  sensitive_collections: string[]; // GET <col>/<id> for these whole-item-sensitive collections (compensation)
  sensitive_verbs: string[]; // `<collection>:<verb>` custom methods that expose sensitive bytes (payslips:download)
};

/**
 * Reads that stream bytes and are deliberately NOT an accountability event, each with the reason.
 *
 * The exemptions used to live only in the prose above `sensitive_verbs`, which meant a new streaming verb was
 * "decided" by whoever did or did not type it into the list. As data they are a decision the drift test can
 * hold every streaming verb against (test/streamingVerbAudit.test.ts), so the next one is classified or the
 * build says so.
 */
export const NON_SENSITIVE_STREAMING_VERBS: Record<string, string> = {
  "employees:getPhoto": "a profile photo, loaded by every directory row and every avatar on the page - the same volume argument that keeps `personal-info` out of sensitive_subresources",
  "employees:getSignature": "the person's own uploaded signature image, drawn onto letters they are already reading",
  "org-documents:download": "the published handbook and company-wide files - shared org content everyone may read",
  "expenses:download": "a vendor invoice for company spend, not a person's document",
  "payslips:previewTemplate": "renders the payslip DESIGN against fabricated sample figures; no real pay is in it",
  "payroll-runs:previewPayslip": "re-renders numbers the run's own review table already shows to the same caller",
  "letterheads:image": "org branding artwork",
  "letterheads:preview": "a sample rendered on the org's letterhead; no person's data is in it",
  "reviews:pdf": "the same content the caller can already read at GET /v1/reviews/<id>, which is not audited either - auditing the rendering and not the record would be a trail that reads as though the PDF were the exposure",
};

// The global policy manifest: protected fields + authorized references + owner refs + state visibility + audit
// policy + grantable scopes + redacted fields, keyed by collection. Stored as one `policy` row (key='manifest')
// and carried on the auth read - no extra query.
export type Policy = {
  protected_fields: Record<string, string[]>;
  references: Record<string, Record<string, RefField>>;
  owner_refs: Record<string, Record<string, OwnerRef>>;
  state_visibility: Record<string, StateRule>;
  audit: AuditPolicy;
  supported_scopes: Record<string, ScopeTier[]>;
  redacted_fields: Record<string, string[]>;
};
