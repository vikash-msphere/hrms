// Row -> AEP wire resource boundary. Emits `path`, snake_case fields, and standard fields.
// NEVER emit *Enc columns or other DB-only fields.
import type { Wire } from "./wire";
import type { AppUser } from "../env";
import { RESOURCE_COLLECTIONS } from "../lib/authzResolve";
import { parseCondition, parseWindow } from "../domain/ruleCondition";
import { round2 } from "../domain/money";
import { parseIllustrationLayout, parseRecipientLayout } from "../domain/illustration";
import { parseScope, scopeToWire } from "../domain/keyScope";
import { parseRecordings } from "../domain/tickets";
import { parseAttachments } from "../domain/ticketAttachments";
import { parseFound, parseScope as parseStocktakeScope } from "../domain/stocktake";
import { competencyScore, goalAttainment, parseCompetencyKeys, type Competency, type GoalSnapshot } from "../domain/performance";
import { goalPace, staleDays } from "../domain/goals";
import { maskedToken } from "../lib/apiKeyToken";
// From the domain leaf, NOT from services/orgDay: `services/settings.ts` imports this module for `etagOf`, so
// reaching into services here would close a cycle (serialize -> orgDay -> settings -> serialize).
import { todayMsOf } from "../domain/attendance";

// Entities whose id resolves via uuidToCode (the same set the activity authz gate uses). An activity row's
// drill-ref is only emitted for these, so the feed never links to a non-resource entity (settings, batch,
// the activity endpoint itself, …) that would fail the target-resolve gate and audit a bogus denial.
const RESOLVABLE_ENTITIES = new Set(RESOURCE_COLLECTIONS);

// The ROW's validator: one version per row, off `updated_at`.
//
// NOT the employee's four encrypted SUB-resources (`bank-account`, `personal-info`, `identity`, `tax`). They
// are separate blobs on one `employees` row, so versioning them from this function gave all four the same
// validator: a write to any one of them invalidated the `If-Match` a caller was holding on the other three,
// and the PATCH was refused with a conflict that did not happen - HR filling in an emergency contact failing
// the bank form the employee had open, on fields neither of them touched. Each of those four is versioned
// from a hash of its OWN ciphertext instead (services/versionGuard.ts#subResourceEtag), so a validator moves
// only when the blob behind it does.
export const etagOf = (updateTimeMs: number) => `W/"${updateTimeMs}"`;
const iso = (d: Date | number) => new Date(d).toISOString();

type BaseRow = {
  uuid: string;
  createdAt: Date | number;
  updatedAt: Date | number;
  deleteTime?: Date | number | null;
  disabled?: boolean | null;
  locked?: boolean | null;
  lockedBy?: string | null;
  published?: boolean | null;
};

// Standard fields shared by every resource (+ lifecycle flags where the row carries them).
function baseResource(row: BaseRow, collection: string) {
  return {
    path: `${collection}/${row.uuid}`,
    create_time: iso(row.createdAt),
    update_time: iso(row.updatedAt),
    etag: etagOf(+new Date(row.updatedAt)),
    ...(row.deleteTime ? { delete_time: iso(row.deleteTime) } : {}),
    ...(row.disabled !== undefined ? { disabled: !!row.disabled } : {}),
    ...(row.locked !== undefined ? { locked: !!row.locked } : {}),
    // A REF, NOT A BARE ID - see the note on `ref` below. `lockedBy` is `actor.uuid` (services/lifecycle.ts),
    // i.e. a `users` primary key, and this rode out in the clear on every lockable collection.
    ...(row.lockedBy ? { locked_by: ref("users", row.lockedBy) } : {}),
    ...(row.published !== undefined ? { published: !!row.published } : {}),
  };
}
/**
 * A wire reference to another record: `<collection>/<id>`.
 *
 * EVERY id THAT LEAVES THIS FILE GOES THROUGH HERE, and the reason is the outbound edge rather than tidiness.
 * middleware/encodeWireIds rewrites `<collection>/<13-char id>` strings into `<collection>/<token>` on the way
 * out; a BARE id matches nothing it looks for, so it is published exactly as stored. Eight fields were emitted
 * that way - `locked_by` on every lockable collection, `decided_by` on the four request collections,
 * `responded_by`, and payroll's `submitted_by`/`approved_by` - and each of them is a `users` primary key: the
 * one value the codec exists to keep off the wire, on the rows that record who approved money and who unlocked
 * a record. They were unusable to a client as well, since the inbound edge decodes a token and these were not
 * one, so the SPA rendered `submitted_by` by stripping a prefix that was never there.
 */
const ref = (collection: string, id: string | null) => (id ? `${collection}/${id}` : undefined);

/**
 * Parse a stored JSON column, falling back rather than throwing.
 *
 * THE BLAST RADIUS IS THE PAGE, NOT THE ROW, which is what makes this worth a helper instead of a judgement
 * call per column. A serializer runs inside `results.map(...)` in the collection factory, so a `JSON.parse`
 * that throws on ONE malformed column takes the whole list response down as a 500 - every other row on the
 * page included - and the caller has no way to page around it. A dozen sites in this file already had their
 * own `try { … } catch { … }` around exactly this, written one at a time; the rest were raw, and the
 * difference between the two sets is which columns somebody happened to worry about, not which ones can be
 * malformed.
 *
 * And these columns have no CHECK constraint (SQLite does not validate `text`), so "the app only ever writes
 * valid JSON" is a property of every writer, forever, plus every migration, seed and backup restore that has
 * ever touched the table. A degraded field is a readable page with one value missing; a thrown parse is a
 * dead page.
 *
 * `null`/`undefined`/empty string take the fallback too, so the `r.col ? parse(r.col) : fallback` shape this
 * replaces collapses into one call. A stored literal `null` also takes it - a column whose value is the JSON
 * null carries no more information than an absent one, and the callers all want the empty shape.
 */
function jsonOr<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s) as T;
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function toPreferenceResource(r: any): Wire<"preference"> {
  return {
    path: `preferences/${r.key}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    key: r.key,
    value: jsonOr<Wire<"preference">["value"]>(r.value, {}),
  };
}

export function toUserResource(r: any): Wire<"user"> {
  return {
    ...baseResource(r, "users"),
    email: r.email,
    role: r.role,
    // The SECONDARY roles, when the caller decorated the row with them (services/users.ts). Omitted rather than
    // emitted empty when they were not loaded: `[]` would say "this person holds no extra roles", which is a
    // different claim from "nobody asked", and the account list does not pay for the join.
    ...(Array.isArray(r.roles) ? { roles: r.roles as string[] } : {}),
    status: r.status,
    employee: ref("employees", r.employeeId),
  };
}

// A machine credential. NEVER emits `hash` (the verifier) - the plaintext secret exists only in the create
// response, where the service attaches it to this resource once and it is then unrecoverable by design.
export function toApiKeyResource(r: any): Wire<"api-key"> {
  return {
    ...baseResource(r, "api-keys"),
    display_name: r.name,
    description: r.description ?? undefined,
    owner: ref("users", r.ownerUserId),
    prefix: r.prefix,
    masked_token: maskedToken(r.prefix),
    scope: (() => {
      const s = parseScope(safeJson(r.scopeJson));
      return s ? scopeToWire(s) : undefined;
    })(),
    expire_time: r.expiresAt ? iso(r.expiresAt) : undefined,
    last_used_time: r.lastUsedAt ? iso(r.lastUsedAt) : undefined,
    revoke_time: r.revokedAt ? iso(r.revokedAt) : undefined,
    // Present on create only; the service passes the freshly minted token through on that one response.
    ...(r.secret ? { secret: r.secret } : {}),
  };
}
/** The untyped form of `jsonOr`, for a value that is about to be validated by a parser of its own. */
const safeJson = (s: string | null | undefined): unknown => jsonOr<unknown>(s, null);

/**
 * The `photo` marker for an employee row, or `undefined` when they have none.
 *
 * The `v=` is the photo's own version (see schema `photo_at`): the client's face cache KEYS on it, so a
 * replaced picture misses in every browser instead of only in the one that uploaded it. One function because
 * every surface that hands the SPA a face has to agree on it - a marker built without the version keys on the
 * bare employee id, and nothing outside the uploading tab ever invalidates that key.
 */
export function photoMarker(r: { uuid: string; photoKey?: string | null; photoAt?: Date | number | null }): string | undefined {
  return r.photoKey ? `employees/${r.uuid}:getPhoto?v=${r.photoAt ? +new Date(r.photoAt) : 0}` : undefined;
}

export function toEmployeeResource(r: any): Wire<"employee"> {
  return {
    ...baseResource(r, "employees"),
    first_name: r.firstName,
    last_name: r.lastName,
    legal_name: r.legalName ?? undefined,
    employee_number: r.employeeNumber ?? undefined,
    work_email: r.workEmail,
    job_title: r.jobTitle ?? undefined,
    // Mirrored from the current `positions` row (db/schema.ts): how and where they work today.
    employment_type: r.employmentType ?? undefined,
    work_mode: r.workMode ?? undefined,
    location: r.location ?? undefined,
    bio: r.bio ?? undefined,
    department: ref("departments", r.departmentId),
    manager: ref("employees", r.managerId),
    start_date: r.startDate ? iso(r.startDate).slice(0, 10) : undefined,
    probation_end_date: r.probationEndDate ? iso(r.probationEndDate).slice(0, 10) : undefined,
    epf_enrolled: !!r.epfEnrolled,
    eps_excluded: !!r.epsExcluded,
    photo: photoMarker(r),
    signature: r.signatureKey ? `employees/${r.uuid}:getSignature` : undefined,
    // national_id / bank_details intentionally omitted (write-only, encrypted at rest).
  };
}

export function toDepartmentResource(r: any): Wire<"department"> {
  let managerIds: string[] = [];
  try {
    const a = JSON.parse(r.managerIds ?? "[]");
    if (Array.isArray(a)) managerIds = a.filter((x: unknown): x is string => typeof x === "string");
  } catch {
    /* malformed -> none */
  }
  return {
    ...baseResource(r, "departments"),
    display_name: r.name,
    parent: ref("departments", r.parentId),
    managers: managerIds.map((id) => `employees/${id}`),
  };
}

export function toHolidayResource(r: any): Wire<"holiday"> {
  return {
    ...baseResource(r, "holidays"),
    display_name: r.name,
    date: iso(r.date).slice(0, 10),
    kind: r.kind,
    ...(r.location ? { location: r.location } : {}),
    ...(r.halfDay ? { half_day: true } : {}),
    ...(r.applies !== undefined ? { applies: !!r.applies } : {}),
    ...(r.selected !== undefined ? { selected: !!r.selected } : {}),
    ...(r.selectionId ? { selection: `holiday-selections/${r.selectionId}` } : {}),
  };
}

export function toComplianceEventResource(r: any): Wire<"compliance-event"> {
  // DUE TODAY IS NOT OVERDUE. `due_date` is a date-only column anchored at UTC midnight (the service's own
  // `parseDate` appends `T00:00:00Z`), so comparing it against the current INSTANT made a filing overdue from
  // the first millisecond of the day it is due - a statutory deadline shown in red, with a penalty implied,
  // on the morning somebody still has all day to meet it. The app contradicted itself about it in one dialog:
  // web/src/pages/Compliance.tsx computes its own hint from calendar days and says "Due today" beside the
  // badge this flag was painting "Overdue". Both sides of the comparison are now the same kind of thing - the
  // start of a day against the start of a day - so the flag turns over when the due day ENDS.
  //
  // AND THE DAY IS THE ORG'S, not UTC's. The two sides being the same KIND of thing is only half of it - they
  // also have to be the same day. Derived from `new Date()` here, "today" rolled over at UTC midnight, which
  // is the previous evening west of UTC and the small hours of the following morning east of it: for those
  // hours a filing due today was already painted overdue, or one that was overdue yesterday still read as
  // pending. `_todayMs` is the org's calendar day, stamped on the row by the route's `decorate` (the one hook
  // on this path that has `Deps` to read the timezone with) - see services/orgDay.ts#stampOrgToday.
  const startOfToday = todayMsOf(r);
  const overdue = r.status === "pending" && r.dueDate ? +new Date(r.dueDate) < startOfToday : false;
  return {
    ...baseResource(r, "compliance-events"),
    title: r.title,
    category: r.category ?? undefined,
    frequency: r.frequency,
    due_date: iso(r.dueDate).slice(0, 10),
    period_label: r.periodLabel ?? undefined,
    status: r.status,
    overdue: overdue || undefined,
    filed_date: r.filedDate ? iso(r.filedDate).slice(0, 10) : undefined,
    reference: r.reference ?? undefined,
    document: ref("org-documents", r.documentId),
    assignee: ref("employees", r.assigneeId),
    notes: r.notes ?? undefined,
    rule: ref("compliance-rules", r.ruleId),
  };
}

export function toBackgroundCheckResource(r: any): Wire<"background-check"> {
  return {
    ...baseResource(r, "background-checks"),
    employee: ref("employees", r.employeeId),
    transition: ref("transitions", r.transitionId),
    check_type: r.checkType,
    status: r.status,
    vendor: r.vendor ?? undefined,
    reference_no: r.referenceNo ?? undefined,
    initiated_date: r.initiatedDate ? iso(r.initiatedDate).slice(0, 10) : undefined,
    completed_date: r.completedDate ? iso(r.completedDate).slice(0, 10) : undefined,
    notes: r.notes ?? undefined,
    document: ref("personal-documents", r.documentId),
  };
}

export function toComplianceRuleResource(r: any): Wire<"compliance-rule"> {
  return {
    ...baseResource(r, "compliance-rules"),
    title: r.title,
    category: r.category ?? undefined,
    frequency: r.frequency,
    due_day: r.dueDay,
    anchor_month: r.anchorMonth ?? undefined,
    assignee: ref("employees", r.assigneeId),
    notes: r.notes ?? undefined,
    active: r.active,
  };
}

export function toEventResource(r: any): Wire<"event"> {
  return {
    ...baseResource(r, "events"),
    title: r.title,
    // Full instants; for an all-day event the time-of-day is not meaningful (only the date matters).
    start_time: iso(r.startTime),
    end_time: iso(r.endTime),
    all_day: !!r.allDay,
    count_as_work: !!r.countAsWork,
    requires_clock_in: !!r.requiresClockIn,
    color: r.color ?? undefined,
    description: r.description ?? undefined,
    // attendeeIds is stored as a JSON array of employee uuids; emit as employee refs (tokenized on the wire).
    attendees: ((): string[] => {
      return jsonOr<string[]>(r.attendeeIds, []).map((id) => `employees/${id}`);
    })(),
    repeat: r.repeat ?? undefined,
    // Who is actually coming (attached by decorate). The tally is what an organiser needs; the individual
    // answers say who to chase.
    responses: (r._responses ?? []).map((x: any) => ({
      employee: ref("employees", x.employeeId),
      response: x.response,
      note: x.note ?? undefined,
      update_time: iso(x.updatedAt ?? x.createdAt),
    })),
    going_count: (r._responses ?? []).filter((x: any) => x.response === "going").length,
    maybe_count: (r._responses ?? []).filter((x: any) => x.response === "maybe").length,
    declined_count: (r._responses ?? []).filter((x: any) => x.response === "declined").length,
    my_response: r._myResponse?.response ?? undefined,
  };
}

export function toHolidaySelectionResource(r: any): Wire<"holiday-selection"> {
  return {
    path: `holiday-selections/${r.uuid}`,
    create_time: iso(r.createdAt),
    etag: etagOf(+new Date(r.createdAt)),
    holiday: ref("holidays", r.holidayId),
    employee: ref("employees", r.employeeId),
  };
}

export function toSettingResource(r: any): Wire<"setting"> {
  return {
    path: `settings/${r.key}`,
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    key: r.key,
    value: jsonOr<Wire<"setting">["value"]>(r.value, {}),
  };
}

export function toRoleResource(r: any): Wire<"role"> {
  return {
    path: `roles/${r.name}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    name: r.name,
    label: r.label,
    protected: !!r.protected,
  };
}

