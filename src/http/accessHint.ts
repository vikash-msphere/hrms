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
  // `issue` is the hand-over: an approved request is closed by giving the person an actual asset.
  "asset-requests": ["approve", "reject", "cancel", "issue"],
  operations: ["run"],
  "cron-runs": ["run"],
  "leave-requests": ["update", "delete", "approve", "reject", "cancel", "upload", "download"],
  goals: ["update", "delete", "updateProgress", "comment", "setContributors", "watch", "unwatch"],
  boards: ["update", "delete", "configure", "metrics"],
  cards: ["update", "delete", "move", "block", "unblock", "assign", "prioritize", "comment", "addTodos", "toggleTodo", "removeTodo", "promoteTodo", "watch", "unwatch"],
  sprints: ["update", "delete", "activate", "complete"],
  "review-cycles": ["update", "delete", "launch", "enroll", "close", "reopen"],
  reviews: ["submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "suggestFeedback", "assignReviewer", "nudge", "pdf"],
  "review-feedback": ["submitFeedback", "decline"],
  "time-entries": ["update", "delete", "submit", "approve", "reject"],
  loans: ["update", "delete", "approve", "reject", "disburse", "recordRepayment"],
  "tax-declarations": ["update", "delete", "verify", "reject", "upload", "download"],
  transitions: ["update", "delete", "complete", "cancel", "reopen", "appendTask"],
  "transition-tasks": ["complete", "reopen", "upload"],
  announcements: ["update", "delete", "post", "giveKudos", "markRead", "markAllRead", "react", "reply", "vote", "publish", "unpublish", "disable", "enable", "lock", "unlock", "pin", "unpin"],
  "api-keys": ["delete", "revoke"], // no update: a credential's scope is fixed at mint time, so there is no PATCH
  holidays: ["update", "delete"],
  // `respond` is the attendee's RSVP: a verb an ordinary employee holds on an event aimed at them, without any
  // write access to the event itself.
  events: ["update", "delete", "respond"],
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
  // Asset custody: `verify` counts one into stock, `acknowledge` is its holder confirming receipt, and
  // `printTag` is what a caller needs before the resource will even carry the tag secret (serialize.ts).
  // `batchCreate` is collection-level (a delivery, not a row); it is listed so the ACL modal can grant or deny
  // "add many at once" by name, exactly as announcements lists markAllRead.
  assets: ["update", "delete", "verify", "acknowledge", "printTag", "reissueTag", "batchCreate"],
  // Inventory counts. The route is factory-built (so its own hint comes from the verbs it mounts); this entry
  // exists so the ACL modal can grant/deny `close` and `recordFound` by name like any other custom method.
  stocktakes: ["update", "delete", "restore", "recordFound", "close"],
  bonuses: ["award"], // award a flat bonus across a scope (company/department/individual)
  // NOTE: `tickets` is not listed because it does not need to be: the route is factory-built, so the hint is
  // derived from the verbs it actually mounts (http/collectionRoute.ts) and this table is never consulted for
  // it. That is also how the ticket list's bulk Resolve/Close learn whether the caller may act on a row - they
  // read those verb names out of `access.can`. Verb rules validate by name (policyValidate), not against this map.
  "bank-formats": ["update", "uploadTemplate"],
  // The artwork is a second object behind the row: `image` reads it, `uploadImage` replaces it.
  letterheads: ["update", "delete", "uploadImage", "image", "deleteImage", "preview", "duplicate"],
  payslips: ["preview", "download"],
  "org-documents": ["update", "delete", "download", "acknowledge", "remindAck"],
  "personal-documents": ["update", "delete", "download", "sign", "refreshEsign", "print"],
  "document-acknowledgements": ["delete"],
  suggestions: ["update", "delete", "respond", "upvote", "downvote", "merge"],
  referrals: ["update", "delete", "upload", "download", "award"],
  "job-requisitions": ["update", "delete"],
  candidates: ["update", "delete", "upload", "download"],
  applications: ["update", "delete", "advance", "hire", "reject"],
  interviews: ["update", "delete", "complete", "cancel", "invite"],
  "interview-feedback": ["update", "delete"],
  offers: ["update", "delete", "approve", "extend", "accept", "decline", "rescind", "letter"],
  expenses: ["update", "delete", "submit", "approve", "reject", "cancel", "pay", "upload", "download"],
  automations: ["update", "delete", "enable", "disable", "test"],
  "access-rules": ["update", "delete", "preview", "requestAccess", "approve", "reject", "clone"],
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
  "setContributors", // credit a share of a goal to the people who delivered it (goals)
  "configure", "metrics", // kanban board config (columns/WIP/policies/lanes) + flow analytics (boards)
  "move", "block", "unblock", "assign", "prioritize", "comment", // kanban card actions (cards)
  "addTodos", "toggleTodo", "removeTodo", // card checklist (cards; tickets use the same verbs)
  "promoteTodo", // turn a checklist item into a card of its own (cards)
  "watch", "unwatch", // follow a card or a goal you do not own (cards, goals)
  "activate", // start a sprint (sprints) - complete reuses the existing verb
  "launch", "enroll", "close", "reopen", // review-cycle lifecycle (review-cycles)
  "submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "nudge", "pdf", // review workflow stages + 360 nomination + stall reminder + record copy (reviews)
  "suggestFeedback", // the reviewee's own list of who saw their work, inert until a manager nominates (reviews)
  "assignReviewer", // name who writes one review, instead of re-parenting the employee (reviews)
  "submitFeedback", "decline", // 360 peer feedback (review-feedback)
  "complete", "appendTask", // onboarding/offboarding transitions + tasks (transitions, transition-tasks)
  "disburse", "recordRepayment", // loan lifecycle (loans)
  "verify", // verify a tax declaration (tax-declarations)
  "approve", "reject", "cancel", "submit", "build", "download", "upload", "pay", // domain custom
  "bankFile", // download a payroll run as a bank's bulk-payment .xlsx
  "statutoryReport", // download a payroll run's PF/ESI/PT/TDS statutory report (.xlsx)
  "previewPayslip", // render one employee's payslip for an unpublished run, inline, nothing persisted (payroll-runs)
  "preview", // view a stored document inline, without the right to keep a copy (payslips); effective-access view-as (access-rules); render a sample page on a letterhead design (letterheads)
  "clockIn", "clockOut", // attendance punches (self-service)
  "sign", // in-place e-signature of a generated letter/contract (personal-documents, owner-only)
  "refreshEsign", // poll an e-sign vendor for a pending document's status and apply it (personal-documents)
  "remindAck", // nudge whoever still owes a signature on a policy's current version (org-documents)
  "run", // run a queued job (operations) or fire a cron tick on demand (cron-runs)
  "uploadTemplate", // upload a bank's blank bulk-payment .xlsx (bank-formats)
  "uploadImage", "image", "deleteImage", // upload / read / remove one of a letterhead's images (letterheads)
  "duplicate", // copy a letterhead, artwork and all, as the basis for a variant (letterheads)
  "print", // re-render a generated letter on its letterhead's print page, storing nothing (personal-documents)
  "award", // award a flat bonus across a scope (bonuses)
  "respond", "upvote", "downvote", // suggestion box: HR triage (status + reply) + peer up/down vote (suggestions); `respond` is also an attendee's RSVP (events)
  "merge", // fold a duplicate suggestion into the one it repeats, taking its votes with it (suggestions)
  "route", // re-route a ticket to a different servicing department (tickets)
  "advance", // ATS: move an application one stage forward in the configured pipeline (applications)
  "hire", // ATS: convert the candidate into an employee, which starts their onboarding (applications)
  "extend", "accept", "rescind", // ATS: offer workflow (offers) - decline/approve reuse existing verbs
  "invite", // ATS: mail the candidate their interview slot, with a calendar attachment (interviews)
  "letter", // ATS: render an offer's own letter as a PDF, inline, nothing persisted (offers)
  "enrollDefaultBenefits", // auto-enrol a new hire in default benefit plans (employees; wired via automation)
  "test", // dry-run an automation rule against a sample event (automations)
  "requestAccess", // ask access admins for a missing grant (access-rules)
  "clone", // copy every rule one subject holds onto another, as one act (access-rules)
  "printTag", "reissueTag", // asset sticker: stamp it as printed / rotate its secret so a lost tag dies (assets)
  "batchCreate", // add a whole delivery of assets in one call - a quantity of identical things, or a list of serials (assets)
  "recordFound", // log a scan that matched no asset during an inventory count (stocktakes)
  "close", // freeze an inventory count: snapshot its counts + missing list, one-way (stocktakes)
  "issue", // hand an in-stock asset to the person whose request was approved (asset-requests)
]);

