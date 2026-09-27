import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { genId } from "../lib/idCodec";

// MONETARY INVARIANT: money and leave-day columns are stored as `real` (IEEE-754 float), not integer minor
// units. This is safe ONLY because every computed value is passed through round2 (Math.round(n*100)/100)
// before it is written or summed - see the round2 helpers in domain/payroll, domain/loans, domain/encashment,
// domain/carryForward and the SQL `round(... * 100) / 100` used for conditional balance decrements. Any new
// arithmetic over these columns MUST round2 its result before persisting or comparing, or sub-cent float
// drift accumulates across aggregates. If that discipline ever proves insufficient, migrate to integer paise.

// Internal PK / FK target: a compact 8-byte random id (13-char base32), held in the `uuid` column.
// NEVER on the wire - the wire shows idCodec.encode(collection, id) (docs/archive/plan.md). Static (never changes,
// even on re-parent), so the encrypted wire token is stable and FKs are untouched by moves.
const pk = () => text("uuid").primaryKey().$defaultFn(genId);
// Internal structured matching/scoping code (nullable until assigned on create, step 0.5). Never on the wire.
// The internal hierarchical scope key. UNIQUE per table: a full `code` embeds its owner/parent prefix, so it
// is globally unique within a table (flat codes are one namespace; owned codes are owner-prefixed). The
// constraint is the backstop for codeAlloc's read-max-then-write race — a concurrent create that would mint a
// duplicate fails safe (mapped to a retryable 409 in errorHandler) instead of silently colliding. Nullable, and
// SQLite allows multiple NULLs, so code-less rows are unaffected.
const codeCol = () => text("code").unique();
const created = () => integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());
// `updated_at` is the ETag source (http/serialize.ts etagOf), so a write that leaves it alone silently disables
// If-Match for that row: a client holding the pre-mutation ETag passes the check against a row that has already
// moved. `$onUpdateFn` makes that structural instead of per-call-site - the generic crudService always set it,
// but the inline `.set({...})` writers across the services did not (job status, itemsBuiltAt, e-sign state,
// cascade clears). It is also what the job queue's stale-reclaim clock reads: without it every `running` job
// older than the cutoff looked orphaned, because the column still held its creation time.
const updated = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// Policy store (all access-control policy is data). `roles` = the role set + lock-override rank; `grants`
// = one JSON blob per role (rides the auth read); `policy` = global manifest (protected fields, refs).
// The day-one rows come from bootstrap/authz/roles.ts.
export const roles = sqliteTable(
  "roles",
  {
    name: text("name").primaryKey(),
    label: text("label").notNull(),
    // Core roles cannot be deleted via the management API (lockout guard, P2). Data, not code: a non-core
    // role added later defaults to deletable.
    protected: integer("protected", { mode: "boolean" }).notNull().default(false),
    // The role a new account is given on hire and at first sign-in (services/roles.ts provisionedRole). At
    // most one row carries it - the partial unique index below - so "which role do new people get" always
    // has one answer, and none means new accounts are refused rather than guessed at.
    provisioned: integer("provisioned", { mode: "boolean" }).notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("roles_one_provisioned").on(t.provisioned).where(sql`${t.provisioned} = 1`)],
);

export const users = sqliteTable("users", {
  uuid: pk(),
  code: codeCol(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("employee").references((): AnySQLiteColumn => roles.name, { onDelete: "restrict" }),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid),
  // Session cut-off: any Google-mode session cookie issued BEFORE this instant is refused (middleware/auth.ts).
  // The cookie is stateless by design - verifying it costs zero reads - which left signing out with nothing to
  // revoke: deleting the browser's copy does not stop the token, so a cookie lifted off a lost laptop stayed
  // good for the rest of its 12 hours and the only server-side answers were disabling the person or rotating
  // AUTH_SESSION_KEY (which signs out the whole company).
  //
  // One nullable column closes that at ZERO cost on the hot path, because auth already reads this row on every
  // request to check `status` and resolve the role - the comparison rides a read that was happening anyway.
  // NULL means "nothing revoked", the state every user starts in.
  sessionsValidFrom: integer("sessions_valid_from", { mode: "timestamp_ms" }),
  // When this account was last seen making a request. A convenience column, not an audit record: the audit log
  // records WRITES, so an account that only ever reads - which is exactly the dormant privileged account worth
  // finding - leaves no trace there at all.
  //
  // Written at most once every `LAST_USED_THROTTLE_MS` per account (services/apiKeys.ts owns the predicate),
  // the same treatment `api_keys.last_used_at` gets and for the same reason: a write per request would put a
  // D1 write on every call in the app for a field nobody reads at that resolution. The READ is free - auth
  // already loads this row on every request to check `status`.
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("users_page_idx").on(t.createdAt, t.uuid),
  // ONE account per person. The link is patchable (`PATCH /v1/users` employee), and nothing stopped two
  // accounts pointing at the same employee - at which point "who is this person's account" has two answers
  // and every consumer picks a different one: the view-as subject lookup takes whichever row comes back
  // first, the holiday-feed token is minted for one of them, and a self-scoped grant resolves against the
  // employee code either account happens to carry. The auto-provision path could never produce it (it links
  // by work email and `users.email` is unique), so this closes the one door that was open - an admin
  // re-pointing an account by hand - rather than a live symptom.
  //
  // SQLite treats NULLs as distinct in a unique index, which is exactly right: an account with no employee
  // (a break-glass identity, a service owner) is unconstrained, and there may be many.
  employeeUniq: uniqueIndex("users_employee_idx").on(t.employeeId),
}));

/**
 * The app lock (app-lock-plan.md): one row per account that has ever set a PIN.
 *
 * ITS OWN TABLE, not columns on `users`, because every write to `users` fires `chg_u_users` - the change feed
 * stamp that every client's cached lists and every list etag key on. Unlocking, locking and a wrong PIN are
 * writes, and none of them changes anything a client has cached. Not a collection either: nothing reads it
 * but the auth middleware (joined into the read it already makes per request) and the /auth/lock routes.
 *
 * The row outlives turning the lock off (`pin_hash` goes NULL) because `key_epoch` must never go backwards:
 * reusing an old epoch would make ciphertext written under it readable again.
 */
export const appLocks = sqliteTable("app_locks", {
  userId: text("user_id").primaryKey().references(() => users.uuid, { onDelete: "cascade" }),
  // HMAC under a key outside the database (lib/appLock.ts hashPin). NULL = no PIN, the browser is never locked.
  pinHash: text("pin_hash"),
  pinLength: integer("pin_length"),
  pinSetAt: integer("pin_set_at", { mode: "timestamp_ms" }),
  // The person's own auto-lock time in minutes; 0 = only when they lock.
  idleMinutes: integer("idle_minutes").notNull().default(15),
  // CONSECUTIVE wrong PINs. Counted before each comparison (services/appLock.ts reserveAttempt) and reset only
  // by a correct PIN or an admin reset, never by time.
  failures: integer("failures").notNull().default(0),
  blockedUntil: integer("blocked_until", { mode: "timestamp_ms" }),
  lastFailedAt: integer("last_failed_at", { mode: "timestamp_ms" }),
  // Unlock proofs issued before this are dead: "lock all my devices", a PIN change, an admin reset.
  unlocksValidFrom: integer("unlocks_valid_from", { mode: "timestamp_ms" }),
  // Proofs revoked one device at a time, [{i, exp}], each dropped once it would have expired anyway.
  revokedJson: text("revoked_json").notNull().default("[]"),
  // Which client-store key the person's browsers encrypt under (lib/appLock.ts clientKeyFor).
  keyEpoch: integer("key_epoch").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

/**
 * The SECONDARY roles a user holds, beyond `users.role`.
 *
 * WHY `users.role` STAYS. It is the PRIMARY role and it is load-bearing in three places that want exactly one
 * answer: `audit_log.actor_role` records it point-in-time on every row, "view as" swaps it, and the UI labels
 * people by it. Replacing it with a pure join table would mean deciding, at each of those, which of somebody's
 * roles to name - so the table is additive and the column keeps its meaning.
 *
 * WHAT THIS BUYS over applying a role TEMPLATE to a person (which already works): the copy does not follow the
 * template afterwards. Someone who is both a team lead and the office's asset manager can be seeded from the IT
 * bundle today, but changing that bundle later leaves their copy on the old rules. Holding the role means they
 * track it.
 *
 * Union semantics, like every other source of authority: the caller's grant is their primary role's, plus each
 * held role's, plus `everyone`, plus their own user rules - all merged (domain/compileGrants.ts mergeGrants).
 * A role here can only ADD; nothing in this table narrows anything.
 *
 * RESTRICT on the role, so a role stays undeletable while anybody holds it - the same promise `users.role`'s FK
 * already makes, which is why services/roles.ts has to check both. CASCADE on the user, because these rows are
 * meaningless without the account and a deleted account must not pin a role forever.
 */
export const userRoles = sqliteTable("user_roles", {
  userId: text("user_id").notNull().references((): AnySQLiteColumn => users.uuid, { onDelete: "cascade" }),
  role: text("role").notNull().references((): AnySQLiteColumn => roles.name, { onDelete: "restrict" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.role] }),
  // "Does anybody hold this role?" - the role delete guard's question, asked without scanning.
  roleIdx: index("user_roles_role_idx").on(t.role),
}));

// Machine credentials. An API key is NOT a principal of its own - it acts as its owner (a real `users` row)
// and may only ever NARROW that user's authority, never widen it (domain/keyScope.ts). That is why there is
// no role column here: the role comes from the owner.
//
// `hash` is an HMAC-SHA256 of the secret (lib/apiKeyToken.ts), never the secret and never a bare digest, so
// a dump of this table is not a set of working credentials. `prefix` is the unhashed lookup handle: it makes
// verification ONE indexed read instead of a scan over every key's hash.
//
// The owner FK cascades: deleting a user must not leave a live credential behind that still resolves.
export const apiKeys = sqliteTable(
  "api_keys",
  {
    uuid: pk(),
    code: codeCol(),
    name: text("name").notNull(),
    // What this credential is for, in the operator's own words. A name identifies the integration; this says
    // why it exists and who to ask before revoking it - the question a key outlives the person who made it.
    description: text("description"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references((): AnySQLiteColumn => users.uuid, { onDelete: "cascade" }),
    prefix: text("prefix").notNull().unique(), // public lookup handle, also shown in the UI to identify a key
    hash: text("hash").notNull(), // HMAC-SHA256(secret), base64
    scopeJson: text("scope_json").notNull(), // domain/keyScope KeyScope - the ceiling on the owner's grant
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }), // null = never (allowed, discouraged in the UI)
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }), // throttled write, best-effort (see middleware/auth)
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }), // set by :revoke; a revoked key stays for the audit trail
    // Soft delete, for the same reason revocation keeps the row: the audit trail resolves a credential by its
    // id, so a hard DELETE would orphan every row that key ever wrote. Deleting hides it and stops it
    // authenticating; `?force` still purges when a record genuinely has to go.
    deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references((): AnySQLiteColumn => users.uuid),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => ({ pageIdx: index("api_keys_page_idx").on(t.createdAt, t.uuid), ownerIdx: index("api_keys_owner_idx").on(t.ownerUserId, t.createdAt, t.uuid) }),
);

// Org-wide key/value config (e.g. holiday policy). One row per key, readable by all,
// writable by config.write.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: updated(),
});

// Global policy manifest (not role-keyed): protected-field designations + authorized-reference specs +
// owner-refs. Consulted on writes; carried alongside the grant so a write costs no extra read.
export const policy = sqliteTable("policy", {
  key: text("key").primaryKey(), // e.g. "protected_fields", "references", "owner_refs"
  valueJson: text("value_json").notNull(),
  updatedAt: updated(),
});

// The authority store - the SOLE source of record for both role and user access (no separate grant blob).
// Each row is ONE access rule: a role or user pattern, created directly by the access-rules management
// service (pattern + narrowing columns derived once, identically to the seed's `compileGrant`). The DB
// NARROWS by (subject, namespace[, match_code]); the unchanged engine (`permissions.ts decide`) DECIDES over
// the verbatim `pattern`. So the narrowing columns are an index, never the guard: a too-loose key only
// fetches extra rows (decide filters them); never dropping a matching row is the security property, proven by
// the differential test (compiled-rows decision == blob decision). Seed rows come from the typed `GRANTS`.
export const accessRules = sqliteTable("access_rules", {
  uuid: pk(),
  subject: text("subject").notNull(), // role name OR user uuid
  subjectKind: text("subject_kind", { enum: ["role", "user"] }).notNull(),
  namespace: text("namespace").notNull(), // collection (first pattern token) or '*' (the super "**" pattern)
  pattern: text("pattern").notNull(), // VERBATIM grant pattern - the decision input, never re-derived
  // `reports`/`org` are the manager chain (domain/permissions.ts SelfContext): subject-relative like
  // `self`/`dept`, so they carry no `scope_code` - who they reach is resolved per caller at decision time.
  scopeKind: text("scope_kind", { enum: ["all", "subtree", "exact", "self", "dept", "reports", "org"] }).notNull(),
  scopeCode: text("scope_code").notNull().default(""), // code prefix for subtree/exact; '' otherwise
  matchCode: text("match_code"), // exact object code for per-object rows (user OR exact role rules), the IN-narrowing key; NULL for scope rules
  level: text("level", { enum: ["read", "write", "admin"] }), // NULL for verb (allow) / deny rules
  effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
  // WHO OWNS THIS ROW: "acl" = a person authored it (the ACL modal, the permissions panels, the seed);
  // "ticket-share" = the category/department viewer machinery wrote it (services/ticketShares.ts).
  //
  // The share rows are byte-identical to a hand-authored `scope:exact, level:read` user rule, which is the
  // point on the way in and was the bug on the way out: the revoke matched on (subject, kind, pattern,
  // effect), so a routine `:assign` or `:route` that dropped somebody from the viewer set deleted the grant an
  // admin had authored on that same ticket - at WHATEVER level it granted, since the level is not in the
  // predicate either. softDelete.ts takes the opposite care over the same question and says why: removing a
  // scope an admin declared "would be destroying a grant, not tidying a dangling one". Nothing in the table
  // could tell the two apart; this column is that difference, and both the machinery's dedupe and its delete
  // are scoped to it.
  // An optional threshold on the ROW the rule is exercised against, as JSON `{field, op, value}` - the approval
  // limit the pattern model has no slot for (domain/ruleCondition.ts). It can only ever SUBTRACT from what the
  // pattern already grants, so a rule with one is never wider than the same rule without.
  //
  // NOT compiled into the pattern, deliberately: the pattern is the decision input and is matched by code, while
  // this is a predicate on a column. Keeping them apart is what lets `decide()` stay the sole authority with the
  // condition as a second, subtractive pass - the same shape the delete-verb deny already has.
  condition: text("condition"),
  // An optional NETWORK fence, in the same comma-separated address/CIDR form as the attendance clock's deploy
  // var (lib/ipAllow.ts): "this payroll grant only from the office range". Like `condition` it can only ever
  // SUBTRACT, and like it the pattern stays untouched - but it is a predicate on the REQUEST rather than a row,
  // so it applies to collection paths as well as items.
  fromIp: text("from_ip"),
  // An optional relative TIME WINDOW on a date field, as JSON `{field, within_days}` - "attendance from around
  // now", which a rule's own `expires_at` cannot say because that bounds when the RULE lives, not which rows it
  // reaches. Subtractive like the two guards above.
  window: text("window"),
  source: text("source", { enum: ["acl", "ticket-share"] }).notNull().default("acl"),
  // Row lifecycle, for orgs that want four-eyes on permission changes (settings key `access-approval`).
  // A rule awaiting approval to be ADDED (`pending`) is inert; a rule awaiting approval to be REMOVED
  // (`pending_delete`) keeps enforcing. Fail-safe in both directions - a pending change never applies itself,
  // in either direction, until a second admin approves it (the predicate lives in lib/policyLoad `isLive`).
  status: text("status", { enum: ["active", "pending", "pending_delete"] }).notNull().default("active"),
  requestedBy: text("requested_by"), // user uuid that asked for the pending change; may not approve it (four eyes)
  // Optional expiry for temporary access (contractors, incident break-glass). Past this instant the rule is
  // no longer loaded by any decision path; the nightly cron deletes the row.
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  // One composite index serves every read: the role-rule fetch (subject prefix), the list shares/denies
  // fetch (subject+namespace prefix), and the user per-object exact-IN narrowing (full key) all use it - a
  // left-prefix superset, confirmed by EXPLAIN QUERY PLAN. (A separate (subject, namespace) index would be
  // redundant.)
  subjNsMatch: index("ar_subject_ns_match_idx").on(t.subject, t.namespace, t.matchCode),
}));

// Comp-off earned by working on a holiday: one row per (employee, worked day). The row IS the idempotency
// marker - the nightly credit inserts it first (unique index) and credits the leave balance only if that insert
// won, so a re-run or an overlapping tick can never credit the same day twice.
export const compOffCredits = sqliteTable("comp_off_credits", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  workedDate: integer("worked_date", { mode: "timestamp_ms" }).notNull(),
  days: real("days").notNull(), // 0.5 (half a day worked) or 1
  holidayId: text("holiday_id").references((): AnySQLiteColumn => holidays.uuid),
  createdAt: created(),
}, (t) => ({ uk: uniqueIndex("compoff_emp_date_idx").on(t.employeeId, t.workedDate) }));

// Which optional holidays each employee has picked.
export const holidaySelections = sqliteTable("holiday_selections", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  holidayId: text("holiday_id").notNull().references((): AnySQLiteColumn => holidays.uuid),
  createdAt: created(),
}, (t) => ({ pageIdx: index("holiday_selections_page_idx").on(t.createdAt, t.uuid), uk: uniqueIndex("hsel_emp_holiday_idx").on(t.employeeId, t.holidayId) }));

// Per-user key/value store (e.g. saved DataTable layouts). One row per (user, key).
export const preferences = sqliteTable("preferences", {
  uuid: pk(),
  code: codeCol(),
  userId: text("user_id").notNull().references(() => users.uuid),
  key: text("key").notNull(),
  value: text("value").notNull(), // JSON
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ userKey: uniqueIndex("pref_user_key_idx").on(t.userId, t.key) }));

export const departments = sqliteTable("departments", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  parentId: text("parent_id").references((): AnySQLiteColumn => departments.uuid),
  managerIds: text("manager_ids"), // JSON array of employee uuids assigned to manage this department
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("departments_page_idx").on(t.createdAt, t.uuid) }));

export const employees = sqliteTable("employees", {
  uuid: pk(),
  code: codeCol(),
  // Human-facing employee ID (e.g. EMP-0042), distinct from the internal `code` (an authz scoping key) and the
  // wire token. Auto-assigned from the org format (settings/employee-number) on create, HR-overridable. Unique.
  employeeNumber: text("employee_number").unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  // Full legal name as it appears on official documents/bank/government IDs, distinct from the display
  // first+last name everyone knows. HR-managed (not self-editable). Used for signing + letters; falls back
  // to "first last" wherever it's empty.
  legalName: text("legal_name"),
  workEmail: text("work_email").notNull().unique(),
  jobTitle: text("job_title"),
  // How and where they work, mirrored from the CURRENT `positions` row the same way `jobTitle` and
  // `departmentId` above are - a transfer, a relocation or a contract-to-permanent conversion is a role
  // change, so the history lives on `positions` and these are the current value. Mirrored rather than
  // joined because the profile header and the directory both read them per row: a join would put an extra
  // read on every employee in every list to render one line of text.
  employmentType: text("employment_type", { enum: ["full_time", "part_time", "contract", "intern", "temporary"] }),
  workMode: text("work_mode", { enum: ["on_site", "hybrid", "remote"] }),
  location: text("location"),
  // Short public "about me" (plain text, self-written via employees/<id>/bio). Not PII - readable by
  // anyone who can read the employee record; shown on profile heroes and the directory.
  bio: text("bio"),
  departmentId: text("department_id").references(() => departments.uuid),
  managerId: text("manager_id").references((): AnySQLiteColumn => employees.uuid),
  startDate: integer("start_date", { mode: "timestamp_ms" }),
  endDate: integer("end_date", { mode: "timestamp_ms" }),
  probationEndDate: integer("probation_end_date", { mode: "timestamp_ms" }),
  // The first day this system holds records for the person (DATE-ONLY, UTC midnight). Someone who joined before
  // the org started using the app has history that happened elsewhere, so a day before this is not inferred as
  // an absence (domain/attendance.ts lopDayUnits), and an accrual period that starts before it belongs to the
  // opening balance rather than to the walk (domain/leave.ts `floorMs`, `leaveAdjustments`). Null = records
  // start on `startDate`, which is the case for everyone hired after go-live.
  trackedFrom: integer("tracked_from", { mode: "timestamp_ms" }),
  epfEnrolled: integer("epf_enrolled", { mode: "boolean" }).notNull().default(false), // EPF is opt-in per employee; default off (no PF deduction / employer share)
  // EPS (Employees' Pension Scheme) exclusion. A member whose pay already exceeded the pension wage ceiling
  // when they first joined EPF is excluded from EPS, and the WHOLE employer share stays in EPF instead of
  // 8.33% being diverted to the pension fund. Membership history is not derivable from this system's data, so
  // it is HR-declared per employee; default false (the ordinary case, EPS applies).
  epsExcluded: integer("eps_excluded", { mode: "boolean" }).notNull().default(false),
  // ENCRYPTED (base64 AES-GCM) - never plaintext, never serialized:
  nationalIdEnc: text("national_id_enc"),
  bankDetailsEnc: text("bank_details_enc"),
  identityDetailsEnc: text("identity_details_enc"), // JSON blob of configured identity field values
  personalDetailsEnc: text("personal_details_enc"), // JSON blob of contact + emergency info
  taxDetailsEnc: text("tax_details_enc"), // JSON blob: prior-employer income + TDS declarations (mid-year joiners)
  // The verification state of the blob above, mirrored in PLAINTEXT (never the figures - only which lane the
  // declaration sits in). It exists so the approvals badge can COUNT the verification queue in SQL; without it
  // the count means scanning every employee and decrypting every blob, which the badge did on every page load.
  // Written only where taxDetailsEnc is (services/taxDetails.ts), so the two can't drift.
  taxVerificationStatus: text("tax_verification_status", { enum: ["DECLARED", "VERIFIED", "REJECTED"] }),
  photoKey: text("photo_key"), // R2 key of the profile photo (JPEG), null if none
  // When the photo was last set or cleared. The R2 key is stable across uploads (`photos/<uuid>`), so this is
  // the only thing that distinguishes one picture from the next - and the client's face cache keys on it, so a
  // replaced photo is a cache miss in EVERY browser rather than only in the one that uploaded it. Deliberately
  // not `updatedAt`: renaming someone must not cost a re-fetch of their face.
  photoAt: integer("photo_at", { mode: "timestamp_ms" }),
  signatureKey: text("signature_key"), // R2 key of the uploaded signature image (PNG), null if none
  // Per-user in-app notification preferences (self-service): JSON `{ muted: string[] }` of event categories
  // this employee has silenced FOR THEMSELVES. Layered over the org-level settings/notifications config -
  // notify() skips a recipient whose prefs mute the category. Edited via employees/<id>/notification-prefs.
  notificationPrefs: text("notification_prefs"),

  status: text("status", { enum: ["active", "terminated", "on_leave"] }).notNull().default("active"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete (optional)
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("employees_page_idx").on(t.createdAt, t.uuid),
  deptIdx: index("emp_dept_idx").on(t.departmentId),
  mgrIdx: index("emp_mgr_idx").on(t.managerId),
}));

export const leaveTypes = sqliteTable("leave_types", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  accrualDaysPerYear: real("accrual_days_per_year").notNull().default(0),
  // How the annual rate is credited: "monthly" (annual/12 once a month) or "semi_monthly" (annual/24 on the
  // 1st and 16th). Same yearly total; semi-monthly just credits in two installments.
  accrualFrequency: text("accrual_frequency").notNull().default("monthly"),
  paid: integer("paid", { mode: "boolean" }).notNull().default(true),
  color: text("color"), // hex (e.g. "#8b5cf6") for calendar/timeline pills; null = auto-assigned by index

  // Probation policy: can it be requested while on probation; the accrual rate during probation (often 0 or
  // reduced); and an optional cap on days that may be TAKEN during probation (null = uncapped).
  availableDuringProbation: integer("available_during_probation", { mode: "boolean" }).notNull().default(true),
  probationAccrualDaysPerYear: real("probation_accrual_days_per_year").notNull().default(0),
  probationCapDays: real("probation_cap_days"),
  // Encashment policy (mid-employment leave cashout, HR-driven). encashable gates the type; the annual cap
  // (null = uncapped) bounds days encashed per financial year; minBalanceRetainedDays is the floor the
  // balance may not be encashed below.
  encashable: integer("encashable", { mode: "boolean" }).notNull().default(false),
  encashmentCapDaysPerYear: real("encashment_cap_days_per_year"),
  minBalanceRetainedDays: real("min_balance_retained_days").notNull().default(0),
  // Carry-forward policy (calendar-year rollover). carryForward gates it; carryForwardCapDays bounds the days
  // that survive into the next year (null = unlimited when the flag is on; flag off = balance resets to 0).
  carryForward: integer("carry_forward", { mode: "boolean" }).notNull().default(false),
  carryForwardCapDays: real("carry_forward_cap_days"),
  // The rest of the policy: notice requirements, frequency caps, sandwich counting, combinations with other
  // types, exit-process limits, joining-month cutoffs, blackout windows (domain/leaveRestrictions.ts). Null =
  // this type adds nothing to the org baseline in settings/leave_restrictions; a leaf set here overrides that
  // baseline, and a leaf set to null exempts this type from it.
  restrictions: text("restrictions", { mode: "json" }).$type<Record<string, unknown>>(),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("leave_types_page_idx").on(t.createdAt, t.uuid) }));

export const leaveBalances = sqliteTable("leave_balances", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  leaveTypeId: text("leave_type_id").notNull().references(() => leaveTypes.uuid),
  balanceDays: real("balance_days").notNull().default(0),
  // Last calendar month (YYYY-MM, UTC) credited for this balance; makes monthly accrual idempotent.
  lastAccrualYm: text("last_accrual_ym"),
  // The EMPLOYMENT WINDOW those credited periods were priced against (domain/leave.ts AccrualInputs).
  //
  // The marker above is a high-water mark and the accrual walk only ever adds, which is right while the window
  // only grows and silently wrong when somebody corrects it: a start date fixed earlier leaves the months
  // before the old start uncredited for ever, a rescinded departure leaves the exit month stuck at the
  // fraction the claw-back reduced it to, and a start date fixed later leaves months credited that nobody
  // worked. The marker names a period and says nothing about the window, so none of the three is detectable
  // from it - which is why the window is recorded beside it rather than inferred.
  //
  // Null start = not recorded (a balance credited before these existed). The walk then falls back to what the
  // marker's own FINAL MARK implies, which is the one bit of this the old design did keep, so such a row is
  // priced exactly as it was before and starts recording its window on the next tick.
  accrualPricedStart: integer("accrual_priced_start", { mode: "timestamp_ms" }),
  accrualPricedEnd: integer("accrual_priced_end", { mode: "timestamp_ms" }),
  // Last calendar year (YYYY, UTC) the year-end carry-forward cap was applied; makes rollover idempotent.
  lastCarryForwardYear: text("last_carry_forward_year"),
  createdAt: created(),
  updatedAt: updated(),
  // One balance row per (employee, leave type). Prevents the adjust insert-branch (or a concurrent accrual)
  // from creating duplicate rows that would split an employee's balance across rows and defeat the guarded
  // reserve/release. A duplicate insert now fails loudly instead of silently corrupting the balance.
}, (t) => ({ pageIdx: index("leave_balances_page_idx").on(t.createdAt, t.uuid), empIdx: index("bal_emp_idx").on(t.employeeId, t.createdAt, t.uuid), empTypeUniq: uniqueIndex("bal_emp_type_idx").on(t.employeeId, t.leaveTypeId) }));