// One access rule (an access_rules row, role OR user). Reverses the row to the structured shape: subject as
// `users/<uuid>` (or the role name), collection = namespace, scope = scopeKind, plus the rule's level OR verb
// and effect. `field` and `verb` are read back from the verbatim pattern (tokens after the id position); for
// an exact rule, `scope_ref` is rebuilt as `<collection>/<objectUuid>` (resolved by the caller). The outbound
// edge encodes the `users/<uuid>` and `<col>/<uuid>` refs to wire tokens.
// The authoring shape, read back out of a stored pattern. ONE parser, because the wire resource is no longer
// the only reader: the audit trail describes rules from the same tokens, and a second copy of this arithmetic
// is a second chance for the two to disagree about what a pattern means.
export function parseRulePattern(pattern: string, level: string | null | undefined): { verb?: string; field?: string; createGate: boolean } {
  const toks = String(pattern).split(".");
  const tail = toks[toks.length - 1];
  return {
    // A custom-method rule (allow OR deny) has no level and a non-`**` tail (the verb). Deny rules carry the verb
    // too, so a verb-deny round-trips as a custom-method rule (not misread as an object-level deny).
    verb: (level === null || level === undefined) && tail !== "**" ? tail : undefined,
    // <col>.<id>.<field...>.** - the field is everything between the id token and the `**` tail, so a sub-resource
    // field path (identity.uan) round-trips whole (not just its last token).
    field: toks.length >= 4 && tail === "**" ? toks.slice(2, -1).join(".") : undefined,
    // The CREATE gate is the bare 1-token collection pattern (`<collection>`). It is stored with scope_kind "all"
    // (a broad rule on the narrowing lane, like every non-exact rule), so scope_kind alone cannot tell it apart
    // from `<collection>.**` (write on every object) - it has to be read back from the pattern. Without this, a
    // create-gate rule round-trips as scope "all": the ACL modal's create dropdown never matches its own rule
    // (stuck on "cannot create") and the rule shows up under the all-objects target instead.
    createGate: toks.length === 1 && tail !== "**",
  };
}

