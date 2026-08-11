// Per-object access HINT for the client (UX only - the authz middleware still enforces every request; this
// gates nothing). For each candidate verb on a collection, the same engine `decide()` answers "may THIS caller
// perform it on THIS object?", matched against the object's internal `code` exactly like a real request path.
// The allowed verbs are shipped as `access.can` on the serialized resource so the SPA can hide/disable
// actions the caller can't perform. Bounded: a small static verb set per collection (kept honest by the
// drift test in test/accessHint.test.ts). The decision is computed server-side and shipped as data - no
// access decision moves into the client.
import { decide, matchingPattern, type Grant } from "../domain/permissions";
import { deriveNarrowing, type ScopeKind } from "../domain/compileGrants";
import type { AppUser } from "../env";

type Self = { employeeCode: string | null };

// Standard methods map to a level; everything else is a custom method (`:verb`). `delete` is the soft delete
// (write); the hard `purge` (admin/?force) stays on the coarse `*.admin` capability, not a per-row hint.
const STANDARD_LEVEL: Record<string, "write" | "admin"> = { update: "write", delete: "write" };

// The candidate verbs probed per collection. Forward + inverse lifecycle members are both listed so the UI
// (which shows e.g. Disable OR Enable by row state) gets a hint either way; they share one grant pattern, so
// it costs only an extra in-memory decide(). Every entry must be a real method on the route (drift test).
export const ACCESS_VERBS: Record<string, string[]> = {
  employees: ["update", "delete", "enrollDefaultBenefits"],
  departments: ["update", "delete"],
  attendance: ["clockIn", "clockOut"],
  "attendance-regularizations": ["approve", "reject", "cancel"],
  "overtime-requests": ["approve", "reject", "cancel"],
  "remote-work-requests": ["approve", "reject", "cancel"],
  operations: ["run"],
  "cron-runs": ["run"],
  "leave-requests": ["update", "delete", "approve", "reject", "cancel"],
  goals: ["update", "delete", "updateProgress"],
  boards: ["update", "delete", "configure", "metrics"],
  cards: ["update", "delete", "move", "block", "unblock", "assign", "prioritize", "comment", "addTodos", "toggleTodo", "removeTodo"],
  sprints: ["update", "delete", "activate", "complete"],
  "review-cycles": ["update", "delete", "launch", "enroll", "close", "reopen"],
  reviews: ["submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "nudge", "pdf"],
  "review-feedback": ["submitFeedback", "decline"],
  "time-entries": ["update", "delete", "submit", "approve", "reject"],
  loans: ["update", "delete", "approve", "reject", "disburse", "recordRepayment"],
  "tax-declarations": ["update", "delete", "verify", "reject", "upload", "download"],
  transitions: ["update", "delete", "complete", "cancel", "reopen", "appendTask"],
  "transition-tasks": ["complete", "reopen", "upload"],
  announcements: ["update", "delete", "post", "giveKudos", "markRead", "markAllRead", "react", "reply", "vote", "publish", "unpublish", "disable", "enable", "lock", "unlock", "pin", "unpin"],
  "api-keys": ["delete", "revoke"], // no update: a credential's scope is fixed at mint time, so there is no PATCH
  holidays: ["update", "delete"],
  "leave-types": ["update", "delete"],
  "letter-templates": ["update", "delete"],
  "pay-components": ["update", "delete"],
  "pay-grades": ["update", "delete"],
  "salary-structures": ["update", "delete"],
  "pay-periods": ["update", "delete"],
  "payroll-runs": ["delete", "submit", "approve", "publish", "build", "bankFile", "statutoryReport", "previewPayslip"],
  reimbursements: ["update", "delete", "approve", "reject", "cancel", "pay", "upload", "download"],
  "leave-encashments": ["approve", "reject", "cancel"],
  "reimbursement-categories": ["update", "delete"],
  "ticket-checklists": ["update", "delete"],
  bonuses: ["award"], // award a flat bonus across a scope (company/department/individual)
  // NOTE: `tickets` is intentionally NOT listed. Each ticket action (start/resolve/comment/toggleTodo/...) is
  // managed by its own verb-scoped access icon (the modal's verbMode handles a verb-target directly), so the
  // collection/row icons stay scoped to the read/write/admin level instead of ballooning into drill-in chips
  // for every verb. Verb rules validate by name (policyValidate), not against this map.
  "bank-formats": ["update", "uploadTemplate"],
  payslips: ["preview", "download"],
  "org-documents": ["update", "delete", "download", "acknowledge"],
  "personal-documents": ["update", "delete", "download", "sign", "refreshEsign"],
  "document-acknowledgements": ["delete"],
  suggestions: ["update", "delete", "respond", "upvote", "downvote"],
  referrals: ["update", "delete", "upload", "download", "award"],
  "job-requisitions": ["update", "delete"],
  candidates: ["update", "delete", "upload", "download"],
  applications: ["update", "delete", "advance", "reject"],
  interviews: ["update", "delete", "complete", "cancel"],
  "interview-feedback": ["update", "delete"],
  offers: ["update", "delete", "approve", "extend", "accept", "decline", "rescind"],
  expenses: ["update", "delete", "submit", "approve", "reject", "cancel", "pay", "upload", "download"],
  automations: ["update", "delete", "enable", "disable", "test"],
  "access-rules": ["update", "delete", "preview", "requestAccess", "approve", "reject"],
};
const DEFAULT_VERBS = ["update", "delete"];

// The full verb vocabulary the hint may reference: standard + shared lifecycle + domain custom methods. The
// drift test asserts ACCESS_VERBS only ever names a verb from here (a typo can't ship a phantom affordance).
export const KNOWN_VERBS: ReadonlySet<string> = new Set([
  "update", "delete", // standard
  "enable", "disable", "lock", "unlock", "publish", "unpublish", "restore", // shared lifecycle
  "revoke", // kill an API key without deleting it (api-keys), so the audit trail can still resolve it
  "post", // create a generic board post (announcements)
  "giveKudos", // give a kudo (a board post about a recipient; announcements, kind="kudos")
  "markRead", // record the caller's read receipt on a board post (announcements)
  "markAllRead", // record that receipt for every post the caller can see (announcements, notifications)
  "react", // toggle the caller's emoji reaction on a board post (announcements)
  "reply", // append a reply to a board post (announcements)
  "vote", // cast the caller's vote on a board poll (announcements)
  "pin", "unpin", // pin a board post to the top of the feed / take it down (announcements, moderation)
  "updateProgress", // move a goal's progress without full edit rights (goals)
  "configure", "metrics", // kanban board config (columns/WIP/policies/lanes) + flow analytics (boards)
  "move", "block", "unblock", "assign", "prioritize", "comment", // kanban card actions (cards)
  "addTodos", "toggleTodo", "removeTodo", // card checklist (cards; tickets use the same verbs)
  "activate", // start a sprint (sprints) - complete reuses the existing verb
  "launch", "enroll", "close", "reopen", // review-cycle lifecycle (review-cycles)
  "submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "nudge", "pdf", // review workflow stages + 360 nomination + stall reminder + record copy (reviews)
  "submitFeedback", "decline", // 360 peer feedback (review-feedback)
  "complete", "appendTask", // onboarding/offboarding transitions + tasks (transitions, transition-tasks)
  "disburse", "recordRepayment", // loan lifecycle (loans)
  "verify", // verify a tax declaration (tax-declarations)
  "approve", "reject", "cancel", "submit", "build", "download", "upload", "pay", // domain custom
  "bankFile", // download a payroll run as a bank's bulk-payment .xlsx
  "statutoryReport", // download a payroll run's PF/ESI/PT/TDS statutory report (.xlsx)
  "previewPayslip", // render one employee's payslip for an unpublished run, inline, nothing persisted (payroll-runs)
  "preview", // view a stored document inline, without the right to keep a copy (payslips); effective-access view-as (access-rules)
  "clockIn", "clockOut", // attendance punches (self-service)
  "sign", // in-place e-signature of a generated letter/contract (personal-documents, owner-only)
  "refreshEsign", // poll an e-sign vendor for a pending document's status and apply it (personal-documents)
  "run", // run a queued job (operations) or fire a cron tick on demand (cron-runs)
  "uploadTemplate", // upload a bank's blank bulk-payment .xlsx (bank-formats)
  "award", // award a flat bonus across a scope (bonuses)
  "respond", "upvote", "downvote", // suggestion box: HR triage (status + reply) + peer up/down vote (suggestions)
  "route", // re-route a ticket to a different servicing department (tickets)
  "advance", // ATS: move an application one stage forward in the configured pipeline (applications)
  "extend", "accept", "rescind", // ATS: offer workflow (offers) - decline/approve reuse existing verbs
  "enrollDefaultBenefits", // auto-enrol a new hire in default benefit plans (employees; wired via automation)
  "test", // dry-run an automation rule against a sample event (automations)
  "requestAccess", // ask access admins for a missing grant (access-rules)
]);

// The verbs this caller may perform on the object with internal `code`, decided by the engine over `grant`
// (the broad role grant, or - on item paths - the per-object-merged grant). Pure, in-memory, zero DB.
export function computeCan(grant: Grant, self: Self, collection: string, code: string): string[] {
  const resource = `${collection}.${code}`;
  const verbs = ACCESS_VERBS[collection] ?? DEFAULT_VERBS;
  const can: string[] = [];
  for (const v of verbs) {
    const level = STANDARD_LEVEL[v];
    const resolved = level ? { kind: "standard" as const, resource, level } : { kind: "custom" as const, resource, verb: v };
    if (decide(grant, resolved, self).allow) can.push(v);
  }
  return can;
}

// Provenance for the hint: the SCOPE by which this caller holds READ on the object - the broad "why you can
// see this" answer the modal surfaces ("allowed via your own record / your department / org-wide"). Subject
// (which role/rule) is intentionally not exposed: the runtime grant is flattened across subjects, so only the
// matching pattern's scope survives - and the scope is the part users actually act on. Null if not derivable.
export function computeWhy(grant: Grant, self: Self, collection: string, code: string): ScopeKind | null {
  const pat = matchingPattern(grant, { kind: "standard", resource: `${collection}.${code}`, level: "read" }, self);
  return pat ? deriveNarrowing(pat).scopeKind : null;
}

// Attach `access.can` to an already-serialized resource. `code` is the object's internal code (the row's
// `code` column - NOT the wire id, since `me`/`my-dept`/prefix scope tokens match against codes). On item
// paths pass the per-object-merged grant (c.get("objectGrant")) for share-accurate hints; lists pass the
// role grant (user.grant).
export function withAccess<T extends object>(
  res: T,
  user: AppUser,
  collection: string,
  code: string | null | undefined,
  grant: Grant = user.grant,
): T & { access: { can: string[]; why?: ScopeKind } } {
  // A row with no code can't be decided against -> fail safe (hint nothing; the server still enforces).
  const self = { employeeCode: user.employeeCode };
  const can = code ? computeCan(grant, self, collection, code) : [];
  const why = code ? computeWhy(grant, self, collection, code) : null;
  return { ...res, access: why ? { can, why } : { can } };
}