// A change to a leave balance that no accrual, request or encashment explains, kept as a LEDGER: each row is
// the signed number of days it moved the balance by, and no row is ever edited - a mistake is corrected by
// another row (services/leaveAdjustments.ts). Two kinds:
//   - `opening`: the balance somebody had when HRMS records started for them (`employees.trackedFrom`), from
//     the system before it. The first one also REMOVES what HRMS had credited for the periods before that day
//     (`removedDays`, domain/leave.ts creditedBeforeFloor); a re-import moves the balance by the difference
//     from the last opening only. `openingSeq` numbers them per (employee, type), and the unique index on it is
//     the lock: two imports of the same opening racing each other make the second one fail and roll back,
//     rather than both applying.
//   - `correction`: HR moving a balance by hand, with the reason on the row.
// Employee-owned and code-scoped like the balance it moves; private by default.
export const leaveAdjustments = sqliteTable("leave_adjustments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  leaveTypeId: text("leave_type_id").notNull().references(() => leaveTypes.uuid),
  kind: text("kind", { enum: ["opening", "correction"] }).notNull(),
  days: real("days").notNull(), // the signed change this row made to the balance
  openingDays: real("opening_days"), // opening: the balance entered, as of `asOf`
  removedDays: real("removed_days"), // opening: what HRMS had credited before `asOf`, taken off by the first one
  encashedDays: real("encashed_days"), // opening: days already encashed this leave year before HRMS
  asOf: integer("as_of", { mode: "timestamp_ms" }), // opening: the employee's tracked_from it was measured against
  openingSeq: integer("opening_seq"), // opening: 1 for the first, then one more per re-import
  reason: text("reason"),
  createdBy: text("created_by").references(() => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("leave_adjustments_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("ladj_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  openingUniq: uniqueIndex("ladj_opening_idx").on(t.employeeId, t.leaveTypeId, t.openingSeq).where(sql`${t.kind} = 'opening'`),
}));

export const leaveRequests = sqliteTable("leave_requests", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  leaveTypeId: text("leave_type_id").notNull().references(() => leaveTypes.uuid),
  startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp_ms" }).notNull(),
  days: real("days").notNull(),
  // Half-day boundaries via sessions: 1 = first half (morning), 2 = second half (afternoon). The leave runs
  // contiguously from startSession of startDate through endSession of endDate. So a leading half is the PM of
  // the first day (startSession=2), a trailing half is the AM of the last day (endSession=1), and a single
  // half day is AM (1,1) or PM (2,2). Defaults 1/2 = full days.
  startSession: integer("start_session").notNull().default(1),
  endSession: integer("end_session").notNull().default(2),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).notNull().default("PENDING"),
  // `import`: leave taken BEFORE HRMS, brought in as history (services/leaveHistoryImport.ts). It is APPROVED
  // and counts toward the leave policy (quotas, lifetime limits, the probation cap) like any other, but it never
  // moved the balance - the opening balance already has it taken off - so cancelling it refunds nothing.
  source: text("source", { enum: ["app", "import"] }).notNull().default("app"),
  reason: text("reason"),
  decidedBy: text("decided_by").references(() => users.uuid),
  // Policy rules this request broke that the org has chosen to WARN on rather than refuse (`soft_rules` in
  // domain/leaveRestrictions.ts): `[{ code, message }]`. Recorded at create time and shown to whoever approves
  // it - a waiver nobody sees is not a waiver, it is a rule that quietly does nothing. Null = broke nothing.
  policyWarnings: text("policy_warnings", { mode: "json" }).$type<{ code: string; message: string }[]>(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("leave_requests_page_idx").on(t.createdAt, t.uuid), empIdx: index("lr_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("lr_state_idx").on(t.state) }));

export const holidays = sqliteTable("holidays", {
  uuid: pk(),
  code: codeCol(),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["fixed", "optional"] }).notNull().default("fixed"),
  // Regional holidays: null = the whole company, otherwise only employees whose CURRENT position location
  // matches (compared case/space-insensitively - locations are free text, same as positions.location). This is
  // not access control: everyone can see the whole calendar, it just isn't everyone's day off.
  location: text("location"),
  // A holiday the office only closes for half of. Leave crossing it is charged 0.5 days, not 0 or 1.
  halfDay: integer("half_day", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("holidays_page_idx").on(t.createdAt, t.uuid) }));

// Documents are split into two resource types, each gated by the middleware via its own path + grants.
// NEITHER has a `visibility`/audience column - access control is NOT in the data or the code; it is purely
// the grants (per the prime directive: private by default). Shared (non-owner) document columns:
const docCommon = () => ({
  documentType: text("document_type", { enum: ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "FORM16", "INSURANCE", "OTHER"] }).notNull(),
  title: text("title").notNull(),
  fileName: text("file_name"),
  r2Key: text("r2_key").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  published: integer("published", { mode: "boolean" }).notNull().default(true),
  expireTime: integer("expire_time", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

// Org-wide documents: flat code, no owner. Access is whatever the grants say (default: HR/super only).
// Org-defined calendar events (e.g. a conference) that mark a set of employees unavailable across a date
// range. Flat collection (org-wide, like holidays). `attendeeIds` is a JSON array of employee uuids; those
// days render as a band on each attendee's timeline row and count as excused (not absent) in attendance.
// Private-by-default (no grant names it -> super-only via ** until granted via the ACL).
export const events = sqliteTable("events", {
  uuid: pk(),
  code: codeCol(),
  title: text("title").notNull(),
  // Full instants (the event can last minutes, hours, days or weeks). For an all-day event the time-of-day
  // is not meaningful and only the date part is used.
  startTime: integer("start_date", { mode: "timestamp_ms" }).notNull(),
  endTime: integer("end_date", { mode: "timestamp_ms" }).notNull(),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(true),
  // When true the event's time counts toward attending employees' worked minutes (so it can make a day count
  // as present / half day). When false the event does NOT excuse the day: an attendee who never clocked in is
  // still absent (loss of pay), and one who did is paid on their clocked minutes like any other day.
  countAsWork: integer("count_as_work", { mode: "boolean" }).notNull().default(false),
  // Only meaningful when countAsWork. When true the credit lands only for attendees who actually punched that
  // day (a team lunch they clocked out for); when false it lands regardless (an off-site nobody badges into).
  requiresClockIn: integer("requires_clock_in", { mode: "boolean" }).notNull().default(false),
  color: text("color"), // hex for the timeline band; null = a default accent
  description: text("description"),
  attendeeIds: text("attendee_ids"), // JSON array of employee uuids marked unavailable
  // Repeats: the all-hands every Monday, the review week every quarter, Founders' Day every year. Set on the
  // one row that carries the series, and the nightly cron creates the next occurrence once this one has passed
  // and MOVES the repeat onto it - the same "exactly one row carries it" shape recurring 1:1s use, so there is
  // never a generator quietly filling the calendar years ahead.
  repeat: text("repeat", { enum: ["weekly", "monthly", "yearly"] }),
  // The series' own day of the month, held so a month step can put the next occurrence back on it. Without
  // it a series steps from wherever the last one landed, and one February moves a 29th/30th/31st series to the
  // 28th for good (domain/calendar.ts#addMonthsFromAnchor). Null until the first roll, which takes it from the
  // occurrence's own date - the last moment that day is still the one the series was written with.
  repeatAnchorDay: integer("repeat_anchor_day"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("events_page_idx").on(t.createdAt, t.uuid), startIdx: index("event_start_idx").on(t.startTime) }));

// One attendee's answer to an event (sub-resource, like card_comments): not a wire collection, folded into the
// event's serialize and written via the event `:respond` verb. Being on `attendee_ids` says an event was aimed
// at you; this says whether you are coming. Without it an organiser counting heads for an off-site is guessing,
// and the attendance credit `count_as_work` grants was being handed to a list nobody had confirmed.
export const eventResponses = sqliteTable("event_responses", {
  uuid: pk(),
  eventId: text("event_id").notNull().references(() => events.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  response: text("response", { enum: ["going", "maybe", "declined"] }).notNull(),
  note: text("note"), // "can only make the morning" - the useful half of a maybe
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  uniq: uniqueIndex("event_response_uniq").on(t.eventId, t.employeeId),
  eventIdx: index("event_response_event_idx").on(t.eventId),
}));

// Statutory compliance calendar: each row is one dated statutory obligation occurrence (PF/ESI/TDS/GST/PT/
// annual returns, etc.) with a due date + status workflow. Flat + company-wide; private by default (no role
// names it in grants -> super-only until access is granted via the ACL). `overdue` is derived (pending + past
// due), not stored. Recurrence is metadata (`frequency`) for now; auto-generation of occurrences is deferred.
export const complianceEvents = sqliteTable("compliance_events", {
  uuid: pk(),
  code: codeCol(),
  title: text("title").notNull(),
  category: text("category"), // authority/area: EPFO, Income Tax (TDS), GST, ESIC, Professional Tax, MCA, ...
  frequency: text("frequency", { enum: ["one_time", "monthly", "quarterly", "annual"] }).notNull().default("one_time"),
  dueDate: integer("due_date", { mode: "timestamp_ms" }).notNull(),
  periodLabel: text("period_label"), // the period this filing covers, e.g. "Jun 2026", "Q1 FY26-27"
  status: text("status", { enum: ["pending", "filed", "waived"] }).notNull().default("pending"),
  filedDate: integer("filed_date", { mode: "timestamp_ms" }),
  reference: text("reference"), // challan / acknowledgement number
  // The PROOF of the filing - the challan or acknowledgement PDF - filed on the org document shelf and linked
  // here. A reference number says a filing happened; only the receipt survives an audit, so the ledger has to
  // be able to hold one. Deliberately a link rather than a second file store: the document shelf already owns
  // access, audit and expiry for company paperwork.
  documentId: text("document_id").references((): AnySQLiteColumn => orgDocuments.uuid),
  assigneeId: text("assignee_id").references((): AnySQLiteColumn => employees.uuid),
  notes: text("notes"),
  // The recurring rule that generated this occurrence, if any (null = ad-hoc one-off). Lets the UI flag
  // generated rows and the generator dedupe (rule + due_date) so a roll-forward never duplicates.
  ruleId: text("rule_id").references((): AnySQLiteColumn => complianceRules.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("compliance_events_page_idx").on(t.createdAt, t.uuid), dueIdx: index("compliance_due_idx").on(t.dueDate), ruleIdx: index("compliance_rule_idx").on(t.ruleId) }));

// Recurring statutory obligation: a rule that auto-generates compliance_events occurrences on a schedule
// (e.g. "PF, monthly, due 15th"). Generation rolls a ~12-month horizon on the daily cron + on rule edit;
// occurrences are normal events (editable/markable) linked back via rule_id. Flat + private by default.
export const complianceRules = sqliteTable("compliance_rules", {
  uuid: pk(),
  code: codeCol(),
  title: text("title").notNull(),
  category: text("category"),
  frequency: text("frequency", { enum: ["monthly", "quarterly", "annual"] }).notNull().default("monthly"),
  dueDay: integer("due_day").notNull().default(1), // day of month (clamped to month length)
  anchorMonth: integer("anchor_month"), // 1-12: quarterly cycle start + annual month; null for monthly
  assigneeId: text("assignee_id").references((): AnySQLiteColumn => employees.uuid),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).notNull().default(true), // false = stop generating new occurrences
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("compliance_rules_page_idx").on(t.createdAt, t.uuid) }));

// Background-verification tracking: one row per verification CHECK for an employee (identity/address/education/
// employment/criminal/reference/credit). An employee's "case" is just their set of checks. Flat company-wide;
// private by default (sensitive - super-only until HR is granted via the ACL).
export const backgroundChecks = sqliteTable("background_checks", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  // The onboarding transition that requested this check, if it was spawned from an onboarding template (null
  // for ad-hoc checks). Lets the BGV page show onboarding context and the transition list its checks.
  transitionId: text("transition_id").references((): AnySQLiteColumn => transitions.uuid),
  checkType: text("check_type", { enum: ["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"] }).notNull().default("identity"),
  status: text("status", { enum: ["pending", "in_progress", "clear", "discrepancy", "failed"] }).notNull().default("pending"),
  vendor: text("vendor"), // the verification agency the check was run through
  referenceNo: text("reference_no"), // the vendor's case reference
  initiatedDate: integer("initiated_date", { mode: "timestamp_ms" }),
  completedDate: integer("completed_date", { mode: "timestamp_ms" }),
  // What the vendor charged for this check. Choosing a verification agency is the decision this collection
  // informs, and turnaround alone only answers half of it. Nullable: a check run in-house, or one whose
  // invoice has not landed, costs nothing recorded rather than zero.
  cost: real("cost"),
  notes: text("notes"),
  // The vendor's report, filed as the employee's own document and linked here. Notes summarise a finding; the
  // report is what a dispute is settled against. Personal, not org: it is about one person.
  documentId: text("document_id").references((): AnySQLiteColumn => personalDocuments.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("background_checks_page_idx").on(t.createdAt, t.uuid), empIdx: index("bgcheck_emp_idx").on(t.employeeId, t.createdAt, t.uuid) }));

export const orgDocuments = sqliteTable("org_documents", {
  uuid: pk(),
  code: codeCol(),
  ...docCommon(),
  // Acknowledgement (compliance): when requiresAck, in-scope employees must acknowledge the current version
  // via :acknowledge. Replacing the file bumps ackVersion so everyone must re-acknowledge the new version.
  requiresAck: integer("requires_ack", { mode: "boolean" }).notNull().default(false),
  ackVersion: integer("ack_version").notNull().default(1),
  // When the CURRENT ack version landed (set when acknowledgement is switched on, re-stamped when the file is
  // replaced). The chase-up schedule ages off this rather than off `updatedAt`, so renaming a policy doesn't
  // restart everybody's reminder clock.
  ackVersionTime: integer("ack_version_time", { mode: "timestamp_ms" }),
  // How an acknowledgement is signed (only meaningful when requiresAck): "internal" embeds the employee's
  // on-file signature image in place; "cashfree" runs a per-employee Aadhaar e-sign. Required when requiresAck.
  ackMethod: text("ack_method", { enum: ["internal", "cashfree"] }),
  // The signature box HR placed on the rendered PDF: a single {page,x1,y1,x2,y2} (PDF points, bottom-left
  // origin, 1-based page) - same shape as EsignSignAnchor. Where the signature is stamped / sign_positions
  // sent to the vendor. Required when requiresAck.
  signAnchorJson: text("sign_anchor_json"),
}, (t) => ({ pageIdx: index("org_documents_page_idx").on(t.createdAt, t.uuid) }));

// Personal documents: employee-owned, owner-embedded code. Access: owner (personal-documents.me) + admins.
export const personalDocuments = sqliteTable("personal_documents", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  // The org-document this file was generated from, if any. Set on a signed acknowledgement copy (policy +
  // certificate page) so the UI can pair the signed copy back to its source policy without reading the
  // acknowledgement records. Null for ordinary personal documents.
  sourceDocId: text("source_doc_id").references((): AnySQLiteColumn => orgDocuments.uuid),
  // Set on a per-employee Aadhaar acknowledgement copy: the ack row this signed copy finalizes. When the copy
  // is e-signed, applyEsignEvent stamps this ack acknowledged. Null for ordinary personal documents / letters.
  ackId: text("ack_id").references((): AnySQLiteColumn => documentAcknowledgements.uuid),
  // E-signature (letters/contracts): when a generated letter has an e-signature placeholder block, it is
  // flagged here so the owner is prompted to sign. Signing re-renders the frozen letter with their signature
  // image embedded at the placeholder (in place), then stamps signedTime + the typed-name attestation + locks.
  requiresSignature: integer("requires_signature", { mode: "boolean" }).notNull().default(false),
  // The letterhead this document was rendered on (letterheads.uuid), for documents this app laid out. Kept on
  // the row, not dug out of the frozen content sidecar, so a LIST can answer "does this one also have a print
  // version?" with one extra query instead of an R2 read per document. Null for uploads.
  letterheadId: text("letterhead_id"),
  signedTime: integer("signed_time", { mode: "timestamp_ms" }),
  signatureName: text("signature_name"), // typed full name = the e-signature attestation
  // Year-end tax docs (Form 16): the financial year the doc covers ("2025-26"), and whether it's the OFFICIAL
  // TRACES copy (uploaded by HR) vs an HRMS-generated Part-B summary. The UI prefers the official copy for a
  // year when present and falls back to the generated one. Null/false for ordinary personal documents.
  financialYear: text("financial_year"),
  official: integer("official", { mode: "boolean" }).notNull().default(false),
  // E-sign provider tracking (vendor-agnostic; see src/domain/esign.ts). Which driver handled this doc, the
  // provider's request id (matched by the inbound webhook), the last known status, and the signer link the
  // employee opens to sign at the vendor. `internal` (in-app image signing) leaves esignRequestId/esignUri null.
  esignProvider: text("esign_provider"),
  esignRequestId: text("esign_request_id"),
  esignStatus: text("esign_status").notNull().default("none"),
  esignUri: text("esign_uri"),
  esignSentAt: integer("esign_sent_at", { mode: "timestamp_ms" }),
  esignSignedAt: integer("esign_signed_at", { mode: "timestamp_ms" }),
  ...docCommon(),
}, (t) => ({ pageIdx: index("personal_documents_page_idx").on(t.createdAt, t.uuid), empIdx: index("pdoc_emp_idx").on(t.employeeId, t.createdAt, t.uuid), esignRefIdx: index("pdoc_esign_ref_idx").on(t.esignRequestId) }));

// An employee's acknowledgement (e-signature) of an org document version - the compliance sign-off. Employee-
// owned + code-scoped (own/dept/all). Created only via org-documents :acknowledge and immutable (no update);
// `version` is the document's ackVersion at sign time, so a later file replace (version bump) re-requires it.
export const documentAcknowledgements = sqliteTable("document_acknowledgements", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  documentId: text("document_id").notNull().references(() => orgDocuments.uuid),
  version: integer("version").notNull().default(1),
  signature: text("signature").notNull(), // typed full name = the e-signature attestation
  // The in-place signed copy of the policy PDF, filed as the employee's personal document (the signature is
  // stamped into the document's sign box). Null until the copy exists.
  signedDocId: text("signed_doc_id").references((): AnySQLiteColumn => personalDocuments.uuid),
  // Null while an Aadhaar e-sign is in flight (copy created, awaiting the signer); set when the ack completes.
  // Internal acks set it immediately (synchronous). A null row is a pending acknowledgement.
  acknowledgedTime: integer("acknowledged_time", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete (admin cleanup)
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("document_acknowledgements_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("dack_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  docIdx: index("dack_doc_idx").on(t.documentId),
  // ONE acknowledgement per (document, employee, version). `:acknowledge` used to be a read-then-write with
  // nothing claiming it, so the same person in two tabs (or the Aadhaar path resuming its own pending ack)
  // filed TWO stamped copies of the same policy - each `locked: true`, so neither could be tidied away - and
  // on the vendor lane fired `provider.createRequest` twice, which is a paid transaction and a second signing
  // link to somebody who agreed to sign once. The service inserts the ack FIRST and treats this index's
  // rejection as "already acknowledged" (lib/errors.ts#isDocumentAckDuplicate), so the copy and the vendor
  // call only happen for the caller who won. Partial on the live rows, like `sa_emp_day_idx`: an admin
  // soft-deleting an ack must leave the person able to sign again.
  onceIdx: uniqueIndex("dack_once_idx").on(t.documentId, t.employeeId, t.version).where(sql`${t.deleteTime} is null`),
}));

export const announcements = sqliteTable("announcements", {
  uuid: pk(),
  code: codeCol(),
  // The board holds three kinds: an "announcement" (official, HR/admin, created via the write-gated create), a
  // generic "post" (anyone granted the `post` verb, via :post), and a "poll" (a post with vote options).
  // Default "announcement" so existing rows read as announcements after the migration; every path sets it.
  kind: text("kind", { enum: ["announcement", "post", "poll", "kudos"] }).notNull().default("announcement"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  authorEmployeeId: text("author_employee_id").references(() => employees.uuid),
  // A DRAFT's schedule, and after it goes out, the date the post carries. Null on a post published straight
  // away - that one is placed on the board by `created_at`, which is the same moment. Settable only while the
  // row is a draft and only in the future, so the board's order (domain/board.ts) stays a fact about when
  // things went out rather than a field an author can edit afterwards.
  publishTime: integer("publish_time", { mode: "timestamp_ms" }),
  published: integer("published", { mode: "boolean" }).notNull().default(true),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  // Poll config (kind="poll" only): whether a voter may pick more than one option, and an optional deadline
  // after which voting is locked. A poll is "closed" when locked or past this time.
  pollMultiple: integer("poll_multiple", { mode: "boolean" }).notNull().default(false),
  pollClosesAt: integer("poll_closes_at", { mode: "timestamp_ms" }),
  // Pinned to the top of the board (HR/moderation - the :pin/:unpin verbs). The timestamp rather than a flag
  // so several pinned posts keep a stable order (most recently pinned first). Null = not pinned.
  pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }),
  // WITHHELD BY THE MODERATION GATE: written, never seen. Set at the moment the row is created while a model
  // reads it, cleared when it is released; a post that fails the check keeps it until somebody decides.
  //
  // A COLUMN RATHER THAN A STATE INFERRED FROM `published`/`disabled`, because those two are somebody's
  // editorial choice and this is not: an editor who may see drafts and disabled posts must NOT see a held
  // one, which is the whole point of holding it. It is also what lets every read path exclude held rows in
  // SQL (`services/withheld.ts`) instead of each one remembering to join the flag that is holding it.
  heldAt: integer("held_at", { mode: "timestamp_ms" }),
  // Kudos (kind="kudos"): the recognized employee + recognition meta. The kudo message lives in `body`; `title`
  // is unused (""). `points` is snapshotted server-side from `level` via the kudos config so a giver can't
  // inflate their recognition. Null for every non-kudos kind. The author (board column) is the giver.
  recipientEmployeeId: text("recipient_employee_id").references(() => employees.uuid),
  // A kudo recognizes EITHER one employee (recipientEmployeeId) OR a whole department (recipientDepartmentId) -
  // exactly one is set. A department kudo is a single feed card fanned out as a notification to every member;
  // it carries no per-head points (the leaderboard groups by employee recipient, so a dept kudo credits no one).
  recipientDepartmentId: text("recipient_department_id").references((): AnySQLiteColumn => departments.uuid),
  // Who gets NOTIFIED about a post (announcements/posts/polls): everybody, one department, or nobody at all.
  //
  // This is an audience, not a permission. The board is still the board - anyone who can read announcements can
  // read this one, on every setting - and what changes is the fan-out: a company-wide bell, one department's, or
  // silence for a notice that only needs to be on the wall (a menu change, a minutes archive, a correction to
  // last week's post that nobody needs pinging about twice). Access is authz's job; inventing a second, quieter
  // access system in a content column is how a "private" post ends up being read by everyone anyway.
  audienceScope: text("audience_scope", { enum: ["everyone", "department", "none"] }).notNull().default("everyone"),
  // Which department, when `audienceScope` is "department". Also the label the card carries, so the rest of the
  // company can see at a glance that a post is not aimed at them.
  audienceDepartmentId: text("audience_department_id").references((): AnySQLiteColumn => departments.uuid),
  // Send it as email too, to the same audience, when it goes live. Recorded rather than inferred so a draft
  // remembers the author's decision, and so publishing twice cannot email twice.
  emailAudience: integer("email_audience", { mode: "boolean" }).notNull().default(false),
  emailedAt: integer("emailed_at", { mode: "timestamp_ms" }),
  value: text("value"), // free-text company value tag (e.g. Teamwork), optional
  category: text("category"), // HR-configurable kudos category (settings/kudos), optional
  level: text("level"), // recognition level name (settings/kudos), optional
  // Art on the card, on any kind - an announcement, a post and a poll carry it as well as a kudos: either a
  // `<category>/<slug>` illustration path (web/public/assets/illustrations, see web/src/lib/illustrations.ts) or a
  // `<file>.png` brand sticker (web/public/assets/kudos), told apart by the suffix. Null means no art, on every
  // kind alike - a kudos is offered one of its category's stickers as it is written, but that becomes an ordinary
  // stored pick the giver can swap or remove. Stored as a relative reference rather than a URL, and shape-checked
  // on write (normalizeIllustration), because the web renders it into an <img src>.
  // `body` holds markdown-lite source, exactly as the author wrote it (web/src/lib/richText.tsx). `bodyText` is
  // that same body with the markup stripped, derived server-side on every write - never accepted from a client -
  // so it cannot disagree with what the card shows. It exists because everything that is not the card wants prose:
  // the FTS index binds to it (see domain/searchIndex.ts), as do notification excerpts and list teasers. Without
  // it, a search for "center" would match every post that happens to centre a line.
  bodyText: text("body_text").notNull().default(""),
  // How the card's heading is aligned. The title is its own field rather than part of the body, so it cannot
  // carry a `{center}` attribute line like a body block can - it gets a column instead. Null = start-aligned.
  titleAlign: text("title_align", { enum: ["left", "center", "right"] }),
  // Where the words sit VERTICALLY in the card. It only shows when a card is taller than its text, which is what a
  // placed sticker does to one (see reserveFor in web/src/components/common/CardSticker.tsx) - and then whether the
  // words ride at the top of that space or sit in the middle of it is a real design choice. Null = middle, the
  // card's own default - "top" is a choice that has to be stored to be had.
  bodyValign: text("body_valign", { enum: ["top", "middle", "bottom"] }),
  illustration: text("illustration"),
  // Where that art sits on the card, as JSON `{x,y,size,opacity}` - see normalizeIllustrationLayout. All four are
  // fractions of the card's own width, never pixels, so one placement holds at every card size (the feed, the
  // dashboard, a preview). Null means the default: the sticker flows inline beside the message. Only set once an
  // author has actually moved, resized or faded it.
  illustrationLayout: text("illustration_layout"),
  // A kudos card's recipient block (avatar + name), when the giver has placed it themselves. JSON `{x,y,size}` -
  // see normalizeRecipientLayout. Null means the card's own layout decides, which is what almost every card uses.
  recipientLayout: text("recipient_layout"),
  points: integer("points").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

// A read receipt: one row the first time an employee opens a board item. Like ticket_comments it's a
// sub-resource reached only through the announcement's routes (not a directly-addressable wire collection),
// so access inherits the parent post. Drives the dashboard "unread" widget (board items the caller has no
// row for) and the author/HR-only "Read by" list. Idempotent: the service skips insert when a row exists.
export const announcementReads = sqliteTable("announcement_reads", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  createdAt: created(),
}, (t) => ({
  // ONE RECEIPT PER VIEWER PER POST, enforced here rather than only by the check-then-insert in
  // services/announcements.ts. Two writes that both read "no receipt" both inserted, and the feed counts rows
  // (`readersVisibleTo` pushes one entry per row), so "seen by N" over-counted the same person. It is not an
  // exotic race: the board marks a post read on open while "Mark all read" walks the same table.
  uniq: uniqueIndex("ar_ann_emp_uniq").on(t.announcementId, t.employeeId),
  empIdx: index("ar_emp_idx").on(t.employeeId),
}));

// A reaction on a board post OR one of its replies. One row per (target, employee) - a viewer holds at most
// one reaction per target. `reply_id` null = a reaction on the post itself; set = a reaction on that reply
// (still under the parent post, so access inherits it). `emoji` is the native unicode glyph. Serialized as
// grouped {emoji, count, reacted}.
export const announcementReactions = sqliteTable("announcement_reactions", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  replyId: text("reply_id").references((): AnySQLiteColumn => announcementReplies.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  emoji: text("emoji").notNull(),
  createdAt: created(),
}, (t) => ({
  // ONE REACTION PER VIEWER PER TARGET - which `toggleReaction` has always claimed and only a read-then-write
  // enforced, so a double tap left two rows and `groupReactions` counted the person twice (and listed them
  // twice in the hover list).
  //
  // TWO PARTIAL INDEXES, not one on (announcement_id, reply_id, employee_id): `reply_id` is nullable and
  // SQLite treats NULLs as DISTINCT in a unique index, so a single composite would constrain reply-level
  // reactions and silently do nothing for post-level ones - which are the common case. Splitting on the
  // predicate makes each half's key wholly non-null.
  postUniq: uniqueIndex("arx_post_emp_uniq").on(t.announcementId, t.employeeId).where(sql`${t.replyId} is null`),
  replyUniq: uniqueIndex("arx_reply_emp_uniq").on(t.replyId, t.employeeId).where(sql`${t.replyId} is not null`),
  annIdx: index("arx_ann_idx").on(t.announcementId),
  empIdx: index("arx_emp_idx").on(t.employeeId),
}));