export function toAccessRuleResource(r: any, objectUuid: string | null): Wire<"access-rule"> {
  const { verb, field, createGate } = parseRulePattern(r.pattern, r.level);
  // The anchor's OWN collection, which for a subtree rule need not be the rule's: a named-department grant on
  // leave requests is anchored to a `departments` object (services/accessRules.ts resolveAnchor). Falls back
  // to the namespace, which is right for every `exact` rule - those pin to an object of their own collection.
  const anchorCollection: string = r._objectCollection ?? r.namespace;
  return {
    path: `access-rules/${r.uuid}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    subject_kind: r.subjectKind,
    subject: r.subjectKind === "user" ? `users/${r.subject}` : r.subject,
    collection: r.namespace,
    scope: createGate ? "create" : r.scopeKind, // create | all | self | dept | subtree | exact
    ...((r.scopeKind === "exact" || r.scopeKind === "subtree") && objectUuid ? { scope_ref: `${anchorCollection}/${objectUuid}` } : {}),
    ...(field ? { field } : {}),
    ...(r.level ? { level: r.level } : {}),
    ...(verb ? { verb } : {}),
    // The approval LIMIT, parsed rather than echoed: a row written before the column existed, or one hand-edited
    // to something unusable, must read as "no limit" on the wire exactly as it decides (domain/ruleCondition.ts
    // fails closed on it at decision time, but the UI showing a limit the engine ignores would be worse than
    // showing none).
    ...(parseCondition(r.condition) ? { condition: parseCondition(r.condition)! } : {}),
    ...(r.fromIp ? { from_ip: r.fromIp as string } : {}),
    ...(parseWindow(r.window) ? { window: parseWindow(r.window)! } : {}),
    effect: r.effect,
    // Lifecycle: `active` decides; `pending` / `pending_delete` are four-eyes changes awaiting a second
    // admin, and `requested_by` names who asked (they may not approve it themselves).
    status: r.status ?? "active",
    ...(r.requestedBy ? { requested_by: `users/${r.requestedBy}` } : {}),
    ...(r.expiresAt ? { expire_time: iso(r.expiresAt) } : {}),
  };
}

export function toPolicyResource(r: any): Wire<"policy"> {
  return {
    path: `policy/${r.key}`,
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    key: r.key,
    value: jsonOr<Wire<"policy">["value"]>(r.valueJson, {}),
  };
}

// A board item's grouped emoji reactions, as the route attached them (`_reactions`). The reactor ids become
// employee refs on the wire, like every other id the client resolves to a name.
function reactionGroups(groups: unknown) {
  return ((groups as { emoji: string; count: number; reacted: boolean; reactors?: string[] }[] | undefined) ?? []).map((g) => ({
    emoji: g.emoji,
    count: g.count,
    reacted: g.reacted,
    reactors: (g.reactors ?? []).map((id) => `employees/${id}`),
  }));
}

export function toAnnouncementResource(r: any): Wire<"announcement"> {
  return {
    ...baseResource(r, "announcements"),
    kind: r.kind ?? "announcement",
    title: r.title,
    // `body` is markdown-lite source (the card renders it); `body_text` is the same words with the markup
    // stripped, for anywhere that wants prose - a search snippet, a dashboard teaser, an export.
    body: r.body,
    body_text: r.bodyText ?? r.body,
    title_align: r.titleAlign ?? undefined,
    body_valign: r.bodyValign ?? undefined,
    author: ref("employees", r.authorEmployeeId),
    // Who gets NOTIFIED - everyone, one department, or nobody - and whether it also went out as email. Reach,
    // not access: the board carries the post on all three, and the card shows the label so the other
    // departments know it is not about them.
    audience_scope: r.audienceScope ?? "everyone",
    audience_department: ref("departments", r.audienceDepartmentId),
    email_audience: !!r.emailAudience,
    email_time: r.emailedAt ? iso(r.emailedAt) : undefined,
    publish_time: r.publishTime ? iso(r.publishTime) : undefined,
    // When the post was pinned to the top of the board (:pin verb); absent = not pinned. The feed shows
    // pinned posts first, most recently pinned leading.
    pin_time: r.pinnedAt ? iso(r.pinnedAt) : undefined,
    // Whether the calling viewer has a read receipt for this post (drives the dashboard "unread" widget).
    // Attached by the route from the caller's read rows; absent = treat as unread. The author/HR-only
    // "Read by" list (read_by / read_count) is attached by the route, gated on the access affordance.
    read: !!r._read,
    // Grouped reactions [{ emoji, count, reacted, reactors }], attached by the route. `reacted` = the
    // calling viewer; `reactors` names who is behind the count (capped - see MAX_REACTORS).
    reactions: reactionGroups(r._reactions),
    // The reply thread (oldest-first) + its count, attached by the route.
    replies: (r._replies as any[] | undefined)?.map(toAnnouncementReplyResource) ?? [],
    reply_count: (r._replies as any[] | undefined)?.length ?? 0,
    // Poll block (kind="poll" only): options + anonymous tallies (attached by the route as `_poll`), plus the
    // config from the row. `closed` = locked or past the deadline; `voted` = the caller has cast a vote.
    poll: r.kind === "poll"
      ? {
          multiple: !!r.pollMultiple,
          closes_time: r.pollClosesAt ? iso(r.pollClosesAt) : undefined,
          closed: !!r.locked || (!!r.pollClosesAt && Date.now() > +new Date(r.pollClosesAt)),
          total_votes: r._poll?.totalVotes ?? 0,
          voted: !!r._poll?.voted,
          options: (r._poll?.options as { id: string; label: string; votes: number; voted: boolean }[] | undefined) ?? [],
        }
      : undefined,
    // Kudos (kind="kudos"): the recognized employee + recognition meta. The giver is `author` (above); the
    // message is `body`. `points` is the server-snapshotted weight of the level (drives the leaderboard).
    recipient: r.kind === "kudos" ? ref("employees", r.recipientEmployeeId) : undefined,
    recipient_department: r.kind === "kudos" ? ref("departments", r.recipientDepartmentId) : undefined,
    value: r.kind === "kudos" ? (r.value ?? undefined) : undefined,
    category: r.kind === "kudos" ? (r.category ?? undefined) : undefined,
    level: r.kind === "kudos" ? (r.level ?? undefined) : undefined,
    points: r.kind === "kudos" ? (r.points ?? 0) : undefined,
    // Card art - every kind carries it, not only kudos - and where the author placed it (absent = inline default).
    illustration: r.illustration ?? undefined,
    illustration_layout: parseIllustrationLayout(r.illustrationLayout),
    recipient_layout: r.kind === "kudos" ? parseRecipientLayout(r.recipientLayout) : undefined,
  };
}

// A board post's reply. Not a directly-addressable resource (no `path`); emitted only inline on the post. `id`
// is the reply's raw pk (a sub-resource handle, like ticket todos - NOT wire-id encoded), used to target the
// reply with the `react` verb. `author` is an employees ref (tokenized on the wire); `author_email` is the
// fallback for an actor with no employee record. `reactions` are grouped like a post's, attached by the route.
export function toAnnouncementReplyResource(r: any) {
  return {
    id: r.uuid,
    author: ref("employees", r.authorId),
    author_email: r.authorEmail ?? undefined,
    body: r.body,
    create_time: iso(r.createdAt),
    reactions: reactionGroups(r._reactions),
  };
}

export function toLeaveTypeResource(r: any): Wire<"leave-type"> {
  return {
    ...baseResource(r, "leave-types"),
    display_name: r.name,
    accrual_days_per_year: r.accrualDaysPerYear ?? undefined,
    accrual_frequency: r.accrualFrequency ?? "monthly",
    paid: r.paid,
    color: r.color ?? undefined,
    available_during_probation: r.availableDuringProbation,
    probation_accrual_days_per_year: r.probationAccrualDaysPerYear ?? 0,
    probation_cap_days: r.probationCapDays ?? undefined,
    encashable: r.encashable,
    encashment_cap_days_per_year: r.encashmentCapDaysPerYear ?? undefined,
    min_balance_retained_days: r.minBalanceRetainedDays ?? 0,
    carry_forward: r.carryForward,
    carry_forward_cap_days: r.carryForwardCapDays ?? undefined,
    // The blob AS STORED, not a parsed one: a leaf this type never set has to come back absent, because the
    // editor reads "absent" as "inherits the org baseline" and an explicit null as "exempt from it"
    // (domain/leaveRestrictions.ts mergeRestrictions). Filling the gaps here would turn every type into an
    // exemption from every org rule the first time it was saved back.
    restrictions: r.restrictions ?? undefined,
  };
}

// Pace + silence for one goal row, as the wire states them. Split out so the shape stays readable and so the
// "absent, not zero" rule is in one place: a goal with no pace to report emits no pace fields at all, rather
// than a drift of 0 that reads as healthy.
function goalHealth(r: any) {
  const pace = goalPace(r);
  const stale = staleDays(r, r._lastCommentAt);
  return {
    ...(pace ? { expected_progress: pace.expected, drift: pace.drift, pace: pace.state } : {}),
    ...(stale != null ? { stale_days: stale } : {}),
  };
}

export function toGoalResource(r: any): Wire<"goal"> {
  return {
    ...baseResource(r, "goals"),
    employee: ref("employees", r.employeeId),
    parent: ref("goals", r.parentId),
    cycle: ref("review-cycles", r.cycleId),
    // Objective or key result. `rolled_up` says the progress on this row came from its key results, so a
    // client shows their numbers instead of offering a slider the next roll-up would overwrite.
    kind: r.kind ?? "objective",
    rolled_up: !!r._rolledUp,
    title: r.title,
    description: r.description ?? undefined,
    weight: r.weight ?? 0,
    progress: r.progress ?? 0,
    status: r.status,
    // The agreement ladder, and who signed it off. `AGREED` on every goal in an org that has not turned the
    // handshake on - setting a goal is agreeing it there.
    stage: r.stage ?? "AGREED",
    agreed_time: r.agreedAt ? iso(r.agreedAt) : undefined,
    agreed_by: ref("employees", r.agreedById),
    due_date: r.dueDate ? iso(r.dueDate).slice(0, 10) : undefined,
    // The owner's own call, and the sentence behind it.
    confidence: r.confidence ?? undefined,
    confidence_note: r.confidenceNote ?? undefined,
    // What it is waiting on (usually another team's goal), the department that owns it when a team does
    // rather than a person, and the closing note written when it ends.
    blocked_by: ref("goals", r.blockedById),
    department: ref("departments", r.departmentId),
    retro: r.retro ?? undefined,
    // Health, derived here so there is one implementation of it: where the goal should be by now, how far off
    // that is, and how long since anyone touched it. Absent where the question has no honest answer - see
    // domain/goals.ts. `_lastCommentAt` is attached by the route (one grouped query per page).
    ...goalHealth(r),
    // The measure, when the goal has one. `measured` says which side owns `progress`, so a client can show
    // "42 of 60 customers" and disable the slider rather than offering a number the next write would overwrite.
    unit: r.unit ?? undefined,
    baseline_value: r.baselineValue ?? undefined,
    target_value: r.targetValue ?? undefined,
    current_value: r.currentValue ?? undefined,
    measured: r.targetValue != null && r.currentValue != null,
    // Approved hours booked against this goal, through the projects pointed at it. Absent when nothing is
    // linked - a goal with no project attached has no effort story to tell, which is not the same as zero.
    logged_hours: r._hours,
    // Linked board tasks, rolled up by the route's decorate (one grouped query per page). Always present, so a
    // client renders the delivery chip from the goal itself instead of reading and grouping every card.
    linked_tasks: r._tasks?.tasks ?? 0,
    delivered_tasks: r._tasks?.delivered ?? 0,
    task_points: r._tasks?.points ?? 0,
    delivered_task_points: r._tasks?.deliveredPoints ?? 0,
    // Who else worked on this, and what share of it is credited to them - attached by the route. Their share
    // scores in THEIR review, at this goal's weight scaled by it; the goal itself is unchanged.
    contributors: ((r._contributors ?? []) as { employeeId: string; share: number; note: string | null }[])
      .map((c) => ({ employee: `employees/${c.employeeId}`, share: c.share, note: c.note ?? undefined })),
    // The split the linked tasks already imply: who delivered the work, and what share of the DELIVERED work
    // was theirs. A suggestion for the contributor editor, never a credit - only `contributors` scores.
    suggested_contributors: ((r._suggestedContributors ?? []) as { employeeId: string; share: number; deliveredPoints: number; deliveredTasks: number }[])
      .map((c) => ({ employee: `employees/${c.employeeId}`, share: c.share, delivered_points: c.deliveredPoints, delivered_tasks: c.deliveredTasks })),
    // Who is following this goal, and whether the caller is one of them - the state of the watch button,
    // answered here rather than by a client matching ids against its own identity.
    watcher_count: Array.isArray(r._watchers) ? (r._watchers as string[]).length : 0,
    watching: Array.isArray(r._watchers) && !!r._viewerEmployeeId && (r._watchers as string[]).includes(r._viewerEmployeeId),
    comments: (r._comments ?? []).map(toGoalCommentResource), // attached by the item Get
    // How progress actually moved, rebuilt from the audit trail by the item Get (never on a list). Two points
    // for a goal set and moved once; the shape of the quarter for a goal that was worked.
    history: ((r._history ?? []) as { at: Date | number; progress: number }[]).map((p) => ({ at_time: iso(p.at), progress: p.progress })),
  };
}

// A comment on a goal (sub-resource, no path of its own), same shape as a card's.
export function toGoalCommentResource(r: any) {
  return {
    author: ref("employees", r.authorId),
    author_email: r.authorEmail ?? undefined,
    body: r.body,
    create_time: iso(r.createdAt),
  };
}

export function toBoardResource(r: any): Wire<"board"> {
  // Each of the three columns it reads has its own element shape in the wire contract, so the element type is
  // the caller's to state - as it was before, when this was a bare `JSON.parse` with no annotation.
  const parse = (s: string | null | undefined): any => jsonOr<any>(s, []);
  return {
    ...baseResource(r, "boards"),
    name: r.name,
    description: r.description ?? undefined,
    task_prefix: r.taskPrefix ?? "",
    mode: r.mode ?? "kanban",
    columns: parse(r.columnsJson),
    swimlane_mode: r.swimlaneMode,
    swimlanes: parse(r.swimlanesJson),
    labels: parse(r.labelsJson),
    hide_empty_lanes: !!r.hideEmptyLanes,
    reassign_lane_on_move: !!r.reassignLaneOnMove,
    no_lane_label: r.noLaneLabel ?? undefined,
    card_count: r._cardCount, // attached by the route on list/get
  };
}

export function toCardResource(r: any): Wire<"card"> {
  return {
    ...baseResource(r, "cards"),
    board: ref("boards", r.boardId),
    key: r.seq != null ? (r.keyPrefix ? `${r.keyPrefix}-${r.seq}` : `#${r.seq}`) : undefined,
    sprint: ref("sprints", r.sprintId),
    employee: ref("employees", r.employeeId),
    department: ref("departments", r.departmentId), // the card's department (defaults to the org default at create)
    assignee: ref("employees", r.assigneeId),
    // Who filed it. Distinct from both of the above: the owner is accountable, the assignee is working on it,
    // and this is who to go back to about it. Stamped at create, never editable.
    reporter: ref("employees", r.reporterId),
    column_key: r.columnKey,
    swimlane_key: r.swimlaneKey ?? undefined,
    rank: r.rank ?? 0,
    title: r.title,
    description: r.description ?? undefined,
    priority: r.priority,
    labels: jsonOr<string[]>(r.labelsJson, []),
    documents: jsonOr<string[]>(r.documentsJson, []).map((id) => ref("org-documents", id)).filter((x): x is string => !!x),
    size: r.size ?? undefined,
    due_date: r.dueDate ? iso(r.dueDate).slice(0, 10) : undefined,
    blocked: !!r.blocked,
    block_reason: r.blockReason ?? undefined,
    blocked_by: ref("cards", r.blockedById),
    goal: ref("goals", r.goalId),
    commit_time: r.committedAt ? iso(r.committedAt) : undefined,
    start_time: r.startedAt ? iso(r.startedAt) : undefined,
    deliver_time: r.deliveredAt ? iso(r.deliveredAt) : undefined,
    // Repeating work: the cadence the next one is filed on when this card is delivered.
    cadence: r.cadence ?? undefined,
    comments: (r._comments ?? []).map(toCardCommentResource), // attached by the route on Get
    // Checklist: full items on the item Get (_todos); compact progress on the list (todoDone/todoTotal).
    ...(r._todos ? { todos: r._todos.map(toCardTodoResource) } : {}),
    todo_done: Array.isArray(r._todos) ? r._todos.filter((x: any) => x.done).length : (r.todoDone ?? 0),
    todo_total: Array.isArray(r._todos) ? r._todos.length : (r.todoTotal ?? 0),
    // Who is following this card, and whether the caller is one of them - on the item Get only, where the
    // watch button lives. `watching` is answered here rather than by a client matching a list of ids against
    // its own identity, and the whole group is ABSENT on a list rather than defaulting to 0/false, which
    // would read as "nobody is watching" when the truth is "this answer did not carry it".
    ...(Array.isArray(r._watchers)
      ? {
        watchers: (r._watchers as string[]).map((id) => `employees/${id}`),
        watcher_count: (r._watchers as string[]).length,
        watching: !!r._viewerEmployeeId && (r._watchers as string[]).includes(r._viewerEmployeeId),
      }
      : {}),
    // Approved hours booked against this task through its project's timesheets. Absent when none are, which
    // is not the same as zero - see the goal resource's `logged_hours`, which works the same way.
    logged_hours: r._hours,
  };
}

// A card's checklist item (subtask; sub-resource, no path). `id` is the handle for :toggleTodo/:removeTodo.
export function toCardTodoResource(r: any) {
  return { id: r.uuid, text: r.text, done: !!r.done, create_time: iso(r.createdAt) };
}

// A card's threaded comment (sub-resource; no path). `author` is an employees ref (tokenized on the wire).
export function toCardCommentResource(r: any) {
  return {
    author: ref("employees", r.authorId),
    author_email: r.authorEmail ?? undefined,
    body: r.body,
    create_time: iso(r.createdAt),
  };
}

