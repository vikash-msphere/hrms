// Body access-control manifests (docs/archive/plan.txt 11C/11R). Pure data + tiny accessors; the authz middleware
// (Phase 2) consumes them so body references and field-level writes are authorized centrally.
import type { Level } from "./permissions";

export type RefField = { collection: string; level: Level };

// Non-ownership body references the middleware validates ("may you reference this target?" = `level` on
// it). Ownership/principal refs (employee, manager, department, owner) are intentionally NOT here: they
// are path-derived or admin-only (re-parent), enforced structurally, so a body value can't smuggle one.
export const REFERENCES: Record<string, Record<string, RefField>> = {
  "leave-requests": { leave_type: { collection: "leave-types", level: "read" } },
  "holiday-selections": { holiday: { collection: "holidays", level: "read" } },
  "payroll-runs": { pay_period: { collection: "pay-periods", level: "read" } },
  reimbursements: { category: { collection: "reimbursement-categories", level: "read" } },
  "benefit-enrollments": { plan: { collection: "benefit-plans", level: "read" } },
  "shift-assignments": { shift: { collection: "shifts", level: "read" } },
  "time-entries": { project: { collection: "projects", level: "read" } },
  referrals: { department: { collection: "departments", level: "read" }, hired_employee: { collection: "employees", level: "read" } },
  "job-requisitions": { department: { collection: "departments", level: "read" }, hiring_manager: { collection: "employees", level: "read" } },
  candidates: { referral: { collection: "referrals", level: "read" } },
  applications: { candidate: { collection: "candidates", level: "read" }, requisition: { collection: "job-requisitions", level: "read" }, referral: { collection: "referrals", level: "read" } },
  interviews: { application: { collection: "applications", level: "read" } },
  "interview-feedback": { interview: { collection: "interviews", level: "read" } },
  // A card lives on a board (need read on it) and may link to a goal (need read on it). `assignee` is a
  // principal ref (like manager), enforced structurally, so it is deliberately not gated here.
  cards: { board: { collection: "boards", level: "read" }, goal: { collection: "goals", level: "read" }, sprint: { collection: "sprints", level: "read" } },
  sprints: { board: { collection: "boards", level: "read" } },
  offers: { application: { collection: "applications", level: "read" } },
};

// Fields that need write authorization beyond the plain resource-write grant. For each such field PRESENT
// in the body (CREATE or UPDATE), the middleware additionally checks write on `<collection>.<id>.<field>`
// - so the level matcher gates it (e.g. employees.** write covers employees.x.department.write for HR,
// but a plain employee, lacking record write, cannot set department/manager on themselves; compensation
// amounts stay payroll-only; users role/status/employee-relink stay super-only). This blocks
// mass-assignment / self-escalation and is the hook for finer per-field control later.
export const PROTECTED_FIELDS: Record<string, string[]> = {
  users: ["role", "status", "employee"], // role/status escalation; employee relink = identity change
  employees: ["department", "manager", "epf_enrolled", "employee_number"], // re-parent (re-scoping) + EPF enrolment + human ID — payroll/HR only, never self-writable
  compensation: ["annual_ctc", "currency_code", "pay_grade", "salary_structure"], // pay amounts (annual_ctc drives the whole split) — payroll only, never self
};

export function referencesOf(collection: string): Record<string, RefField> {
  return REFERENCES[collection] ?? {};
}
export function protectedFieldsOf(collection: string): string[] {
  return PROTECTED_FIELDS[collection] ?? [];
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
  if ((policy.protected_fields[collection] ?? []).includes(field)) return true;
  if (subresourceBodyKey(field) !== null) return true; // whole sub-resource
  const dot = field.indexOf(".");
  if (dot > 0) return field.slice(dot + 1).length > 0 && subresourceBodyKey(field.slice(0, dot)) !== null;
  return false;
}