// A reply on a board post. Append-only; reached only through the announcement's routes, so access inherits
// the parent post (like ticket_comments - not a directly-addressable wire collection). `authorId` is the
// replier's employee record when they have one; `authorEmail` is the fallback label for an actor without one.
export const announcementReplies = sqliteTable("announcement_replies", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  authorId: text("author_id").references(() => employees.uuid),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  // Soft-delete, and the only way a reply comes off the wall. It exists for moderation: a reply is the one
  // public surface written by somebody other than the post's author, so hiding the parent to deal with an
  // abusive comment would take down the author's post for what a commenter wrote. Append-only was right
  // while nothing could withdraw one; it stopped being right the moment a moderator could.
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  /** Withheld by the moderation gate - see `announcements.held_at`. A held reply is off the thread for
   *  everyone, including its author, until it is released or the hold is upheld. */
  heldAt: integer("held_at", { mode: "timestamp_ms" }),
  createdAt: created(),
}, (t) => ({ annIdx: index("arp_ann_idx").on(t.announcementId) }));

// A choice on a board poll (kind="poll"). Reached only through the announcement's routes (a sub-resource, like
// replies); set once at poll creation. `position` keeps the options in the author's order.
export const announcementPollOptions = sqliteTable("announcement_poll_options", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  label: text("label").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: created(),
}, (t) => ({ annIdx: index("apo_ann_idx").on(t.announcementId) }));

// A vote on a poll option. One row per (option, voter). A single-choice poll keeps one row per voter; a
// multi-choice poll may have several. Votes are anonymous on the wire (counts only) - the employee id is kept
// only to enforce one-vote-per-option and to let the voter change/clear their choice.
export const announcementPollVotes = sqliteTable("announcement_poll_votes", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  optionId: text("option_id").notNull().references(() => announcementPollOptions.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  createdAt: created(),
}, (t) => ({
  // ONE VOTE PER VIEWER PER OPTION. Keyed on the option and not just the post because a `poll_multiple` poll
  // legitimately takes several options from one person; what it must never take is the same option twice.
  // Without it a double submit inflated `countByOption` (which counts rows) while the poll's total-voter
  // figure de-duplicates through a Set - so the per-option counts could out-total the voters.
  uniq: uniqueIndex("apv_opt_emp_uniq").on(t.optionId, t.employeeId),
  annIdx: index("apv_ann_idx").on(t.announcementId),
  empIdx: index("apv_emp_idx").on(t.employeeId),
}));

// ---- Performance: goals ----
// An employee's goal (performance objective). Employee-owned and code-scoped like leave-requests, so the same
// own/dept/all ACL scopes apply. `weight` is a relative importance (0-100) that a review rolls into a weighted
// attainment score; `progress` is 0-100. Status is the lifecycle of the goal itself (distinct from progress so
// a goal can be 100% yet not formally marked done).
export const goals = sqliteTable("goals", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // Alignment: an optional parent goal this one rolls up under (a manager's/leader's goal). Link-only - the
  // parent's "aligned progress" is derived client-side from the children a viewer can see, never persisted.
  parentId: text("parent_id").references((): AnySQLiteColumn => goals.uuid),
  // The review cycle this goal was set for, when it belongs to one. Optional, because plenty of goals are just
  // work with a due date - but a goal that IS the cycle's says so instead of being guessed at from dates. The
  // review reads its evidence through this link, and the weighted attainment it scores is the set this names.
  cycleId: text("cycle_id").references((): AnySQLiteColumn => reviewCycles.uuid),
  // Objective or key result. An objective is the sentence ("make onboarding excellent"); a key result is one
  // of the numbers that proves it ("time-to-first-commit under 3 days"). A KR always hangs off an objective
  // (`parentId`), and an objective that HAS key results stops carrying its own progress: the server derives it
  // from theirs, weighted, on every write. Everything written before this is an objective, which is what a
  // goal with no children has always been.
  kind: text("kind", { enum: ["objective", "key_result"] }).notNull().default("objective"),
  title: text("title").notNull(),
  description: text("description"),
  weight: integer("weight").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  status: text("status", { enum: ["not_started", "in_progress", "completed", "cancelled"] }).notNull().default("not_started"),
  // Whether this goal has been AGREED, which is a different question from how the work is going (`status`).
  // A review scores a person against these, so "nobody ever signed this off" is a thing the record has to be
  // able to say. DRAFT while the owner is still writing it, PROPOSED once they hand it to their manager,
  // AGREED once the manager accepts it - and `agreedAt`/`agreedById` stamp who accepted it and when, because
  // an attainment figure computed from goals of unknown provenance is not defensible six months later.
  //
  // Defaults to AGREED: an org that has not turned goal approval on (settings/performance) is one where
  // setting a goal IS agreeing it, and every goal in that org should read as settled rather than as a draft
  // nobody is going to submit.
  stage: text("stage", { enum: ["DRAFT", "PROPOSED", "AGREED"] }).notNull().default("AGREED"),
  agreedAt: integer("agreed_at", { mode: "timestamp_ms" }),
  agreedById: text("agreed_by_id").references((): AnySQLiteColumn => employees.uuid),
  dueDate: integer("due_date", { mode: "timestamp_ms" }),
  // The owner's own call on whether this lands, with the sentence that explains it. Deliberately separate from
  // `progress` and from the pace the server derives from the dates: pace is arithmetic and knows nothing about
  // the vendor who slipped a month, and the disagreement between the two ("says on track, 25 points behind")
  // is the conversation worth having. Null until somebody says.
  confidence: text("confidence", { enum: ["on_track", "at_risk", "off_track"] }),
  confidenceNote: text("confidence_note"),
  // What this goal is waiting on. Alignment says which goal this one rolls UP into; this says which goal has
  // to move before this one can - usually somebody else's, in another team. Same vocabulary a blocked board
  // card uses, and the reason a goal sat at 20% all quarter is far more often this than effort.
  blockedById: text("blocked_by_id").references((): AnySQLiteColumn => goals.uuid),
  // Written when the goal closes: what actually happened, in the owner's words. A percentage says how far it
  // got and nothing about why, and by review time nobody remembers. Carried into the review PDF.
  retro: text("retro"),
  // A goal a whole DEPARTMENT owns rather than a person. `employeeId` stays populated (the accountable lead,
  // and the row's owner code), so every existing scope rule keeps working unchanged - this only widens who
  // reads it as theirs, and says so on the card.
  departmentId: text("department_id").references((): AnySQLiteColumn => departments.uuid),
  // A measure, when the goal has one: where it started, where it has to get to, and what the number IS
  // ("customers", "%", "days"). With all three set, `progress` is COMPUTED from them on every write instead of
  // being somebody's estimate - "42 of 60 customers" is a fact, "70%" is a feeling. `baselineValue` matters
  // because plenty of goals start above zero (churn from 8% to 4%, uptime from 99.0 to 99.9), and measuring
  // from zero would report those as nearly done on day one. Targets below the baseline count DOWN, so a
  // reduction goal reads the same way as a growth one.
  unit: text("unit"),
  baselineValue: real("baseline_value"),
  targetValue: real("target_value"),
  currentValue: real("current_value"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("goals_page_idx").on(t.createdAt, t.uuid), empIdx: index("goal_emp_idx").on(t.employeeId, t.createdAt, t.uuid), parentIdx: index("goal_parent_idx").on(t.parentId), cycleIdx: index("goal_cycle_idx").on(t.cycleId), blockedIdx: index("goal_blocked_idx").on(t.blockedById) }));

// A comment on a goal (sub-resource, like card_comments): not a wire collection, emitted inline on the goal Get
// and written via the goal `:comment` verb. A goal is a conversation between an owner and a manager for a
// quarter at a time, and until this existed the only writable text on it was the owner's own progress note -
// so the conversation happened in chat and the goal recorded nothing.
export const goalComments = sqliteTable("goal_comments", {
  uuid: pk(),
  goalId: text("goal_id").notNull().references(() => goals.uuid),
  authorId: text("author_id").references(() => employees.uuid),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  createdAt: created(),
}, (t) => ({ goalIdx: index("goalcomment_goal_idx").on(t.goalId) }));

// Somebody other than the owner who worked on a goal, and how much of it was theirs.
//
// A goal has exactly one owner, which is right for accountability and wrong for the work: a launch that two
// teams pulled off either counts for nobody on the other side, or gets typed up a second time as a near
// duplicate goal that then scores separately and double-counts the same win. A contributor is a SHARE of the
// goal's attainment, credited into that person's own review - the goal itself is untouched.
//
// `share` is a percentage of the goal's weight, capped by the service so the credited shares can never exceed
// the goal itself. A goal with no contributors behaves exactly as it always has.
export const goalContributors = sqliteTable("goal_contributors", {
  uuid: pk(),
  goalId: text("goal_id").notNull().references(() => goals.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  share: integer("share").notNull().default(0), // percent of the goal's weight credited to this person
  note: text("note"),
  createdAt: created(),
}, (t) => ({
  goalIdx: index("goalcontrib_goal_idx").on(t.goalId),
  empIdx: index("goalcontrib_emp_idx").on(t.employeeId),
  // One row per person per goal: a second credit for the same person is an edit, not another share.
  onceIdx: uniqueIndex("goalcontrib_once_idx").on(t.goalId, t.employeeId),
}));

// Somebody who wants to hear about a goal they do not own.
//
// The cases are specific and all of them were silent: the owner of a goal that is BLOCKED BY this one (their
// own plan turns on it and they had no way to hear it slip), a contributor credited with a share of it, and a
// skip-level or peer who simply cares. A goal moves on a weekly rhythm, so "remember to check" means finding
// out about a slip a fortnight after it happened.
//
// A sub-resource like the comments (not a wire collection): reached through the goal's `:watch` / `:unwatch`,
// so access inherits the goal and nobody watches a goal they cannot read.
export const goalWatchers = sqliteTable("goal_watchers", {
  uuid: pk(),
  goalId: text("goal_id").notNull().references(() => goals.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  createdAt: created(),
}, (t) => ({
  goalIdx: index("goalwatch_goal_idx").on(t.goalId),
  empIdx: index("goalwatch_emp_idx").on(t.employeeId),
  onceIdx: uniqueIndex("goalwatch_once_idx").on(t.goalId, t.employeeId),
}));

// A goal blueprint: the shape of a goal the org sets over and over ("complete security training", "hit the
// quarter's quota"), kept once and stamped out onto people. Flat-coded reference data like leave types and
// asset categories - HR curates it in Settings, and `:apply` writes real goals from it.
//
// Every field is the goal's own field, so applying a template is a copy rather than a translation. The one
// exception is `dueInDays`, which is RELATIVE: a template that carried a fixed date would be wrong the day
// after it was written, and re-dating forty templates each quarter is the chore this exists to remove.
export const goalTemplates = sqliteTable("goal_templates", {
  uuid: pk(),
  code: codeCol(),
  title: text("title").notNull(),
  description: text("description"),
  weight: integer("weight").notNull().default(0),
  dueInDays: integer("due_in_days"), // days from the day it is applied
  unit: text("unit"),
  baselineValue: real("baseline_value"),
  targetValue: real("target_value"),
  // Who it is FOR - a hint that filters the catalogue when picking, never a rule. A template suggested for
  // one department is still applicable to anybody; the person applying it knows better than the label.
  departmentId: text("department_id").references((): AnySQLiteColumn => departments.uuid),
  // Free-text grouping ("New hire 30/60/90", "Sales Q3") so a SET can be applied in one press. A group is a
  // label rather than a table: sets are renamed and reshuffled constantly, and a join table would make that a
  // migration instead of a keystroke.
  groupName: text("group_name"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("goal_templates_page_idx").on(t.createdAt, t.uuid), groupIdx: index("goaltpl_group_idx").on(t.groupName) }));

// ---- Performance: review cycles + reviews ----
// A review cycle (e.g. "H1 2026"): an HR-managed container, flat-coded like pay-periods. DRAFT while being set
// up; ACTIVE once launched (which creates a `reviews` row per selected employee - HR picks who, not auto-all);
// CLOSED when done. The optional dates are informational windows shown on each review.
export const reviewCycles = sqliteTable("review_cycles", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  periodStart: integer("period_start", { mode: "timestamp_ms" }),
  periodEnd: integer("period_end", { mode: "timestamp_ms" }),
  // When the cycle's goals were supposed to be agreed by. Goal-setting season is the half of a review cycle
  // that had no deadline at all: the coverage count said who had no goals, but not by when that had to stop
  // being true.
  goalSettingDueDate: integer("goal_setting_due_date", { mode: "timestamp_ms" }),
  selfDueDate: integer("self_due_date", { mode: "timestamp_ms" }),
  managerDueDate: integer("manager_due_date", { mode: "timestamp_ms" }),
  // Which of the framework's competencies THIS cycle rates: a JSON array of competency keys, or null for all
  // of them (which is what every cycle written before this did).
  //
  // The framework is org-wide, so a probation review and an annual review had to ask the same five questions.
  // A subset rather than a per-cycle catalogue on purpose: ratings are stored keyed by the framework's own
  // `key`, so narrowing keeps two cycles comparable, where letting a cycle invent competencies would quietly
  // make the attainment history meaningless. Unknown keys are inert.
  competencyKeysJson: text("competency_keys_json"),
  state: text("state", { enum: ["DRAFT", "ACTIVE", "CLOSED"] }).notNull().default("DRAFT"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("review_cycles_page_idx").on(t.createdAt, t.uuid) }));

// One employee's review within a cycle. Employee-owned + code-scoped like goals (own/dept/all). The workflow
// runs self -> manager -> shared -> acknowledged; each stage is skippable. `ratingsJson` holds the per-competency
// scores keyed by competency key (the framework lives in settings/performance); `overallRating` is the summary.
// Manager fields stay hidden from the owner-employee until SHARED (gated in serialize).
export const reviews = sqliteTable("reviews", {
  uuid: pk(),
  code: codeCol(),
  cycleId: text("cycle_id").notNull().references(() => reviewCycles.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // Who writes this one, when that is not the employee's current manager.
  //
  // The write-up used to fall to `managerIdOf()` and nowhere else, which is right until it isn't: somebody
  // transfers in March and their new manager has not seen the work; a matrix report is reviewed by the lead
  // they actually worked for; a manager is on long leave. The only fix was re-parenting the employee, which
  // changes approvals, scopes and the org chart to solve a review. Null = the manager chain, as before.
  reviewerId: text("reviewer_id").references(() => employees.uuid),
  state: text("state", { enum: ["SELF", "MANAGER", "SHARED", "ACKNOWLEDGED"] }).notNull().default("SELF"),
  selfComment: text("self_comment"),
  selfRatingsJson: text("self_ratings_json"), // {[competencyKey]: number} - the employee's optional self ratings
  ackComment: text("ack_comment"), // optional employee note recorded on acknowledge
  managerComment: text("manager_comment"),
  overallRating: integer("overall_rating"),
  ratingsJson: text("ratings_json"), // {[competencyKey]: number}
  // The manager's verdict on each of the cycle's goals: {[goalCode]: {rating?: number, comment?: string}}, on
  // the same scale as the competencies. Keyed by the goal's CODE, not its id, so the assessment survives the
  // goal row being purged and reads the same in the snapshot below.
  goalRatingsJson: text("goal_ratings_json"),
  // The cycle's goals frozen as they stood when the manager shared the review: [{code, title, weight, progress,
  // status}]. A review is a record of a moment, and goals keep moving after it - without the snapshot, last
  // year's review would re-render against this year's progress and its attainment score would drift.
  goalsJson: text("goals_json"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("reviews_page_idx").on(t.createdAt, t.uuid), cycleIdx: index("rev_cycle_idx").on(t.cycleId), empIdx: index("rev_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  // ONE review per person per cycle, enforced by the DB. `addReviewees` reads which employees the cycle
  // already covers and inserts the rest, which is a check-then-write: two concurrent launches of one cycle
  // both read an empty set and both insert the whole roster. A duplicate review is not untidiness - the
  // person is counted twice in calibration and in the analytics, sees two rows in their own list, and gets
  // two "your review is open" notices. `review_feedback` has carried the same guard one level down
  // (`rf_once_idx`) since it was written; this is the pair it was missing.
  cycleEmpUniq: uniqueIndex("review_cycle_emp_idx").on(t.cycleId, t.employeeId) }));

// A 360/peer feedback request on a review. Owned (code-scoped) by the AUTHOR - the nominee giving feedback -
// so they see "feedback asked of me" via own-scope and submit it. The manager/HR nominate peers via the
// review's `nominate` verb (authorized by their access to the review) and read submitted feedback embedded in
// the review (named); the employee sees it anonymized once the review is shared. `revieweeId` is denormalized
// from the review (the subject) so the nominee's list can name who they're giving feedback on.
export const reviewFeedback = sqliteTable("review_feedback", {
  uuid: pk(),
  code: codeCol(),
  reviewId: text("review_id").notNull().references(() => reviews.uuid),
  revieweeId: text("reviewee_id").notNull().references(() => employees.uuid),
  authorId: text("author_id").notNull().references(() => employees.uuid),
  comment: text("comment"),
  overallRating: integer("overall_rating"),
  // SUGGESTED is the reviewee's own nomination, and it asks nobody for anything yet.
  //
  // Nomination was the manager's alone, which gets the 360 backwards: the people who saw the work are known to
  // the person who did it, and a manager two projects away is guessing. A suggestion is inert - it notifies
  // nothing and cannot be written to - until the manager nominates that person for real, which turns the same
  // row REQUESTED. Declining stays the nominee's own answer.
  state: text("state", { enum: ["SUGGESTED", "REQUESTED", "SUBMITTED", "DECLINED"] }).notNull().default("REQUESTED"),
  /** Why the nominee said no. Optional, and only ever their own words. */
  declineReason: text("decline_reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("review_feedback_page_idx").on(t.createdAt, t.uuid),
  reviewIdx: index("rf_review_idx").on(t.reviewId),
  authorIdx: index("rf_author_idx").on(t.authorId),
  // One row per person per review: a manager nominating somebody the reviewee already suggested upgrades that
  // row rather than asking them twice.
  onceIdx: uniqueIndex("rf_once_idx").on(t.reviewId, t.authorId),
}));

// ---- Performance: agile kanban boards ----
// A kanban board: a team/department work-tracking surface. Flat-coded + HR/team-managed (like review-cycles).
// The workflow lives in `columnsJson` (ordered columns; a column IS the state - like ats.stages), with per-
// column WIP limits, explicit policies, and the commitment/delivery point flags. Swimlanes + classes of
// service are data too. `deliveryAdvancesGoal` opts the board into rolling a delivered card's progress up to
// its linked goal. Private-by-default (no seeded grant; super via ** until an admin widens via the ACL).
export const boards = sqliteTable("boards", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  description: text("description"),
  taskPrefix: text("task_prefix").notNull().default(""), // human task-key prefix, e.g. "MS" -> MS-1, MS-2 (per-board seq)
  // Continuous flow (kanban) or time-boxed iterations (scrum). Scrum layers `sprints` + card.sprintId on the
  // same board; the columns/cards/WIP/movements machinery is shared - only the view + analytics differ.
  mode: text("mode", { enum: ["kanban", "scrum"] }).notNull().default("kanban"),
  columnsJson: text("columns_json").notNull().default("[]"), // BoardColumn[]
  swimlaneMode: text("swimlane_mode", { enum: ["none", "assignee", "goal", "priority", "department", "custom"] }).notNull().default("none"),
  swimlanesJson: text("swimlanes_json").notNull().default("[]"), // Swimlane[] (used when swimlaneMode = custom)
  noLaneLabel: text("no_lane_label"), // custom mode only: label for the catch-all bucket (default "No lane")
  labelsJson: text("labels_json").notNull().default("[]"), // Label[] catalog {key,label,color}; cards reference keys
  // Swimlane display prefs (board view): hide lanes with no visible cards.
  hideEmptyLanes: integer("hide_empty_lanes", { mode: "boolean" }).notNull().default(false),
  // When on, dragging a card into another swimlane's cell reassigns the lane (custom → swimlane_key,
  // assignee/goal → that field). Off (default): swimlanes are locked; a cross-column drop keeps the card's own lane.
  reassignLaneOnMove: integer("reassign_lane_on_move", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("boards_page_idx").on(t.createdAt, t.uuid) }));

// A sprint: a time-boxed iteration on a scrum-mode board (flat-coded, board-scoped, HR/team-managed like the
// board itself). `state` runs planning -> active -> completed; at most one active sprint per board. Cards join
// a sprint via `card.sprintId` (null = product backlog). Completing a sprint sweeps its unfinished (undelivered)
// cards back to the product backlog. Burndown/velocity are computed from the cards' sizes + delivery times.
export const sprints = sqliteTable("sprints", {
  uuid: pk(),
  code: codeCol(),
  boardId: text("board_id").notNull().references(() => boards.uuid),
  name: text("name").notNull(),
  goal: text("goal"),
  startDate: integer("start_date", { mode: "timestamp_ms" }),
  endDate: integer("end_date", { mode: "timestamp_ms" }),
  state: text("state", { enum: ["planning", "active", "completed"] }).notNull().default("planning"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("sprints_page_idx").on(t.createdAt, t.uuid), boardIdx: index("sprint_board_idx").on(t.boardId) }));

// A card (work item) on a board. Employee-owned + code-scoped like goals (own/dept/all), so a member sees own
// cards / a manager the dept's / HR all. `columnKey` is the current column (= state); `rank` is a fractional
// order within (column, swimlane) so drag-reorder persists without renumbering siblings. `committedAt`/
// `startedAt`/`deliveredAt` are stamped the first time the card enters the commitment / first working / delivery
// column - they power lead time (delivered-committed) and cycle time (delivered-started). Optionally links to a
// `goal` (with `goalContribution` percent points) so delivery can advance the objective.
export const cards = sqliteTable("cards", {
  uuid: pk(),
  code: codeCol(),
  boardId: text("board_id").notNull().references(() => boards.uuid),
  seq: integer("seq"), // per-board incrementing number for the human key
  keyPrefix: text("key_prefix"), // board's task prefix copied at create → immutable key (MS-<seq>)
  sprintId: text("sprint_id").references(() => sprints.uuid), // scrum: the sprint this card is in (null = product backlog)
  employeeId: text("employee_id").notNull().references(() => employees.uuid), // owner
  // The card's department (the team doing the work). Defaults to the org-wide default department at create
  // (organization setting `default_department`); overridable per card; NULL = no department. Boards are NOT
  // tied to a department, so this is the card's own attribute, used for filtering/reporting.
  departmentId: text("department_id").references(() => departments.uuid),
  columnKey: text("column_key").notNull(),
  // When the card entered the column it is in now, stamped by the same write that moves it. Ageing WIP - a
  // card sat in review for a fortnight - is the whole point of a board, and the list view could not see it:
  // `cardMovements` holds the answer but is read only by the board roll-up, so a table would need the movement
  // log per row to age one column. Reset on every move, so it is "since this column", not "since it was filed".
  columnSince: integer("column_since", { mode: "timestamp_ms" }),
  swimlaneKey: text("swimlane_key"),
  rank: real("rank").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  assigneeId: text("assignee_id").references(() => employees.uuid),
  // Who FILED it, stamped once at create and never editable.
  //
  // The card already had two people on it and neither is this one: `employee_id` is the accountable owner
  // (and the authz code the row is scoped by, so it is reassigned deliberately) and `assignee_id` is whoever
  // is doing the work. When a manager files a card FOR somebody, both of those become that person and the
  // question "who asked for this, and who do I go back to about it" had no answer on the row at all - only an
  // audit entry, which the board cannot show and a filter cannot reach.
  //
  // Nullable because an admin login with no employee record can file one, and immutable because a reporter is
  // a fact about the past: correcting it would rewrite who raised the work.
  reporterId: text("reporter_id").references(() => employees.uuid),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  labelsJson: text("labels_json").notNull().default("[]"), // string[] of board label-catalog keys
  documentsJson: text("documents_json").notNull().default("[]"), // string[] of org-document uuids linked to this card (link-only; no card-owned storage)
  size: integer("size"), // estimate / story points
  dueDate: integer("due_date", { mode: "timestamp_ms" }),
  blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
  blockReason: text("block_reason"), // optional free-text note on the block
  blockedById: text("blocked_by_id").references((): AnySQLiteColumn => cards.uuid), // the task this one is blocked by (a dependency)
  goalId: text("goal_id").references(() => goals.uuid),
  // Repeating operational work: the weekly compliance sweep, the monthly access review, the quarterly backup
  // restore test. When set and the card is DELIVERED, the nightly tick files the next one (due date shifted by
  // the cadence) and MOVES the cadence onto it - so exactly one card in a series carries it, the same
  // invariant recurring 1:1s run on. Null = a one-off card, which is every card written before this existed.
  cadence: text("cadence", { enum: ["weekly", "biweekly", "monthly", "quarterly"] }),
  // The series' own day of the month, held so a month step can put the next occurrence back on it. Without
  // it a series steps from wherever the last one landed, and one February moves a 29th/30th/31st series to the
  // 28th for good (domain/calendar.ts#addMonthsFromAnchor). Null until the first roll, which takes it from the
  // occurrence's own date - the last moment that day is still the one the series was written with.
  cadenceAnchorDay: integer("cadence_anchor_day"),
  committedAt: integer("committed_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
// `seq` is UNIQUE per board because it is the card's human key (MS-4 on a sticky note, in a commit message,
// said out loud in a stand-up). It is allocated max+1 like a code, so two cards filed at the same moment
// compose the same number - and without the index both would keep it, leaving two different tasks answering
// to one name. The index fails the loser instead, and services/cards.ts re-numbers it.
}, (t) => ({ pageIdx: index("cards_page_idx").on(t.createdAt, t.uuid), boardIdx: index("card_board_idx").on(t.boardId), empIdx: index("card_emp_idx").on(t.employeeId, t.createdAt, t.uuid), deptIdx: index("card_dept_idx").on(t.departmentId), assigneeIdx: index("card_assignee_idx").on(t.assigneeId), reporterIdx: index("card_reporter_idx").on(t.reporterId), goalIdx: index("card_goal_idx").on(t.goalId), boardSeqIdx: uniqueIndex("card_board_seq_idx").on(t.boardId, t.seq),
  // The bottom of a column, as a SEEK rather than a walk. `nextRank` (services/cards.ts) asks
  // `max(rank) where board_id = ? and column_key = ? and delete_time is null` on every card create and every
  // cross-column move; without a matching index SQLite walks the board's whole range to answer it. With the
  // equality columns leading and `rank` next, the min/max optimisation turns it into one backward seek
  // (verified: SeekLE/Prev rather than Next). PARTIAL on the same predicate the query carries, so it indexes
  // only live cards - which is also what the WIP-limit read filters on.
  boardColRankIdx: index("card_board_col_rank_idx").on(t.boardId, t.columnKey, t.rank).where(sql`${t.deleteTime} is null`) }));

// Append-only movement log: one row per column transition of a card. INTERNAL (not a wire collection / route):
// written only by the card `move` verb and read only server-side by the board analytics roll-up, so it needs no
// code/authz plumbing. Powers the cumulative flow diagram (count per column over time) + lead/cycle time.
export const cardMovements = sqliteTable("card_movements", {
  uuid: pk(),
  cardId: text("card_id").notNull().references(() => cards.uuid),
  boardId: text("board_id").notNull().references(() => boards.uuid),
  fromColumn: text("from_column"), // null on the first placement (create)
  toColumn: text("to_column").notNull(),
  actorId: text("actor_id"), // employee uuid of who moved it (best-effort)
  at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => ({ boardIdx: index("cardmove_board_idx").on(t.boardId), cardIdx: index("cardmove_card_idx").on(t.cardId) }));

// A card's threaded comment (sub-resource, like ticket_comments): not a wire collection, emitted inline on the
// card Get and written via the card `:comment` verb. `authorId` is the commenter (employee), `authorEmail` the
// admin fallback when there's no employee identity.
export const cardComments = sqliteTable("card_comments", {
  uuid: pk(),
  cardId: text("card_id").notNull().references(() => cards.uuid),
  authorId: text("author_id").references(() => employees.uuid),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ cardIdx: index("cardcomment_card_idx").on(t.cardId) }));

// A checklist item (subtask) on a card - a working todo list. Like card_comments, it's a sub-resource reached
// only through the card's routes (not a wire collection), so access inherits the parent card. Items are added
// one-off or copied in bulk from a predefined `ticket-checklists` (the shared, generic checklist catalog);
// the text is snapshotted on copy. Ordered by createdAt; toggling `done` does not reorder.
export const cardTodos = sqliteTable("card_todos", {
  uuid: pk(),
  cardId: text("card_id").notNull().references(() => cards.uuid),
  text: text("text").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ cardIdx: index("ct_card_idx").on(t.cardId) }));

// Somebody who wants to hear about a card without being the one doing it.
//
// Notifications used to reach exactly one person, the assignee, on exactly two events (assigned, blocked). The
// people who actually need to know are wider and different: whoever raised it, whoever commented on it, the
// lead who cares that this particular card moves. Their only option was to remember to look, which for a card
// that moves once a week means finding out late.
//
// A sub-resource like the comments and the checklist (not a wire collection): reached through the card's own
// `:watch` / `:unwatch` verbs, so access inherits the parent card and nobody can watch a card they cannot
// read. The unique index makes watching idempotent - pressing it twice is one watcher, not two notifications.
export const cardWatchers = sqliteTable("card_watchers", {
  uuid: pk(),
  cardId: text("card_id").notNull().references(() => cards.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  createdAt: created(),
}, (t) => ({
  cardIdx: index("cw_card_idx").on(t.cardId),
  empIdx: index("cw_emp_idx").on(t.employeeId),
  onceIdx: uniqueIndex("cw_once_idx").on(t.cardId, t.employeeId),
}));

// ---- Onboarding / offboarding (employee transitions) ----
// A transition is one employee's onboarding or offboarding: a checklist of tasks tracked to done. Subject-owned
// (code-scoped like leave-requests, so own/dept/all apply); seeded from a template in settings/transition-templates.
// `anchorDate` is the start date (onboarding) or last working day (offboarding); task due dates derive from it.
export const transitions = sqliteTable("transitions", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  kind: text("kind", { enum: ["onboarding", "offboarding"] }).notNull(),
  name: text("name").notNull(),
  anchorDate: integer("anchor_date", { mode: "timestamp_ms" }),
  state: text("state", { enum: ["ACTIVE", "COMPLETED", "CANCELLED"] }).notNull().default("ACTIVE"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("transitions_page_idx").on(t.createdAt, t.uuid), empIdx: index("trn_emp_idx").on(t.employeeId, t.createdAt, t.uuid) }));

// A task within a transition. Owned (code-scoped) by the ASSIGNEE - the person who does it - so an assignee
// sees "tasks assigned to me" via own-scope and completes them, even though the transition belongs to someone
// else. `subjectId` is denormalized from the transition so the assignee's list can name who it's about. Tasks
// are also embedded in the transition for the subject/manager/HR view.
export const transitionTasks = sqliteTable("transition_tasks", {
  uuid: pk(),
  code: codeCol(),
  transitionId: text("transition_id").notNull().references(() => transitions.uuid),
  subjectId: text("subject_id").notNull().references(() => employees.uuid),
  assigneeId: text("assignee_id").notNull().references(() => employees.uuid),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: integer("due_date", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["TODO", "DONE"] }).notNull().default("TODO"),
  note: text("note"),
  // A background-verification check this task tracks (spawned from an onboarding template). The check's outcome
  // drives this task DONE; the task itself carries no sensitive status, so it's safe in the subject/manager view.
  backgroundCheckId: text("background_check_id").references(() => backgroundChecks.uuid),
  // Typed file-upload task: when set, this task collects a document (of this personal-document type). The
  // assignee uploads via :upload, which files a personal-document for the subject, links it here, and the
  // upload marks the task DONE. Null = a plain instruction/checkbox task.
  docType: text("doc_type"),
  documentId: text("document_id").references((): AnySQLiteColumn => personalDocuments.uuid),
  position: integer("position").notNull().default(0),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("transition_tasks_page_idx").on(t.createdAt, t.uuid), trnIdx: index("trt_trn_idx").on(t.transitionId), assigneeIdx: index("trt_assignee_idx").on(t.assigneeId) }));