// One audit-trail entry, for the on-demand activity feed. `actor` is the actor's employee ref (tokenized on
// the wire; the client resolves name/avatar from its cached employees) with the email as a fallback. Lean by
// design — the caller already knows which resource they asked about.
export function toActivityResource(r: any) {
  const meta = jsonOr<unknown>(r.meta, undefined);
  return {
    path: `activity/${r.uuid}`,
    action: r.action,
    entity: r.entity ?? undefined,
    // The touched record, as a wire ref so the org-wide feed can link out (encodeWireIds tokenizes it
    // outbound). Only for resolvable resource entities — a non-resource entity (e.g. settings, a denied
    // activity read) has no drillable trail, so omit its ref rather than offer a link that can't resolve.
    // Rows with no entityId (a collection-level create) are omitted too.
    entity_ref: r.entity && r.entityId && RESOLVABLE_ENTITIES.has(r.entity) ? ref(r.entity, r.entityId) : undefined,
    entity_name: r.entityName ?? undefined, // resolved display name of the touched record (feed label)
    actor: ref("employees", r.actorId),
    actor_email: r.actorEmail,
    actor_name: r.actorName ?? undefined, // resolved actor employee name (falls back to email on the client)
    actor_role: r.actorRole ?? undefined, // the authority the act was performed under, AS OF the event
    // The act this entry was part of. Opaque on purpose - it is an equality key for "show me the rest of this
    // act" (`GET /v1/activity?correlation=...`), never something to display.
    correlation_id: r.correlationId ?? undefined,
    // The sitting. Like correlation_id: an equality key for "the rest of this login", never a label.
    session_id: r.sessionId ?? undefined,
    // Who the entry is ABOUT (the actor is who did it). A wire ref, so the outbound edge tokenizes it and the
    // client can pass it straight back as `?subject`.
    subject: ref("employees", r.subjectId),
    create_time: iso(r.at),
    ...(r.ip ? { ip: r.ip } : {}),
    ...(r.userAgent ? { user_agent: r.userAgent } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

export function toSprintResource(r: any): Wire<"sprint"> {
  return {
    ...baseResource(r, "sprints"),
    board: ref("boards", r.boardId),
    name: r.name,
    goal: r.goal ?? undefined,
    start_date: r.startDate ? iso(r.startDate).slice(0, 10) : undefined,
    end_date: r.endDate ? iso(r.endDate).slice(0, 10) : undefined,
    state: r.state,
  };
}

export function toReviewCycleResource(r: any): Wire<"review-cycle"> {
  return {
    ...baseResource(r, "review-cycles"),
    name: r.name,
    period_start: r.periodStart ? iso(r.periodStart).slice(0, 10) : undefined,
    period_end: r.periodEnd ? iso(r.periodEnd).slice(0, 10) : undefined,
    goal_setting_due_date: r.goalSettingDueDate ? iso(r.goalSettingDueDate).slice(0, 10) : undefined,
    self_due_date: r.selfDueDate ? iso(r.selfDueDate).slice(0, 10) : undefined,
    manager_due_date: r.managerDueDate ? iso(r.managerDueDate).slice(0, 10) : undefined,
    // Which framework competencies this cycle rates. Absent = all of them, so a probation review and an
    // annual review can ask different questions off one org-wide framework.
    competency_keys: parseCompetencyKeys(r.competencyKeysJson) ?? undefined,
    state: r.state,
    review_count: r._reviewCount, // attached by the route on list/get
    // How many of those reviewees have at least one goal attached to this cycle - the gap between the two is
    // the people whose review has nothing to score.
    goal_coverage: r._goalCoverage,
    // Present only on the `:variablePay` / `:award` answers: what each reviewee earned and what that is worth
    // against their target. Nothing is stored - the run is arithmetic over the reviews and the compensation
    // effective at the period end.
    variable_pay: r._variablePay,
    awarded: r._awarded,
  };
}

// A review. The manager's assessment (ratings / overall / manager comment) is withheld from the owner-employee
// until the review is SHARED; the route sets `_managerVisible` from the access affordance (an editor - manager
// or HR - always sees it). The self-assessment is always visible to the owner + editors.
export function toReviewResource(r: any): Wire<"review"> {
  const out: Wire<"review"> = {
    ...baseResource(r, "reviews"),
    cycle: ref("review-cycles", r.cycleId),
    employee: ref("employees", r.employeeId),
    // Who owes the write-up when it is not the employee's current manager. Absent means the manager chain,
    // which is what every review had before an override existed.
    reviewer: ref("employees", r.reviewerId),
    state: r.state,
    self_comment: r.selfComment ?? undefined,
    self_ratings: jsonOr<Wire<"review">["self_ratings"]>(r.selfRatingsJson, undefined),
    ack_comment: r.ackComment ?? undefined,
  };
  if (r._managerVisible) {
    out.manager_comment = r.managerComment ?? undefined;
    out.overall_rating = r.overallRating ?? undefined;
    out.ratings = jsonOr<NonNullable<Wire<"review">["ratings"]>>(r.ratingsJson, {});
    // The per-goal verdicts are the manager's assessment too, so they travel with it, not with the goals.
    if (r.goalRatingsJson) out.goal_ratings = jsonOr<NonNullable<Wire<"review">["goal_ratings"]>>(r.goalRatingsJson, {});
    // What those competency ratings add up to on the framework's own weights - derived here, from the
    // catalogue the route attached, so the page, the PDF and the calibration grid quote one number. The
    // manager's `overall_rating` is their own judgement and is never replaced by it.
    if (r._competencies) out.competency_score = competencyScore(r._competencies as Competency[], out.ratings ?? {}) ?? undefined;
  }
  // The cycle's goals, attached by the route: live before the review is shared, the frozen snapshot after.
  // `goal_attainment` is derived from exactly the list that ships, so a client never re-derives it (and can
  // never disagree with the PDF or the calibration grid about what this person delivered).
  if (r._goals !== undefined) {
    const goals = r._goals as GoalSnapshot[];
    out.goals = goals;
    out.goal_attainment = goalAttainment(goals) ?? undefined;
    out.goals_frozen = !!r.goalsJson;
  }
  // How this person's attainment has moved over their last few cycles, on the item read only. A score reads
  // differently depending on what came before it, and every review used to be read in isolation.
  if (r._trend !== undefined) out.attainment_trend = r._trend;
  // Embedded 360 feedback, attached by the route. `_feedbackNamed` = the viewer (manager/HR) may see authors;
  // for the employee the entries arrive already filtered (submitted-only) and are rendered author-less.
  if (r._feedback !== undefined) {
    out.feedback = (r._feedback as any[]).map((f) => reviewFeedbackEntry(f, !!r._feedbackNamed));
  }
  return out;
}

// A single 360 feedback entry embedded on a review. `author` is present only when the viewer may see who gave
// it.
//
// `id` IS OMITTED WHEN THE AUTHOR IS. It used to be emitted in both states as a sub-resource handle, and that
// handle de-anonymized the whole feature: the row is promoted in place through its life (SUGGESTED -> REQUESTED
// -> SUBMITTED), so its pk never changes, and the reviewee sees the same row at both ends. They see it first as
// their own SUGGESTED nomination, which names the author deliberately (there is no answer yet to protect), and
// again after sharing as an anonymous SUBMITTED entry - with the same id. Joining the two lists on it names
// every peer the employee suggested against that peer's supposedly anonymous rating and comment, which is most
// of the panel.
//
// Nothing on the anonymous view acts on the handle (the SPA uses it only as a React key), so there is nothing
// to replace it with. A named viewer - manager, HR - still gets it, because for them there is no anonymity to
// protect and the id is the sub-resource handle it was meant to be.
function reviewFeedbackEntry(f: any, named: boolean) {
  const identified = named || f.state === "SUGGESTED";
  return {
    ...(identified ? { id: f.uuid } : {}),
    state: f.state,
    comment: f.comment ?? undefined,
    overall_rating: f.overallRating ?? undefined,
    // Why a nominee said no. Only ever their own words, and only where authors are named at all - it is a
    // sentence about a working relationship, not part of the shared review.
    ...(named && f.declineReason ? { decline_reason: f.declineReason } : {}),
    // A SUGGESTED row is a name the REVIEWEE typed and nothing else - no rating, no comment, nobody asked
    // anything of yet - so its author is named even to them. Anonymity protects an ANSWER; there isn't one.
    ...(identified ? { author: ref("employees", f.authorId) } : {}),
  };
}

// The nominee's own view of a feedback request (review-feedback collection): who to give feedback on + their draft.
export function toReviewFeedbackResource(r: any): Wire<"review-feedback"> {
  return {
    ...baseResource(r, "review-feedback"),
    review: ref("reviews", r.reviewId),
    reviewee: ref("employees", r.revieweeId),
    author: ref("employees", r.authorId),
    state: r.state,
    comment: r.comment ?? undefined,
    overall_rating: r.overallRating ?? undefined,
    decline_reason: r.declineReason ?? undefined,
  };
}

export function toTransitionResource(r: any): Wire<"transition"> {
  const out: Wire<"transition"> = {
    ...baseResource(r, "transitions"),
    employee: ref("employees", r.employeeId),
    kind: r.kind,
    name: r.name,
    anchor_date: r.anchorDate ? iso(r.anchorDate).slice(0, 10) : undefined,
    state: r.state,
  };
  // Tasks embedded for the subject/manager/HR view, attached by the route. Counts ride along for list cards.
  if (r._tasks !== undefined) {
    const tasks = r._tasks as any[];
    out.tasks = tasks.map(toTransitionTaskResource);
    out.task_count = tasks.length;
    out.done_count = tasks.filter((t) => t.status === "DONE").length;
  }
  return out;
}

export function toTransitionTaskResource(r: any): Wire<"transition-task"> {
  return {
    ...baseResource(r, "transition-tasks"),
    transition: ref("transitions", r.transitionId),
    subject: ref("employees", r.subjectId),
    assignee: ref("employees", r.assigneeId),
    title: r.title,
    description: r.description ?? undefined,
    due_date: r.dueDate ? iso(r.dueDate).slice(0, 10) : undefined,
    status: r.status,
    note: r.note ?? undefined,
    background_check: ref("background-checks", r.backgroundCheckId),
    doc_type: r.docType ?? undefined,
    document: ref("personal-documents", r.documentId),
  };
}

export function toCheckInResource(r: any, user?: AppUser): Wire<"check-in"> {
  // A private note is served to the ONE person who wrote it and to nobody else - not to the other party, not to
  // an HR admin who can read the row, not to a manager reading down the chain. Redacting here rather than in the
  // query is deliberate: every read of a check-in goes through this function, so there is no path that forgets.
  const mine = user?.employeeId
    ? user.employeeId === r.employeeId ? (r.employeeNote ?? undefined)
      : user.employeeId === r.counterpartId ? (r.counterpartNote ?? undefined)
      : undefined
    : undefined;
  return {
    ...baseResource(r, "check-ins"),
    employee: ref("employees", r.employeeId),
    counterpart: ref("employees", r.counterpartId),
    // The two names, served with the row. An employee may read only their OWN employee record, so a page
    // that resolved the other attendee client-side had nothing to resolve it FROM: their own 1:1 list named
    // the person they met as "-". Decorated by the service (see checkInSpec.decorate).
    employee_name: r.employeeName ?? undefined,
    counterpart_name: r.counterpartName ?? undefined,
    meeting_date: r.meetingDate ? iso(r.meetingDate).slice(0, 10) : undefined,
    notes: r.notes ?? undefined,
    action_items: jsonOr<Wire<"check-in">["action_items"]>(r.actionItemsJson, []),
    cadence: r.cadence ?? undefined,
    private_note: mine,
    // Whether the OTHER side has kept a note. The text stays private; that one exists is not a secret, and
    // hiding even that would make "did they write anything?" a reason to go asking.
    other_has_private_note: user?.employeeId === r.employeeId ? !!r.counterpartNote : user?.employeeId === r.counterpartId ? !!r.employeeNote : false,
    pulse: r.pulse ?? undefined,
  };
}

export function toBenefitPlanResource(r: any): Wire<"benefit-plan"> {
  return {
    ...baseResource(r, "benefit-plans"),
    name: r.name,
    category: r.category,
    description: r.description ?? undefined,
    provider: r.provider ?? undefined,
    employee_cost: r.employeeCost ?? 0,
    employer_cost: r.employerCost ?? 0,
    cost_period: r.costPeriod ?? "month",
    allows_dependents: !!r.allowsDependents,
    auto_enroll: !!r.autoEnroll,
  };
}

export function toDependentResource(r: any): Wire<"dependent"> {
  return {
    ...baseResource(r, "dependents"),
    employee: ref("employees", r.employeeId),
    name: r.name,
    relationship: r.relationship,
    date_of_birth: r.dateOfBirth ? iso(r.dateOfBirth).slice(0, 10) : undefined,
  };
}

export function toBenefitEnrollmentResource(r: any): Wire<"benefit-enrollment"> {
  return {
    ...baseResource(r, "benefit-enrollments"),
    employee: ref("employees", r.employeeId),
    plan: ref("benefit-plans", r.planId),
    status: r.status,
    effective_date: r.effectiveDate ? iso(r.effectiveDate).slice(0, 10) : undefined,
    // Drop any blank id rather than emitting an undefined hole in the array.
    dependents: jsonOr<string[]>(r.dependentsJson, [])
      .map((id) => ref("dependents", id))
      .filter((p): p is string => !!p),
  };
}

export function toShiftResource(r: any): Wire<"shift"> {
  return {
    ...baseResource(r, "shifts"),
    name: r.name,
    start: r.startTime,
    end: r.endTime,
    break_minutes: r.breakMinutes ?? 0,
    color: r.color ?? undefined,
  };
}

export function toShiftAssignmentResource(r: any): Wire<"shift-assignment"> {
  return {
    ...baseResource(r, "shift-assignments"),
    employee: ref("employees", r.employeeId),
    shift: ref("shifts", r.shiftId),
    date: r.date ? iso(r.date).slice(0, 10) : undefined,
    note: r.note ?? undefined,
  };
}

export function toProjectResource(r: any): Wire<"project"> {
  return {
    ...baseResource(r, "projects"),
    name: r.name,
    client: r.client ?? undefined,
    code: r.projectCode ?? undefined,
    billable: !!r.billable,
    goal: ref("goals", r.goalId),
    status: r.status,
  };
}

export function toTimeEntryResource(r: any): Wire<"time-entry"> {
  return {
    ...baseResource(r, "time-entries"),
    employee: ref("employees", r.employeeId),
    project: ref("projects", r.projectId),
    // The task inside that project, when the work is tracked as a card. Secondary to the project on purpose:
    // the project is what a timesheet approves and what a client is billed for.
    card: ref("cards", r.cardId),
    date: r.date ? iso(r.date).slice(0, 10) : undefined,
    hours: r.hours ?? 0,
    description: r.description ?? undefined,
    billable: !!r.billable,
    status: r.status,
  };
}

export function toLoanResource(r: any): Wire<"loan"> {
  const principal = r.principal ?? 0;
  const repaid = r.repaid ?? 0;
  return {
    ...baseResource(r, "loans"),
    employee: ref("employees", r.employeeId),
    kind: r.kind,
    principal,
    installments: r.installments ?? 1,
    monthly_amount: r.monthlyAmount ?? 0,
    repaid,
    outstanding: Math.max(0, principal - repaid),
    reason: r.reason ?? undefined,
    start_date: r.startDate ? iso(r.startDate).slice(0, 10) : undefined,
    status: r.status,
  };
}

export function toTaxDeclarationResource(r: any): Wire<"tax-declaration"> {
  return {
    ...baseResource(r, "tax-declarations"),
    employee: ref("employees", r.employeeId),
    financial_year: r.financialYear,
    section: r.section,
    label: r.label ?? undefined,
    declared_amount: r.declaredAmount ?? 0,
    verified_amount: r.verifiedAmount ?? undefined,
    status: r.status,
    note: r.note ?? undefined,
    has_proof: !!r.hasProof, // set by the route when an attachment exists
  };
}

export function toLeaveRequestResource(r: any): Wire<"leave-request"> {
  return {
    ...baseResource(r, "leave-requests"),
    employee: ref("employees", r.employeeId),
    leave_type: ref("leave-types", r.leaveTypeId),
    start_date: iso(r.startDate).slice(0, 10),
    end_date: iso(r.endDate).slice(0, 10),
    days: r.days,
    start_session: r.startSession ?? 1,
    end_session: r.endSession ?? 2,
    state: r.state,
    reason: r.reason ?? undefined,
    has_document: !!r.hasDocument, // set by the route when a supporting file is attached to this request
    // Policy rules the org waives rather than enforces, recorded when this was filed. The approver sees them
    // on the decision card - a waiver nobody is shown is a rule that quietly does nothing.
    policy_warnings: r.policyWarnings ?? undefined,
  };
}

export function toCompensationResource(r: any): Wire<"compensation"> {
  // The grade's band (when attached by the service via `r.grade`) yields two derived signals: the
  // compa-ratio (base / band midpoint, 2dp) and whether base sits below / within / above the band. Bands
  // are guardrails - "below"/"above" is informational, never an error.
  const g = r.grade as { name?: string; bandMin?: number | null; bandMid?: number | null; bandMax?: number | null } | undefined;
  const compaRatio = g && g.bandMid ? round2(r.ctcAnnual / g.bandMid) : undefined;
  let bandStatus: "below" | "in_band" | "above" | undefined;
  if (g && (g.bandMin != null || g.bandMax != null)) {
    if (g.bandMin != null && r.ctcAnnual < g.bandMin) bandStatus = "below";
    else if (g.bandMax != null && r.ctcAnnual > g.bandMax) bandStatus = "above";
    else bandStatus = "in_band";
  }
  return {
    ...baseResource(r, "compensation"),
    employee: ref("employees", r.employeeId),
    annual_ctc: r.ctcAnnual, // the authoritative figure everything leads with
    // What they are playing for on top, at 100% attainment. Not part of CTC - see the schema comment.
    variable_pay_target: r.variablePayTarget ?? undefined,
    base_pay: r.basePay, // derived: the monthly basic the split resolved to (for the payslip/statutory view)
    special_allowance: r.specialAllowance || undefined, // derived: the balancing plug of the split
    currency_code: r.currency,
    pay_grade: ref("pay-grades", r.payGradeId),
    pay_grade_name: g?.name ?? undefined,
    compa_ratio: compaRatio,
    band_status: bandStatus,
    salary_structure: ref("salary-structures", r.structureId),
    salary_structure_name: (r.structure as { name?: string } | undefined)?.name ?? undefined,
    effective_from: iso(r.effectiveFrom).slice(0, 10),
    effective_to: r.effectiveTo ? iso(r.effectiveTo).slice(0, 10) : undefined,
    current: !r.effectiveTo, // the active salary
    arrears_amount: r.arrearsAmount || undefined, // retro arrears owed by this backdated revision
    arrears_paid: r.arrearsAmount ? !!r.arrearsPaidRunId : undefined, // whether a run has paid them
    // The CTC build-up, attached by the service on the current row of a single-employee read (domain
    // `ctcLines` - the same pricing the CTC letter and the payroll run use). It exists so a reader who cannot
    // see the pay-component catalog or the salary-structure behind this row - an employee reading their own
    // pay - still gets the itemised split rather than a bare CTC number.
    ctc_monthly: (r.ctc as { ctcMonthly?: number } | undefined)?.ctcMonthly,
    breakdown: (r.ctc as { lines?: { name: string; monthly: number; annual: number; aboveCtc?: boolean }[] } | undefined)?.lines?.map((l) => ({
      name: l.name,
      monthly: l.monthly,
      annual: l.annual,
      above_ctc: l.aboveCtc,
    })),
  };
}

export function toSalaryStructureResource(r: any): Wire<"salary-structure"> {
  // Stored lines hold internal component ids; render each as a `pay-components/<id>` ref (the outbound edge
  // tokenizes it). `lines` is an ordered array of { component, rate }.
  let lines: { component: string; rate: number | null }[] = [];
  try {
    const arr = JSON.parse(r.linesJson ?? "[]");
    if (Array.isArray(arr)) lines = arr.map((l: any) => ({ component: ref("pay-components", l.component)!, rate: l.rate ?? null }));
  } catch { /* leave empty on malformed json */ }
  return {
    ...baseResource(r, "salary-structures"),
    display_name: r.name,
    description: r.description ?? undefined,
    lines,
  };
}

export function toPayGradeResource(r: any): Wire<"pay-grade"> {
  return {
    ...baseResource(r, "pay-grades"),
    display_name: r.name,
    level: r.level,
    band_min: r.bandMin ?? undefined,
    band_mid: r.bandMid ?? undefined,
    band_max: r.bandMax ?? undefined,
    currency_code: r.currency,
    description: r.description ?? undefined,
  };
}

export function toSettlementResource(r: any): Wire<"settlement"> {
  return {
    ...baseResource(r, "settlements"),
    employee: ref("employees", r.employeeId),
    settlement_date: iso(r.settlementDate).slice(0, 10),
    currency_code: r.currency,
    leave_days: r.leaveDays,
    notice_shortfall_days: r.noticeShortfallDays,
    lines: jsonOr<Wire<"settlement">["lines"]>(r.linesJson, []),
    total_earnings: r.totalEarnings,
    taxable_earnings: r.taxableEarnings,
    total_deductions: r.totalDeductions,
    tds: r.tds,
    net: r.net,
  };
}

export function toBonusResource(r: any): Wire<"bonus"> {
  return {
    ...baseResource(r, "bonuses"),
    employee: ref("employees", r.employeeId),
    amount: r.amount,
    currency_code: r.currency,
    kind: r.kind ?? undefined,
    reason: r.reason ?? undefined,
    award_date: iso(r.awardDate).slice(0, 10),
    scope: r.scope ?? "individual",
    scope_ref: r.scopeRef ?? undefined, // departments/<id> for a department-wide award
    batch_id: r.batchId ?? undefined, // groups the rows of one company/department award
    paid: !!r.paidRunId, // paid out by a payroll run
    paid_run: r.paidRunId ? ref("payroll-runs", r.paidRunId) : undefined,
  };
}

// The tag secret is the one field here that is NOT for everybody: it is what a scan proves possession with,
// so serving it to the asset's holder would let them confirm custody from their sofa. It rides out only for a
// caller who may print this asset's tag - which is exactly who needs it, since the printer renders it into
// the QR. `can` is the access hint the route computed for this caller on this row.
export function toAssetResource(r: any, _user?: AppUser, can?: string[]): Wire<"asset"> {
  return {
    ...baseResource(r, "assets"),
    asset_tag: r.assetTag ?? undefined,
    name: r.name,
    category: r.categoryId ? ref("asset-categories", r.categoryId) : undefined,
    serial_number: r.serialNumber ?? undefined,
    status: r.status,
    assigned_to: r.assignedTo ? ref("employees", r.assignedTo) : undefined,
    assigned_on: r.assignedOn ? iso(r.assignedOn).slice(0, 10) : undefined,
    purchase_date: r.purchaseDate ? iso(r.purchaseDate).slice(0, 10) : undefined,
    tag_printed_time: r.tagPrintedAt ? iso(r.tagPrintedAt) : undefined,
    last_verified_time: r.verifiedAt ? iso(r.verifiedAt) : undefined,
    // Who saw it last, whether a scan proved it, and which count claimed the sighting. Together these let the
    // inventory answer "seen by whom, how well proved, in which walk-through" without reading the audit log
    // per row - and they are what lets a stocktake resume after a refresh (domain/stocktake.ts).
    last_verified_by: r.verifiedBy ? ref("employees", r.verifiedBy) : undefined,
    last_verified_scanned: r.verifiedScanned == null ? undefined : !!r.verifiedScanned,
    last_stocktake: r.lastStocktakeId ? ref("stocktakes", r.lastStocktakeId) : undefined,
    acknowledged_time: r.acknowledgedAt ? iso(r.acknowledgedAt) : undefined,
    pending_since_time: r.custodySince ? iso(r.custodySince) : undefined,
    condition: r.custodyState ?? undefined,
    ...(can?.includes("printTag") && r.tagSecret ? { tag_secret: r.tagSecret } : {}),
    notes: r.notes ?? undefined,
  };
}

// One walk-through of the inventory. It carries no sightings - those are stamps on the asset rows - so what
// travels here is the frame (who, from when, over what scope) plus, once closed, the frozen result. `scope`
// and `result`/`found` are parsed out of their JSON columns so the client never re-parses stored text; the
// refs inside `result` (assets/<id>, employees/<id>) are tokenized by the outbound wire edge like any other.
export function toStocktakeResource(r: any): Wire<"stocktake"> {
  const scope = parseStocktakeScope(r.scopeJson);
  return {
    ...baseResource(r, "stocktakes"),
    label: r.label,
    status: r.status,
    scope: { ...(scope.statuses ? { statuses: scope.statuses } : {}), ...(scope.categories ? { categories: scope.categories.map((c) => `asset-categories/${c}`) } : {}) },
    started_by: r.startedBy ? ref("employees", r.startedBy) : undefined,
    start_time: iso(r.startedAt),
    closed_by: r.closedBy ? ref("employees", r.closedBy) : undefined,
    closed_time: r.closedAt ? iso(r.closedAt) : undefined,
    found: parseFound(r.foundJson),
    result: jsonOr<Wire<"stocktake">["result"]>(r.resultJson, undefined),
    notes: r.notes ?? undefined,
  };
}

// `tag_code` is a category's contribution to every tag printed in it (Laptop -> LAP -> MS-LAP-014).
export function toAssetCategoryResource(r: any): Wire<"asset-category"> {
  return {
    ...baseResource(r, "asset-categories"),
    display_name: r.name,
    tag_code: r.tagCode,
    requires_serial: !!r.requiresSerial,
  };
}

// A goal blueprint. `applied_count`/`skipped_count` are present only on the `:apply` answer - what that press
// did, which is the only part of it a page can report.
export function toGoalTemplateResource(r: any): Wire<"goal-template"> {
  return {
    ...baseResource(r, "goal-templates"),
    title: r.title,
    description: r.description ?? undefined,
    weight: r.weight ?? 0,
    due_in_days: r.dueInDays ?? undefined,
    unit: r.unit ?? undefined,
    baseline_value: r.baselineValue ?? undefined,
    target_value: r.targetValue ?? undefined,
    department: ref("departments", r.departmentId),
    group_name: r.groupName ?? undefined,
    disabled: !!r.disabled,
    applied_count: r._applied,
    skipped_count: r._skipped,
  };
}

export function toPositionResource(r: any): Wire<"position"> {
  return {
    ...baseResource(r, "positions"),
    employee: ref("employees", r.employeeId),
    job_title: r.jobTitle ?? undefined,
    department: r.departmentId ? ref("departments", r.departmentId) : undefined,
    location: r.location ?? undefined,
    employment_type: r.employmentType ?? undefined,
    work_mode: r.workMode ?? undefined,
    note: r.note ?? undefined,
    effective_from: iso(r.effectiveFrom).slice(0, 10),
    effective_to: r.effectiveTo ? iso(r.effectiveTo).slice(0, 10) : undefined,
    current: !r.effectiveTo, // the active role
  };
}

export function toAttendanceSessionResource(r: any): Wire<"attendance"> {
  return {
    ...baseResource(r, "attendance"),
    employee: ref("employees", r.employeeId),
    clock_in: iso(r.clockIn),
    clock_out: r.clockOut ? iso(r.clockOut) : undefined,
    open: !r.clockOut, // currently clocked in
    source: r.source,
    note: r.note ?? undefined,
  };
}

export function toAttendanceRegularizationResource(r: any): Wire<"attendance-regularization"> {
  return {
    ...baseResource(r, "attendance-regularizations"),
    employee: ref("employees", r.employeeId),
    date: iso(r.date).slice(0, 10),
    sessions: (typeof r.sessions === "string" ? jsonOr<Wire<"attendance-regularization">["sessions"]>(r.sessions, []) : r.sessions) ?? [],
    reason: r.reason ?? undefined,
    state: r.state,
    decided_by: ref("users", r.decidedBy),
  };
}

export function toAttendanceDayMarkResource(r: any): Wire<"attendance-day-mark"> {
  return {
    ...baseResource(r, "attendance-day-marks"),
    employee: ref("employees", r.employeeId),
    date: iso(r.date).slice(0, 10),
    credit: r.credit,
    reason: r.reason ?? undefined,
  };
}

export function toOvertimeRequestResource(r: any): Wire<"overtime-request"> {
  const minutes = Math.max(0, Math.round((+new Date(r.endTime) - +new Date(r.startTime)) / 60000));
  return {
    ...baseResource(r, "overtime-requests"),
    employee: ref("employees", r.employeeId),
    date: iso(r.date).slice(0, 10),
    start_time: iso(r.startTime),
    end_time: iso(r.endTime),
    minutes, // derived duration; clients sum these per employee per month for the monthly total
    reason: r.reason ?? undefined,
    state: r.state,
    decided_by: ref("users", r.decidedBy),
    decision_note: r.decisionNote ?? undefined,
    paid: !!r.paidRunId, // whether a payroll run has paid this overtime
    paid_run: r.paidRunId ? ref("payroll-runs", r.paidRunId) : undefined,
  };
}

export function toApprovalDelegationResource(r: any): Wire<"approval-delegation"> {
  return {
    ...baseResource(r, "approval-delegations"),
    delegator: ref("employees", r.delegatorId),
    delegate: ref("employees", r.delegateId),
    from_date: iso(r.fromDate).slice(0, 10),
    to_date: iso(r.toDate).slice(0, 10),
    reason: r.reason ?? undefined,
  };
}

export function toRemoteWorkRequestResource(r: any): Wire<"remote-work-request"> {
  // Inclusive calendar days, less a half for a leading PM start (startSession=2) or trailing AM end (endSession=1).
  const cal = Math.round((+new Date(r.endDate) - +new Date(r.startDate)) / 86400000) + 1;
  const days = Math.max(0.5, cal - (r.startSession === 2 ? 0.5 : 0) - (r.endSession === 1 ? 0.5 : 0));
  return {
    ...baseResource(r, "remote-work-requests"),
    employee: ref("employees", r.employeeId),
    start_date: iso(r.startDate).slice(0, 10),
    end_date: iso(r.endDate).slice(0, 10),
    start_session: r.startSession,
    end_session: r.endSession,
    days, // half-day-aware count
    location: r.location ?? undefined,
    reason: r.reason ?? undefined,
    state: r.state,
    decided_by: ref("users", r.decidedBy),
    decision_note: r.decisionNote ?? undefined,
  };
}

// An asset request names a category, not a machine; `issued_asset` is what the person actually got, once a
// hand-over has happened.
export function toAssetRequestResource(r: any): Wire<"asset-request"> {
  return {
    ...baseResource(r, "asset-requests"),
    employee: ref("employees", r.employeeId),
    category: ref("asset-categories", r.categoryId),
    justification: r.justification ?? undefined,
    needed_by: r.neededBy ? iso(r.neededBy).slice(0, 10) : undefined,
    state: r.state,
    decided_by: ref("users", r.decidedBy),
    decision_note: r.decisionNote ?? undefined,
    issued_asset: r.issuedAssetId ? ref("assets", r.issuedAssetId) : undefined,
    issued_time: r.issuedAt ? iso(r.issuedAt) : undefined,
  };
}

export function toNoticePeriodResource(r: any): Wire<"notice-period"> {
  const lwd = +new Date(r.lastWorkingDay);
  const totalDays = Math.max(0, Math.round((lwd - +new Date(r.noticeDate)) / 86400000));
  // The ORG's today, not UTC's. `last_working_day` is a date-only column at UTC midnight, so counting down to
  // it from a UTC-derived day put `days_remaining` one out for the hours each day when the two disagree -
  // "3 days left" on a screen the person is reading on the day it says 2. Stamped by the route's `decorate`
  // (services/orgDay.ts#stampOrgToday); a serializer has no Deps of its own to read the timezone with.
  const todayMid = todayMsOf(r);
  const remaining = r.status === "serving" ? Math.max(0, Math.round((lwd - todayMid) / 86400000)) : 0;
  return {
    ...baseResource(r, "notice-periods"),
    employee: ref("employees", r.employeeId),
    type: r.type,
    notice_date: iso(r.noticeDate).slice(0, 10),
    last_working_day: iso(r.lastWorkingDay).slice(0, 10),
    total_days: totalDays, // notice length (last working day - notice date)
    days_remaining: r.status === "serving" ? remaining : undefined, // calendar days until the last working day
    status: r.status,
    reason: r.reason ?? undefined,
    notes: r.notes ?? undefined,
    transition: ref("transitions", r.transitionId),
  };
}

export function toSuggestionResource(r: any): Wire<"suggestion"> {
  return {
    ...baseResource(r, "suggestions"),
    // Hidden when anonymous (still owned by the submitter for their own view + scope).
    submitter: r.anonymous ? undefined : ref("employees", r.submitterId),
    anonymous: !!r.anonymous,
    category: r.category ?? undefined,
    title: r.title,
    body: r.body,
    status: r.status,
    response: r.response ?? undefined,
    responded_by: ref("users", r.respondedById),
    upvotes: r.upCount ?? 0,
    downvotes: r.downCount ?? 0,
    my_vote: r.myVote ?? 0, // -1 down, 0 none, +1 up
    own: !!r.own, // the caller submitted this one (can't vote on it) - true even when anonymous
    // Folded into another suggestion: kept readable so its submitter can follow where their idea went.
    merged_into: ref("suggestions", r.mergedIntoId),
  };
}

export function toLetterTemplateResource(r: any): Wire<"letter-template"> {
  return {
    ...baseResource(r, "letter-templates"),
    label: r.label,
    category: r.category ?? undefined,
    filename: r.filename ?? undefined,
    letterhead: ref("letterheads", r.letterheadId),
    inputs: r.inputs ?? undefined,
    blocks: r.blocks ?? [],
  };
}

export function toLetterheadResource(r: any): Wire<"letterhead"> {
  return {
    ...baseResource(r, "letterheads"),
    label: r.label,
    // The images this letterhead holds, by VERSION then slot: `{ screen: { mark: { content_type, size_bytes }
    // } }`. Two levels, matching how they are stored - flattening one level here is what once served
    // `{ screen: {} }`, so an uploaded image was invisible to the editor while the renderer drew it fine. The
    // bytes come from `:image?variant=&slot=`, never inline: a full sheet of stationery has no business in a
    // list response. `r2Key` is deliberately dropped - the client addresses images by slot, not by key.
    assets: Object.fromEntries(
      Object.entries(jsonOr<Record<string, Record<string, { content_type?: string; size_bytes?: number }>>>(r.assetsJson, {})).map(
        ([variant, slots]) => [
          variant,
          Object.fromEntries(Object.entries(slots).map(([slot, a]) => [slot, { content_type: a.content_type, size_bytes: a.size_bytes }])),
        ]
      )
    ),
    // The stored page design, or undefined for a letterhead that prints on the stock page.
    design: jsonOr<Record<string, unknown> | undefined>(r.designJson, undefined),
    // The print page, when this letterhead has one; absent means it prints as it renders.
    print_design: jsonOr<Record<string, unknown> | undefined>(r.printDesignJson, undefined),
  };
}

export function toNotificationResource(r: any): Wire<"notification"> {
  return {
    ...baseResource(r, "notifications"),
    recipient: ref("employees", r.recipientId),
    type: r.type,
    title: r.title,
    body: r.body ?? undefined,
    link: r.link ?? undefined,
    // The resource path this is about (e.g. "overtime-requests/<id>"). The outbound wire-id middleware encodes
    // the id segment, so it matches the row's `path` in the web; drives the per-row "New" marker.
    subject: r.subject ?? undefined,
    priority: r.priority ?? "normal",
    action: r.action ?? undefined,
    // The person who caused this (denormalized name for the avatar; ref for a profile deep-link). Absent for
    // system/broadcast events.
    actor: r.actorName ?? undefined,
    actor_id: r.actorId ? ref("employees", r.actorId) : undefined,
    snooze_until_time: r.snoozeUntil ? iso(r.snoozeUntil) : undefined,
    read_time: r.readTime ? iso(r.readTime) : undefined,
    read: !!r.readTime,
  };
}

export function toReimbursementCategoryResource(r: any): Wire<"reimbursement-category"> {
  return {
    ...baseResource(r, "reimbursement-categories"),
    display_name: r.name,
    requires_receipt: !!r.requiresReceipt,
  };
}

export function toTicketChecklistResource(r: any): Wire<"ticket-checklist"> {
  let items: string[] = [];
  try { items = Array.isArray(r.items) ? r.items : JSON.parse(r.items ?? "[]"); } catch { items = []; }
  return {
    ...baseResource(r, "ticket-checklists"),
    display_name: r.name,
    items,
  };
}

export function toReimbursementResource(r: any): Wire<"reimbursement"> {
  return {
    ...baseResource(r, "reimbursements"),
    employee: ref("employees", r.employeeId),
    category: ref("reimbursement-categories", r.categoryId),
    amount: r.amount,
    incurred_on: r.incurredOn ? iso(r.incurredOn).slice(0, 10) : undefined,
    description: r.description ?? undefined,
    state: r.state,
    has_receipt: !!r.hasReceipt, // set by the route when an attachment exists for this claim
    paid_run: ref("payroll-runs", r.paidRunId),
    paid_time: r.paidAt ? iso(r.paidAt) : undefined,
  };
}

export function toExpenseCategoryResource(r: any): Wire<"expense-category"> {
  return {
    ...baseResource(r, "expense-categories"),
    display_name: r.name,
    requires_receipt: !!r.requiresReceipt,
    gl_code: r.glCode ?? undefined,
  };
}

export function toVendorResource(r: any): Wire<"vendor"> {
  return {
    ...baseResource(r, "vendors"),
    display_name: r.name,
    contact_email: r.contactEmail ?? undefined,
    contact_phone: r.contactPhone ?? undefined,
    tax_id: r.taxId ?? undefined,
    payment_terms: r.paymentTerms ?? undefined,
    bank_details: r.bankDetails ?? undefined,
    default_category: ref("expense-categories", r.defaultCategoryId),
    notes: r.notes ?? undefined,
  };
}

export function toExpenseResource(r: any): Wire<"expense"> {
  return {
    ...baseResource(r, "expenses"),
    employee: ref("employees", r.employeeId),
    vendor: ref("vendors", r.vendorId),
    category: ref("expense-categories", r.categoryId),
    department: ref("departments", r.departmentId),
    amount: r.amount,
    tax_amount: r.taxAmount,
    incurred_on: r.incurredOn ? iso(r.incurredOn).slice(0, 10) : undefined,
    description: r.description ?? undefined,
    invoice_number: r.invoiceNumber ?? undefined,
    payment_method: r.paymentMethod ?? undefined,
    payment_ref: r.paymentRef ?? undefined,
    state: r.state,
    reimbursable: !!r.reimbursable,
    reimbursement: ref("reimbursements", r.reimbursementId),
    has_invoice: !!r.hasInvoice, // set by the route when an attachment exists
    paid_time: r.paidAt ? iso(r.paidAt) : undefined,
    decision_note: r.decisionNote ?? undefined,
    recurring: !!r.isRecurring,
    paused: !!r.paused,
    recurrence_rule: r.recurrenceRule ?? undefined,
    next_occurrence_on: r.nextOccurrenceOn ? iso(r.nextOccurrenceOn).slice(0, 10) : undefined,
    last_generated_time: r.lastGeneratedOn ? iso(r.lastGeneratedOn) : undefined,
    template: ref("expenses", r.templateId),
  };
}

export function toExpenseBudgetResource(r: any): Wire<"expense-budget"> {
  return {
    ...baseResource(r, "expense-budgets"),
    department: ref("departments", r.departmentId),
    category: ref("expense-categories", r.categoryId),
    period_type: r.periodType,
    period_key: r.periodKey,
    amount: r.amount,
    recurring: !!r.recurring,
    spent: r.spent ?? 0, // derived by the service
    pending: r.pending ?? 0, // submitted, not yet approved - not counted in utilization
    remaining: r.remaining ?? r.amount,
    utilization: r.utilization ?? 0,
    // The highest alert threshold the daily cron has already fired for this period, so the page can say the
    // notification went out (and why editing the cap re-arms it) instead of leaving it invisible.
    alert_level: r.alertLevel ?? 0,
  };
}

export function toReferralResource(r: any): Wire<"referral"> {
  return {
    ...baseResource(r, "referrals"),
    referrer: ref("employees", r.referrerId),
    candidate_name: r.candidateName,
    candidate_email: r.candidateEmail ?? undefined,
    candidate_phone: r.candidatePhone ?? undefined,
    position_title: r.positionTitle ?? undefined,
    department: ref("departments", r.departmentId),
    notes: r.notes ?? undefined,
    status: r.status,
    hired_employee: ref("employees", r.hiredEmployeeId),
    has_resume: !!r.hasResume, // set by the route when a resume attachment exists
    bonus: ref("bonuses", r.bonusId),
    bonus_status: r.bonusStatus,
    bonus_amount: r.bonusAmount ?? undefined,
    bonus_eligible_time: r.bonusEligibleDate ? iso(r.bonusEligibleDate) : undefined,
    bonus_paid_time: r.bonusPaidDate ? iso(r.bonusPaidDate) : undefined,
  };
}

// ATS - a job requisition (role to fill).
export function toRequisitionResource(r: any): Wire<"job-requisition"> {
  return {
    ...baseResource(r, "job-requisitions"),
    title: r.title,
    department: ref("departments", r.departmentId),
    hiring_manager: ref("employees", r.hiringManagerId),
    location: r.location ?? undefined,
    employment_type: r.employmentType ?? undefined,
    openings: r.openings,
    description: r.description ?? undefined,
    pay_grade: ref("pay-grades", r.payGradeId),
    status: r.status,
    applicant_count: r.applicantCount, // set by the route (List enrichment) when available
    opened_time: r.openedDate ? iso(r.openedDate) : undefined,
    closed_time: r.closedDate ? iso(r.closedDate) : undefined,
  };
}

// ATS - a candidate (talent-pool person). Resume presence via `has_resume` (set by the route).
export function toCandidateResource(r: any): Wire<"candidate"> {
  return {
    ...baseResource(r, "candidates"),
    name: r.name,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    source: r.source ?? undefined,
    source_detail: r.sourceDetail ?? undefined,
    referral: ref("referrals", r.referralId),
    tags: r.tags ?? undefined,
    notes: r.notes ?? undefined,
    has_resume: !!r.hasResume,
  };
}

// ATS - an application (candidate x requisition; the pipeline entity).
export function toApplicationResource(r: any): Wire<"application"> {
  return {
    ...baseResource(r, "applications"),
    candidate: ref("candidates", r.candidateId),
    requisition: ref("job-requisitions", r.requisitionId),
    stage: r.stage,
    status: r.status,
    rejection_reason: r.rejectionReason ?? undefined,
    source: r.source ?? undefined,
    referral: ref("referrals", r.referralId),
    hired_employee: ref("employees", r.hiredEmployeeId),
    applied_time: r.appliedDate ? iso(r.appliedDate) : undefined,
    stage_changed_time: r.stageChangedDate ? iso(r.stageChangedDate) : undefined,
  };
}

// ATS - a scheduled interview. `interviewers` is emitted as employee refs (tokenized on the wire).
export function toInterviewResource(r: any): Wire<"interview"> {
  return {
    ...baseResource(r, "interviews"),
    application: ref("applications", r.applicationId),
    title: r.title,
    mode: r.mode,
    scheduled_start_time: r.scheduledStart ? iso(r.scheduledStart) : undefined,
    scheduled_end_time: r.scheduledEnd ? iso(r.scheduledEnd) : undefined,
    interviewers: jsonOr<string[]>(r.interviewerIds, []).map((id) => `employees/${id}`),
    location: r.location ?? undefined,
    status: r.status,
  };
}

// ATS - an interview scorecard (one interviewer's evaluation).
export function toInterviewFeedbackResource(r: any): Wire<"interview-feedback"> {
  return {
    ...baseResource(r, "interview-feedback"),
    interview: ref("interviews", r.interviewId),
    author: ref("employees", r.authorId),
    ratings: jsonOr<Record<string, number>>(r.ratingsJson, {}),
    overall_rating: r.overallRating ?? undefined,
    recommendation: r.recommendation ?? undefined,
    comment: r.comment ?? undefined,
  };
}

// ATS - an offer on an application.
export function toOfferResource(r: any): Wire<"offer"> {
  return {
    ...baseResource(r, "offers"),
    application: ref("applications", r.applicationId),
    base_comp: r.baseComp ?? undefined,
    currency_code: r.currency,
    offer_time: r.offerDate ? iso(r.offerDate) : undefined,
    join_time: r.joinDate ? iso(r.joinDate) : undefined,
    expiry_time: r.expiryDate ? iso(r.expiryDate) : undefined,
    status: r.status,
    approver: ref("employees", r.approverId),
    notes: r.notes ?? undefined,
    created_employee: ref("employees", r.createdEmployeeId),
    transition: ref("transitions", r.transitionId),
  };
}

// A ticket's threaded comment. Not a directly-addressable resource (no `path`); emitted only inline on the
// ticket Get. `author` is an employees ref (tokenized on the wire); `author_email` is the admin fallback.
export function toTicketCommentResource(r: any): Wire<"ticket-comment"> {
  return {
    author: ref("employees", r.authorId),
    author_email: r.authorEmail ?? undefined,
    body: r.body,
    create_time: iso(r.createdAt),
  };
}

export function toTicketTodoResource(r: any): Wire<"ticket-todo"> {
  // `id` is the item's random pk - the handle :toggleTodo/:removeTodo address it by (sub-resource, not a wire
  // collection, so it isn't wire-id encoded - matching the pk's own random, non-sequential form).
  return {
    id: r.uuid,
    text: r.text,
    done: !!r.done,
    create_time: iso(r.createdAt),
  };
}

export function toTicketResource(r: any): Wire<"ticket"> {
  return {
    ...baseResource(r, "tickets"),
    employee: ref("employees", r.employeeId), // the requester
    category: r.category ?? undefined, // key into the ticket-categories settings blob
    department: ref("departments", r.departmentId), // the servicing department
    assignee: ref("employees", r.assigneeId),
    subject: r.subject,
    description: r.description ?? undefined,
    priority: r.priority,
    state: r.state,
    // Checklist progress on every ticket (list + get): from the loaded items when present (Get), else the
    // counts the list query attached. Lets the table show done/total without loading the full items.
    // Oldest first, the order they were made in. The console link is built client-side from the configured org
    // slug - the API stays free of a vendor URL.
    session_replays: parseRecordings(r.sessionReplaysJson).map((x) => ({
      id: x.id,
      create_time: iso(new Date(x.created_at)),
      by: x.by ? ref("employees", x.by) : undefined,
    })),
    todo_done: Array.isArray(r.todos) ? r.todos.filter((x: any) => x.done).length : (r.todoDone ?? 0),
    todo_total: Array.isArray(r.todos) ? r.todos.length : (r.todoTotal ?? 0),
    // Attachments travel as metadata only - name, type, size and the storage key the :attachment verb takes.
    // The bytes are never inlined: a list of ten tickets would otherwise carry megabytes of screenshots.
    attachments: parseAttachments(r.attachmentsJson).map((a) => ({
      key: a.key, name: a.name, content_type: a.content_type, size_bytes: a.size_bytes, create_time: a.created_at,
    })),
    // Comments and the full checklist are attached by the Get route (the list endpoint omits them to stay cheap).
    ...(r.comments ? { comments: r.comments.map(toTicketCommentResource) } : {}),
    ...(r.todos ? { todos: r.todos.map(toTicketTodoResource) } : {}),
  };
}

export function toLeaveEncashmentResource(r: any): Wire<"leave-encashment"> {
  return {
    ...baseResource(r, "leave-encashments"),
    employee: ref("employees", r.employeeId),
    leave_type: ref("leave-types", r.leaveTypeId),
    days: r.days,
    rate_per_day: r.ratePerDay,
    amount: r.amount,
    currency_code: r.currency,
    state: r.state,
    paid_run: ref("payroll-runs", r.paidRunId),
    paid_time: r.paidAt ? iso(r.paidAt) : undefined,
  };
}

export function toLeaveBalanceResource(r: any): Wire<"leave-balance"> {
  return {
    ...baseResource(r, "leave-balances"),
    employee: ref("employees", r.employeeId),
    leave_type: ref("leave-types", r.leaveTypeId),
    balance_days: round2(r.balanceDays ?? 0),
  };
}

// Shared document fields (both resources). No `visibility` - audience is grant policy, not data.
// Fields common to both document collections. Typed against the contract so the two schemas' `required`
// lists stay honest - this helper is spread into both serializers, where a bare object would hide it.
function docFields(r: any): Pick<Wire<"org-document">, "display_name" | "document_type" | "file_name" | "content_type" | "size_bytes" | "expire_time"> {
  return {
    display_name: r.title,
    document_type: r.documentType,
    file_name: r.fileName ?? undefined,
    content_type: r.contentType ?? undefined,
    size_bytes: r.sizeBytes ?? undefined,
    expire_time: r.expireTime ? iso(r.expireTime) : undefined,
  };
}

export function toOrgDocumentResource(r: any): Wire<"org-document"> {
  // `acknowledged` (per caller) needs the row decorated with the caller's signed version (`ackedVersion`).
  const requiresAck = !!r.requiresAck;
  return {
    ...baseResource(r, "org-documents"),
    ...docFields(r),
    requires_ack: requiresAck || undefined,
    ack_version: requiresAck ? r.ackVersion ?? 1 : undefined,
    acknowledged: requiresAck ? (r.ackedVersion ?? 0) >= (r.ackVersion ?? 1) : undefined,
    ack_method: requiresAck ? r.ackMethod ?? undefined : undefined,
    sign_anchor: requiresAck && r.signAnchorJson ? safeParse(r.signAnchorJson) : undefined,
    // Set only on the :acknowledge response for an Aadhaar doc: the vendor signing link to open. Not persisted
    // on the org-document row - attached ad-hoc by the acknowledge service.
    esign_uri: r.esignUri ?? undefined,
  };
}

// The stored sign-anchor blob. Parsed defensively: a malformed row must not take the whole response down,
// and the shape is the contract's own so a schema change lands here.
function safeParse(s: string): NonNullable<Wire<"org-document">["sign_anchor"]> | undefined {
  return jsonOr<NonNullable<Wire<"org-document">["sign_anchor"]> | undefined>(s, undefined);
}

export function toPersonalDocumentResource(r: any): Wire<"personal-document"> {
  return {
    ...baseResource(r, "personal-documents"),
    employee: ref("employees", r.employeeId),
    source_document: ref("org-documents", r.sourceDocId),
    requires_signature: r.requiresSignature || undefined,
    // True when this document's letterhead has a print version of its own, so the UI offers the two downloads
    // as a choice. Absent = there is one version and one download.
    print_variant: r.printVariant || undefined,
    signed_time: r.signedTime ? iso(r.signedTime) : undefined,
    signature_name: r.signatureName ?? undefined,
    esign_provider: r.esignProvider ?? undefined,
    esign_status: r.esignStatus && r.esignStatus !== "none" ? r.esignStatus : undefined,
    esign_uri: r.esignUri ?? undefined,
    financial_year: r.financialYear ?? undefined,
    official: r.official || undefined,
    ...docFields(r),
  };
}

export function toDocumentAcknowledgementResource(r: any): Wire<"document-acknowledgement"> {
  return {
    ...baseResource(r, "document-acknowledgements"),
    employee: ref("employees", r.employeeId),
    document: ref("org-documents", r.documentId),
    version: r.version,
    signature: r.signature,
    signed_document: ref("personal-documents", r.signedDocId),
    acknowledged_time: iso(r.acknowledgedTime),
  };
}

export function toPayComponentResource(r: any): Wire<"pay-component"> {
  return {
    ...baseResource(r, "pay-components"),
    display_name: r.name,
    kind: r.kind,
    method: r.method,
    rate: r.rate ?? undefined,
    cap: r.cap ?? undefined,
    regime: r.regime ?? undefined,
    recurring: r.recurring,
    in_ctc: r.inCtc,
    pf_wages: r.pfWages,
  };
}

export function toPayPeriodResource(r: any): Wire<"pay-period"> {
  return {
    ...baseResource(r, "pay-periods"),
    display_name: r.label,
    period_start: iso(r.periodStart).slice(0, 10),
    period_end: iso(r.periodEnd).slice(0, 10),
    pay_date: iso(r.payDate).slice(0, 10),
  };
}

export function toPayrollRunResource(r: any): Wire<"payroll-run"> {
  return {
    ...baseResource(r, "payroll-runs"),
    pay_period: ref("pay-periods", r.payPeriodId),
    state: r.state,
    submitted_by: ref("users", r.submittedBy),
    submitted_by_name: r.submittedByName ?? undefined,
    approved_by: ref("users", r.approvedBy),
    approved_by_name: r.approvedByName ?? undefined,
    // Set = a payout file has been handed to a bank, so the run is no longer deletable (deleteRun would
    // release the one-off payables it already paid). The UI drops the delete action on the strength of this.
    bank_file_time: r.bankFileAt ? new Date(r.bankFileAt).toISOString() : undefined,
  };
}

export function toPayslipResource(r: any): Wire<"payslip"> {
  return {
    ...baseResource(r, "payslips"),
    payroll_run: ref("payroll-runs", r.runId),
    employee: ref("employees", r.employeeId),
    gross: r.gross,
    total_deductions: r.totalDeductions,
    // The column has always been there (schema.payslips.tax) and the wire schema has always declared it; the
    // serializer was the one place it dropped out, so every `tax` on a payslip read as undefined - the TDS
    // column and the year's withholding tile on #/payslips summed zero over slips that had withheld tax.
    tax: r.tax,
    net: r.net,
  };
}

// Operation is not a DB resource shape; the jobs row maps to it here.
export function toOperationResource(job: {
  uuid: string;
  kind?: string;
  status: "queued" | "running" | "done" | "error";
  attempts?: number;
  lastError: string | null;
  resultJson: string | null;
  createdAt?: Date | number;
  updatedAt?: Date | number;
}): Wire<"operation"> {
  const done = job.status === "done" || job.status === "error";
  return {
    path: `operations/${job.uuid}`,
    done,
    ...(job.status === "error" ? { error: { title: "Operation failed", detail: job.lastError ?? "error" } } : {}),
    ...(job.status === "done" && job.resultJson ? { response: jsonOr<Record<string, unknown>>(job.resultJson, {}) } : {}),
    // AEP operations carry free-form metadata: the admin-facing detail (kind/live status/attempts/timing)
    // lives here so the LRO contract (path/done/error/response) stays clean.
    metadata: {
      ...(job.kind !== undefined ? { kind: job.kind } : {}),
      status: job.status,
      ...(job.attempts !== undefined ? { attempts: job.attempts } : {}),
      ...(job.createdAt !== undefined ? { create_time: iso(job.createdAt) } : {}),
      ...(job.updatedAt !== undefined ? { update_time: iso(job.updatedAt) } : {}),
    },
  };
}

// A recorded domain event (admin-only). The spine of the workflow engine (see services/eventBus.ts).
// Replace every value with a marker, keeping only KEY names. The observability logs embed domain payloads
// (e.g. loan amounts/balances) that a viewer without the underlying collection's read grant should not see;
// non-super viewers get event SHAPE, not values. Only super_admin (source-of-truth access) sees raw payloads.
function redactValues(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(() => "[redacted]");
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = "[redacted]";
    return out;
  }
  return "[redacted]";
}

export function toEventLogResource(r: {
  uuid: string;
  type: string;
  subject: string | null;
  actorId: string | null;
  employeeId: string | null;
  payloadJson: string | null;
  correlationId?: string | null;
  occurredAt: Date | number;
  createdAt: Date | number;
  updatedAt: Date | number;
}, redactPayload = false): Wire<"event_log_entry"> {
  const payload = jsonOr<any>(r.payloadJson, {});
  return {
    path: `event-log/${r.uuid}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    type: r.type,
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.actorId ? { actor: ref("users", r.actorId) } : {}),
    ...(r.employeeId ? { employee: ref("employees", r.employeeId) } : {}),
    ...(r.correlationId ? { correlation_id: r.correlationId } : {}),
    payload: redactPayload ? redactValues(payload) : payload,
    occurred_time: iso(r.occurredAt),
  };
}

// An automation rule (when/if/then). condition/actions are the domain/automations.ts JSON shapes.
export function toAutomationResource(r: {
  uuid: string;
  name: string;
  description: string | null;
  triggerType: string;
  conditionJson: string | null;
  actionsJson: string;
  scheduleJson?: string | null;
  lastScheduledOn?: string | null;
  disabled: boolean | null;
  locked: boolean | null;
  lockedBy: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}): Wire<"automation"> {
  return {
    ...baseResource(r, "automations"),
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    trigger_type: r.triggerType,
    // `any`, as this was before: the generated wire type for `condition`/`schedule` is non-nullable while the
    // column and this serializer both use `null` for "none". Pinning the generic here would change the emitted
    // value to satisfy the type, which is a contract change, not a parse fix - so the shape stays exactly as
    // it was and only the throw is removed.
    condition: jsonOr<any>(r.conditionJson, null),
    // `[]`, not a throw: a rule whose actions column is unreadable is a rule that does nothing, which is what
    // the row already means to the engine (it reads the same column). A 500 here would take the whole
    // Automations list down over one bad row and hide every healthy rule beside it.
    actions: jsonOr<Wire<"automation">["actions"]>(r.actionsJson, []),
    schedule: jsonOr<any>(r.scheduleJson, null),
    ...(r.lastScheduledOn ? { last_scheduled_on: r.lastScheduledOn } : {}),
    enabled: !r.disabled,
  };
}

// A recorded automation firing (observability, like cron-runs).
export function toAutomationRunResource(r: {
  uuid: string;
  automationId: string | null;
  eventId: string | null;
  eventType: string;
  status: "done" | "partial" | "error" | "skipped" | "dropped";
  resultJson: string | null;
  subject?: string | null;
  employeeId?: string | null;
  correlationId?: string | null;
  startedAt: Date | number;
  finishedAt: Date | number | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}, redactResult = false): Wire<"automation_run"> {
  // Non-super viewers get action kind + status only (the `detail` string can carry ids/paths from the run).
  const result = jsonOr<any>(r.resultJson, undefined);
  const shown = redactResult && Array.isArray(result) ? result.map((o) => ({ kind: o?.kind, status: o?.status })) : result;
  return {
    path: `automation-runs/${r.uuid}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    // Absent on a `dropped` row - the budget was exhausted before any rule was loaded, so none is to blame.
    ...(r.automationId ? { automation: ref("automations", r.automationId) } : {}),
    ...(r.eventId ? { event: ref("event-log", r.eventId) } : {}),
    event_type: r.eventType,
    status: r.status,
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.employeeId ? { employee: ref("employees", r.employeeId) } : {}),
    ...(r.correlationId ? { correlation_id: r.correlationId } : {}),
    ...(shown !== undefined ? { result: shown } : {}),
    start_time: iso(r.startedAt),
    ...(r.finishedAt ? { end_time: iso(r.finishedAt) } : {}),
  };
}

// A suspended/finished durable workflow (admin observability). Arms/results are the domain JSON shapes.
export function toWorkflowInstanceResource(r: {
  uuid: string;
  automationId: string | null;
  status: "waiting" | "done" | "expired" | "error";
  awaitedTypes: string | null;
  armsJson: string;
  originType: string | null;
  subject: string | null;
  employeeId: string | null;
  correlationId?: string | null;
  resumedAt: Date | number | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}): Wire<"workflow_instance"> {
  return {
    path: `workflow-instances/${r.uuid}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    ...(r.automationId ? { automation: ref("automations", r.automationId) } : {}),
    status: r.status,
    ...(r.awaitedTypes ? { awaited_types: r.awaitedTypes.split(",") } : {}),
    arms: jsonOr<any>(r.armsJson, []),
    ...(r.originType ? { origin_type: r.originType } : {}),
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.employeeId ? { employee: ref("employees", r.employeeId) } : {}),
    ...(r.correlationId ? { correlation_id: r.correlationId } : {}),
    ...(r.resumedAt ? { resumed_time: iso(r.resumedAt) } : {}),
  };
}

// A recorded cron tick (admin-only). started_at/finished_at use the AEP `*_time` time-field convention.
export function toCronRunResource(r: {
  uuid: string;
  cron: string;
  status: "running" | "done" | "error";
  startedAt: Date | number;
  finishedAt: Date | number | null;
  durationMs: number | null;
  error: string | null;
  summaryJson: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}): Wire<"cron_run"> {
  return {
    path: `cron-runs/${r.uuid}`,
    create_time: iso(r.createdAt),
    update_time: iso(r.updatedAt),
    etag: etagOf(+new Date(r.updatedAt)),
    cron: r.cron,
    status: r.status,
    start_time: iso(r.startedAt),
    ...(r.finishedAt ? { end_time: iso(r.finishedAt) } : {}),
    ...(r.durationMs != null ? { duration_ms: r.durationMs } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.summaryJson ? { summary: jsonOr<Wire<"cron_run">["summary"]>(r.summaryJson, {}) } : {}),
  };
}

// A saved custom grid. The DEFINITION travels on the wire (base, columns, filters, sort, params); the rows it
// produces are a separate call (`:run`), because they are re-read under each reader's own scopes.
export function toTableViewResource(r: any): Wire<"table-view"> {
  const spec = jsonOr<{ columns?: unknown[]; filters?: unknown[]; sort?: unknown[]; params?: Record<string, unknown> }>(r.specJson, {});
  return {
    ...baseResource(r, "table-views"),
    display_name: r.name,
    description: r.description ?? undefined,
    owner: ref("employees", r.ownerId),
    base: r.base,
    columns: (spec.columns ?? []) as Wire<"table-view">["columns"],
    filters: (spec.filters ?? []) as Wire<"table-view">["filters"],
    sort: (spec.sort ?? []) as Wire<"table-view">["sort"],
    params: (spec.params ?? {}) as Wire<"table-view">["params"],
  };
}