// The verbs this caller may perform on the object with internal `code`, decided by the engine over `grant`
// (the broad role grant, or - on item paths - the per-object-merged grant). Pure, in-memory, zero DB.
export function computeCan(grant: Grant, self: Self, collection: string, code: string, candidates?: readonly string[]): string[] {
  const resource = `${collection}.${code}`;
  // A factory-built collection passes the methods it ACTUALLY mounted (http/collectionRoute.ts), so the hint
  // can never advertise an action the route does not have - an append-only collection like event-log used to
  // inherit the update+delete default and offer the SPA two buttons that would 404.
  const verbs = candidates ?? ACCESS_VERBS[collection] ?? DEFAULT_VERBS;
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

export type AccessHint = { can: string[]; why?: ScopeKind };

// The hint for one object, computed BEFORE it is serialized. That order matters for a resource whose SHAPE
// depends on what the caller may do - a board post carries its read receipts only for someone who may edit it -
// because only the caller of this holds the per-object grant the answer depends on. `code` is the object's
// internal code (the row's `code` column - NOT the wire id, since `me`/`my-dept`/prefix scope tokens match
// against codes). On item paths pass the per-object-merged grant (c.get("objectGrant")) for share-accurate
// hints; lists pass the role grant (user.grant).
export function accessHint(
  user: AppUser,
  collection: string,
  code: string | null | undefined,
  grant: Grant = user.grant,
  candidates?: readonly string[],
): AccessHint {
  // A row with no code can't be decided against -> fail safe (hint nothing; the server still enforces).
  const self = { employeeCode: user.employeeCode };
  const can = code ? computeCan(grant, self, collection, code, candidates) : [];
  const why = code ? computeWhy(grant, self, collection, code) : null;
  return why ? { can, why } : { can };
}

/** Attach an already-computed hint (or compute it now) to a serialized resource. */
export function withAccess<T extends object>(
  res: T,
  user: AppUser,
  collection: string,
  code: string | null | undefined,
  grant: Grant = user.grant,
  candidates?: readonly string[],
  hint?: AccessHint,
): T & { access: AccessHint } {
  return { ...res, access: hint ?? accessHint(user, collection, code, grant, candidates) };
}