// A 1:1 check-in between an employee (the report, who owns it) and a counterpart (usually their manager).
// Report-owned + code-scoped like leave-requests (own/dept/all), so the report sees their own, the manager
// sees their reports', HR all - and both the report and the manager may edit the shared notes. Lightweight:
// a date, shared notes, and a JSON list of action items. `counterpartId` is the other attendee.
export const checkIns = sqliteTable("check_ins", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  counterpartId: text("counterpart_id").references(() => employees.uuid),
  meetingDate: integer("meeting_date", { mode: "timestamp_ms" }),
  notes: text("notes"),
  actionItemsJson: text("action_items_json"), // [{ text, done }]
  // Recurring 1:1s: when set and meetingDate passes, the nightly cron creates the next one (carrying open
  // action items forward) and MOVES the cadence onto it - so exactly one row per pair carries the cadence.
  cadence: text("cadence", { enum: ["weekly", "biweekly", "monthly"] }),
  // The series' own day of the month, held so a month step can put the next occurrence back on it. Without
  // it a series steps from wherever the last one landed, and one February moves a 29th/30th/31st series to the
  // 28th for good (domain/calendar.ts#addMonthsFromAnchor). Null until the first roll, which takes it from the
  // occurrence's own date - the last moment that day is still the one the series was written with.
  cadenceAnchorDay: integer("cadence_anchor_day"),
  // Everything above is shared with the other party by design. These two are not.
  //
  // A 1:1 whose every word is read by both people is a 1:1 where the honest half goes in a private notebook
  // instead - so each side gets one note only they can read, served to its owner and stripped for everyone
  // else (see services/checkIns.ts). Two columns rather than one table because there are exactly two parties.
  employeeNote: text("employee_note"),
  counterpartNote: text("counterpart_note"),
  // How the meeting felt, 1 (bad) to 5 (great), recorded by the employee. One number, asked once a fortnight,
  // is the cheapest honest signal a manager gets; it is the employee's own, so the counterpart can read it but
  // never write it.
  pulse: integer("pulse"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("check_ins_page_idx").on(t.createdAt, t.uuid), empIdx: index("ci_emp_idx").on(t.employeeId, t.createdAt, t.uuid) }));

// ---- Benefits administration ----
// HR-managed catalog of benefit plans (flat-coded like leave-types). Flat monthly costs in v1 (no tier matrix).
export const benefitPlans = sqliteTable("benefit_plans", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  category: text("category", { enum: ["health", "dental", "vision", "life", "disability", "retirement", "other"] }).notNull().default("health"),
  description: text("description"),
  provider: text("provider"),
  employeeCost: real("employee_cost").notNull().default(0), // employee's contribution per costPeriod
  employerCost: real("employer_cost").notNull().default(0), // employer's contribution per costPeriod
  costPeriod: text("cost_period", { enum: ["month", "year"] }).notNull().default("month"), // the contributions are per this period
  allowsDependents: integer("allows_dependents", { mode: "boolean" }).notNull().default(false),
  // When true, a new hire is auto-enrolled in this plan (employees:enrollDefaultBenefits, wired via automation).
  autoEnroll: integer("auto_enroll", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

// An employee's dependent (for benefit coverage). Employee-owned + code-scoped (own/dept/all). Sensitive PII.
export const dependents = sqliteTable("dependents", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  name: text("name").notNull(),
  relationship: text("relationship", { enum: ["spouse", "child", "parent", "domestic_partner", "other"] }).notNull().default("other"),
  dateOfBirth: integer("date_of_birth", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("dependents_page_idx").on(t.createdAt, t.uuid), empIdx: index("dep_emp_idx").on(t.employeeId, t.createdAt, t.uuid) }));

// An employee's election for a plan. Employee-owned + code-scoped like leave-requests (own/dept/all); references
// a plan (read-gated) and an optional list of covered dependents (the employee's own).
export const benefitEnrollments = sqliteTable("benefit_enrollments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  planId: text("plan_id").notNull().references(() => benefitPlans.uuid),
  status: text("status", { enum: ["enrolled", "waived"] }).notNull().default("enrolled"),
  effectiveDate: integer("effective_date", { mode: "timestamp_ms" }),
  dependentsJson: text("dependents_json"), // [dependent uuid] of covered dependents
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("benefit_enrollments_page_idx").on(t.createdAt, t.uuid), empIdx: index("ben_emp_idx").on(t.employeeId, t.createdAt, t.uuid), planIdx: index("ben_plan_idx").on(t.planId) }));

// ---- Shift scheduling ----
// An HR-defined shift pattern (flat-coded catalog like leave-types). Times are wall-clock "HH:MM" in the org
// timezone; a roster assignment puts a shift on a date for an employee, and a work pattern hands it out on a
// repeating cycle. `end_time` at or before `start_time` is a NIGHT SHIFT: it runs past midnight, and the day
// it belongs to is the day it starts on (domain/workSchedule.ts).
export const shifts = sqliteTable("shifts", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  startTime: text("start_time").notNull().default("09:00"),
  endTime: text("end_time").notNull().default("18:00"),
  breakMinutes: integer("break_minutes").notNull().default(0),
  // What a day ON THIS SHIFT is worth, for the full/half-day ladder loss of pay is scored on
  // (domain/attendance.ts derivedCredit). Null on each is the derivation, which is what a shift almost always
  // wants: a full day is the shift itself (span less break) and half a day is half of that. Without them the
  // org's single `full_day_minutes` applied to every shift, so every day of a four-hour shift read as under
  // hours and was docked half a day. Set one only where the shift is genuinely not its own span - a nine-hour
  // window whose full day is eight.
  fullDayMinutes: integer("full_day_minutes"),
  halfDayMinutes: integer("half_day_minutes"),
  // Null = the org's own (`settings/attendance`). A shift with its own lateness allowance, or one judged on
  // minutes worked alone, says so here rather than forcing the org's answer onto everybody who works it.
  graceMinutes: integer("grace_minutes"),
  flexibleHours: integer("flexible_hours", { mode: "boolean" }),
  color: text("color"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

// A roster entry: an employee works a shift on a date, or is explicitly off that day. Employee-owned +
// code-scoped like leave-requests (own/dept/all), so an employee sees their own roster, a manager their
// team's, HR all.
//
// THE MOST SPECIFIC LAYER of a resolved day (domain/workSchedule.ts): an entry here beats the work pattern the
// person is on, which beats the org's own week. That is what a roster edit IS - cover on a day off, a swapped
// day, a one-off late shift - so it has to be able to say "off" as well as "this shift", or the only
// expressible exception is adding work.
export const shiftAssignments = sqliteTable("shift_assignments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // Null exactly when `kind` is "off" - a rest day names no shift. Required otherwise
  // (services/shiftAssignments.ts refuses a "shift" entry without one).
  shiftId: text("shift_id").references(() => shifts.uuid),
  kind: text("kind", { enum: ["shift", "off"] }).notNull().default("shift"),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  note: text("note"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("shift_assignments_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("sa_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  shiftIdx: index("sa_shift_idx").on(t.shiftId),
  dateIdx: index("sa_date_idx").on(t.date),
  // ONE roster entry per person per day, which is what every reader already assumes: the roster grid keys its
  // cells `(employeeId, date)` and keeps the last row it sees, so a second entry for the same cell is not a
  // second shift on screen - it is an invisible one. Editing the visible entry then leaves the hidden one
  // behind, the employee gets two "shift assigned" notifications, and the day's coverage count is one too
  // many. Partial, on the live rows only (like comp_open_idx): a soft-deleted entry must not block rostering
  // that person again on that day.
  empDayUniq: uniqueIndex("sa_emp_day_idx").on(t.employeeId, t.date).where(sql`${t.deleteTime} is null`),
}));

// A WORK PATTERN: the repeating shape of somebody's week, and the thing "a schedule" means to HR. A flat-coded
// catalog like `shifts` and `leave_types`.
//
// `days` is the cycle, as JSON: `cycle_weeks * 7` entries indexed `weekIndex * 7 + weekday` with weekday
// 0=Sun..6=Sat, each holding a shift uuid or null for a REST DAY. One `cycle_weeks` covers "Mon-Fri days" and
// "Mon/Wed/Fri mornings"; two or three cover a rotation. A rest day being a null entry rather than a separate
// working-day list is what keeps "which days does this person work" a single answer - the org's `work_days`
// and a per-person day list would be two, and they would drift.
//
// ONE JSON COLUMN rather than a child table because the cycle is at most 56 entries and every read wants all
// of it: a pattern costs one row read, not a join over a page of them (D1 bills rows read).
export const workPatterns = sqliteTable("work_patterns", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  cycleWeeks: integer("cycle_weeks").notNull().default(1),
  daysJson: text("days_json").notNull().default("[]"),
  color: text("color"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("work_patterns_page_idx").on(t.createdAt, t.uuid) }));

// One employee on one work pattern over a window - the MIDDLE layer of a resolved day. Employee-owned +
// code-scoped exactly like `shift_assignments`.
//
// DATE-RANGED rather than a single current pattern on the employee row, because payroll restates closed
// periods (services/payroll.ts recomputeLopUnits): somebody who moved to the night rotation in April must have
// their March loss of pay recomputed against the pattern they were on in March. `end_date` null is open ended.
//
// `anchor_date` is the date the cycle counts from, snapped to its own week, so two teams on the same
// three-week rotation offset by a week differ in this and nothing else. Null = `start_date`.
//
// Live assignments for one employee NEVER OVERLAP (checked in services/workPatternAssignments.ts - SQLite
// cannot express range overlap as an index), so a day resolves to at most one pattern.
export const workPatternAssignments = sqliteTable("work_pattern_assignments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  patternId: text("pattern_id").notNull().references(() => workPatterns.uuid),
  startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp_ms" }),
  anchorDate: integer("anchor_date", { mode: "timestamp_ms" }),
  note: text("note"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("work_pattern_assignments_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("wpa_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  patternIdx: index("wpa_pattern_idx").on(t.patternId),
  // The window read: every assignment overlapping a period, for the employees a payroll build is pricing.
  startIdx: index("wpa_start_idx").on(t.startDate),
}));

// ---- Timesheets / project time tracking ----
// A project to log time against (flat-coded catalog like leave-types). `code` (wire) is an optional human
// project code, distinct from the internal scope code. `client` is a free-text label (no separate clients
// entity in v1).
export const projects = sqliteTable("projects", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  client: text("client"),
  projectCode: text("project_code"),
  billable: integer("billable", { mode: "boolean" }).notNull().default(true),
  // The goal this project's work is FOR, when it is for one. Hours are booked against projects and outcomes
  // are tracked as goals, and the two have never been able to see each other: this link is what lets a goal
  // say "140 hours logged, 30% done", which is the pairing that catches effort going into something that is
  // not moving.
  goalId: text("goal_id").references((): AnySQLiteColumn => goals.uuid),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

// A time entry: an employee logs hours on a project on a date. Employee-owned + code-scoped (own/dept/all, like
// leave-requests); workflow DRAFT -> SUBMITTED -> APPROVED/REJECTED via grantable verbs.
export const timeEntries = sqliteTable("time_entries", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  projectId: text("project_id").notNull().references(() => projects.uuid),
  // The board task this hour went into, when the work is tracked as a card. Optional and secondary to the
  // project: time still books to a project (that is what a timesheet approves and what a client is billed
  // for), and this only says which task inside it - so "what did that task actually cost" has an answer where
  // the board is the unit of work. Null on every entry booked straight to a project.
  cardId: text("card_id").references(() => cards.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  hours: real("hours").notNull().default(0),
  description: text("description"),
  billable: integer("billable", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"] }).notNull().default("DRAFT"),
  decidedBy: text("decided_by").references(() => users.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("time_entries_page_idx").on(t.createdAt, t.uuid), empIdx: index("te_emp_idx").on(t.employeeId, t.createdAt, t.uuid), projIdx: index("te_proj_idx").on(t.projectId), cardIdx: index("te_card_idx").on(t.cardId), dateIdx: index("te_date_idx").on(t.date) }));

// ---- Loans / salary advances ----
// An employee's loan or salary advance, recovered over monthly installments. Employee-owned + code-scoped
// (own/dept/all, like leave-requests). Workflow PENDING -> APPROVED -> DISBURSED -> CLOSED (+ REJECTED).
// `monthlyAmount` is computed on approval (principal / installments); `repaid` accrues via recordRepayment;
// outstanding = principal - repaid (derived on the wire). A payroll run recovers one installment per calendar
// month from the agreed `startDate` onward, capped so net never goes negative (services/loans.ts).
export const loans = sqliteTable("loans", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  kind: text("kind", { enum: ["loan", "advance"] }).notNull().default("loan"),
  principal: real("principal").notNull().default(0),
  installments: integer("installments").notNull().default(1),
  monthlyAmount: real("monthly_amount").notNull().default(0),
  repaid: real("repaid").notNull().default(0),
  reason: text("reason"),
  startDate: integer("start_date", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["PENDING", "APPROVED", "DISBURSED", "CLOSED", "REJECTED"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("loans_page_idx").on(t.createdAt, t.uuid), empIdx: index("loan_emp_idx").on(t.employeeId, t.createdAt, t.uuid) }));

// Loan repayment ledger: one row per installment a payroll run deducted from a disbursed loan. A loan repays
// over MANY runs (unlike a one-shot bonus/reimbursement), so the repayment history is a ledger, not a single
// paidRunId. Keyed by (loanId, runId): a payroll rebuild deletes this run's rows and re-inserts, so it stays
// idempotent; the loan's `repaid`/`status` are kept in sync. Internal (no wire code / no route).
export const loanRepayments = sqliteTable("loan_repayments", {
  uuid: pk(),
  loanId: text("loan_id").notNull().references((): AnySQLiteColumn => loans.uuid),
  // Nullable: a payroll-driven repayment links its run; a MANUAL repayment (recordLoanRepayment) has no run,
  // so runId is null. resetLoanRepaymentStmts matches a specific runId, so null (manual) rows are never
  // reversed by a run delete - which is correct, a manual repayment isn't undone by deleting a payroll run.
  runId: text("run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  // The reimbursement claim whose approval produced this credit, for a claim settled against an ADVANCE.
  // Null for a payroll installment and for a manual repayment, which is why the uniqueness below is partial.
  //
  // THIS COLUMN IS A LOCK, not a cross-reference. D1 runs a batch as one transaction, but a zero-row UPDATE is
  // not an error - so two concurrent approvals of the same claim each ran their batch to completion, the
  // loser's guarded claim-flip matched nothing, and its credit landed anyway: the advance was discharged
  // TWICE for one claim. `runBatchChecked` reported the mismatch afterwards, which is too late, because the
  // money had already moved. A UNIQUE VIOLATION is an error, and an error is the one thing that makes D1 roll
  // the whole batch back - so the loser now writes nothing at all.
  reimbursementId: text("reimbursement_id").references((): AnySQLiteColumn => reimbursements.uuid),
  amount: real("amount").notNull(),
  at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  loanIdx: index("loan_repayment_loan_idx").on(t.loanId),
  runIdx: index("loan_repayment_run_idx").on(t.runId),
  // One credit per claim, ever. Partial, so the payroll and manual rows (which carry no claim) are unaffected.
  claimUniq: uniqueIndex("loan_repayment_claim_idx").on(t.reimbursementId).where(sql`${t.reimbursementId} is not null`),
}));

// ---- Investment / tax declarations ----
// One declared tax-saving item for a financial year (e.g. 80C: ELSS 50000). Employee-owned + code-scoped
// (own/dept/all, like leave-requests). Workflow DECLARED -> VERIFIED/REJECTED by payroll/HR; `verifiedAmount`
// is what they accept. A proof file attaches via the attachments service (slot "proof"), like reimbursement
// receipts. VERIFIED amounts reduce withholding: the payroll build and the Tax page feed them through
// allowedDeductions (domain/incomeTax.ts), which keeps only the sections the regime permits, each capped - under
// the new regime that is 80CCD(2)/80CCH alone. A merely DECLARED row never moves tax (verification is the gate).
export const taxDeclarations = sqliteTable("tax_declarations", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  financialYear: text("financial_year").notNull(),
  section: text("section").notNull(),
  label: text("label"),
  declaredAmount: real("declared_amount").notNull().default(0),
  verifiedAmount: real("verified_amount"),
  status: text("status", { enum: ["DECLARED", "VERIFIED", "REJECTED"] }).notNull().default("DECLARED"),
  note: text("note"),
  decidedBy: text("decided_by").references(() => users.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("tax_declarations_page_idx").on(t.createdAt, t.uuid), empIdx: index("td_emp_idx").on(t.employeeId, t.createdAt, t.uuid), fyIdx: index("td_fy_idx").on(t.financialYear) }));

// Append-only audit trail (INSERT-only; never updated/deleted/purged, and deliberately NOT registered in
// authzResolve TABLES so no CRUD/delete route can target it). Read back only via the on-demand activity API.
export const auditLog = sqliteTable("audit_log", {
  uuid: pk(),
  code: codeCol(),
  actorEmail: text("actor_email").notNull(),
  actorId: text("actor_id"), // employee uuid of the actor when known (null for system/automation/no-employee)
  actorName: text("actor_name"), // actor's display name AS OF the event (point-in-time snapshot; null for system/nameless)
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  entityName: text("entity_name"), // descriptive label of the touched record AS OF the event (point-in-time snapshot)
  meta: text("meta"), // JSON: change details, incl. `diff` ({field:{from,to}}) on updates
  // The API key the request rode, when it rode one. The actor columns name the HUMAN the key acts as (that is
  // what a key is), so without this "what has this credential been doing?" - the question incident response
  // actually asks, and the one that decides whether revoking it is safe - has no answer. `meta.via_api_key`
  // carries the key's point-in-time name for display; this column is what makes it queryable.
  apiKeyId: text("api_key_id"),
  // The role the actor held AS OF the event. Roles are data and they change, so "who approved this settlement"
  // reads differently once the approver is no longer payroll_admin - the same point-in-time argument
  // `actor_name` is snapshotted for.
  actorRole: text("actor_role"),
  // What one ACT was. A single request writes many entries - accepting an offer creates the employee, their
  // compensation, the hire and the transition's tasks - and without this they are six unrelated lines that
  // happen to share a timestamp. The trace is minted per request (middleware) or per cron tick, and the
  // workflow engine already threads the SAME id through event_log / automation_runs / workflow_instances
  // (`correlation_id` there), so an automation's writes join to the run that caused them and to the human
  // request that set the whole thing off.
  correlationId: text("correlation_id"),
  // WHO the entry is about, as opposed to who performed it. The two differ in exactly the cases that matter -
  // a manager approving somebody else's leave, payroll revising somebody else's pay - and without this the
  // question "everything that happened to Asha" spans a dozen collections with no index behind it. Populated
  // from the `employee` ref the meta already carries, so it costs no call site anything.
  subjectId: text("subject_id"),
  // The SITTING. A correlation id groups one act; this groups every act of one login - "what did they do while
  // signed in from that address on Tuesday", which is the question an incident review actually opens with and
  // which per-request traces cannot answer. Derived from the session cookie's issue instant, so it is stable
  // for the life of a session and changes on the next sign-in. Null on lanes that carry no session (an API
  // key, a Cloudflare Access assertion, the dev bypass, cron).
  sessionId: text("session_id"),
  // Request IP, from `cf-connecting-ip` ONLY - the address the edge observed. Never from a forwarding header:
  // this is a security record, and a caller-supplied one would let the subject of an investigation pick the
  // address it reads back. Null when there is none to observe (cron, internal dispatch, off-edge deploys).
  ip: text("ip"),
  userAgent: text("user_agent"), // request User-Agent, when available
  at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  entIdx: index("audit_entity_idx").on(t.entity, t.entityId), // per-entity feed
  atIdx: index("audit_at_idx").on(t.at), // org-wide feed (newest-first keyset paging)
  // "Everything that happened in this one act", the query the correlation id exists to answer. Partial: an
  // entry written outside any traced request carries none, and indexing those would be indexing nulls.
  corrIdx: index("audit_corr_idx").on(t.correlationId, t.at).where(sql`${t.correlationId} is not null`),
  // One person's whole timeline, across every collection. Partial for the same reason as the two above: most
  // entries are about a record rather than a person, and indexing their nulls buys nothing.
  subjIdx: index("audit_subject_idx").on(t.subjectId, t.at).where(sql`${t.subjectId} is not null`),
  sessIdx: index("audit_session_idx").on(t.sessionId, t.at).where(sql`${t.sessionId} is not null`),
  // "Everything this person did", asked by email rather than by id - the Activity page's actor box. It is a
  // PREFIX match (services/activity.ts), which is what makes an index usable at all; with the leading-wildcard
  // LIKE it used to be, this filter scanned the whole table beside three neighbours that are seeks.
  actorEmailIdx: index("audit_actor_email_idx").on(t.actorEmail, t.at),
  // Partial: nearly every row is a human's, so indexing only the key-borne ones keeps this tiny and costs
  // almost nothing on the write path that every audited request pays.
  keyIdx: index("audit_api_key_idx").on(t.apiKeyId, t.at).where(sql`${t.apiKeyId} is not null`),
}));

// `jobs` doubles as the AEP Operation store (operations/{id}).
export const jobs = sqliteTable("jobs", {
  uuid: pk(),
  code: codeCol(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  createdBy: text("created_by").references((): AnySQLiteColumn => users.uuid), // who ran it (audit lineage)
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid), // owner (scope key); null = admin-only visibility
  status: text("status", { enum: ["queued", "running", "done", "error"] }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  resultJson: text("result_json"),
  // When set, the drain skips this job until now >= runAfter (delayed automation actions; null = run asap).
  runAfter: integer("run_after", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("jobs_page_idx").on(t.createdAt, t.uuid), statusIdx: index("jobs_status_idx").on(t.status) }));

// One row per scheduled (cron) tick, written by runScheduled: makes "did it run / when / how long / did it
// fail" observable (the crons themselves are stateless Cloudflare triggers that record nothing). Admin-only.
// One row per write a client sent with an `Idempotency-Key` (middleware/idempotency.ts): the answer it got, so
// a retry of the same write is handed that answer instead of doing the write twice. `status` 0 marks a write
// still in flight. Keyed per principal, because a key is only unique within the client that minted it. Swept
// nightly (cron.ts) - a retry arrives within seconds, so a day is a generous window.
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  principal: text("principal").notNull(),
  key: text("key").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull().default(0),
  headersJson: text("headers_json"), // the answer's Content-Type, ETag and Location, replayed with it
  body: text("body"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.principal, t.key] }), createdIdx: index("idempotency_keys_created_idx").on(t.createdAt) }));

export const cronRuns = sqliteTable("cron_runs", {
  uuid: pk(),
  code: codeCol(),
  cron: text("cron").notNull(), // the expression that fired, e.g. "*/5 * * * *"
  status: text("status", { enum: ["running", "done", "error"] }).notNull().default("running"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  durationMs: integer("duration_ms"),
  error: text("error"),
  summaryJson: text("summary_json"), // per-tick result, e.g. {"drained":3} or {"accrued":12,"reminders":4}
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("cron_runs_page_idx").on(t.createdAt, t.uuid), cronIdx: index("cron_runs_cron_idx").on(t.cron), startedIdx: index("cron_runs_started_idx").on(t.startedAt) }));