// How to find the field map in a sub-resource write body (code-coupled, like AUDIT - not org-configurable).
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
// is the ref TARGET (always employees here). holiday-selections is omitted: its service forces self.
export type OwnerRef = { collection: string };
export const OWNER_REFS: Record<string, Record<string, OwnerRef>> = {
  "leave-requests": { employee: { collection: "employees" } },
  "personal-documents": { employee: { collection: "employees" } },
  "attendance-regularizations": { employee: { collection: "employees" } },
  "overtime-requests": { employee: { collection: "employees" } },
  "remote-work-requests": { employee: { collection: "employees" } },
  "notice-periods": { employee: { collection: "employees" } },
  // The board author owns their row: kudos are author(giver)-owned, and a generic post's author owns it too, so
  // an author can self-scope edit/soft-delete their own item (kudos folded into announcements as kind="kudos").
  announcements: { author: { collection: "employees" } },
  suggestions: { submitter: { collection: "employees" } },
  reimbursements: { employee: { collection: "employees" } },
  goals: { employee: { collection: "employees" } },
  // A card is owned by its employee (default: the caller). Present = create on behalf of that employee (gated:
  // needs write on cards.<ownerCode>), so an ordinary employee can only own their own cards.
  cards: { employee: { collection: "employees" } },
  transitions: { employee: { collection: "employees" } },
  "check-ins": { employee: { collection: "employees" } },
  dependents: { employee: { collection: "employees" } },
  "benefit-enrollments": { employee: { collection: "employees" } },
  "shift-assignments": { employee: { collection: "employees" } },
  "time-entries": { employee: { collection: "employees" } },
  loans: { employee: { collection: "employees" } },
  "tax-declarations": { employee: { collection: "employees" } },
  // A ticket is owned by its requester employee. Absent = the caller (self-service). Present = raise it ON
  // BEHALF OF that employee - the middleware gates it (needs write on tickets.<ownerCode>), so an ordinary
  // employee can only set it to themselves, while HR/super/system automations may raise one for anyone.
  tickets: { employee: { collection: "employees" } },
  referrals: { referrer: { collection: "employees" } },
  "interview-feedback": { author: { collection: "employees" } },
  // Admin-created comp records. Default holders (hr_admin/payroll_admin) have `**` write so the owner check is
  // a no-op for them; the point is defense-in-depth: if any of these is ever granted at a narrow (self/dept)
  // scope via the ACL, create-on-behalf-of-another is blocked (must hold write on the target's namespace),
  // closing a BOLA-write gap. The bonuses `:award` BULK path is a separate admin op (gated by the award verb),
  // not owner-scoped by design.
  compensation: { employee: { collection: "employees" } },
  positions: { employee: { collection: "employees" } },
  bonuses: { employee: { collection: "employees" } },
  settlements: { employee: { collection: "employees" } },
  "leave-encashments": { employee: { collection: "employees" } },
};

// Which SUBJECT-RELATIVE scope tiers are meaningful when granting access on a collection, narrowest-first (so
// the ACL UI's default selection is the tightest). These are the tiers an access icon offers IN ADDITION to
// the structural object-anchored ones the UI adds whenever an object is in context: `exact` (this one object)
// and `subtree` (this object + the codes under it - only for container/dept-coded objects, so it's listed
// here ONLY for collections whose objects nest). The set is authoritative: the UI reads it (carried on
// users/me) instead of guessing from a parallel hardcoded list, so every access icon offers exactly the
// relevant choices. Over-inclusion is SAFE - a tier the engine can't honor for a collection just yields an
// inert rule (never a security hole) - so this errs toward offering a scope. Anything unlisted is "all" only.
export type ScopeTier = "self" | "dept" | "subtree" | "all";
export const SUPPORTED_SCOPES: Record<string, ScopeTier[]> = {
  // Employee-coded collections: target the subject's own rows, their department, or everyone.
  employees: ["self", "dept", "all"],
  "leave-requests": ["self", "dept", "all"],
  goals: ["self", "dept", "all"],
  cards: ["self", "dept", "all"], // owner-coded kanban cards: own / the dept's board work / all
  reviews: ["self", "dept", "all"],
  "review-feedback": ["self", "dept", "all"],
  transitions: ["self", "dept", "all"],
  "transition-tasks": ["self", "dept", "all"],
  "check-ins": ["self", "dept", "all"],
  dependents: ["self", "dept", "all"],
  "benefit-enrollments": ["self", "dept", "all"],
  "shift-assignments": ["self", "dept", "all"],
  "time-entries": ["self", "dept", "all"],
  loans: ["self", "dept", "all"],
  "tax-declarations": ["self", "dept", "all"],
  referrals: ["self", "dept", "all"],
  "interview-feedback": ["self", "dept", "all"],
  "leave-balances": ["self", "dept", "all"],
  "leave-encashments": ["self", "dept", "all"],
  attendance: ["self", "dept", "all"],
  "attendance-regularizations": ["self", "dept", "all"],
  "overtime-requests": ["self", "dept", "all"],
  "remote-work-requests": ["self", "dept", "all"],
  "notice-periods": ["self", "dept", "all"],
  announcements: ["self", "dept", "all"], // author-owned (giver for kudos); self = own posts/kudos
  suggestions: ["self", "dept", "all"],
  "document-acknowledgements": ["self", "dept", "all"],
  "personal-documents": ["self", "all"],
  payslips: ["self", "dept", "all"],
  reimbursements: ["self", "dept", "all"],
  compensation: ["self", "dept", "all"],
  positions: ["self", "dept", "all"],
  bonuses: ["self", "dept", "all"],
  settlements: ["self", "dept", "all"],
  operations: ["self", "all"], // employee-owned jobs
  tickets: ["self", "all"], // owner-coded; visibility beyond own is category-based, not a grant scope
  // Departments form the code hierarchy, so `subtree` (this dept + its sub-depts) is the meaningful narrowing.
  departments: ["subtree", "all"],
  // Per-entity activity trail gate (ANDed with the record read). Scope narrows WHICH records' activity you may
  // see: own / your dept / all. The target collection rides the field slot (`activity.<scope>.<collection>`),
  // authored in the ACL editor's per-collection picker — so activity is scopeable AND collection-filterable.
  activity: ["self", "dept", "all"],
};
export function supportedScopesOf(policy: Policy, collection: string): ScopeTier[] {
  return policy.supported_scopes?.[collection] ?? ["all"];
}

