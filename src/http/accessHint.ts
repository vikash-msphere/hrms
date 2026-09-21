// Per-object access HINT for the client (UX only - the authz middleware still enforces every request; this
// gates nothing). For each candidate verb on a collection, the same engine `decide()` answers "may THIS caller
// perform it on THIS object?", matched against the object's internal `code` exactly like a real request path.
// The allowed verbs are shipped as `access.can` on the serialized resource so the SPA can hide/disable
// actions the caller can't perform. Bounded: a small static verb set per collection (kept honest by the
// drift test in test/accessHint.test.ts). The decision is computed server-side and shipped as data - no
// access decision moves into the client.
import { decide, denyingPattern, matchingPattern, withOwnerResource, type Grant, type Resolved } from "../domain/permissions";
import { deriveNarrowing, type ScopeKind } from "../domain/compileGrants";
import { redactedFieldsOf } from "../domain/manifests";
import type { SubjectScopes } from "../domain/access";
import type { AppUser } from "../env";
import { selfContextOf } from "../lib/selfContext";

type Self = { employeeCode: string | null };

// Standard methods map to a level; everything else is a custom method (`:verb`). `delete` is the soft delete
// (write); the hard `purge` (admin/?force) stays on the coarse `*.admin` capability, not a per-row hint.
// `delete` additionally honours a deny on the `delete` verb - the axis that separates editing from
// destroying, since both otherwise resolve to `write` (see computeCan below).
const STANDARD_LEVEL: Record<string, "write" | "admin"> = { update: "write", delete: "write" };