// ---- AI layer ----
// One row per inference, written whether the call succeeded or not. Two jobs, and the second is the reason
// the first is not enough on its own:
//
//   MEASUREMENT. Cloudflare's free allocation is 10,000 Neurons/day for the whole account, and the per-model
//   neuron cost of a real workload is not something a pricing table answers - it depends on our prompts and
//   our text lengths. `estimatedNeurons` starts as the pessimistic guess in domain/aiPolicy.ts and this table
//   is what replaces it with a measurement, so the budget ceilings can be retuned from evidence.
//
//   ACCOUNTABILITY. An AI layer over HR data has to be able to answer "what was sent to a model, by whom,
//   about what" a year later. So the row records the FEATURE, the caller, and the subject it concerned - and
//   `inputHash` rather than the input. Storing the prompt would recreate, inside our own database, exactly
//   the retained copy of salary and review text that lib/ai.ts suppresses at the gateway.
export const aiUsage = sqliteTable("ai_usage", {
  uuid: pk(),
  feature: text("feature").notNull(), // "search.embed", "tickets.triage", "announcements.draft", ...
  model: text("model").notNull(), // the @cf/... id actually called
  role: text("role", { enum: ["embed", "rerank", "generate", "moderate"] }).notNull(),
  userId: text("user_id").references((): AnySQLiteColumn => users.uuid), // null = a cron/system call
  subject: text("subject"), // "<collection>/<uuid>" the call concerned, for the accountability question
  inputHash: text("input_hash").notNull(), // sha256 of the prompt. NEVER the prompt itself.
  inputChars: integer("input_chars").notNull().default(0),
  outputChars: integer("output_chars").notNull().default(0),
  estimatedNeurons: integer("estimated_neurons").notNull().default(0),
  cacheHit: integer("cache_hit", { mode: "boolean" }).notNull().default(false),
  durationMs: integer("duration_ms"),
  outcome: text("outcome", { enum: ["ok", "error", "refused", "budget"] }).notNull().default("ok"),
  error: text("error"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("ai_usage_page_idx").on(t.createdAt, t.uuid),
  // The budget check is "neurons spent since midnight UTC", so it reads by time. Without this index that
  // check would scan the table, and it runs before every single inference.
  spendIdx: index("ai_usage_spend_idx").on(t.createdAt),
  userIdx: index("ai_usage_user_idx").on(t.userId, t.createdAt),
  featureIdx: index("ai_usage_feature_idx").on(t.feature),
}));

// Generation results, keyed by (feature, prompt version, hash of the inputs). A review-cycle summary nobody
// edited costs one inference forever, which on a 10,000-neuron day is the difference between a feature being
// affordable and not.
//
// The output IS stored here, unlike in `ai_usage`, and that is a deliberate distinction rather than an
// inconsistency: the output is already being shown in the app and is about to be written to a record, so it
// lives in the same database under the same access control as the record it describes. The INPUT still is not
// stored - a hash is enough to match a cache entry, and storing the prompt would mean keeping a second copy
// of source text that already exists in its own table.
export const aiCache = sqliteTable("ai_cache", {
  uuid: pk(),
  cacheKey: text("cache_key").notNull(), // sha256(feature | promptVersion | inputs)
  feature: text("feature").notNull(),
  output: text("output").notNull(),
  hits: integer("hits").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  keyIdx: uniqueIndex("ai_cache_key_idx").on(t.cacheKey),
  // The nightly sweep deletes by expiry; without this it would scan.
  expiryIdx: index("ai_cache_expiry_idx").on(t.expiresAt),
}));

// A machine's suggestion about one record, and what a human did with it.
//
// Generic in its key (`hostCollection` + `hostRecordId`) but NOT a wire collection: it is served as a
// sub-resource of whatever it is about, gated by read on that record, so there is no separate question of who
// may see a suggestion about somebody else's ticket. Promoting it to a collection later, when a second host
// exists, is a route change rather than a migration - which is why the columns are host-agnostic now.
//
// It exists for two reasons, and neither is "so the app can act on it":
//   PROVENANCE. An AI layer over HR data has to be able to say which suggestions were made, by which model,
//   from what evidence, and whether a person took them. `basis` records the evidence count - "4 of the 7
//   nearest resolved tickets" - so a suggestion can be re-explained after the fact.
//   MEASUREMENT. The accept rate is the only honest signal of whether a feature is worth its neurons. A
//   suggestion nobody takes is a feature to remove, and without this table that is unanswerable.
//
// Accepting does NOT write through this table. The UI calls the record's own verb (`tickets:route`,
// `tickets:prioritize`), so the change goes through the normal service with the normal validation and audit
// trail, and `state` here is only the record of what was decided.
export const aiSuggestions = sqliteTable("ai_suggestions", {
  uuid: pk(),
  hostCollection: text("host_collection").notNull(), // "tickets"
  hostRecordId: text("host_record_id").notNull(),
  feature: text("feature").notNull(), // "tickets.triage"
  payloadJson: text("payload_json").notNull(), // the suggested values + the neighbours that produced them
  model: text("model").notNull(),
  basis: integer("basis").notNull().default(0), // how many neighbours the vote was taken over
  state: text("state", { enum: ["pending", "accepted", "rejected", "superseded"] }).notNull().default("pending"),
  decidedBy: text("decided_by").references((): AnySQLiteColumn => users.uuid),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  // One live suggestion per record per feature: a recomputation REPLACES the previous one rather than
  // stacking, so the panel never has to choose between two answers and the accept rate counts records, not
  // page opens.
  hostIdx: uniqueIndex("ai_suggestions_host_idx").on(t.hostCollection, t.hostRecordId, t.feature),
  stateIdx: index("ai_suggestions_state_idx").on(t.feature, t.state),
}));

// What the semantic index currently holds, and for which version of the text. The VECTORS are in Vectorize
// (see lib/vector.ts for why they are not here); this is the bookkeeping that makes the index reconcilable.
//
// Without it there is no way to answer either of the two questions the embed drain has to ask every tick:
// which `search_docs` rows have changed since they were embedded (compare `textHash`), and which entries in
// the index no longer have a row behind them at all. The second matters because `search_docs` is maintained
// by SQL triggers - a delete happens inside the database, where nothing can call Vectorize - so orphans are
// found by outer-joining this table against `search_docs` rather than by noticing the delete as it happens.
//
// `model` is recorded because vectors from two models are not comparable. Changing the embedding model means
// every row needs re-embedding, and this column is what makes that a query rather than a guess.
export const searchVectors = sqliteTable("search_vectors", {
  uuid: pk(),
  collection: text("collection").notNull(),
  recordId: text("record_id").notNull(),
  textHash: text("text_hash").notNull(), // sha256 of the title + subtitle that was embedded
  model: text("model").notNull(),
  embeddedAt: integer("embedded_at", { mode: "timestamp_ms" }).notNull(),
  // When the drain last COMPARED this row's text against its hash, which is not the same as when it last
  // embedded it: a row that has not changed is checked and left alone.
  //
  // It exists to make the sweep a rotation. `search_docs` is trigger-maintained and carries no updated_at, so
  // "has this row's text changed" can only be answered by hashing it, which means reading rows that are
  // probably fine. Ordering the sweep by this column oldest-first means every row comes up for inspection in
  // turn; without it the drain would re-examine whatever the database handed back first and could leave the
  // rest of the table permanently unvisited.
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  // Mirrors the key `search_docs` is unique on, which is also the Vectorize id (lib/vector.ts vectorIdOf).
  recordIdx: uniqueIndex("search_vectors_record_idx").on(t.collection, t.recordId),
  modelIdx: index("search_vectors_model_idx").on(t.model),
  // The sweep's order. Without this the rotation below would sort the whole table every five minutes.
  checkedIdx: index("search_vectors_checked_idx").on(t.checkedAt),
}));

// Which public posts have been through the moderation model, and on what text.
//
// WHY A TABLE AND NOT A LOOK AT `ai_suggestions`. The flag row only exists when the model OBJECTED, so a post
// that was scanned and found unremarkable is indistinguishable from one that has never been scanned - and the
// unremarkable case is nearly all of them. Without this the drain would re-scan the whole wall every five
// minutes, which for a generation-class model is the most expensive possible way to learn nothing.
//
// `textHash` is what makes it reconciling rather than a one-shot stamp, exactly as it is for `search_vectors`:
// an edited post hashes differently and comes back round for a re-scan, so somebody cannot post something
// innocuous and edit it afterwards. `model` is recorded for the same reason it is there - a different guard
// model is a different opinion, and changing it should re-scan rather than trust the old verdict.
export const moderationScans = sqliteTable("moderation_scans", {
  uuid: pk(),
  collection: text("collection").notNull(),
  recordId: text("record_id").notNull(),
  textHash: text("text_hash").notNull(), // sha256 of the title + body that was scanned
  model: text("model").notNull(),
  /** What the scan concluded, kept so the queue can report coverage ("scanned, nothing found") rather than
   *  only ever showing the objections. */
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  scannedAt: integer("scanned_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  recordIdx: uniqueIndex("moderation_scans_record_idx").on(t.collection, t.recordId),
  // The sweep's order: oldest scan first, so a backlog drains in age order rather than whatever the database
  // hands back, and no post can sit unvisited forever behind a busier one.
  scannedIdx: index("moderation_scans_scanned_idx").on(t.scannedAt),
}));

// ---- Workflow & automation engine ----
// Append-only record of every emitted domain event (see services/eventBus.ts). The spine that makes the
// system coherent: services announce "X happened" here, and the automation engine reacts. Flat, admin-only
// (HR + super); observable + the substrate the engine dispatches from. `subject` = "<collection>/<uuid>".
export const eventLog = sqliteTable("event_log", {
  uuid: pk(),
  code: codeCol(),
  type: text("type").notNull(), // e.g. "leave.approved" (see domain/events.ts EVENT_TYPES)
  subject: text("subject"), // the resource this is about, "<collection>/<uuid>" (nullable for org-wide events)
  actorId: text("actor_id").references((): AnySQLiteColumn => users.uuid), // who triggered it (audit lineage)
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid), // primary employee concerned (scoping/conditions)
  payloadJson: text("payload_json"), // event-specific fields (domain/events.ts documents the shape per type)
  correlationId: text("correlation_id"), // trace id shared by every event/run/instance of one workflow execution
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("event_log_page_idx").on(t.createdAt, t.uuid), typeIdx: index("event_log_type_idx").on(t.type), occurredIdx: index("event_log_occurred_idx").on(t.occurredAt), corrIdx: index("event_log_corr_idx").on(t.correlationId) }));

// The rules: one row = one `when <triggerType> [if <condition>] then <actions[]>`. Config-as-data - HR
// authors these (via the ACL-gated route/UI) instead of shipping code. conditionJson/actionsJson are the
// domain/automations.ts shapes. Flat, HR + super only (authoring is the privileged act; actions run with
// system authority). Carries the standard lifecycle flags (enable/disable/lock) via the shared helpers.
export const automations = sqliteTable("automations", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  description: text("description"),
  triggerType: text("trigger_type").notNull(), // the event type that fires this rule (or "schedule.recurring" for time-driven)
  conditionJson: text("condition_json"), // predicate tree (domain/automations.ts Condition); null = always
  actionsJson: text("actions_json").notNull(), // Action[] to run when matched
  // Time-driven rules: recurrence spec (domain/automations.ts Schedule). Non-null iff triggerType is
  // "schedule.recurring" - a daily cron scanner fires the rule when the recurrence matches today, instead of
  // an inbound event. Turns the engine PROACTIVE (weekly nudges, month-start prep) with no code.
  scheduleJson: text("schedule_json"),
  // Idempotency guard for scheduled rules: the last date (YYYY-MM-DD) this rule fired on, so a re-run of the
  // daily tick (or a manual trigger) the same day can't double-fire. Claimed with a guarded update.
  lastScheduledOn: text("last_scheduled_on"),
  // Whether the rule fires, as the SHARED lifecycle column every collection uses (:enable / :disable). There
  // used to be a second `enabled` column meaning the same thing, which left two answers to "does this rule
  // fire" and a lifecycle verb that wrote the wrong one. The wire field is still `enabled` (see
  // toAutomationResource) - one column, one meaning, unchanged API.
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  // Was the LAST person to write this rule a super admin? Not decoration: an `emitEvent` action re-emits a
  // domain event with an author-chosen type and payload, and the event's SUBJECT is inherited from whatever
  // triggered the relaying rule. Without this, an hr_admin - who may author `emitEvent` but never `apiCall` -
  // could relay into a super-authored rule whose action is `POST /v1/{{subject}}:approve` and have it run, as
  // super, against a record of their choosing. The engine refuses that by asking this column (see
  // automationEngine.ts dispatchAutomations). Stamped on every create and update, so a non-super edit of a
  // super-authored rule downgrades it; the seeds default to trusted because bootstrap.sql IS the app.
  superAuthored: integer("super_authored", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").references((): AnySQLiteColumn => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("automations_page_idx").on(t.createdAt, t.uuid), triggerIdx: index("automations_trigger_idx").on(t.triggerType) }));

// A SUSPENDED durable workflow (Temporal-lite). Written when a rule's `waitFor` action pauses the chain: it
// persists the wait arms (event/timer selectors + their continuation `then`), the accumulated results bag, the
// correlation values, and the loop-depth. Resumed when a matching event is emitted (resume hook in
// automationEngine) or a timer arm fires (cron `workflow.timer` job). First arm to fire flips status off
// `waiting` (atomic guard) so the race resolves once. No hardcoded timeout - a timeout is just an optional timer
// arm the author sets (or omits = wait forever, durably). See docs/workflow-engine-plan.md (PR5).
export const workflowInstances = sqliteTable("workflow_instances", {
  uuid: pk(),
  code: codeCol(),
  automationId: text("automation_id").references((): AnySQLiteColumn => automations.uuid),
  status: text("status", { enum: ["waiting", "done", "expired", "error"] }).notNull().default("waiting"),
  awaitedTypes: text("awaited_types"), // comma-joined event types across the event arms (cheap resume prefilter)
  armsJson: text("arms_json").notNull(), // WaitArm[] (event/timer selector + each arm's `then` continuation)
  resultsJson: text("results_json"), // accumulated results bag (data-passing) at suspend time
  originType: text("origin_type"), // the event type that started the workflow (context reconstruction)
  subject: text("subject"),
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid),
  correlationId: text("correlation_id"), // trace id of the workflow execution this instance belongs to
  depth: integer("depth").notNull().default(0), // loop-guard depth carried across the suspend
  resumedAt: integer("resumed_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("workflow_instances_page_idx").on(t.createdAt, t.uuid), statusIdx: index("workflow_instances_status_idx").on(t.status) }));

// Observability of each firing (like cron_runs): which rule fired for which event, and the per-action outcome.
export const automationRuns = sqliteTable("automation_runs", {
  uuid: pk(),
  code: codeCol(),
  // Nullable for exactly one case: a `dropped` row, which records that the per-request dispatch budget was
  // exhausted and events went unprocessed. No single rule caused that and none was even loaded, so there is
  // no automation to point at. Every other status names its rule.
  automationId: text("automation_id").references((): AnySQLiteColumn => automations.uuid),
  eventId: text("event_id").references((): AnySQLiteColumn => eventLog.uuid),
  eventType: text("event_type").notNull(),
  status: text("status", { enum: ["done", "partial", "error", "skipped", "dropped"] }).notNull(),
  resultJson: text("result_json"), // per-action outcome array
  // Denormalized from the triggering event so a run shows WHAT/WHO it was about without a join, and shares the
  // workflow execution's trace id for grouping.
  subject: text("subject"),
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid),
  correlationId: text("correlation_id"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("automation_runs_page_idx").on(t.createdAt, t.uuid), autoIdx: index("automation_runs_auto_idx").on(t.automationId), startedIdx: index("automation_runs_started_idx").on(t.startedAt), corrIdx: index("automation_runs_corr_idx").on(t.correlationId) }));

// ---- Payroll (compensation & payslips; single jurisdiction; NO tax engine) ----
export const compensation = sqliteTable("compensation", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // Contractual monthly BASIC - the wage anchor. EPF (both shares), percent_base allowances, gratuity,
  // encashment/overtime rates and pay-grade bands all key off this. Gross = basic + earning components;
  // CTC = gross + employer contributions (employer PF/ESI/gratuity are ON TOP, never carved out of basic).
  // Authoritative figure: the annual CTC entered for this revision. Everything the user sees leads with this;
  // basePay + specialAllowance below are its DERIVED split (basic = ctc.basic_pct% of monthly CTC, special
  // allowance balances the rest) cached so payroll/tax/statutory math has a concrete monthly basic to key off.
  ctcAnnual: real("ctc_annual").notNull().default(0), // default only satisfies the SQLite ADD COLUMN; every write sets it (annual_ctc > 0 enforced)
  basePay: real("base_pay").notNull(),
  // Balancing plug of the split: a per-employee taxable fixed earning that, on top of basic + structure
  // earnings + employer contributions, makes total CTC land on ctcAnnual. Paid as a "Special Allowance" line.
  specialAllowance: real("special_allowance").notNull().default(0),
  currency: text("currency").notNull().default("INR"),
  // Target variable pay for a full year at 100% attainment - the bonus this person is playing for, agreed
  // when their compensation is. Deliberately NOT part of `ctcAnnual`: CTC is what the company has committed
  // to pay, and a figure that has to be earned is not a commitment. Null for anybody with no variable
  // component, which is most people in most orgs.
  variablePayTarget: real("variable_pay_target"),
  payGradeId: text("pay_grade_id").references((): AnySQLiteColumn => payGrades.uuid),
  // Optional salary structure: governs which recurring EARNING components apply to this employee (with
  // per-structure rate overrides). Null = the global component set applies (default behaviour).
  structureId: text("structure_id").references((): AnySQLiteColumn => salaryStructures.uuid),
  effectiveFrom: integer("effective_from", { mode: "timestamp_ms" }).notNull(),
  effectiveTo: integer("effective_to", { mode: "timestamp_ms" }), // null = current
  // Retro arrears owed by a BACKDATED revision: (new base - prior base) x whole months from effective_from to
  // the revision month. Paid as a taxable earning by the next payroll run; paidRunId pins which run (idempotent).
  arrearsAmount: real("arrears_amount").notNull().default(0),
  // The PF-wage slice of those arrears (the rise in BASIC x the same months). PF is due on arrears of basic
  // wages, not on the whole gross delta, so the payroll run needs the two figures apart; ESI is due on the
  // whole arrears amount and uses `arrearsAmount`.
  arrearsBaseAmount: real("arrears_base_amount").notNull().default(0),
  // Which already-published periods `arrearsAmount` is owed FOR, as a JSON array of
  // {label, months, amount} - the breakdown the pricing already computes on its way to the total.
  //
  // STORED rather than derived, and that is the whole point: `arrearsAmount` is frozen at the moment of the
  // revision, because it depends on which periods had published by then. Recomputing the breakdown later - once
  // more runs have published - would produce a list that no longer describes the money actually paid, so the
  // payslip would explain an arrear with months it never covered. Null on rows written before this existed and
  // on rows that owe nothing; the payslip then shows the total alone, exactly as it did.
  arrearsPeriodsJson: text("arrears_periods_json"),
  arrearsPaidRunId: text("arrears_paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  arrearsPaidAt: integer("arrears_paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
  // Soft delete: a revision entered by mistake is taken OUT OF THE TIMELINE but kept as a row, so the audit
  // trail - and any published payslip that was priced against it - still resolves to something. Removing a row
  // heals the chain: the preceding revision absorbs the removed window, and reopens if the removed row was the
  // current one. Every timeline read therefore filters on `delete_time is null`.
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  // At most ONE open (current) LIVE row per employee, enforced by the DB. A revision closes the open row and
  // inserts a new one in two statements; two concurrent revisions would otherwise both close the same row and
  // leave TWO open rows - an ambiguous current salary, and arrears computed (and paid) twice off the same delta.
  // Soft-deleted rows are outside the predicate, so removing the current revision (which reopens its
  // predecessor) and correcting a row's dates never trip the constraint on a row nobody can see.
}, (t) => ({
  empIdx: index("comp_emp_idx").on(t.employeeId),
  openUniq: uniqueIndex("comp_open_idx").on(t.employeeId).where(sql`${t.effectiveTo} is null and ${t.deleteTime} is null`),
}));

// Effective-dated role history (designation + department + location). A promotion or transfer is a NEW row
// effective from a chosen date; the previously-current row is closed (effective_to set). The employee's
// jobTitle/departmentId mirror the current row (kept in sync on change) so the rest of the app reads them
// unchanged; this table preserves the history that promotion/transfer letters read (old -> new).
export const positions = sqliteTable("positions", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  jobTitle: text("job_title"),
  departmentId: text("department_id").references((): AnySQLiteColumn => departments.uuid),
  location: text("location"),
  // Same enums the requisition uses (job_requisitions below), so a hire converts into a position without a
  // vocabulary of its own. Null on the rows that predate them - the header simply omits what it has not got.
  employmentType: text("employment_type", { enum: ["full_time", "part_time", "contract", "intern", "temporary"] }),
  workMode: text("work_mode", { enum: ["on_site", "hybrid", "remote"] }),
  note: text("note"),
  effectiveFrom: integer("effective_from", { mode: "timestamp_ms" }).notNull(),
  effectiveTo: integer("effective_to", { mode: "timestamp_ms" }), // null = current
  createdAt: created(),
  updatedAt: updated(),
  // At most ONE open (current) row per employee, for the same reason `comp_open_idx` exists on the salary
  // timeline above - this table is the same shape and had neither half of that guard. Two concurrent role
  // changes (a double-click, a retried submit) both read the same open row, both close it and both insert,
  // leaving TWO current positions. Nothing downstream can tell them apart: `location` is read last-wins for
  // the regional holiday calendar and comp-off credit (services/holidays.ts, leaveRequests.ts, compOff.ts),
  // and the `employees.department_id` copy written alongside can end up matching neither - which is a scope
  // key, so a wrong one is an access-control fact and not only a display one.
  // No `delete_time` term: a position row is history and is never soft-deleted (the collection is list+get,
  // see services/positions.ts), so the open row is the only thing the predicate has to be narrowed to.
}, (t) => ({ pageIdx: index("positions_page_idx").on(t.effectiveFrom, t.uuid),
  empIdx: index("pos_emp_idx").on(t.employeeId, t.effectiveFrom, t.uuid),
  openUniq: uniqueIndex("pos_open_idx").on(t.employeeId).where(sql`${t.effectiveTo} is null`),
}));

// One-off awards (performance/joining/retention bonus, incentive). A flat per-employee log (no effective-
// dating); the bonus/incentive letter cites the most recent award. Payout is handled separately via payroll.
export const bonuses = sqliteTable("bonuses", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  kind: text("kind"), // e.g. Performance Bonus, Joining Bonus, Retention Bonus, Incentive
  reason: text("reason"),
  awardDate: integer("award_date", { mode: "timestamp_ms" }).notNull(),
  // A company/department-wide award materializes one row per in-scope employee (so it shows on each profile);
  // `scope`+`scopeRef` describe how it was issued and `batchId` ties the materialized rows together for the
  // payroll Bonus tab. `scope` "individual" (or null) = a single-employee award.
  scope: text("scope", { enum: ["company", "department", "individual"] }),
  scopeRef: text("scope_ref"), // department ref for a department-wide award (display/label)
  batchId: text("batch_id"), // shared by all rows of one group award
  // The review cycle this payout came out of, when it is a `:awardVariablePay` run rather than a bonus
  // somebody typed. It is the IDEMPOTENCE KEY for that award, which is why it is a real reference and not a
  // sentence: the dedupe used to match on the bonus `reason` text, which carries the cycle's NAME - so
  // renaming a cycle after awarding made the run stop recognising its own work and pay everybody a second
  // time, while two cycles that happened to share a name (a "Q1" per year) blocked the later one's payout as
  // already awarded. A cycle's identity does not change when its label does.
  cycleId: text("cycle_id").references((): AnySQLiteColumn => reviewCycles.uuid),
  // A bonus is an unpaid payable until a payroll run pays it (taxable earning); paidRunId pins which run did,
  // so a rebuild is idempotent (reset first) and it's never double-paid.
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("bonuses_page_idx").on(t.awardDate, t.uuid),
  empIdx: index("bonus_emp_idx").on(t.employeeId, t.awardDate, t.uuid),
  batchIdx: index("bonus_batch_idx").on(t.batchId),
  paidIdx: index("bonus_paid_idx").on(t.paidRunId),
  // ONE variable-pay payout per person per cycle, enforced by the DATABASE.
  //
  // `cycleId` was called the idempotence key above and was not one: `awardVariablePay` read what the cycle had
  // already paid, then wrote in a loop, so two `:awardVariablePay` calls that overlapped both read "nothing
  // paid yet" and both paid - a double payout on the one table where that is unrecoverable once payroll has
  // run. Every other money transition in this app is guarded on the state it read (services/payroll.ts's
  // approve flip); this is the same guarantee expressed as a constraint, which is what a per-ROW claim needs.
  // Partial, on `cycle_id is not null`, so an ordinary typed bonus (no cycle) is untouched and a person may
  // hold as many of those as they are given.
  cycleOnceIdx: uniqueIndex("bonus_cycle_emp_idx").on(t.cycleId, t.employeeId).where(sql`${t.cycleId} is not null`),
}));

