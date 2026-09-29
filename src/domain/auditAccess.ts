// Pure: given an authz outcome for a request, decide whether (and what) to write to the audit trail.
// The middleware audits every DENIAL (access.denied - the enumeration/abuse signal) and every ALLOWED
// read that touches a sensitive surface (a PII sub-resource, a sensitive whole-item collection, or a
// sensitive verb such as a download). Ordinary allowed reads return null (not audited - volume): a preview
// of sample/template data, an org document everyone may read, or an admin work surface whose numbers are
// already on screen is NOT an accountability event, and logging it only costs writes and buries the feed. meta
// carries field keys + the (internal) reason, never a value - the middleware never sees the value. Which
// sub-resources/collections/verbs count as sensitive is DATA (domain/manifests AUDIT), not a rule here -
// `personal-info` (contact / emergency card) is deliberately absent from it: routine, high-volume, not an
// accountability event. The
// `entityId` is the immutable internal id from the path (the anchor); codes are not used here.
import type { Decision } from "./permissions";
import type { AuditPolicy } from "./manifests";

export type AuditDescriptor = { action: string; entity: string; entityId: string | null; meta: Record<string, unknown> };

// `isSelf` = the caller is reading their OWN record (resolved by the middleware from the item code vs the
// caller's employee code). Viewing your own sensitive data is not an abuse signal, so it is never audited;
// denials are always recorded regardless.
export function accessAudit(method: string, pathname: string, decision: Decision, policy: AuditPolicy, isSelf = false): AuditDescriptor | null {
  // Parse /v1/<collection>/<id>[/<sub...>][:verb]. At authz time the id is the internal uuid (wire token
  // already decoded), not the code - so it is a sound audit anchor.
  let rest = pathname.replace(/^\/v1\//, "").replace(/^\/+/, "");
  const q = rest.indexOf("?");
  if (q >= 0) rest = rest.slice(0, q);
  let verb: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    verb = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const segs = rest.split("/").filter(Boolean);
  const collection = segs[0] ?? "";
  const idSeg = segs[1];
  const id = idSeg && idSeg !== "me" && idSeg !== "-" ? idSeg : null;
  const sub = segs.slice(2);
  const m = method.toUpperCase();

  if (!decision.allow) {
    return {
      action: "access.denied",
      entity: collection || "(unmapped)",
      entityId: id,
      meta: { method: m, path: verb ? `${rest}:${verb}` : rest, reason: decision.reason },
    };
  }

  // Reading your OWN sensitive data is expected, not an abuse signal - never audited.
  if (isSelf) return null;
  const sensitiveSub = m === "GET" && sub.some((t) => policy.sensitive_subresources.includes(t));
  // A whole-item-sensitive collection is only audited for a SPECIFIC record read (has an id) - a plain
  // list/collection GET exposes no one record's sensitive fields, so it isn't logged as a sensitive view.
  const sensitiveCol = m === "GET" && !!id && sub.length === 0 && policy.sensitive_collections.includes(collection);
  // Sensitive verbs are qualified `collection:verb` - a bare verb name is ambiguous across collections
  // (`payslips:download` streams someone's pay, `org-documents:download` hands out the published handbook).
  const sensitiveVerb = verb !== null && policy.sensitive_verbs.includes(`${collection}:${verb}`);
  if (sensitiveSub || sensitiveCol || sensitiveVerb) {
    const field = sensitiveVerb ? `:${verb}` : sub.length ? sub.join(".") : collection;
    // `authorized_by` is NOT set here: the middleware parks the allowing pattern on the request user, so
    // lib/audit stamps it on this row and on every row the handler writes, from one place.
    return { action: `${collection}.read.sensitive`, entity: collection, entityId: id, meta: { method: m, field } };
  }
  return null;
}

// Custom methods that READ - they produce output (bytes, a report, a metric) and change no state. AEP
// delivers custom methods as POST, so the write backstop below must exclude them or it would log a read as a
// write ("HR bank-filed a payroll run"). Keyed `collection:verb`, never a bare verb: the same verb name reads
// in one collection and mutates in another - `batch:run` fans out GETs while `operations/<id>:run` re-runs a
// job, `payslips:download` streams bytes while `transition-tasks:upload` stores them.
//
// This set is a STRUCTURAL fact about each handler (does it change state?), not policy. Whether a read is
// worth an audit row is the separate, data-driven `sensitive_verbs` question above: a read listed there gets
// one `.read.sensitive` row from accessAudit; every other read here writes nothing at all.
export const READ_VERBS = new Set([
  "employees:getPhoto", "employees:getSignature", "employees:upcomingCelebrations",
  "employees:downloadIdentityDoc",
  "boards:metrics", // board/flow analytics
  "boards:sharing", // who may see and work a board - reads the list and the department's managers, writes nothing
  "automations:test", // dry run: evaluates the condition, executes no action
  "batch:run", // GET-only multi-read transport (each sub-request is separately gated + audited)
  "payslips:preview", "payslips:download", "payslips:previewTemplate",
  "payroll-runs:previewPayslip", "payroll-runs:statutoryReport",
  // `payroll-runs:bankFile` is NOT here, despite streaming bytes like its neighbours. It also STAMPS the run
  // (services/bankFile.ts: "Stamp the first generation. Handing the file to the bank is where the money
  // actually leaves"), and that stamp is irreversible and load-bearing - services/payroll.ts refuses to delete
  // a stamped run and the SPA hides its delete control. This set is a STRUCTURAL fact about the handler, and
  // structurally that handler changes state, so listing it made the write backstop skip a mutation. The trail
  // was not missing - the verb is in AUDIT.sensitive_verbs, so accessAudit already writes one
  // `payroll-runs.read.sensitive` row - but that is the wrong TYPE: somebody asking "who locked this run, and
  // when" found a read event, and any filter or alert keyed on writes missed it entirely. Off this list both
  // rows are written, which is the honest record for a call that streams every employee's account number AND
  // locks the run.
  "personal-documents:previewLetter", "personal-documents:download",
  "org-documents:download",
  "candidates:download", "referrals:download", "expenses:download", "reimbursements:download", "tax-declarations:download",
  // Four more that were in neither registry for the same reason, and are as plainly reads as the two below:
  // each renders a PDF or hands back a stored image and files nothing (the handlers say so - "Nothing is
  // stored either way", "nothing is filed either way"), yet `offers.letter` and `reviews.pdf` were landing in
  // the trail as changes to the offer and to the review.
  "offers:letter", "reviews:pdf",
  "letterheads:image", "letterheads:preview",
  // Two byte-streaming verbs that were in NEITHER registry, so each was filed as a mutation by the backstop
  // below - `leave-requests.download` and `tickets.attachment` entries reading as a change to the record.
  // Both handlers read a row, fetch from R2 and return (services/attachments.ts#downloadAttachment,
  // services/tickets.ts#readTicketAttachment); structurally they change nothing, which is the only question
  // this set asks. Whether the read deserves a row is the separate question, answered in AUDIT.sensitive_verbs
  // (both are there now), and the two registries have to agree or the trail is filed under the wrong half of
  // the vocabulary: a reviewer filtering for "viewed" to answer "who opened this person's medical document"
  // got nothing back, and the rows that did exist sat under "other".
  "leave-requests:download", "tickets:attachment",
  // The two JSON reads behind a review's drawer: the delivered-work evidence and the 360 picker's suggested
  // colleagues. Both handlers read and answer ("Nothing is written: nominating is still a separate act"), so
  // opening a review must not land in the trail as a change to it.
  "reviews:evidence", "reviews:collaborators",
]);

// Collections whose writes never reach the activity feed. These are recipient/caller-owned personal state with
// no accountability value — auditing them floods the feed with self-referential noise:
//   notifications       — read-state toggles (read / dismissed / snooze / markAllRead), emitted server-side
//   preferences         — per-user UI settings (theme, tab_seen, …), written constantly by the SPA
//   attendance          — self clock in/out punches, high-frequency and already fully recorded in the attendance
//                         session rows themselves (corrections go through attendance-regularizations, which ARE audited)
//   holiday-selections  — the caller's own optional-holiday picks (the service forces self); the selection row
//                         IS the record, with its own timestamps
const NO_AUDIT_COLLECTIONS = new Set(["notifications", "preferences", "attendance", "holiday-selections"]);

// Custom methods that mutate but are self-referential engagement, never an accountability event. Keyed
// `collection:verb` like READ_VERBS. The tallies live in the target row / vote table, which is the record.
//   announcements:markRead        — the caller's own read receipt on a board post
//   announcements:markAllRead     — the same receipt, for every post they can see (the "Mark all read" action)
//   announcements:react / :vote   — an emoji reaction / a poll answer (poll answers are deliberately private)
//   suggestions:upvote/:downvote  — a vote on a suggestion (the box may be anonymous)
const NO_AUDIT_VERBS = new Set([
  "announcements:markRead", "announcements:markAllRead", "announcements:react", "announcements:vote",
  "suggestions:upvote", "suggestions:downvote",
]);

// Sub-resources (last path segment) that are caller-owned personal settings — skipped regardless of the parent
// collection. `notification-prefs` hangs off employees/<id> but is the caller's own mute/digest list.
const NO_AUDIT_SUBRESOURCES = new Set(["notification-prefs"]);

// The write backstop (authz middleware, AFTER a successful mutating request the handler did NOT already audit).
// Emits ONE generic activity row so every create/update/delete/custom-method call shows in the feed, closing
// the gap left by services that don't call audit() inline. Returns null for read-shaped requests that reach it
// (a GET slips through, or a read-only custom verb). Parsing mirrors accessAudit: the path id is the internal
// uuid (wire token already decoded), a sound audit anchor; codes are not used.
export function mutationAudit(method: string, pathname: string): AuditDescriptor | null {
  let rest = pathname.replace(/^\/v1\//, "").replace(/^\/+/, "");
  const q = rest.indexOf("?");
  if (q >= 0) rest = rest.slice(0, q);
  let verb: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    verb = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const segs = rest.split("/").filter(Boolean);
  const collection = segs[0] ?? "";
  if (!collection) return null;
  if (NO_AUDIT_COLLECTIONS.has(collection)) return null;
  const m = method.toUpperCase();
  if (m !== "POST" && m !== "PATCH" && m !== "PUT" && m !== "DELETE") return null;
  if (verb && (READ_VERBS.has(`${collection}:${verb}`) || NO_AUDIT_VERBS.has(`${collection}:${verb}`))) return null;
  const idSeg = segs[1];
  const id = idSeg && idSeg !== "me" && idSeg !== "-" ? idSeg : null;
  const sub = segs.slice(2);
  if (sub.length && NO_AUDIT_SUBRESOURCES.has(sub[sub.length - 1]!)) return null;

  let action: string;
  if (verb) action = `${collection}.${verb}`;
  else if (sub.length) action = `${collection}.${sub.join(".")}.${m === "DELETE" ? "delete" : "update"}`;
  else if (m === "POST") action = `${collection}.create`;
  else if (m === "DELETE") action = `${collection}.delete`;
  else action = `${collection}.update`; // PATCH / PUT
  return { action, entity: collection, entityId: id, meta: { method: m, path: verb ? `${rest}:${verb}` : rest } };
}