// The candidate verbs probed per collection. Forward + inverse lifecycle members are both listed so the UI
// (which shows e.g. Disable OR Enable by row state) gets a hint either way; they share one grant pattern, so
// it costs only an extra in-memory decide(). Every entry must be a real method on the route (drift test).
export const ACCESS_VERBS: Record<string, string[]> = {
  // `uploadPhoto` / `clearPhoto`: the avatar's own gate, and a grant of its own (`employees.me.uploadPhoto`
  // for the owner, the broad `employees.**` for HR). The pencil on the avatar was gated on WRITE of the
  // personal-info sub-resource instead - a different rule that happens to coincide for the seeded roles and
  // parts company the moment an org grants one without the other, offering an editor that 403s or hiding one
  // that would work. A verb the hint does not list cannot be asked about, which is why they belong here.
  // (The signature verbs deliberately do NOT: they are owner-only at the service level, not grantable.)
  employees: ["update", "delete", "enrollDefaultBenefits", "uploadPhoto", "clearPhoto"],
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
  goals: ["update", "delete", "updateProgress", "comment", "setContributors", "watch", "unwatch", "similar", "suggestMeasure"],
  boards: ["update", "delete", "configure", "metrics", "duplicates", "narrate"],
  cards: ["update", "delete", "move", "block", "unblock", "assign", "prioritize", "comment", "addTodos", "toggleTodo", "removeTodo", "promoteTodo", "watch", "unwatch", "triage", "flow", "suggestGoal", "suggestSteps"],
  sprints: ["update", "delete", "activate", "complete"],
  "review-cycles": ["update", "delete", "launch", "enroll", "close", "reopen"],
  reviews: ["submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "suggestFeedback", "assignReviewer", "nudge", "pdf", "evidence", "collaborators"],
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
  "payroll-runs": ["delete", "submit", "approve", "publish", "build", "bankFile", "statutoryReport", "previewPayslip", "paymentResult"],
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
  suggestions: ["update", "delete", "respond", "upvote", "downvote", "merge", "similar"],
  referrals: ["update", "delete", "upload", "download", "award"],
  "job-requisitions": ["update", "delete"],
  candidates: ["update", "delete", "upload", "download", "extractResume"],
  applications: ["update", "delete", "advance", "hire", "reject"],
  interviews: ["update", "delete", "complete", "cancel", "invite"],
  "interview-feedback": ["update", "delete"],
  offers: ["update", "delete", "approve", "extend", "accept", "decline", "rescind", "letter"],
  expenses: ["update", "delete", "submit", "approve", "reject", "cancel", "pay", "upload", "download"],
  automations: ["update", "delete", "enable", "disable", "test"],
  "access-rules": ["update", "delete", "preview", "requestAccess", "approve", "reject", "clone", "review", "scopeCounts"],
  // The flagged-post queue. Listed so `decide` is offerable BY NAME in the ACL modal: the capability is
  // private by default and granted deliberately, so the one action on it should be grantable just as
  // deliberately rather than only through a wildcard. `moderation` has no table, so there is no per-row hint
  // to compute - this is here for the authoring UI.
  moderation: ["decide"],
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
  "duplicates", // the open cards a nightly sweep found to be the same work filed twice (boards)
  "move", "block", "unblock", "assign", "prioritize", "comment", // kanban card actions (cards)
  "addTodos", "toggleTodo", "removeTodo", // card checklist (cards; tickets use the same verbs)
  "triage", "decideTriage", // read the nearest-neighbour triage suggestion, and record what was done with it (tickets)
  "flow", // how long work like this card has taken on this board, from its movement log (cards)
  "suggestGoal", // which goal a card is probably serving, so delivering it can roll up (cards)
  "suggestSteps", // the checklist items that comparable delivered work actually carried (cards)
  "draft", // collection-level: write a first draft of some text from the caller's own instruction (announcements, job-requisitions, goals, suggestions)
  "extractResume", // read a CV into suggested form fields for the recruiter to accept one by one (candidates)
  "suggestMeasure", // propose a unit, a starting value and a target for a goal that has none (goals)
  "describe", // collection-level: turn a description of a grid into a spec the builder renders (table-fields)
  "narrate", // write up how measures changed against the previous window (people-analytics collection-level; boards per item)
  "decide", // uphold or clear a moderation flag on a public post (moderation)
  "similar", // other records asking for or aiming at the same thing (suggestions: what to merge; goals: duplicated effort and what to align to)
  "promoteTodo", // turn a checklist item into a card of its own (cards)
  "watch", "unwatch", // follow a card or a goal you do not own (cards, goals)
  "activate", // start a sprint (sprints) - complete reuses the existing verb
  "launch", "enroll", "close", "reopen", // review-cycle lifecycle (review-cycles)
  "submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "nudge", "pdf", // review workflow stages + 360 nomination + stall reminder + record copy (reviews)
  "suggestFeedback", // the reviewee's own list of who saw their work, inert until a manager nominates (reviews)
  "assignReviewer", // name who writes one review, instead of re-parenting the employee (reviews)
  "evidence", // what the person actually did in the cycle - delivered cards, kudos, contributions, 1:1 notes (reviews)
  "collaborators", // who worked with the reviewee this cycle, for the 360 picker to lead with (reviews)
  "submitFeedback", "decline", // 360 peer feedback (review-feedback)
  "complete", "appendTask", // onboarding/offboarding transitions + tasks (transitions, transition-tasks)
  "disburse", "recordRepayment", // loan lifecycle (loans)
  "verify", // verify a tax declaration (tax-declarations)
  "approve", "reject", "cancel", "submit", "build", "download", "upload", "pay", // domain custom
  "bankFile", // download a payroll run as a bank's bulk-payment .xlsx
  "paymentResult", // record what the bank did with that file: paid, failed or returned, per person
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
  "uploadPhoto", "clearPhoto", // the profile avatar (employees) - own via `employees.me.*`, org-wide for HR
  "test", // dry-run an automation rule against a sample event (automations)
  "requestAccess", // ask access admins for a missing grant (access-rules)
  "clone", // copy every rule one subject holds onto another, as one act (access-rules)
  "review", // the access review: unused rules + org-wide rules the recorded usage says could be narrower (access-rules)
  "scopeCounts", // how many records a scope choice reaches, for the ACL's scope chips (access-rules)
  "printTag", "reissueTag", // asset sticker: stamp it as printed / rotate its secret so a lost tag dies (assets)
  "batchCreate", // add a whole delivery of assets in one call - a quantity of identical things, or a list of serials (assets)
  "recordFound", // log a scan that matched no asset during an inventory count (stocktakes)
  "close", // freeze an inventory count: snapshot its counts + missing list, one-way (stocktakes)
  "issue", // hand an in-stock asset to the person whose request was approved (asset-requests)
]);

// The verbs this caller may perform on the object with internal `code`, decided by the engine over `grant`
// (the broad role grant, or - on item paths - the per-object-merged grant). Pure, in-memory, zero DB.
export function computeCan(grant: Grant, self: Self, collection: string, code: string, candidates?: readonly string[], ownerCode?: string | null): string[] {
  const resource = `${collection}.${code}`;
  // The OWNER KEY, for the flat-coded owner-column collections (assets, users). The middleware decides the real
  // request with it (domain/permissions.ts Resolved#ownerResource), so the hint has to be computed with it too:
  // without it the SPA would show no Edit or Delete on the very rows a self-scoped caller can edit, and - since
  // this app hides what the caller cannot use rather than disabling it - the affordance would simply not exist.
  const withOwner = (r: Resolved): Resolved => (ownerCode ? withOwnerResource(r, ownerCode) : r);
  // A factory-built collection passes the methods it ACTUALLY mounted (http/collectionRoute.ts), so the hint
  // can never advertise an action the route does not have - an append-only collection like event-log used to
  // inherit the update+delete default and offer the SPA two buttons that would 404.
  const verbs = candidates ?? ACCESS_VERBS[collection] ?? DEFAULT_VERBS;
  const can: string[] = [];
  for (const v of verbs) {
    const level = STANDARD_LEVEL[v];
    const resolved = level ? { kind: "standard" as const, resource, level } : { kind: "custom" as const, resource, verb: v };
    if (!decide(grant, withOwner(resolved), self).allow) continue;
    // `delete` is decided on the standard `write` level like `update`, so the two are one key - except that a
    // deny on the `delete` VERB blocks the request (middleware/authz.ts). Mirror that here or the row would
    // offer a Delete action whose only outcome is a 403, which is precisely what `access.can` exists to
    // prevent. The same deny lane, asked the same question - owner key included, as the middleware asks it.
    if (v === "delete" && denyingPattern(grant, withOwner({ kind: "custom" as const, resource, verb: "delete" }), self)) continue;
    can.push(v);
  }
  return can;
}