// Employee referrals: an employee refers an external candidate for a role. Owner-embedded code (referrer owns
// their own; HR sees all). When the referred candidate is hired and linked to their new employee record
// (`hiredEmployeeId`), a daily cron awards the referral bonus once the configured milestone is reached (after
// joining OR after probation - `settings/referrals.award_trigger`). Awarding creates a `bonuses` row (`bonusId`)
// which the next payroll run pays as a taxable earning; `bonusStatus` tracks pending -> eligible -> paid.
export const referrals = sqliteTable("referrals", {
  uuid: pk(),
  code: codeCol(),
  referrerId: text("referrer_id").notNull().references(() => employees.uuid),
  candidateName: text("candidate_name").notNull(),
  candidateEmail: text("candidate_email"),
  candidatePhone: text("candidate_phone"),
  positionTitle: text("position_title"),
  departmentId: text("department_id").references((): AnySQLiteColumn => departments.uuid),
  notes: text("notes"),
  status: text("status", { enum: ["submitted", "screening", "interviewing", "hired", "joined", "rejected", "withdrawn"] }).notNull().default("submitted"),
  // Set by HR when the candidate joins as an employee - the milestone anchor (read startDate / probationEndDate).
  hiredEmployeeId: text("hired_employee_id").references((): AnySQLiteColumn => employees.uuid),
  // The payout: the bonus row created at award time (links the referral to its taxable payroll earning).
  bonusId: text("bonus_id").references((): AnySQLiteColumn => bonuses.uuid),
  bonusStatus: text("bonus_status", { enum: ["pending", "eligible", "paid", "cancelled"] }).notNull().default("pending"),
  bonusAmount: real("bonus_amount"), // null -> filled from settings/referrals.default_bonus_amount at award time
  bonusEligibleDate: integer("bonus_eligible_date", { mode: "timestamp_ms" }),
  bonusPaidDate: integer("bonus_paid_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("referrals_page_idx").on(t.createdAt, t.uuid), referrerIdx: index("referral_referrer_idx").on(t.referrerId, t.createdAt, t.uuid), hiredIdx: index("referral_hired_idx").on(t.hiredEmployeeId) }));

// ATS - a role to fill. Flat/company-level (recruiter/HR), private-by-default + ACL. `status` walks
// draft -> open -> on_hold -> closed/filled (validated in the service). Applications reference it.
export const jobRequisitions = sqliteTable("job_requisitions", {
  uuid: pk(),
  code: codeCol(),
  title: text("title").notNull(),
  departmentId: text("department_id").references((): AnySQLiteColumn => departments.uuid),
  hiringManagerId: text("hiring_manager_id").references((): AnySQLiteColumn => employees.uuid),
  location: text("location"),
  employmentType: text("employment_type", { enum: ["full_time", "part_time", "contract", "intern", "temporary"] }),
  openings: integer("openings").notNull().default(1),
  description: text("description"),
  // The budget for the role. A requisition that records its band is what lets the pipeline draft a real offer
  // when a candidate reaches the offer stage, instead of an empty one somebody has to price by hand.
  payGradeId: text("pay_grade_id").references((): AnySQLiteColumn => payGrades.uuid),
  status: text("status", { enum: ["draft", "open", "on_hold", "closed", "filled"] }).notNull().default("draft"),
  openedDate: integer("opened_date", { mode: "timestamp_ms" }),
  closedDate: integer("closed_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("job_requisitions_page_idx").on(t.createdAt, t.uuid), deptIdx: index("requisition_dept_idx").on(t.departmentId) }));

// ATS - a person in the talent pool (one person, many applications). Flat/company-level, private-by-default +
// ACL. Resume via attachments slot "resume" (mirror referrals). `source` is a key from settings/ats.sources.
export const candidates = sqliteTable("candidates", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  source: text("source"), // settings/ats.sources: referral | job_board | agency | direct | ...
  sourceDetail: text("source_detail"), // agency name / board url / free text
  referralId: text("referral_id").references((): AnySQLiteColumn => referrals.uuid), // set when sourced from a referral
  tags: text("tags"), // comma-separated
  notes: text("notes"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("candidates_page_idx").on(t.createdAt, t.uuid), emailIdx: index("candidate_email_idx").on(t.email) }));

// ATS - candidate x requisition; the pipeline entity rendered on the kanban board. `stage` is a key into
// settings/ats.stages; `status` is the coarse outcome. `:advance` moves the stage, `:reject` ends it.
export const applications = sqliteTable("applications", {
  uuid: pk(),
  code: codeCol(),
  candidateId: text("candidate_id").notNull().references((): AnySQLiteColumn => candidates.uuid),
  requisitionId: text("requisition_id").notNull().references((): AnySQLiteColumn => jobRequisitions.uuid),
  stage: text("stage").notNull().default("applied"), // key into settings/ats.stages
  status: text("status", { enum: ["active", "hired", "rejected", "withdrawn"] }).notNull().default("active"),
  rejectionReason: text("rejection_reason"),
  source: text("source"),
  referralId: text("referral_id").references((): AnySQLiteColumn => referrals.uuid),
  // Who this application became. A hired stage is only a string; this is the proof the conversion happened,
  // and it is what the pipeline hands off to onboarding (stamped by `offers:accept` and `applications:hire`).
  hiredEmployeeId: text("hired_employee_id").references((): AnySQLiteColumn => employees.uuid),
  appliedDate: integer("applied_date", { mode: "timestamp_ms" }),
  stageChangedDate: integer("stage_changed_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("applications_page_idx").on(t.createdAt, t.uuid), candidateIdx: index("application_candidate_idx").on(t.candidateId), requisitionIdx: index("application_requisition_idx").on(t.requisitionId), hiredIdx: index("application_hired_idx").on(t.hiredEmployeeId) }));

// ATS - a scheduled interview on an application. Flat/company-level, private-by-default + ACL. `interviewerIds`
// is a JSON array of employee uuids (the panel); `:complete`/`:cancel` move the status.
export const interviews = sqliteTable("interviews", {
  uuid: pk(),
  code: codeCol(),
  applicationId: text("application_id").notNull().references((): AnySQLiteColumn => applications.uuid),
  title: text("title").notNull(), // round name, e.g. "Technical round"
  mode: text("mode", { enum: ["onsite", "video", "phone"] }).notNull().default("video"),
  scheduledStart: integer("scheduled_start", { mode: "timestamp_ms" }),
  scheduledEnd: integer("scheduled_end", { mode: "timestamp_ms" }),
  interviewerIds: text("interviewer_ids"), // JSON array of employee uuids (the panel)
  location: text("location"), // room or meeting link
  status: text("status", { enum: ["scheduled", "done", "cancelled"] }).notNull().default("scheduled"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("interviews_page_idx").on(t.createdAt, t.uuid), applicationIdx: index("interview_application_idx").on(t.applicationId) }));

// ATS - one interviewer's scorecard for an interview. Author(interviewer)-owned code (mirror review_feedback):
// the author owns their own, HR sees all. `ratingsJson` is a per-criterion {key:number} map (criteria from
// settings/ats.scorecard_criteria). Private-by-default + ACL.
export const interviewFeedback = sqliteTable("interview_feedback", {
  uuid: pk(),
  code: codeCol(),
  interviewId: text("interview_id").notNull().references((): AnySQLiteColumn => interviews.uuid),
  authorId: text("author_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  ratingsJson: text("ratings_json"), // {[criterionKey]: number}
  overallRating: integer("overall_rating"),
  recommendation: text("recommendation", { enum: ["strong_yes", "yes", "no", "strong_no"] }),
  comment: text("comment"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("interview_feedback_page_idx").on(t.createdAt, t.uuid), interviewIdx: index("if_interview_idx").on(t.interviewId), authorIdx: index("if_author_idx").on(t.authorId) }));

// ATS - an offer on an application. Flat/company-level, private-by-default + ACL. Workflow draft -> approved
// -> extended -> accepted | declined | rescinded (validated by domain/ats.ts). On :accept the candidate is
// converted to an employee (`createdEmployeeId`) and an onboarding transition is opened (`transitionId`).
export const offers = sqliteTable("offers", {
  uuid: pk(),
  code: codeCol(),
  applicationId: text("application_id").notNull().references((): AnySQLiteColumn => applications.uuid),
  baseComp: real("base_comp"), // offered compensation (annual)
  currency: text("currency").notNull().default("INR"),
  offerDate: integer("offer_date", { mode: "timestamp_ms" }),
  joinDate: integer("join_date", { mode: "timestamp_ms" }), // proposed start date -> employee.startDate on accept
  expiryDate: integer("expiry_date", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["draft", "approved", "extended", "accepted", "declined", "rescinded"] }).notNull().default("draft"),
  approverId: text("approver_id").references((): AnySQLiteColumn => employees.uuid),
  notes: text("notes"),
  createdEmployeeId: text("created_employee_id").references((): AnySQLiteColumn => employees.uuid), // set on accept (conversion)
  transitionId: text("transition_id").references((): AnySQLiteColumn => transitions.uuid), // onboarding opened on accept
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("offers_page_idx").on(t.createdAt, t.uuid), applicationIdx: index("offer_application_idx").on(t.applicationId) }));

// Company asset inventory (laptops, phones, etc.). Org-level (flat code); ownership is dynamic via
// `assignedTo` (an employee, nullable when in stock), so the same row can be reassigned over time. The
// employee profile lists assets assigned to that person; the inventory page lists everything.
//
// Custody is claimed by SCANNING the printed tag, never by typing a form: a fresh (or returned) asset sits in
// `pending_verification` until an admin scans it into stock, and an assigned one sits in `pending_ack` until
// the holder scans it themselves. `tagSecret` is the nonce printed inside the QR that makes a scan evidence
// of physically holding the thing - it is withheld from every caller who may not print tags.
// What kind of thing an asset is (mirrors reimbursement-categories: own table, Settings editor, soft-delete).
// `tagCode` is the short code that lands in the middle of a printed tag (Laptop -> LAP -> MS-LAP-014), so a
// category is the one place a tag's shape is decided; the sequence after it is per code.
export const assetCategories = sqliteTable("asset_categories", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(), // e.g. "Laptop"
  tagCode: text("tag_code").notNull(), // short code printed in the tag, e.g. "LAP"
  requiresSerial: integer("requires_serial", { mode: "boolean" }).notNull().default(false), // serial number mandatory for this kind
  // How long this kind of kit is written down over, in months - the depreciation life a laptop or a monitor
  // has as a CLASS, which is why it sits here and not on each asset. Feeds `bookValue` (domain/assetValue.ts)
  // together with the asset's own purchase cost and date. NULL = this category is not depreciated, and an
  // asset in it has no book value rather than a book value equal to its cost.
  usefulLifeMonths: integer("useful_life_months"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("asset_categories_page_idx").on(t.createdAt, t.uuid) }));

export const assets = sqliteTable("assets", {
  uuid: pk(),
  code: codeCol(),
  // Human-facing tag, allocated by the server on create from settings/asset-tags + the category's code
  // (see domain/assetTag.ts), HR-overridable. UNIQUE: it is what a sticker says, and two assets answering to
  // the same sticker would make every scan ambiguous. Also the backstop for the read-max-then-write race.
  assetTag: text("asset_tag").unique(),
  name: text("name").notNull(), // e.g. "MacBook Pro 14"
  categoryId: text("category_id").references((): AnySQLiteColumn => assetCategories.uuid),
  serialNumber: text("serial_number"),
  status: text("status", { enum: ["pending_verification", "in_stock", "pending_ack", "assigned", "repair", "retired"] }).notNull().default("pending_verification"),
  assignedTo: text("assigned_to").references(() => employees.uuid),
  assignedOn: integer("assigned_on", { mode: "timestamp_ms" }),
  purchaseDate: integer("purchase_date", { mode: "timestamp_ms" }),
  // What it cost. Half of the book value the inventory is asked for ("what are we holding"); the other half is
  // the category's useful life. Kept nullable because most of what an inventory inherits has no invoice behind
  // it any more, and guessing a cost would be worse than declining to value the row.
  purchaseCost: real("purchase_cost"),
  tagPrintedAt: integer("tag_printed_at", { mode: "timestamp_ms" }), // last time a physical sticker tag was printed for this asset
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }), // last time the physical asset was sighted (stocktake scan)
  // Who sighted it, and whether that sighting was PROVEN by a scan or ticked off by hand (a destroyed sticker
  // is allowed, with a note - see requireProof). The audit row carries both too; these are here so the
  // inventory itself can say "last seen by Priya, unscanned" without reading the log per row.
  verifiedBy: text("verified_by").references((): AnySQLiteColumn => employees.uuid),
  verifiedScanned: integer("verified_scanned", { mode: "boolean" }),
  // Which stocktake claimed the last sighting (null for an ordinary check-in outside a walk-through). Set to
  // null if that count is ever purged: it is provenance, not a dependency.
  lastStocktakeId: text("last_stocktake_id").references((): AnySQLiteColumn => stocktakes.uuid, { onDelete: "set null" }),
  tagSecret: text("tag_secret"), // nonce printed in the QR; proves a :verify/:acknowledge came from a real scan
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }), // when the current holder confirmed receipt
  custodyState: text("custody_state"), // free-form condition the holder reported: good / damaged / missing_parts
  custodySince: integer("custody_since", { mode: "timestamp_ms" }), // when the current pending_* wait started (drives the chase-up cron)
  notes: text("notes"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("assets_page_idx").on(t.createdAt, t.uuid),
  assignedIdx: index("asset_assigned_idx").on(t.assignedTo, t.createdAt, t.uuid),
  statusIdx: index("asset_status_idx").on(t.status),
  categoryIdx: index("asset_category_idx").on(t.categoryId),
}));

// One physical walk-through of the inventory. The SIGHTINGS it collects are not stored here - they are the
// `verified_at` / `verified_by` / `last_stocktake_id` stamps `:verify` already writes on each asset row, so a
// scan stays one write. What this row adds is everything a stamp cannot carry: who is counting, from when,
// over what scope, and - once closed - the frozen result.
//
// `result_json` is the reason the collection exists. A missing list derived live rots (assets get retired,
// reassigned, or scanned a week later), so closing a count SNAPSHOTS its counts and its missing rows; that
// snapshot is the auditable artefact. Closing is one-way: another walk is another row.
export const stocktakes = sqliteTable("stocktakes", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(), // e.g. "Q3 2026 - Bengaluru office"
  // `{ statuses?: string[], categories?: string[] }` - what this walk expects to sight. The client's presets
  // ("in the office") resolve to an explicit status list before they are stored, so the server never has to
  // agree with the client about what a preset means.
  scopeJson: text("scope_json").notNull().default("{}"),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  startedBy: text("started_by").references((): AnySQLiteColumn => employees.uuid),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  closedBy: text("closed_by").references((): AnySQLiteColumn => employees.uuid),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  // Scans that matched no asset: "there is a laptop here that nobody recorded" is a finding, not a typo.
  foundJson: text("found_json").notNull().default("[]"),
  resultJson: text("result_json"), // frozen counts + missing rows, written by :close
  notes: text("notes"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete: an accidental count can be dropped
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("stocktakes_page_idx").on(t.createdAt, t.uuid),
  statusIdx: index("stocktake_status_idx").on(t.status),
}));

// Full-and-final settlement (FnF) snapshots computed at exit. Each POST stores the computed line items +
// net; the FnF letter renders the most recent one. A snapshot (not recomputed live) so the issued letter and
// the record always agree, like a payslip.
export const settlements = sqliteTable("settlements", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  settlementDate: integer("settlement_date", { mode: "timestamp_ms" }).notNull(),
  currency: text("currency").notNull().default("INR"),
  leaveDays: real("leave_days").notNull().default(0),
  noticeShortfallDays: real("notice_shortfall_days").notNull().default(0),
  linesJson: text("lines_json").notNull(),
  totalEarnings: real("total_earnings").notNull(),
  totalDeductions: real("total_deductions").notNull(),
  net: real("net").notNull(),
  // The FnF is salary income and the year's largest single payment, so it withholds like a payroll run does:
  // `taxableEarnings` is the slice of the earnings that is chargeable (exempt gratuity / leave-encashment
  // portions excluded) and `tds` the income tax withheld on it. Both are stored because Form 16 is assembled
  // from actuals - a leaver is in no payroll run, so without these the certificate would omit the payment.
  taxableEarnings: real("taxable_earnings").notNull().default(0),
  tds: real("tds").notNull().default(0),
  // Exactly which payables this FnF consumed: {reimbursements,bonuses,encashments,overtime,arrears,loans[],
  // leaveDebits[]} by id. The FnF is the leaver's terminal payout, so it takes those rows OUT of the payroll
  // queues (they would otherwise never be paid - a terminated employee is in no run). Recording the ids is
  // what makes a recompute safe: POSTing a corrected settlement releases exactly what the previous one took
  // before re-pricing, the same release-then-rebuild contract a payroll run has.
  settledJson: text("settled_json"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("settlements_page_idx").on(t.settlementDate, t.uuid), empIdx: index("settle_emp_idx").on(t.employeeId, t.settlementDate, t.uuid) }));

// Mid-employment leave encashment (cashout) - HR converts accrued, still-employed leave balance into a cash
// payout. WORKFLOW resource (custom methods :approve/:reject/:cancel); APPROVED debits the leave balance and
// PAID is set when the next payroll run pays it as a taxable earning line (never set by hand). rate/amount are
// snapshotted at compute time so a later comp change can't re-price an approved request.
export const leaveEncashments = sqliteTable("leave_encashments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  leaveTypeId: text("leave_type_id").notNull().references(() => leaveTypes.uuid),
  days: real("days").notNull(),
  ratePerDay: real("rate_per_day").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "PAID"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid), // set when paid via a payroll run
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("leave_encashments_page_idx").on(t.createdAt, t.uuid), empIdx: index("encash_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("encash_state_idx").on(t.state) }));

// Org-level grade ladder + salary bands (flat-coded catalog like pay-components, HR-managed, soft-delete).
// Each grade is a rung on the ladder (`level`, lower = more junior) carrying an optional salary band
// (min/mid/max ANNUAL CTC in `currency`). A compensation row references a grade; the wire derives the
// compa-ratio (ctc/mid) and an in-band/below/above flag. Bands are guardrails - out-of-band pay is allowed
// (HR overrides happen), it is only flagged, never blocked.
export const payGrades = sqliteTable("pay_grades", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(0),
  bandMin: real("band_min"),
  bandMid: real("band_mid"),
  bandMax: real("band_max"),
  currency: text("currency").notNull().default("INR"),
  description: text("description"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("pay_grades_page_idx").on(t.createdAt, t.uuid) }));

// A named salary structure: a per-employee selection of recurring EARNING components, each with an optional
// rate override (e.g. "Senior" sets HRA to 50% while "Standard" uses the component's own 40%). Deductions and
// statutory lines (EPF/TDS) are not part of a structure - they always apply. `linesJson` is an ordered array
// of { component: <pay_components.uuid>, rate: number | null }. Flat-coded catalog, HR-managed, soft-delete.
export const salaryStructures = sqliteTable("salary_structures", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  description: text("description"),
  linesJson: text("lines_json").notNull().default("[]"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("salary_structures_page_idx").on(t.createdAt, t.uuid) }));

export const payComponents = sqliteTable("pay_components", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  // earning = paid, in gross; deduction = withheld from gross (employee side); employer_contribution = the
  // employer's on-top cost (PF/ESI/gratuity): part of neither gross nor deductions, reported as cost to
  // company (CTC views, the run's own lines and the payslip's employer block). What is provided (gratuity
  // etc.), at what rate/cap/method, is ALL data: add/remove a row, no code changes.
  kind: text("kind", { enum: ["earning", "deduction", "employer_contribution"] }).notNull(),
  // "edli" and "pf_admin" are the employer's two statutory PF side-charges (EDLI 0.5%, administration 0.5%),
  // priced on the SAME PF wages as method "epf" (basic-or-configured composition, capped at the wage ceiling).
  // They exist as their own methods rather than a percent_base row because percent_base ignores the PF ceiling.
  method: text("method", { enum: ["fixed", "percent_base", "income_tax", "epf", "esi", "pt", "edli", "pf_admin"] }).notNull().default("fixed"),
  rate: real("rate"),
  cap: real("cap"), // for methods "epf"/"edli"/"pf_admin": wage ceiling on PF wages (e.g. 15000); null = uncapped
  regime: text("regime"), // for method "income_tax": which tax regime block to use (e.g. "new")
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(true),
  // EARNING rows only, and only when settings/pf sets wage_basis "basic_plus": does this allowance count as PF
  // wages? (The SC's Vivekananda Vidyamandir line: universally-paid allowances are "basic wages"; HRA, overtime
  // and bonus are statutorily excluded.) Ignored under the default "basic" basis, where PF wages are basic only.
  pfWages: integer("pf_wages", { mode: "boolean" }).notNull().default(false),
  // employer_contribution rows only: does this contribution count INSIDE the CTC figure (default, the common
  // Indian convention) or is it paid OVER AND ABOVE CTC ("CTC + PF")? Either way the company pays it and the
  // payroll run costs it; this only decides which side of the CTC number it lands on. Ignored (always true)
  // for earnings and employee deductions, which are inside CTC by construction.
  inCtc: integer("in_ctc", { mode: "boolean" }).notNull().default(true),
  // The accounting code this component posts to, mirroring `expense_categories.gl_code`. Null until an org
  // maps its chart of accounts, and a run refuses to produce a journal while any component it priced is
  // unmapped - a partial journal is worse than none, because it balances by leaving money out.
  //
  // WHICH SIDE it posts to is NOT stored: it follows from `kind`, and storing it would let the two disagree.
  // An earning debits an expense, an employee deduction credits a liability, and an employer contribution does
  // BOTH (its own expense, and the liability the company will later discharge). Net pay is not a component at
  // all - it is the balancing payable, and its account lives in the `payroll-gl` settings blob with the
  // rounding account, because neither is derived from anything an org configures per component.
  glCode: text("gl_code"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("pay_components_page_idx").on(t.createdAt, t.uuid) }));

export const payPeriods = sqliteTable("pay_periods", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(),
  periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
  periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
  payDate: integer("pay_date", { mode: "timestamp_ms" }).notNull(),
  // The day after which this period's inputs are meant to stop moving, so payroll can be built against a
  // settled set of figures. NULLABLE, and null means the org has not adopted a cutoff - the periods that exist
  // today were written without one and must keep behaving exactly as they did.
  //
  // It is a DATE THE ORG PUBLISHES, not a lock. A reimbursement approved the evening before pay date is a
  // legitimate write that happens to invalidate a run somebody already reviewed, and the app's only response
  // today is `runStaleness` reporting it afterwards. Naming the day in advance is what lets everyone upstream
  // of payroll see the deadline they are working to; refusing the late write is a separate decision, and
  // deliberately not this column's job.
  inputCutoffOn: integer("input_cutoff_on", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("pay_periods_page_idx").on(t.createdAt, t.uuid) }));

export const payrollRuns = sqliteTable("payroll_runs", {
  uuid: pk(),
  code: codeCol(),
  payPeriodId: text("pay_period_id").notNull().references(() => payPeriods.uuid),
  state: text("state", { enum: ["DRAFT", "REVIEW", "APPROVED", "PUBLISHED"] }).notNull().default("DRAFT"),
  createdBy: text("created_by").references(() => users.uuid),
  submittedBy: text("submitted_by").references(() => users.uuid),
  approvedBy: text("approved_by").references(() => users.uuid),
  lockTime: integer("lock_time", { mode: "timestamp_ms" }), // unused (the LOCKED step was removed); kept to avoid a migration
  // When the run's line items were last (re)built from live inputs. Drives the "inputs changed since build"
  // staleness check: any income-affecting input (comp, components, bonuses, encashments, reimbursements,
  // overtime, loans, tax verifications, settings, new joiners, holidays, and - with LOP on - approved leave
  // and attendance punches) touched after this timestamp = rebuild needed.
  itemsBuiltAt: integer("items_built_at", { mode: "timestamp_ms" }),
  // The size of the last build: how many people it priced, and what it priced them at. Written by the SAME
  // atomic batch as `itemsBuiltAt` and the items themselves, and cleared with them on every reset - so the
  // three can never describe different builds, and NULL means "never built" exactly as a null build stamp does.
  //
  // Stored rather than summed on read. The figures live on `payroll_run_items`, one row per employee per run,
  // so a run list that wanted them would read the whole org's items for every run on the page to render twelve
  // lines. The build already holds those rows in memory when it commits, so this costs one wider update on a
  // path that was already writing, and nothing at all on the read.
  headcount: integer("headcount"),
  gross: real("gross"),
  net: real("net"),
  // When a bank payout file was first generated for this run. Downloading it is the point where the money
  // leaves the company, and deleting a run RELEASES every payable it paid back into the queue - so once this
  // is stamped the run can no longer be deleted, otherwise the next run would pay the same one-offs again.
  bankFileAt: integer("bank_file_at", { mode: "timestamp_ms" }),
  // The bank the run's payout file was made for. Every file carries every payable employee, so files for two
  // banks on one run are every salary paid twice if both are submitted. The first generation claims the run
  // for its bank (services/bankFile.ts); the same bank can regenerate, another is refused. NULL = no file yet.
  bankFileBank: text("bank_file_bank"),
  // Employee ids the last build CONSIDERED but could not price - a JSON array, written by the same atomic
  // batch that writes the items and cleared whenever the run is reset to "never built".
  //
  // The build walks every employee who has not left and skips anyone with no compensation row in force at the
  // period end, because there is no salary to price. That skip is correct; being SILENT about it was not.
  // Nothing downstream could see it either: a skipped person has no `payroll_run_items` row, and every other
  // warning this run carries (staleness, split drift) is computed from the items - so the one employee the run
  // is wrong about is the one employee it cannot mention. The visible symptom was not an error, it was someone
  // quietly not being paid, found when they asked. Every other money path already refuses this state out loud
  // (services/settlements.ts, services/leaveEncashments.ts: "the employee has no compensation on record").
  unpricedJson: text("unpriced_json"),
  createdAt: created(),
  updatedAt: updated(),
  // At most ONE committed (APPROVED/PUBLISHED) run per pay period, enforced by the DB. Drafts are unrestricted
  // (many can coexist), but the money commits at APPROVE, so a partial unique index makes a second concurrent
  // approve for the same period fail loudly instead of the check-then-write race paying the monthly salary twice.
}, (t) => ({ pageIdx: index("payroll_runs_page_idx").on(t.createdAt, t.uuid),
  periodIdx: index("run_period_idx").on(t.payPeriodId),
  committedPeriodUniq: uniqueIndex("run_period_committed_idx").on(t.payPeriodId).where(sql`${t.state} in ('APPROVED', 'PUBLISHED')`),
}));