// State-gated visibility: a row that is NOT in its `public_when` state is visible only to callers who hold
// `requires` on the collection (the editors). The middleware decides "may see restricted rows" from the
// grant; a list service binds the column filter (decides nothing); item-GET is gated by the same rule with
// the row state riding the id->code resolve. Pure data - which collections gate, and how, is configurable.
export type StateRule = { requires: Level; public_when: Record<string, boolean> };
export const STATE_VISIBILITY: Record<string, StateRule> = {
  announcements: { requires: "write", public_when: { published: true, disabled: false } },
};

// Audit policy (data): which reads are SENSITIVE enough to record. The middleware audits every authz
// DENIAL (the abuse/enumeration signal) plus an allowed read that touches one of these - a sensitive PII
// sub-resource, a sensitive whole-item collection, or a sensitive custom verb (downloads). Ordinary reads
// are NOT audited (volume). meta records field keys, never values - the middleware never sees the values.
export type AuditPolicy = {
  sensitive_subresources: string[]; // GET <col>/<id>/<sub> with <sub> here (bank-account/identity/tax)
  sensitive_collections: string[]; // GET <col>/<id> for these whole-item-sensitive collections (compensation)
  sensitive_verbs: string[]; // `<collection>:<verb>` custom methods that expose sensitive bytes (payslips:download)
};
export const AUDIT: AuditPolicy = {
  // Field-bearing PII sub-resources whose read IS an accountability event: bank details (payout fraud),
  // statutory ids (PAN/Aadhaar/UAN), tax declarations. `personal-info` is deliberately NOT here: it is the
  // contact / emergency / blood-group card that the profile page and the emergency quick-view load on every
  // open, so auditing it logs routine colleague lookups by the hundred and buries the real signal. Its
  // per-field access control is unchanged (still read-redacted + write-gated); only the read row is dropped.
  sensitive_subresources: ["bank-account", "identity", "tax"],
  // Whole-item-sensitive collections: reading one row exposes salary / PII / medical, so an item GET is
  // audited (a `<col>.read.sensitive` row anchored on the record) even when the caller is allowed. Kept
  // deliberately narrow — a collection belongs here only if the ROW ITSELF carries money or personal data:
  // an org-level catalog (salary-structures = reusable component templates), a membership row (benefit-
  // enrollments = which plan), or a document's metadata (personal-documents = name/type/status; its BYTES
  // are audited via `personal-documents:download`) is not that, and auditing it is pure volume.
  sensitive_collections: ["compensation", "payslips", "settlements", "background-checks", "offers"],
  // Custom methods that stream sensitive bytes, keyed `<collection>:<verb>` — a bare verb name is ambiguous
  // (`payslips:download` is a person's pay, `org-documents:download` is the handbook everyone may read).
  // Only reads belong here. A write is already logged as a write (`personal-documents:generateForm16` files a
  // document), and these three reads are left silent on purpose: `payslips:previewTemplate` renders fabricated
  // sample figures, `payroll-runs:previewPayslip` re-renders numbers the run's review table already shows to
  // the same caller, `org-documents:download` / `expenses:download` are shared org content, not personal data.
  sensitive_verbs: [
    "employees:downloadIdentityDoc",
    "payslips:preview", "payslips:download",
    "payroll-runs:bankFile", "payroll-runs:statutoryReport", // bulk exports: every employee's account no. / statutory ids
    "personal-documents:download", "personal-documents:previewLetter", // previewLetter renders a NAMED employee's real letter (CTC)
    "candidates:download", "referrals:download", // an external person's resume
    "tax-declarations:download", // rent receipts / PAN / investment proofs
  ],
};

// The global policy manifest as data: protected fields + authorized references + owner refs + state
// visibility + audit policy, keyed by collection. Stored as one `policy` row (key='manifest') and carried
// on the auth read - no extra query.
export type Policy = {
  protected_fields: Record<string, string[]>;
  references: Record<string, Record<string, RefField>>;
  owner_refs: Record<string, Record<string, OwnerRef>>;
  state_visibility: Record<string, StateRule>;
  audit: AuditPolicy;
  supported_scopes: Record<string, ScopeTier[]>;
};

// Typed seed default - seeds the `policy` table and is the fail-closed fallback if the row is missing. NOT
// the runtime source of truth (the DB row is); identical values, so a missing row never changes behavior.
export const DEFAULT_POLICY: Policy = { protected_fields: PROTECTED_FIELDS, references: REFERENCES, owner_refs: OWNER_REFS, state_visibility: STATE_VISIBILITY, audit: AUDIT, supported_scopes: SUPPORTED_SCOPES };