// Provenance for the hint: the SCOPE by which this caller holds READ on the object - the broad "why you can
// see this" answer the modal surfaces ("allowed via your own record / your department / org-wide"). Subject
// (which role/rule) is intentionally not exposed: the runtime grant is flattened across subjects, so only the
// matching pattern's scope survives - and the scope is the part users actually act on. Null if not derivable.
export function computeWhy(grant: Grant, self: Self, collection: string, code: string, ownerCode?: string | null): ScopeKind | null {
  const r = { kind: "standard" as const, resource: `${collection}.${code}`, level: "read" as const };
  const pat = matchingPattern(grant, ownerCode ? withOwnerResource(r, ownerCode) : r, self);
  return pat ? deriveNarrowing(pat).scopeKind : null;
}

export type AccessHint = {
  can: string[];
  why?: ScopeKind;
  /**
   * Employees only: what the caller may reach ABOUT THE PERSON this row is, across every collection
   * (`domain/access.ts subjectScopes`). `can` answers "which verbs on THIS row"; a profile's tabs ask the
   * other question - "may I see this person's goals, their attendance, their pay" - and each of those is a
   * different collection whose own grant decides it, against this person's code.
   */
  subject?: SubjectScopes;
};

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
  /** The row owner's employee code, for a flat-coded owner-column collection. See computeCan. */
  ownerCode?: string | null,
): AccessHint {
  // A row with no code can't be decided against -> fail safe (hint nothing; the server still enforces).
  // The request's own matcher context, so a hint answers the question the GATE answered - see selfContextOf.
  const self = selfContextOf(user);
  const can = code ? computeCan(grant, self, collection, code, candidates, ownerCode) : [];
  const why = code ? computeWhy(grant, self, collection, code, ownerCode) : null;
  return why ? { can, why } : { can };
}

/**
 * Per-field READ gate for base-record fields (`policy.redacted_fields`), applied where every resource is
 * serialized so no collection has to remember to do it.
 *
 * Each listed field is decided at `<collection>.<code>.<field>` level read and dropped from the payload when
 * that fails. ADDITIVE: a pattern's `**` matches trailing tokens, so `offers.**` / `leave-requests.my-dept.**`
 * already satisfy the field key and nobody loses a field by it being listed. What the list buys is the
 * ability to take one away - a deny on `offers.*.base_comp` removes that field and nothing else, scoped like
 * any other pattern - instead of forcing the choice between the whole record and none of it.
 *
 * Dropped, not nulled: an absent key reads as "not provided" to every client, while `null` on a field that is
 * genuinely nullable would be indistinguishable from a real empty value.
 *
 * NO OWNER KEY here, matching the write-side field gate in middleware/authz.ts: the owner key says the ROW is
 * yours, and a redacted field is exactly the part of your own row you may not see. Deciding it on the row's real
 * code keeps "read my own asset" and "read the fields marked sensitive on it" two separate grants.
 */
function redactFields<T extends object>(res: T, user: AppUser, collection: string, code: string | null | undefined, grant: Grant): T {
  if (!code) return res;
  const fields = redactedFieldsOf(user.policy, collection);
  if (!fields.length) return res;
  const self = selfContextOf(user);
  let out: Record<string, unknown> | null = null;
  for (const f of fields) {
    if (!(f in res)) continue; // already absent (undefined on the wire) - nothing to decide
    if (decide(grant, { kind: "standard", resource: `${collection}.${code}.${f}`, level: "read" }, self).allow) continue;
    out ??= { ...(res as Record<string, unknown>) };
    delete out[f];
  }
  return (out ?? res) as T;
}

/** Attach an already-computed hint (or compute it now) to a serialized resource, field-redacted for them. */
export function withAccess<T extends object>(
  res: T,
  user: AppUser,
  collection: string,
  code: string | null | undefined,
  grant: Grant = user.grant,
  candidates?: readonly string[],
  hint?: AccessHint,
): T & { access: AccessHint } {
  return { ...redactFields(res, user, collection, code, grant), access: hint ?? accessHint(user, collection, code, grant, candidates) };
}