export const payrollRunItems = sqliteTable("payroll_run_items", {
  uuid: pk(),
  code: codeCol(),
  runId: text("run_id").notNull().references(() => payrollRuns.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  linesJson: text("lines_json").notNull(),
  gross: real("gross").notNull(),
  taxableGross: real("taxable_gross").notNull().default(0), // earnings that count toward income tax (excludes non-taxable lines e.g. reimbursements)
  totalDeductions: real("total_deductions").notNull(),
  tax: real("tax").notNull().default(0), // TDS withheld this run (also a deduction line in lines_json)
  net: real("net").notNull(),
  // The employee's department AS OF THIS BUILD, stamped rather than resolved later. Payroll is the largest
  // line in the company and the only one with no cost-centre attribution; `expenses.department_id` exists for
  // exactly this reason. Stamped because a transfer in March must not rewrite what February's accounts said -
  // resolving through `employees.department_id` at read time would do precisely that. Null for an employee
  // with no department, which posts to the org-wide account rather than being dropped.
  departmentId: text("department_id").references(() => departments.uuid),
  // A FINGERPRINT of the account this row was actually paid into, written when the bank file is generated.
  // Never the account number: it answers "same or different" against the next run and nothing else, and it
  // cannot be read back. That is what lets the payout check say "this person's account has changed since the
  // last run that paid them" without holding, comparing or displaying anybody's account number.
  //
  // Null until a payout file is produced for the run, and null for a row with nothing to pay.
  bankAccountHash: text("bank_account_hash"),
  // WHETHER THE MONEY ARRIVED, which the module could not previously answer at all: `bank_file_at` records
  // the moment a payout file was produced and nothing records what the bank then did with it. A wrong
  // account number, a closed account or a bank-side rejection was discovered when the employee said they had
  // not been paid.
  //
  // Null until a bank response is recorded, which is the honest state for "sent, nothing heard back" - and
  // distinct from "paid", which must only ever mean the bank confirmed it.
  paymentStatus: text("payment_status", { enum: ["paid", "failed", "returned"] }),
  paymentAt: integer("payment_at", { mode: "timestamp_ms" }),
  // What the bank called it, so a failure can be chased with the bank using their own reference.
  paymentRef: text("payment_ref"),
  // Why it did not land, in the bank's words. The reason is the whole value of a failure row: "account
  // closed" and "name mismatch" need different people to do different things.
  paymentReason: text("payment_reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ runIdx: index("rri_run_idx").on(t.runId), runEmpUniq: uniqueIndex("rri_run_emp_idx").on(t.runId, t.employeeId) }));

// Pay and tax an employee had ALREADY been paid this financial year before HRMS ran their payroll, from the
// system before it (services/payrollOpenings.ts). One live row per (employee, financial year), covering the
// months from the start of the year through `paidThrough`. services/taxProjection.ts#finalizedTotals folds it in
// beside the finalized runs, so the year's TDS, the PT annual cap, the settlement and Form 16 all count it, and
// the months it covers are neither re-priced nor collected in again.
export const payrollOpenings = sqliteTable("payroll_openings", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  financialYear: text("financial_year").notNull(), // "2026-27", as fyWindow labels it
  paidThrough: text("paid_through").notNull(), // "YYYY-MM": the last month whose salary the figures include
  gross: real("gross").notNull(),
  taxableGross: real("taxable_gross").notNull(),
  tds: real("tds").notNull().default(0),
  pt: real("pt").notNull().default(0),
  // Whether ESI was being deducted in `paidThrough`: once in, an employee stays in for the rest of that
  // contribution period whatever their wage does (domain/statutory.ts), and a run that cannot see the months
  // before HRMS would otherwise re-test the ceiling and stop the deduction.
  esiContributing: integer("esi_contributing", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  createdBy: text("created_by").references(() => users.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("payroll_openings_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("popen_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  empFyUniq: uniqueIndex("popen_emp_fy_idx").on(t.employeeId, t.financialYear).where(sql`${t.deleteTime} is null`),
}));

export const payslips = sqliteTable("payslips", {
  uuid: pk(),
  code: codeCol(),
  runId: text("run_id").notNull().references(() => payrollRuns.uuid),
  runItemId: text("run_item_id").notNull().references(() => payrollRunItems.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  r2Key: text("r2_key").notNull(),
  gross: real("gross").notNull().default(0),
  taxableGross: real("taxable_gross").notNull().default(0),
  totalDeductions: real("total_deductions").notNull().default(0),
  tax: real("tax").notNull().default(0), // TDS withheld
  net: real("net").notNull().default(0),
  // When the EMPLOYEE THEMSELVES first opened this slip, and nothing else about their reading of it.
  //
  // A delivery record, not a reading record, and the difference is the whole justification. "Did everybody get
  // their payslip" is a question payroll has to be able to answer; "what has this person been looking at, and
  // when" is the question domain/auditAccess.ts refuses to let anybody ask of their own data ("Reading your OWN
  // sensitive data is expected, not an abuse signal - never audited"). So this is one timestamp, written once,
  // by the owner's own first view - never a counter, never a log, and never touched when HR or a manager opens
  // somebody else's slip, which the audit trail already covers as the accountability event it is.
  firstOpenedAt: integer("first_opened_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("payslips_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("payslip_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  runIdx: index("payslip_run_idx").on(t.runId),
  // One slip per run item, enforced by the storage layer. processPayslipRunJob already skips items that
  // have a slip, which holds for a sequential retry but not for two drains running the same job at once -
  // both would read an empty `existing` set and both insert. This is the backstop that makes a duplicate
  // job a harmless conflict instead of a second payslip for the same month.
  runItemUniq: uniqueIndex("payslip_run_item_idx").on(t.runItemId),
}));

// ---- Reimbursements (employee expense claims; request/approve/deny like leave; paid out non-taxable) ----
// Configurable categories (mirrors leave-types / pay-components: own table, Settings tab, soft-delete).
export const reimbursementCategories = sqliteTable("reimbursement_categories", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  requiresReceipt: integer("requires_receipt", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("reimbursement_categories_page_idx").on(t.createdAt, t.uuid) }));

export const reimbursements = sqliteTable("reimbursements", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  categoryId: text("category_id").references(() => reimbursementCategories.uuid),
  amount: real("amount").notNull(),
  incurredOn: integer("incurred_on", { mode: "timestamp_ms" }),
  description: text("description"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "PAID"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  // The advance this claim spends, when the employee was given money UP FRONT for it (a travel float). A
  // `loans` row of kind "advance" - an advance IS a zero-interest short-term loan here, which is why it reuses
  // that machinery rather than becoming a second way for the company to be owed money.
  //
  // WITHOUT THIS the employee is paid twice: they take a 50,000 travel advance, file 45,000 of claims, and the
  // claims pay out in full while payroll separately recovers the 50,000 from their salary.
  advanceId: text("advance_id").references((): AnySQLiteColumn => loans.uuid),
  // How much of this claim went to discharging that advance instead of being paid out. The payout queue pays
  // `amount - advance_settled`, so a claim inside the advance pays nothing and one that overspends it pays only
  // the excess. Held on the CLAIM rather than inferred from the advance, because the advance's outstanding
  // balance moves as later claims settle against it: recomputing this later would not give back the split that
  // was actually applied to the money.
  advanceSettled: real("advance_settled").notNull().default(0),
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid), // set when paid via a payroll run
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("reimbursements_page_idx").on(t.createdAt, t.uuid), empIdx: index("reimb_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("reimb_state_idx").on(t.state) }));

// Generic encrypted file attachments, reached THROUGH their parent's routes so access inherits the parent
// object's gating (NOT a directly-addressable collection). One file per (collection, object_id, slot);
// uploading the same slot overwrites. Bytes are encrypted in R2 by the docstore wrapper.
export const attachments = sqliteTable("attachments", {
  uuid: pk(),
  collection: text("collection").notNull(), // parent collection, e.g. "reimbursements" / "employees"
  objectId: text("object_id").notNull(),     // parent row uuid
  slot: text("slot").notNull().default(""),   // e.g. "receipt" or "identity:pan"
  r2Key: text("r2_key").notNull(),
  fileName: text("file_name"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  uploadedBy: text("uploaded_by").references(() => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ targetIdx: uniqueIndex("attach_target_idx").on(t.collection, t.objectId, t.slot) }));

// ---- Expenses (operational / company spend; vendor invoices, rent, utilities, software, supplies) --------
// Distinct from `reimbursements` (personal, payroll-paid). Company spend attributed to a department (cost
// centre) and paid out-of-band to a vendor. The employee-owned code (submitter) reuses the reimbursement
// scoping exactly: a manager's dept breadth sees their reports' expenses via the dept-prefixed employee code;
// finance (all breadth) sees everything. `departmentId` is attribution/reporting data, NOT the scope key.

// Configurable categories (mirrors reimbursement-categories): own table, Settings editor, soft-delete.
export const expenseCategories = sqliteTable("expense_categories", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  requiresReceipt: integer("requires_receipt", { mode: "boolean" }).notNull().default(false),
  glCode: text("gl_code"), // accounting general-ledger code
  // A category the org pays at a PUBLISHED RATE rather than against a receipt: mileage per kilometre, a
  // subsistence allowance per day. Both are null on an ordinary category, and both are set together - a rate
  // with no kind cannot be applied and a kind with no rate cannot compute.
  //
  // What this buys is correctness by construction. A car journey and a day away have no invoice, so today the
  // claimant multiplies in their head and types a total: the rate lives in somebody's memory, it is applied
  // inconsistently, and an approver has no way to check the arithmetic without knowing the rate themselves.
  // With these set the submitter enters distance or days and the amount follows, `requires_receipt` stops
  // applying (there is nothing to attach), and the claim carries what it was computed from.
  //
  // NOT EFFECTIVE-DATED, and that is a real limitation rather than an oversight. Changing the rate here changes
  // what is computed from that moment on; claims already filed keep their own stored `amount`, so history is
  // not rewritten, but a claim filed TODAY for a trip LAST YEAR is priced at today's rate. Rates do change by
  // year, so an org that backdates claims across a rate change needs a per-period rate table - that is the
  // follow-up, and it is deliberately not pretended at with a single column.
  rateKind: text("rate_kind", { enum: ["per_km", "per_day"] }),
  rate: real("rate"),
  // The two limits a finance team actually applies, as policy DATA rather than as a habit in somebody's head.
  // Both null on an unrestricted category.
  //
  // What they buy is WHERE the rule lands. Both are things a claim gets rejected for days later today, and a
  // rejection for a rule that could have been stated at submit is the interaction that makes people resent an
  // expenses module. `decision_note` exists so a submitter is told the reason rather than the verdict; the
  // same reason is worth more before the claim is filed than after.
  amountCap: real("amount_cap"), // most a single claim in this category may be
  maxAgeDays: integer("max_age_days"), // how late a claim may be filed, counted from the date incurred
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("expense_categories_page_idx").on(t.createdAt, t.uuid) }));

// Vendor master: who the company pays. Flat reference (soft-delete/disable/lock like a category).
export const vendors = sqliteTable("vendors", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  taxId: text("tax_id"), // GSTIN / tax registration
  // How many days after the invoice date this vendor is paid. A NUMBER, not the free text it was ("Net 30"),
  // because nothing could compute with the text: an approved expense had no due date, so the app could not say
  // what was payable this week, could not age its payables and could not count a late payment. Null means the
  // vendor has no agreed terms, which is different from zero (due immediately).
  //
  // Terms run from the INVOICE date (`expenses.incurred_on`), which is what "Net 30" means in the trade and
  // also what lets the due date exist before anybody approves anything.
  paymentTermsDays: integer("payment_terms_days"),
  bankDetails: text("bank_details"),
  defaultCategoryId: text("default_category_id").references(() => expenseCategories.uuid),
  notes: text("notes"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("vendors_page_idx").on(t.createdAt, t.uuid) }));

// WORKFLOW resource. state: DRAFT -> SUBMITTED -> APPROVED -> PAID (+ REJECTED / CANCELLED). PAID is set by
// :pay (vendor, out-of-band) OR mirrored from the linked reimbursement (employee-fronted bridge), never by hand.
export const expenses = sqliteTable("expenses", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid), // submitter/owner (+ reimbursable payee)
  vendorId: text("vendor_id").references(() => vendors.uuid),
  categoryId: text("category_id").references(() => expenseCategories.uuid),
  departmentId: text("department_id").references(() => departments.uuid), // cost-centre attribution (not scope key)
  amount: real("amount").notNull(),
  // How many kilometres, or how many days, on a claim against a rated category (expense_categories.rate_kind).
  // Null on every ordinary expense. Stored rather than derived back out of the amount because it is what the
  // claimant actually asserted - dividing an amount by today's rate to recover it would give the wrong
  // distance the moment the rate changed, and an approver reading "412 km" is checking a different claim from
  // one reading "₹4,120".
  quantity: real("quantity"),
  taxAmount: real("tax_amount").notNull().default(0), // GST / tax component of the amount
  incurredOn: integer("incurred_on", { mode: "timestamp_ms" }),
  description: text("description"),
  invoiceNumber: text("invoice_number"),
  paymentMethod: text("payment_method", { enum: ["bank", "card", "cash", "upi", "cheque"] }),
  paymentRef: text("payment_ref"),
  state: text("state", { enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "PAID"] }).notNull().default("DRAFT"),
  reimbursable: integer("reimbursable", { mode: "boolean" }).notNull().default(false), // an employee fronted it
  reimbursementId: text("reimbursement_id").references((): AnySQLiteColumn => reimbursements.uuid), // set when bridged
  decidedBy: text("decided_by").references(() => users.uuid),
  // The FIRST of two approvals, on a claim large enough that the org wants two pairs of hands
  // (settings/expenses `second_approval_threshold`). Null on everything below the threshold and on everything
  // filed before an org set one.
  //
  // A COLUMN RATHER THAN A STATE, deliberately, and the trade is worth writing down. A claim holding one
  // approval is still awaiting an approval, so leaving it SUBMITTED keeps `domain/approvalsSummary.ts` and
  // every queue filter correct for free; a new enum member would have had to be added to each of them, and
  // missing one would silently drop these claims out of somebody's queue - which is the failure that loses
  // money quietly. What the state cannot carry, this column does: who has already approved, so the second
  // approver is told, and so the same person cannot be both.
  firstApprovedBy: text("first_approved_by").references(() => users.uuid),
  firstApprovedAt: integer("first_approved_at", { mode: "timestamp_ms" }),
  decisionNote: text("decision_note"), // why it was rejected - the submitter is told the reason, not just the verdict
  paidBy: text("paid_by").references(() => users.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  // Recurrence: a template row (isRecurring=true) is cloned by the daily cron into concrete expenses.
  isRecurring: integer("is_recurring", { mode: "boolean" }).notNull().default(false),
  // Paused keeps the schedule and its history but stops generation (a lease on hold, a subscription frozen);
  // stopping for good is :cancel. Both are checked by the daily cron.
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  recurrenceRule: text("recurrence_rule", { enum: ["monthly", "quarterly", "yearly"] }),
  nextOccurrenceOn: integer("next_occurrence_on", { mode: "timestamp_ms" }),
  // The series' own day of the month, held so a month step can put the next occurrence back on it. Without
  // it a series steps from wherever the last one landed, and one February moves a 29th/30th/31st series to the
  // 28th for good (domain/calendar.ts#addMonthsFromAnchor). Null until the first roll, which takes it from the
  // occurrence's own date - the last moment that day is still the one the series was written with.
  recurrenceAnchorDay: integer("recurrence_anchor_day"),
  lastGeneratedOn: integer("last_generated_on", { mode: "timestamp_ms" }),
  templateId: text("template_id").references((): AnySQLiteColumn => expenses.uuid), // the recurring template this was cloned from
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("expenses_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("exp_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  stateIdx: index("exp_state_idx").on(t.state),
  deptIdx: index("exp_dept_idx").on(t.departmentId),
  catIdx: index("exp_cat_idx").on(t.categoryId),
  vendorIdx: index("exp_vendor_idx").on(t.vendorId),
}));

// Budget: a spend cap for a (department?, category?, period). NULL dept = org-wide; NULL category = all
// categories. `spent`/`remaining`/`utilization` are derived (never stored) from APPROVED+PAID expenses.
// `alertLevel` records the highest threshold already alerted (0/80/100) so a budget alert fires once.
// One invoice split across cost centres. A single bill that is sixty per cent Engineering and forty per cent
// Sales was previously filed as TWO expenses, which meant the invoice could only be attached to one of them -
// the second row was evidence-free by construction, and neither row was the amount the company actually paid.
//
// A CHILD ROW, not a collection: reached only through its parent expense, exactly like `attachments`, so it
// needs no code, no authz entry and no routes of its own - the parent's read and write gates are its gates.
//
// The lines must sum to the expense's own amount, which is what keeps `expenses.amount` the single answer to
// "what did this cost" while the lines answer "who paid for it". Budget attribution consumes the LINES where
// they exist and the row where they do not (services/expenseBudgets.ts), which is the only place in the app
// that has to understand a split at all.
export const expenseAllocations = sqliteTable("expense_allocations", {
  uuid: pk(),
  expenseId: text("expense_id").notNull().references(() => expenses.uuid),
  departmentId: text("department_id").references(() => departments.uuid),
  categoryId: text("category_id").references(() => expenseCategories.uuid),
  amount: real("amount").notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ expIdx: index("exp_alloc_expense_idx").on(t.expenseId) }));

// A row off a corporate card statement, and the claim it accounts for.
//
// The point of holding these at all is that an UNCLAIMED charge is otherwise invisible: the app only knows
// about spending somebody remembered to file. With the statement imported, the statement is the list - a row
// with no expense behind it is work outstanding, and a claim with no row is one to ask about.
//
// `import_key` is what makes re-uploading a statement safe. Card issuers hand out overlapping periods and
// people upload the same file twice, so the key is derived from the row's own content (services/cardStatements.ts)
// and carries a unique index: a second import of the same charge is a no-op rather than a duplicate the
// matcher then has to be clever about.
//
// `employee_id` is the CARDHOLDER, not whoever files the claim. It is nullable because a statement may name a
// card this app cannot resolve to a person, and a row nobody owns is still a charge the company paid - it
// belongs on the list rather than being dropped for want of an owner.
export const cardTransactions = sqliteTable("card_transactions", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").references(() => employees.uuid),
  cardLast4: text("card_last4"),
  postedOn: integer("posted_on", { mode: "timestamp_ms" }).notNull(),
  amount: real("amount").notNull(),
  merchant: text("merchant"),
  reference: text("reference"), // the issuer's own row id, where the format carries one
  importKey: text("import_key").notNull(),
  // The claim this charge accounts for. `match_confidence` records HOW it was decided, because "the amount
  // and the week agreed" and "a person said so" are different warrants and an approver should be able to
  // tell them apart.
  expenseId: text("expense_id").references((): AnySQLiteColumn => expenses.uuid),
  matchConfidence: text("match_confidence", { enum: ["exact", "likely", "manual"] }),
  matchedAt: integer("matched_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("card_transactions_page_idx").on(t.createdAt, t.uuid),
  keyUniq: uniqueIndex("card_txn_import_key_idx").on(t.importKey),
  empIdx: index("card_txn_emp_idx").on(t.employeeId, t.postedOn),
  expenseIdx: index("card_txn_expense_idx").on(t.expenseId),
}));

// Payroll budgets: a spend cap for a (department?, period), with SPEND DERIVED FROM PAYROLL RUNS rather than
// from expenses. Salary is the largest line in the company and was the only one with no budget surface at all.
//
// A SEPARATE TABLE rather than a `source` column on `expense_budgets`, deliberately. The two share a shape -
// a scope, a period, a cap, a recurrence - but nothing else: they are filled from different collections, read
// by different people, and every existing expense-budget query would have had to learn to exclude payroll
// rows. One forgotten filter there would silently count salary as expense spend against a department's
// expense cap, which is a wrong number nobody would question because both figures are real.
//
// No category dimension, unlike an expense budget: payroll's equivalent of a category is a pay component, and
// capping "basic pay for Engineering" is not a budget anybody sets. Department and period are the whole scope.
export const payrollBudgets = sqliteTable("payroll_budgets", {
  uuid: pk(),
  code: codeCol(),
  departmentId: text("department_id").references(() => departments.uuid), // null = org-wide
  periodType: text("period_type", { enum: ["monthly", "quarterly", "yearly"] }).notNull(),
  periodKey: text("period_key").notNull(), // "2026" | "2026-Q1" | "2026-07"
  amount: real("amount").notNull(),
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(false),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("payroll_budgets_page_idx").on(t.createdAt, t.uuid),
  periodIdx: index("payrollbudget_period_idx").on(t.periodType, t.periodKey),
}));

export const expenseBudgets = sqliteTable("expense_budgets", {
  uuid: pk(),
  code: codeCol(),
  departmentId: text("department_id").references(() => departments.uuid),
  categoryId: text("category_id").references(() => expenseCategories.uuid),
  periodType: text("period_type", { enum: ["monthly", "quarterly", "yearly"] }).notNull(),
  periodKey: text("period_key").notNull(), // "2026" | "2026-Q1" | "2026-07"
  amount: real("amount").notNull(),
  // A recurring cap re-opens itself: once its period ends the daily cron creates the same cap for the next
  // period at the SAME amount (never the unspent remainder - that would silently turn a monthly cap into an
  // annual one). Repetition belongs on the cap, not on the category: a cap's identity is
  // (department, category, period_type), so a category-level flag could not say "Travel/Sales repeats but
  // Travel/Engineering does not".
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(false),
  alertLevel: integer("alert_level").notNull().default(0), // highest budget-alert threshold already fired
  // When the daily sweep last said this cap is FORECAST to breach. Its own guard rather than a second
  // `alertLevel`, because the two answer different questions and must be able to fire independently: a cap
  // can be forecast over in week one (this stamps) and then actually cross 80% in week three (`alertLevel`
  // rises), and neither should silence the other. Cleared wherever `alertLevel` resets - changing the cap or
  // the period re-arms both - so a re-armed budget can warn again about the period it is now describing.
  projectionAlertedAt: integer("projection_alerted_at", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("expense_budgets_page_idx").on(t.createdAt, t.uuid), periodIdx: index("expbudget_period_idx").on(t.periodType, t.periodKey) }));

// Attendance clock sessions: one clock-in -> clock-out pair. `clockOut` NULL = an OPEN session (the employee
// is currently clocked in); multiple sessions per day model breaks. Employee-owned (owner-embedded code), so
// the middleware scopes them via me/my-dept exactly like leave-requests. `source` distinguishes a live clock
// punch from a session written by an approved regularization.
export const attendanceSessions = sqliteTable("attendance_sessions", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  clockIn: integer("clock_in", { mode: "timestamp_ms" }).notNull(),
  clockOut: integer("clock_out", { mode: "timestamp_ms" }), // NULL = open (currently clocked in)
  source: text("source", { enum: ["clock", "correction"] }).notNull().default("clock"),
  // Set to the regularization uuid whose approval replaced this session; non-NULL rows are excluded from all
  // derived attendance (soft-supersede keeps the audit trail instead of hard-deleting the old punch).
  supersededBy: text("superseded_by").references((): any => attendanceRegularizations.uuid),
  note: text("note"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("attendance_sessions_page_idx").on(t.clockIn, t.uuid), empIdx: index("att_emp_idx").on(t.employeeId, t.clockIn, t.uuid), openIdx: index("att_open_idx").on(t.clockOut),
  // At most ONE LIVE open session per employee, enforced by the DB - the same shape as `comp_open_idx` and
  // `pos_open_idx`, for the same reason. `clockIn` reads "is anything open" and then inserts, which is two
  // statements, so two punches at once (a double-tapped button, a phone and a laptop) both saw nothing open
  // and both wrote a row. `openSessionFor` then takes one of them arbitrarily and `clockOut` closes that one,
  // leaving the other open for good: every later `clockIn` answers "already clocked in", so the person can
  // never punch again - and loss of pay is derived from punches, so every subsequent working day is docked as
  // a full absence.
  //
  // SUPERSEDED ROWS ARE OUTSIDE THE PREDICATE, and that half is load-bearing rather than tidy. An approved
  // regularization supersedes the day's punches by `clock_in`, an OPEN session among them included, and it
  // writes only closed corrected pairs - so the superseded row keeps `clock_out` null forever. Counted as
  // open, it is the same permanent lockout reached with no race at all, just by correcting a day you are
  // still clocked in on. `openSessionFor` filters the same two columns; this is the backstop under it.
  openEmpUniq: uniqueIndex("att_open_emp_idx").on(t.employeeId).where(sql`${t.clockOut} is null and ${t.supersededBy} is null`) }));

// Attendance regularization: an employee's request to correct a whole day's clock times (missed punch, wrong
// time, extra break). `sessions` is the COMPLETE intended set of in/out pairs for the day. A manager (own
// dept) or HR approves; on approval the day's existing punches are superseded and the requested sessions are
// written as `correction` sessions, so the derived day recomputes with no double-counting and no manual work.
export const attendanceRegularizations = sqliteTable("attendance_regularizations", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(), // the calendar day being corrected (UTC midnight)
  sessions: text("sessions", { mode: "json" }).notNull().$type<{ clock_in: string; clock_out: string }[]>(), // ISO instants; [] = day had no work (remove punches)
  reason: text("reason"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("attendance_regularizations_page_idx").on(t.createdAt, t.uuid), empIdx: index("attreg_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("attreg_state_idx").on(t.state) }));

// Attendance day mark: HR's decision about what ONE day is worth, replacing what the punches say.
//
// A regularization fixes the PUNCHES ("the times were wrong, here are the right ones") and is a request the
// employee files. This is the other half of the same problem and the opposite shape: the punches are right
// and the day still should not count the way they make it count - a short afternoon agreed in advance that
// should be paid in full, or eight hours clocked by somebody who was not working. So it is an HR ACTION, not
// a request: no state machine, no approval, and the person it is about does not file it.
//
// `credit` is the same scale `lopDayUnits` settles on (domain/attendance.ts), which is what makes a mark a
// substitute for the derived value rather than a second mechanism stacked on it. Soft-deletable: removing the
// mark is how a day goes back to being judged on its punches, and the trail of what was decided stays.
export const attendanceDayMarks = sqliteTable("attendance_day_marks", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(), // the calendar day being marked (UTC midnight)
  credit: text("credit", { enum: ["full", "half", "absent"] }).notNull(),
  reason: text("reason"),
  createdAt: created(),
  updatedAt: updated(),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete: the day goes back to its punches
}, (t) => ({
  pageIdx: index("attendance_day_marks_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("attmark_emp_idx").on(t.employeeId, t.date),
  // ONE LIVE MARK PER PERSON PER DAY. Two marks on one day is not a state the readers can settle - payroll
  // would take whichever the query returned first - so the database refuses it rather than leaving the answer
  // to row order. Deleted ones are excluded, so a day can be re-marked after its mark is withdrawn.
  liveDayUniq: uniqueIndex("attmark_live_day_idx").on(t.employeeId, t.date).where(sql`${t.deleteTime} is null`),
}));

// Overtime request: an employee logs extra hours worked on a day for approval. Employee-owned + code-scoped
// (own/dept/all, like leave-requests): the employee files, a manager (own dept) or HR approves/rejects, the
// owner can cancel while pending. Private by default - granted via the ACL. Hours are decimal (e.g. 1.5).
export const overtimeRequests = sqliteTable("overtime_requests", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(), // the day the overtime was worked (UTC midnight, derived from startTime)
  startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp_ms" }).notNull(), // duration = endTime - startTime (minutes are derived, summed per employee per month)
  reason: text("reason"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  decisionNote: text("decision_note"),
  // Approved overtime is an unpaid payable until a payroll run pays it (taxable earning); paidRunId pins which
  // run did, so a rebuild is idempotent (reset first) and it's never double-paid (mirrors bonuses).
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("overtime_requests_page_idx").on(t.createdAt, t.uuid), empIdx: index("ot_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("ot_state_idx").on(t.state) }));

// Work-from-home / remote-day request: an employee requests to work remotely over a date range. Employee-owned
// + code-scoped (own/dept/all, like leave-requests): the employee files, a manager (own dept) or HR approves/
// rejects, the owner cancels while pending. Private by default. Does NOT consume any leave balance.
export const remoteWorkRequests = sqliteTable("remote_work_requests", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(), // first remote day (UTC midnight)
  endDate: integer("end_date", { mode: "timestamp_ms" }).notNull(), // last remote day (inclusive)
  // Half-day support (like leave-requests): the range runs from startSession of startDate through endSession of
  // endDate. 1 = first half (AM), 2 = second half (PM). A single morning = start 1/end 1; afternoon = 2/2.
  startSession: integer("start_session").notNull().default(1),
  endSession: integer("end_session").notNull().default(2),
  location: text("location"), // where they'll work from, e.g. Home / a city / client site
  reason: text("reason"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  decisionNote: text("decision_note"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("remote_work_requests_page_idx").on(t.createdAt, t.uuid), empIdx: index("rwr_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("rwr_state_idx").on(t.state) }));

// Late arrival / early departure request: an employee asks to come in late, or leave early, on one day.
// Employee-owned + code-scoped (own/dept/all, like overtime-requests): the employee files, a manager (own dept)
// or HR approves or rejects, the owner cancels while pending. The row records only that it was asked and how it
// was answered; what an approved one does to the day and to pay is the org's policy (settings/punctuality, read
// through domain/punctuality.ts), so changing the policy changes every day it covers without rewriting a row.
export const lateEarlyRequests = sqliteTable("late_early_requests", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(), // the org-local day it is about (UTC midnight)
  kind: text("kind", { enum: ["late_arrival", "early_departure"] }).notNull(),
  // Wall-clock "HH:MM" in the org timezone: when they will arrive (a late arrival) or leave (an early departure).
  at: text("at").notNull(),
  // How far `at` is from the shift edge it moves, fixed when filed: the monthly allowance is counted in these, so
  // a later change to the shift does not re-price requests already made.
  minutes: integer("minutes").notNull(),
  reason: text("reason"),
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).notNull().default("PENDING"),
  // Filed past the monthly allowance while the policy accepts such requests; shown to whoever decides it.
  overLimit: integer("over_limit", { mode: "boolean" }).notNull().default(false),
  // Approved on filing by the policy's auto-approval threshold, so `decidedBy` is empty by design.
  autoApproved: integer("auto_approved", { mode: "boolean" }).notNull().default(false),
  decidedBy: text("decided_by").references(() => users.uuid),
  decisionNote: text("decision_note"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("late_early_requests_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("ler_emp_idx").on(t.employeeId, t.date),
  // The payroll build and the attendance windows read APPROVED rows over a range of days.
  stateDateIdx: index("ler_state_date_idx").on(t.state, t.date),
  // ONE LIVE REQUEST PER PERSON, DAY AND KIND. Two approved late arrivals on one day is not a state the day can be
  // judged by, and the filing check reads-then-inserts, so two presses at once would both pass it. Rejected and
  // cancelled rows are outside the predicate, so a day can be asked about again after a refusal.
  liveUniq: uniqueIndex("ler_live_idx").on(t.employeeId, t.date, t.kind).where(sql`${t.state} in ('PENDING', 'APPROVED')`),
}));

// A request for kit: "I need a laptop". Employee-owned + code-scoped (own/dept/all, like leave-requests): the
// employee files it naming a CATEGORY (not a specific machine - which one they get is inventory's call), a
// manager or HR decides, the owner cancels while pending.
//
// One state past the usual approve/reject: an approved request still owes the person an actual thing, so
// `:issue` hands over an in-stock asset and lands the row in ISSUED with `issuedAssetId` pointing at what they
// got. The hand-over runs through the normal assignment path, so the asset waits in `pending_ack` until the
// holder scans its tag - a request being closed is not evidence that anybody received anything.
export const assetRequests = sqliteTable("asset_requests", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  categoryId: text("category_id").notNull().references((): AnySQLiteColumn => assetCategories.uuid), // what kind of thing is being asked for
  justification: text("justification"), // why they need it (what an approver reads)
  neededBy: integer("needed_by", { mode: "timestamp_ms" }), // when it stops being useful, e.g. a client visit
  state: text("state", { enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "ISSUED"] }).notNull().default("PENDING"),
  decidedBy: text("decided_by").references(() => users.uuid),
  decisionNote: text("decision_note"),
  issuedAssetId: text("issued_asset_id").references((): AnySQLiteColumn => assets.uuid), // the thing they were actually given
  issuedAt: integer("issued_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("asset_requests_page_idx").on(t.createdAt, t.uuid), empIdx: index("areq_emp_idx").on(t.employeeId, t.createdAt, t.uuid), stateIdx: index("areq_state_idx").on(t.state) }));

// Approval delegation (out-of-office cover). A manager who'll be away names a delegate to receive - and act on
// - approvals during a date window. Owner = the delegator (their own record, self-service). While a delegation
// is active, manager-directed notifications also copy the delegate (services/notifications.ts activeDelegate),
// so nothing stalls while the manager is out. Click-through approval works whenever the delegate already holds
// the delegator's approval scope (same department / HR) - cross-scope authority stays an ACL grant.
export const approvalDelegations = sqliteTable("approval_delegations", {
  uuid: pk(),
  code: codeCol(),
  delegatorId: text("delegator_id").notNull().references(() => employees.uuid), // owner: who is away
  delegateId: text("delegate_id").notNull().references(() => employees.uuid), // who covers
  fromDate: integer("from_date", { mode: "timestamp_ms" }).notNull(), // first covered day (UTC midnight)
  toDate: integer("to_date", { mode: "timestamp_ms" }).notNull(), // last covered day (inclusive)
  reason: text("reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("approval_delegations_page_idx").on(t.createdAt, t.uuid), delegatorIdx: index("appdel_delegator_idx").on(t.delegatorId, t.createdAt, t.uuid), delegateIdx: index("appdel_delegate_idx").on(t.delegateId) }));

// Notice-period tracking: a departing employee's notice (resignation/termination/retirement) - notice date +
// last working day, with a derived countdown. Employee-owned + code-scoped (own/dept/all): the employee sees
// their own, a manager their dept, HR all. Private by default. Status: serving -> completed | withdrawn.
export const noticePeriods = sqliteTable("notice_periods", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  type: text("type", { enum: ["resignation", "termination", "retirement", "other"] }).notNull().default("resignation"),
  noticeDate: integer("notice_date", { mode: "timestamp_ms" }).notNull(), // date notice was given (UTC midnight)
  lastWorkingDay: integer("last_working_day", { mode: "timestamp_ms" }).notNull(), // planned final working day
  status: text("status", { enum: ["serving", "completed", "withdrawn"] }).notNull().default("serving"),
  reason: text("reason"),
  notes: text("notes"),
  // The offboarding transition this notice kicked off, if any. Its state + anchor (last working day) stay in
  // sync with the notice (completed -> transition completed, withdrawn -> cancelled).
  transitionId: text("transition_id").references(() => transitions.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("notice_periods_page_idx").on(t.createdAt, t.uuid), empIdx: index("notice_emp_idx").on(t.employeeId, t.createdAt, t.uuid), statusIdx: index("notice_status_idx").on(t.status) }));

// Letter templates: the HR letter/document types (offer, increment, ...). First-class objects so
// per-template access uses the real engine - READ = who may generate this letter type, WRITE =
// who may edit it. Private by default; seed widens read+write to hr_admin. `blocks`/`inputs` are the editable
// template content (see src/domain/letters.ts), stored as JSON.
// The org's letterhead catalogue: the stationery documents are ISSUED on, one per legal entity or brand,
// distinct from the single app-branding logo in settings/organization. `design_json` is the page itself
// (domain/letterhead.ts): margins, typeface, palette, header band, footer band, watermark. A letter template
// names one as its default and a generation can override it. The artwork lives in R2 (`letterheads/<uuid>`),
// never in a settings blob - lib/refData.ts snapshots the whole settings table on the first settings read of a
// request, so an image parked there would be bytes read on nearly every request.
export const letterheads = sqliteTable("letterheads", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(), // the entity/brand this letterhead belongs to
  // The letterhead's IMAGES, by slot (domain/letterhead.ts LETTERHEAD_SLOTS): a header mark, screen
  // stationery, print stationery, a watermark. `{ [slot]: { key, content_type, size_bytes } }` - the bytes
  // themselves live in R2 under `letterheads/<uuid>/<slot>`, never in the row. A JSON column rather than a
  // child table because the whole set is read together, always, and never queried across rows.
  assetsJson: text("assets_json"),
  designJson: text("design_json"), // the page design (domain/letterhead.ts); null = the stock page
  // The same letterhead as it should come out of a printer - typically the screen page minus the flooded
  // background, or with the header band off because the paper is already pre-printed. Null = documents print
  // exactly as they render on screen, which is what a single-design letterhead means.
  printDesignJson: text("print_design_json"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("letterheads_page_idx").on(t.createdAt, t.uuid) }));

export const letterTemplates = sqliteTable("letter_templates", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(),
  category: text("category"), // grouping for the editor + generate pickers (Onboarding, Compensation, ...)
  filename: text("filename"), // download filename template (placeholders ok)
  // Which letterhead this type is issued on (letterheads.uuid). Null - or one since removed - falls back to the
  // org-wide default for letters, so a deleted letterhead degrades the letter rather than breaking it.
  letterheadId: text("letterhead_id"),
  inputs: text("inputs", { mode: "json" }).$type<unknown[]>(), // fields HR fills in at generation time
  blocks: text("blocks", { mode: "json" }).$type<unknown[]>().notNull(), // ordered content blocks
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("letter_templates_page_idx").on(t.createdAt, t.uuid) }));

// Suggestion box (employee engagement): an employee submits an idea/suggestion, optionally anonymously; peers
// upvote it; HR responds + moves it through a status. Owned by the SUBMITTER (code-scoped own/dept/all,
// owner-on-create), private by default - an org grants suggestions.read/write to `everyone` for an open box.
// When `anonymous`, the submitter is hidden from the serialized output (still stored for the owner's own view).
export const suggestions = sqliteTable("suggestions", {
  uuid: pk(),
  code: codeCol(),
  submitterId: text("submitter_id").notNull().references(() => employees.uuid),
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  category: text("category"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["new", "under_review", "planned", "implemented", "declined"] }).notNull().default("new"),
  response: text("response"), // HR's public reply
  respondedById: text("responded_by_id").references(() => users.uuid),
  // Set when this suggestion was folded into another one: the same idea, asked twice. The votes move to the
  // target (a duplicate splits support three ways and then looks unpopular), this row stays readable so its
  // submitter can see what happened to their words, and `:merge` is the only thing that writes it.
  mergedIntoId: text("merged_into_id").references((): AnySQLiteColumn => suggestions.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete (moderation)
  /** Withheld by the moderation gate - see `announcements.held_at`. Distinct from the soft-delete above: a
   *  held suggestion was never on the box, and releasing it is not a restore. */
  heldAt: integer("held_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("suggestions_page_idx").on(t.createdAt, t.uuid), submitterIdx: index("sugg_submitter_idx").on(t.submitterId, t.createdAt, t.uuid), statusIdx: index("sugg_status_idx").on(t.status) }));

// One upvote per (suggestion, employee). Internal table (NOT a collection) - counts fold into the suggestion
// serialize, exactly like announcement_reactions. One row per (suggestion, employee); `value` is the direction
// (+1 up, -1 down). Toggled via suggestions :upvote / :downvote (same direction clears, opposite flips).
export const suggestionVotes = sqliteTable("suggestion_votes", {
  uuid: pk(),
  suggestionId: text("suggestion_id").notNull().references(() => suggestions.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  value: integer("value").notNull().default(1),
  createdAt: created(),
}, (t) => ({ uniq: uniqueIndex("sugg_vote_uniq").on(t.suggestionId, t.employeeId), suggIdx: index("sugg_vote_sugg_idx").on(t.suggestionId) }));

// In-app notifications: one row per RECIPIENT, emitted server-side by event services (a leave decision, a
// kudos received, a new request to approve, ...). Owned by the recipient (code-scoped own/dept/all,
// owner = recipientId), private by default - an org grants notifications.read/write to `everyone` to switch
// the feature on. `readTime` null = unread. `link` is a web route the bell deep-links to (page key, optional
// `/id`). `type` is a machine tag (e.g. `leave.approved`) for the icon/grouping; title/body are pre-rendered.
export const notifications = sqliteTable("notifications", {
  uuid: pk(),
  code: codeCol(),
  recipientId: text("recipient_id").notNull().references(() => employees.uuid),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"), // web route to open, e.g. "leave-requests/history" or "documents"
  subject: text("subject"), // the resource this is about, as a path "<collection>/<id>" (wire-encoded outbound);
  // lets the web flag the matching list row "New". Null for notifications with no single subject (announcements).
  // Priority drives ordering + emphasis in the bell/list. urgent/high float to the top; an action item (e.g.
  // "sign this document") is typically high/urgent. Configurable per event category in settings/notifications.
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
  // Optional call-to-action verb the recipient should take (e.g. "sign", "acknowledge"). Drives a CTA label
  // in the UI; null = informational. The `link` opens the page where the action is performed.
  action: text("action"),
  // The person whose action produced this notification (approver, kudos-giver, commenter, ...). `actorId`
  // links to their employee row; `actorName` is DENORMALIZED at emit time so the recipient can render an
  // avatar + attribution ("Priya approved your leave") without a cross-employee read they may not be allowed.
  // Null for system/broadcast events (announcements, compliance reminders) - those show the category icon.
  actorId: text("actor_id").references(() => employees.uuid),
  actorName: text("actor_name"),
  // Snooze: while `snoozeUntil` is in the future the row is hidden from the feed + unread count, then it
  // resurfaces (still unread). Null = not snoozed. `dismissedTime` = archived out of the feed by the recipient
  // (a soft dismiss via PATCH, so it needs only write - never a hard delete). Null = still in the feed.
  snoozeUntil: integer("snooze_until", { mode: "timestamp_ms" }),
  dismissedTime: integer("dismissed_time", { mode: "timestamp_ms" }),
  readTime: integer("read_time", { mode: "timestamp_ms" }), // null = unread
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("notifications_page_idx").on(t.createdAt, t.uuid), recipientIdx: index("notif_recipient_idx").on(t.recipientId, t.createdAt, t.uuid), readIdx: index("notif_read_idx").on(t.readTime) }));

// Parked notifications awaiting the daily digest flush. When a recipient opts into digest mode, informational
// (no-CTA) low/normal notifications land here instead of the live feed; the day-tick coalesces each
// recipient's queue into ONE summary notification and clears the rows. Internal - never addressed by a route,
// so no wire code. Urgent/actionable notifications skip this entirely and post to `notifications` directly.
export const notificationDigestQueue = sqliteTable("notification_digest_queue", {
  uuid: pk(),
  recipientId: text("recipient_id").notNull().references(() => employees.uuid),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  createdAt: created(),
}, (t) => ({ recipientIdx: index("notif_digest_recipient_idx").on(t.recipientId) }));

// Support tickets: an employee-raised request filed under a category. The categories (and each category's
// default assignee) are org config, stored in the `ticket-categories` settings blob - NOT a collection. On
// create, the chosen category's default assignee is stamped onto `assigneeId`; it can be reassigned later.
// Owner-embedded code (the requester), so the middleware scopes it via me/my-dept exactly like leave-requests.
// Threaded follow-ups live in `ticket_comments`, served THROUGH this ticket's routes (not directly addressable).
export const tickets = sqliteTable("tickets", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid), // the requester
  category: text("category"), // key into the `ticket-categories` settings blob
  // The SERVICING department that owns this ticket (which team handles it) - distinct from the requester's own
  // department. Defaulted from the category's configured department on create, overridable, re-routable via
  // :route. Its managers get a per-ticket read share (like category members), so a dept lead sees their queue.
  departmentId: text("department_id").references(() => departments.uuid),
  assigneeId: text("assignee_id").references(() => employees.uuid), // auto-set from the category; reassignable
  subject: text("subject").notNull(),
  description: text("description"),
  priority: text("priority", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
  state: text("state", { enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "CANCELLED"] }).notNull().default("OPEN"),
  // The two service timestamps a queue is judged on. Stamped rather than derived: first response would
  // otherwise mean reading a ticket's whole comment thread for every row of a list, which is the cost the
  // checklist counts were denormalized to avoid.
  //
  // `firstResponseAt` is the first comment by somebody OTHER than the requester. It is claimed once and never
  // moves - a later reply is not a first response, and the requester chasing their own ticket is not an answer.
  // `resolvedAt` is when the ticket reached its CURRENT resolution: `:resolve` stamps it and `:reopen` clears
  // it, so a reopened ticket is honestly unresolved again rather than carrying the date it was wrongly closed.
  // A ticket resolved twice reports the second date, which is the one a reader asking "is this done" wants.
  firstResponseAt: integer("first_response_at", { mode: "timestamp_ms" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  // Files attached to the ticket: a JSON array of {key,name,content_type,size_bytes,created_at,by} where `key`
  // is the R2 object holding the bytes. A JSON column rather than a child collection because an attachment has
  // no life of its own - it is readable exactly when its ticket is, dies with it, and is never listed, shared
  // or granted on separately. Screenshots are how support tickets get answered, so this is not an extra.
  attachmentsJson: text("attachments_json").notNull().default("[]"),
  // Session recordings on this ticket: a JSON array of {id,created_at,by}, oldest first. `id` is a Sentry
  // replay id (32 hex) - an id, not a URL, because the org slug that completes the link is deploy
  // configuration (VITE_SENTRY_ORG) and baking a third party's URL shape into rows would outlive the vendor.
  //
  // An ARRAY, not one id, and for the same reason attachments are: a ticket is a conversation, and "can you
  // show me that again?" is the commonest thing support says. The first recording arrives with the report;
  // later ones are added from the ticket itself (`:attachRecording`). A JSON column rather than a child
  // collection because a recording has no life of its own - it is readable exactly when its ticket is, dies
  // with it, and is never listed or granted on separately.
  sessionReplaysJson: text("session_replays_json").notNull().default("[]"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("tickets_page_idx").on(t.createdAt, t.uuid), empIdx: index("ticket_emp_idx").on(t.employeeId, t.createdAt, t.uuid), deptIdx: index("ticket_dept_idx").on(t.departmentId), assigneeIdx: index("ticket_assignee_idx").on(t.assigneeId), stateIdx: index("ticket_state_idx").on(t.state) }));

// A predefined, reusable checklist (a named, ordered list of item texts) that can be copied onto a ticket.
// Unlike the per-ticket items below, this IS a first-class wire collection so each checklist is access-
// controlled individually through the authz middleware (private-by-default; who can see/use a checklist is its
// read grant, managed in the ACL UI). `items` is a JSON-encoded string[].
export const ticketChecklists = sqliteTable("ticket_checklists", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  items: text("items").notNull().default("[]"), // JSON string[]
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("ticket_checklists_page_idx").on(t.createdAt, t.uuid) }));

// A checklist item on a ticket - the assignee's working todo list. Like ticket_comments, it's a sub-resource
// reached only through the ticket's routes (not a directly-addressable wire collection), so access inherits
// the parent ticket. Items can be added one-off or copied in bulk from a predefined `ticket-checklists`
// checklist; the text is snapshotted on copy, so later checklist edits never change items already on a ticket.
// Ordered by createdAt; toggling `done` does not reorder.
export const ticketTodos = sqliteTable("ticket_todos", {
  uuid: pk(),
  ticketId: text("ticket_id").notNull().references(() => tickets.uuid),
  text: text("text").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ ticketIdx: index("tt_ticket_idx").on(t.ticketId) }));

// A threaded reply/follow-up on a ticket. Append-only; reached only through the ticket's routes, so access
// inherits the parent ticket (like attachments - not a directly-addressable wire collection). `authorId` is
// the commenter's employee record when they have one; `authorEmail` is the fallback label for an admin/system
// actor with no employee record.
export const ticketComments = sqliteTable("ticket_comments", {
  uuid: pk(),
  ticketId: text("ticket_id").notNull().references(() => tickets.uuid),
  authorId: text("author_id").references(() => employees.uuid),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ ticketIdx: index("tc_ticket_idx").on(t.ticketId) }));

// ---- Global search index ------------------------------------------------------------------------------------
// One row per searchable record, across every collection. Exists because a `LIKE '%q%'` search cannot use an
// index: it scans, and D1 bills rows READ, so searching ~60 tables per keystroke would burn the daily read
// budget within a few dozen searches and get worse as the data grows. Matching instead runs against the FTS5
// table `search_fts` (created alongside this one - see src/db/searchDdl.ts), whose rowid is this table's
// rowid; a hit reads only the matching rows.
//
// NOT a wire collection: it holds no truth of its own, is never served, and carries no `uuid`/`code` of its
// own. Every row is maintained by triggers on the source table, so no service writes here and nothing can
// drift out of sync. `code` and `ownerId` are copied from the source row so the SAME `applyScope` predicate
// the collection's own list uses can be applied to a search hit; `deleted` and `restricted` mirror the source
// row's soft-delete and state-visibility so those rows are filtered rather than deleted from the index.
// One row per wire collection, holding WHEN it was last written to. Maintained by generated triggers (see
// src/db/changeDdl.ts) on every insert, update and delete of the table behind that collection.
//
// WHY A TABLE AND NOT THE AUDIT LOG. `GET /v1/changes` lets a client keep what it has stored instead of
// re-reading it, so a missed write is not a stale badge - it is a client serving yesterday's rows and never
// finding out. The audit log cannot carry that weight: cron accrual, the automation engine, the code cascade
// and the notification writer all write without an audit row, so "no audit entry" does not mean "no change".
// A trigger is the only place that sees every write - the same argument the search index rests on - so this is
// complete by construction rather than by everyone remembering.
//
// It is also cheap to ASK: one row per collection (about seventy in total), indexed on `at`, so the question
// "what changed since T" reads a handful of rows no matter how much data or history the org has.
// The high-water mark of each code namespace, so allocating a code is one indexed write instead of a read of
// every sibling (services/codeAlloc.ts).
//
// WHY. A `code` is allocated as max+1 over the codes already in its scope, and that max came from
// `SELECT code FROM <table>` - the WHOLE table for a flat namespace. For a bounded table (departments, boards)
// that is cheap and stayed cheap. For the append-only ones it is not: `event_log` is written by essentially
// every action in the app and is never pruned, so within a year each new action was reading a hundred thousand
// rows to compose one code, on a platform that bills rows read and caps CPU per request. `jobs`,
// `automation_runs`, `workflow_instances` and `cron_runs` have the same shape.
//
// `next` is the LAST value handed out for the scope, not the next one - a reservation of n values leaves it
// at the end of the run, so `allocFlatCodes` can take twenty at once and still be a single statement.
//
// THE INVARIANT this rests on: every code in a scope is minted through codeAlloc.ts. The counter is seeded on
// its first touch from the codes already there (one scan, once per scope ever), which is what lets it be
// introduced over an existing database and what makes a seeded database correct. Rows inserted with codes
// BEHIND the counter's back after that - a re-seed over a live database - would leave it stale; the unique
// index still refuses the duplicate, and `withFreshCode` walks the counter forward, so the failure mode is a
// retryable conflict rather than a duplicate code.
export const codeSequences = sqliteTable("code_sequences", {
  // "<table>" for a flat namespace, "<table>:<owner uuid>" for an owner-scoped one, and
  // "dept-children:<parent uuid | root>" for the child namespace under one department - which spans two tables
  // (its sub-departments and its employees share one sequence) and so is named after neither.
  scope: text("scope").primaryKey(),
  next: integer("next").notNull(),
});

/**
 * How often each GRANT PATTERN has actually authorized something, and when it last did - the counter an access
 * review reads to answer "which rules has nobody used?" and "which org-wide rule could be narrower?".
 *
 * WHY A COUNTER AND NOT A QUERY OVER `audit_log`. `decide()` already returns the pattern that allowed a request
 * and `lib/audit.ts` stamps it as `authorized_by` - but inside the row's JSON `meta` column. Rolling that up
 * means matching inside JSON across the whole table, which is the scan `docs/authz.md` §12.2 rules out ("D1
 * bills rows read and `LIKE '%q%'` cannot use an index"). `audit_log` grows with every action in the app, so
 * that report would cost more every month it ran. This is a handful of rows, keyed and indexed, written in the
 * SAME batch as the audit row it comes from - so it adds no round trip to any request.
 *
 * KEYED BY PATTERN, NOT BY RULE ID, deliberately. `via` carries the pattern because by decision time the grant
 * is a compiled projection and several rules have collapsed into one (see permissions.ts Decision.via), so a
 * rule id would have to be threaded through the compiler, the cached blob, mergeGrants and the API-key clamp.
 * The report therefore answers at pattern granularity and says so; "which of these three rules" is one query
 * away when somebody asks.
 *
 * NOT A COMPLETE PICTURE OF READS, and the report has to say this too: routine reads are deliberately not
 * audited (volume - see manifests.ts AUDIT), so a zero here means "no writes and no sensitive reads", not "no
 * access". It is still the right first cut for an access review, and it is the only one that is cheap.
 */
export const ruleUsage = sqliteTable("rule_usage", {
  // The grant pattern verbatim, e.g. `leave-requests.my-dept.**` - the same string `authorized_by` records.
  pattern: text("pattern").primaryKey(),
  hits: integer("hits").notNull().default(0),
  // How far the rule actually REACHED, counted alongside the total, which is what turns "this rule is org-wide"
  // into a recommendation an admin can act on: a rule whose every hit was the holder's own record, or inside
  // their own department, is one that could have been written at `self` or `dept`. Without these the report can
  // only say a rule is broad - which the admin already knew when they wrote it.
  //
  // Both counters are only incremented for a request that resolved to an ITEM; a collection-level request has no
  // row to classify, so it raises `hits` alone and the report treats `self + dept < hits` as "reached wider, or
  // reached something unclassifiable" - the conservative reading, which never recommends narrowing on thin
  // evidence.
  selfHits: integer("self_hits").notNull().default(0),
  deptHits: integer("dept_hits").notNull().default(0),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({
  // The report's window predicate ("nothing since <date>"), so it never reads the whole table.
  lastUsedIdx: index("rule_usage_last_used_idx").on(t.lastUsedAt),
}));

export const collectionVersions = sqliteTable("collection_versions", {
  collection: text("collection").primaryKey(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({
  atIdx: index("collection_versions_at_idx").on(t.at),
}));

export const searchDocs = sqliteTable("search_docs", {
  collection: text("collection").notNull(), // wire collection = the authz namespace
  recordId: text("record_id").notNull(), // the source row's uuid
  code: text("code"), // source row's hierarchy code, for applyScope
  ownerId: text("owner_id"), // source row's owner column, for applyScope's "own" breadth
  title: text("title"),
  subtitle: text("subtitle"),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  restricted: integer("restricted", { mode: "boolean" }).notNull().default(false), // non-public per state_visibility
  // When the source row was created, copied from its own createdAt. This is what makes "what is new since I
  // last looked" answerable as ONE indexed COUNT per collection (routes/activityCounts.ts) instead of the
  // client fetching a page of every collection it wants a badge for. Indexed, so a count reads the new rows
  // rather than scanning the table - the same reason the FTS index exists.
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
}, (t) => ({
  recordIdx: uniqueIndex("search_docs_record_idx").on(t.collection, t.recordId),
  createdIdx: index("search_docs_created_idx").on(t.createdAt),
}));

// How ⌘K is used, as DAILY COUNTERS - never a log of who searched for what. One row per (day, kind, label),
// incremented in place, so the table holds at most a few hundred rows a day however busy the palette is, and
// nothing in it names a person. services/searchInsights.ts is the only writer.
//
//   kind "zero"  label = a query that found nothing at all, normalised; what synonyms and nouns are missing.
//                Only queries that carry no identifier (lib scrubIdentifiers) are kept, and only short ones.
//   kind "open"  label = which result was opened: `<keyword|related|local>:<position bucket>`.
//   kind "ask"   label = what an Ask came back with: "answered" or "empty".
//
// Kept 30 days (cron.ts prunes it). Read through the `search-insights` collection, which no role is granted.
export const searchInsights = sqliteTable("search_insights", {
  uuid: pk(),
  code: codeCol(),
  day: text("day").notNull(), // UTC YYYY-MM-DD
  kind: text("kind", { enum: ["zero", "open", "ask"] }).notNull(),
  label: text("label").notNull(),
  count: integer("count").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  keyIdx: uniqueIndex("search_insights_key_idx").on(t.day, t.kind, t.label),
  pageIdx: index("search_insights_page_idx").on(t.createdAt, t.uuid),
}));

// A saved custom grid: which collection one row IS, which fields are its columns, and how it is filtered and
// sorted. The DEFINITION only - a view holds no data of its own, and running it re-reads every source under
// the runner's own scopes, so a view shared with somebody shows them their rows, never the author's.
//
// Owned by its author (the code embeds the owner, like goals and check-ins), so `me`-scoped rules work on it
// and sharing one is an ordinary object share on its code - the existing ACL, not a mechanism of its own.
export const tableViews = sqliteTable("table_views", {
  uuid: pk(),
  code: codeCol(),
  ownerId: text("owner_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  name: text("name").notNull(),
  description: text("description"),
  // The base collection one row of the grid is (`employees`, `tickets`, ...). Stored beside the spec because
  // it is what the builder and the run gate on first, and a filter on it should not have to parse JSON.
  base: text("base").notNull(),
  // { columns[], filters[], sort[], params{} } - validated against the catalogue on every write, so a stored
  // spec can never name a field that does not exist.
  specJson: text("spec_json").notNull(),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false), // a draft, while it is being built
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ pageIdx: index("table_views_page_idx").on(t.createdAt, t.uuid),
  ownerIdx: index("table_view_owner_idx").on(t.ownerId),
}));

// Loss of pay corrected after its period closed.
//
// One row per (employee, closed period) while unpaid, enforced below. That uniqueness IS the design: an
// adjustment RESTATES what a period should have docked rather than adding to a running total, so a second
// retroactive change to the same period must overwrite the first, not queue behind it. Three late approvals
// against one March leave one row worth three days. See domain/lopAdjust.ts for why the restatement is
// recomputed from scratch each time instead of accumulated.
//
// Signed throughout: positive = the run over-docked and the employee is owed it back, negative = it
// under-docked and the money is recovered. Loss of pay is itself a NEGATIVE EARNING, so the correction sits
// on the earning side too, or the two never net out on a payslip.
//
// `charged_units` and `correct_units` are stored beside the result rather than derived from it because they
// are the ARGUMENT for the figure - "the run docked 2, attendance says 1" is what makes the line defensible
// to the person it is paid to, and recomputing them later would read the period's attendance as it stands
// then rather than as it stood when the adjustment was raised.
export const lopAdjustments = sqliteTable("lop_adjustments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // The CLOSED period being corrected, not the one that will pay it.
  payPeriodId: text("pay_period_id").notNull().references(() => payPeriods.uuid),
  chargedUnits: real("charged_units").notNull(),
  correctUnits: real("correct_units").notNull(),
  dayUnits: real("day_units").notNull(),
  amount: real("amount").notNull(),
  // The run that settled it. Null while queued, which is the same shape bonuses, encashments, overtime and
  // reimbursements use - so the run build picks this up by the mechanism it already has for every other
  // late-arriving payable.
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  pageIdx: index("lop_adjustments_page_idx").on(t.createdAt, t.uuid),
  empIdx: index("lopadj_emp_idx").on(t.employeeId, t.createdAt, t.uuid),
  // At most ONE unpaid adjustment per (employee, period). A paid one is history and may sit beside a new
  // correction to the same period, which is why the index is partial rather than total.
  openUniq: uniqueIndex("lopadj_open_idx").on(t.employeeId, t.payPeriodId).where(sql`${t.paidRunId} is null`),
}));
