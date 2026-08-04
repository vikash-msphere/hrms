import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
const updated = () => integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

// Seed role set (the typed default). NOT the runtime source of truth - the `roles` table is. Kept only to
// seed that table and as the key set for DEFAULT_GRANTS. Roles are data: add/remove via a row, not an edit.
export const ROLES = ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"] as const;

// Policy store (all access-control policy is data). `roles` = the role set + lock-override rank; `grants`
// = one JSON blob per role (rides the auth read); `policy` = global manifest (protected fields, refs).
export const roles = sqliteTable("roles", {
  name: text("name").primaryKey(),
  label: text("label").notNull(),
  // Core roles cannot be deleted via the management API (lockout guard, P2). Data, not code: a non-core
  // role added later defaults to deletable.
  protected: integer("protected", { mode: "boolean" }).notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const users = sqliteTable("users", {
  uuid: pk(),
  code: codeCol(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("employee").references((): AnySQLiteColumn => roles.name, { onDelete: "restrict" }),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  employeeId: text("employee_id").references((): AnySQLiteColumn => employees.uuid),
  createdAt: created(),
  updatedAt: updated(),
});

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
  id: pk(),
  subject: text("subject").notNull(), // role name OR user uuid
  subjectKind: text("subject_kind", { enum: ["role", "user"] }).notNull(),
  namespace: text("namespace").notNull(), // collection (first pattern token) or '*' (the super "**" pattern)
  pattern: text("pattern").notNull(), // VERBATIM grant pattern - the decision input, never re-derived
  scopeKind: text("scope_kind", { enum: ["all", "subtree", "exact", "self", "dept"] }).notNull(),
  scopeCode: text("scope_code").notNull().default(""), // code prefix for subtree/exact; '' otherwise
  matchCode: text("match_code"), // exact object code for per-object rows (user OR exact role rules), the IN-narrowing key; NULL for scope rules
  level: text("level", { enum: ["read", "write", "admin"] }), // NULL for verb (allow) / deny rules
  effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  // One composite index serves every read: the role-rule fetch (subject prefix), the list shares/denies
  // fetch (subject+namespace prefix), and the user per-object exact-IN narrowing (full key) all use it - a
  // left-prefix superset, confirmed by EXPLAIN QUERY PLAN. (A separate (subject, namespace) index would be
  // redundant.)
  subjNsMatch: index("ar_subject_ns_match_idx").on(t.subject, t.namespace, t.matchCode),
}));

// Which optional holidays each employee has picked.
export const holidaySelections = sqliteTable("holiday_selections", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references((): AnySQLiteColumn => employees.uuid),
  holidayId: text("holiday_id").notNull().references((): AnySQLiteColumn => holidays.uuid),
  createdAt: created(),
}, (t) => ({ uk: uniqueIndex("hsel_emp_holiday_idx").on(t.employeeId, t.holidayId) }));

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
});

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
  // Short public "about me" (plain text, self-written via employees/<id>/bio). Not PII - readable by
  // anyone who can read the employee record; shown on profile heroes and the directory.
  bio: text("bio"),
  departmentId: text("department_id").references(() => departments.uuid),
  managerId: text("manager_id").references((): AnySQLiteColumn => employees.uuid),
  startDate: integer("start_date", { mode: "timestamp_ms" }),
  endDate: integer("end_date", { mode: "timestamp_ms" }),
  probationEndDate: integer("probation_end_date", { mode: "timestamp_ms" }),
  epfEnrolled: integer("epf_enrolled", { mode: "boolean" }).notNull().default(false), // EPF is opt-in per employee; default off (no PF deduction / employer share)
  // ENCRYPTED (base64 AES-GCM) - never plaintext, never serialized:
  nationalIdEnc: text("national_id_enc"),
  bankDetailsEnc: text("bank_details_enc"),
  identityDetailsEnc: text("identity_details_enc"), // JSON blob of configured identity field values
  personalDetailsEnc: text("personal_details_enc"), // JSON blob of contact + emergency info
  taxDetailsEnc: text("tax_details_enc"), // JSON blob: prior-employer income + TDS declarations (mid-year joiners)
  photoKey: text("photo_key"), // R2 key of the profile photo (JPEG), null if none
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
}, (t) => ({
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
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

export const leaveBalances = sqliteTable("leave_balances", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  leaveTypeId: text("leave_type_id").notNull().references(() => leaveTypes.uuid),
  balanceDays: real("balance_days").notNull().default(0),
  // Last calendar month (YYYY-MM, UTC) credited for this balance; makes monthly accrual idempotent.
  lastAccrualYm: text("last_accrual_ym"),
  // Last calendar year (YYYY, UTC) the year-end carry-forward cap was applied; makes rollover idempotent.
  lastCarryForwardYear: text("last_carry_forward_year"),
  createdAt: created(),
  updatedAt: updated(),
  // One balance row per (employee, leave type). Prevents the adjust insert-branch (or a concurrent accrual)
  // from creating duplicate rows that would split an employee's balance across rows and defeat the guarded
  // reserve/release. A duplicate insert now fails loudly instead of silently corrupting the balance.
}, (t) => ({ empIdx: index("bal_emp_idx").on(t.employeeId), empTypeUniq: uniqueIndex("bal_emp_type_idx").on(t.employeeId, t.leaveTypeId) }));

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
  reason: text("reason"),
  decidedBy: text("decided_by").references(() => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("lr_emp_idx").on(t.employeeId), stateIdx: index("lr_state_idx").on(t.state) }));

export const holidays = sqliteTable("holidays", {
  uuid: pk(),
  code: codeCol(),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["fixed", "optional"] }).notNull().default("fixed"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

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
  // as present / half day). When false the event simply marks attendees unavailable (excused) for its dates.
  countAsWork: integer("count_as_work", { mode: "boolean" }).notNull().default(false),
  color: text("color"), // hex for the timeline band; null = a default accent
  description: text("description"),
  attendeeIds: text("attendee_ids"), // JSON array of employee uuids marked unavailable
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ startIdx: index("event_start_idx").on(t.startTime) }));

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
  assigneeId: text("assignee_id").references((): AnySQLiteColumn => employees.uuid),
  notes: text("notes"),
  // The recurring rule that generated this occurrence, if any (null = ad-hoc one-off). Lets the UI flag
  // generated rows and the generator dedupe (rule + due_date) so a roll-forward never duplicates.
  ruleId: text("rule_id").references((): AnySQLiteColumn => complianceRules.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ dueIdx: index("compliance_due_idx").on(t.dueDate), ruleIdx: index("compliance_rule_idx").on(t.ruleId) }));

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
});

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
  notes: text("notes"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("bgcheck_emp_idx").on(t.employeeId) }));

export const orgDocuments = sqliteTable("org_documents", {
  uuid: pk(),
  code: codeCol(),
  ...docCommon(),
  // Acknowledgement (compliance): when requiresAck, in-scope employees must acknowledge the current version
  // via :acknowledge. Replacing the file bumps ackVersion so everyone must re-acknowledge the new version.
  requiresAck: integer("requires_ack", { mode: "boolean" }).notNull().default(false),
  ackVersion: integer("ack_version").notNull().default(1),
  // How an acknowledgement is signed (only meaningful when requiresAck): "internal" embeds the employee's
  // on-file signature image in place; "cashfree" runs a per-employee Aadhaar e-sign. Required when requiresAck.
  ackMethod: text("ack_method", { enum: ["internal", "cashfree"] }),
  // The signature box HR placed on the rendered PDF: a single {page,x1,y1,x2,y2} (PDF points, bottom-left
  // origin, 1-based page) - same shape as EsignSignAnchor. Where the signature is stamped / sign_positions
  // sent to the vendor. Required when requiresAck.
  signAnchorJson: text("sign_anchor_json"),
});

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
  signedTime: integer("signed_time", { mode: "timestamp_ms" }),
  signatureName: text("signature_name"), // typed full name = the e-signature attestation
  // Year-end tax docs (Form 16): the financial year the doc covers ("2025-26"), and whether it's the OFFICIAL
  // TRACES copy (uploaded by HR) vs an HRMS-generated Part-B summary. The UI prefers the official copy for a
  // year when present and falls back to the generated one. Null/false for ordinary personal documents.
  financialYear: text("financial_year"),
  official: integer("official", { mode: "boolean" }).notNull().default(false),
  // E-sign provider tracking (vendor-agnostic; see src/domain/esign.ts). Which driver handled this doc, the
  // provider's request id (matched by the inbound webhook), the last known status, and the signer link the
  // employee opens to sign at the vendor. `internal` (in-app image signing) leaves esignRequestId/esignUrl null.
  esignProvider: text("esign_provider"),
  esignRequestId: text("esign_request_id"),
  esignStatus: text("esign_status").notNull().default("none"),
  esignUrl: text("esign_url"),
  esignSentAt: integer("esign_sent_at", { mode: "timestamp_ms" }),
  esignSignedAt: integer("esign_signed_at", { mode: "timestamp_ms" }),
  ...docCommon(),
}, (t) => ({ empIdx: index("pdoc_emp_idx").on(t.employeeId), esignRefIdx: index("pdoc_esign_ref_idx").on(t.esignRequestId) }));

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
}, (t) => ({ empIdx: index("dack_emp_idx").on(t.employeeId), docIdx: index("dack_doc_idx").on(t.documentId) }));

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
  // Kudos (kind="kudos"): the recognized employee + recognition meta. The kudo message lives in `body`; `title`
  // is unused (""). `points` is snapshotted server-side from `level` via the kudos config so a giver can't
  // inflate their recognition. Null for every non-kudos kind. The author (board column) is the giver.
  recipientEmployeeId: text("recipient_employee_id").references(() => employees.uuid),
  // A kudo recognizes EITHER one employee (recipientEmployeeId) OR a whole department (recipientDepartmentId) -
  // exactly one is set. A department kudo is a single feed card fanned out as a notification to every member;
  // it carries no per-head points (the leaderboard groups by employee recipient, so a dept kudo credits no one).
  recipientDepartmentId: text("recipient_department_id").references((): AnySQLiteColumn => departments.uuid),
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
}, (t) => ({ annIdx: index("ar_ann_idx").on(t.announcementId), empIdx: index("ar_emp_idx").on(t.employeeId) }));

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
}, (t) => ({ annIdx: index("arx_ann_idx").on(t.announcementId), empIdx: index("arx_emp_idx").on(t.employeeId), replyIdx: index("arx_reply_idx").on(t.replyId) }));

// A reply on a board post. Append-only; reached only through the announcement's routes, so access inherits
// the parent post (like ticket_comments - not a directly-addressable wire collection). `authorId` is the
// replier's employee record when they have one; `authorEmail` is the fallback label for an actor without one.
export const announcementReplies = sqliteTable("announcement_replies", {
  uuid: pk(),
  announcementId: text("announcement_id").notNull().references(() => announcements.uuid),
  authorId: text("author_id").references(() => employees.uuid),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
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
}, (t) => ({ annIdx: index("apv_ann_idx").on(t.announcementId), empIdx: index("apv_emp_idx").on(t.employeeId), optIdx: index("apv_opt_idx").on(t.optionId) }));

// ---- Performance: goals ----
// An employee's goal (performance objective). Employee-owned and code-scoped like leave-requests, so the same
// own/dept/all ACL scopes apply. `weight` is a relative importance (0-100, used later to roll a goals score);
// `progress` is 0-100. Status is the lifecycle of the goal itself (distinct from progress so a goal can be
// 100% yet not formally marked done). A future review cycle link arrives with Phase 2.
export const goals = sqliteTable("goals", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  // Alignment: an optional parent goal this one rolls up under (a manager's/leader's goal). Link-only - the
  // parent's "aligned progress" is derived client-side from the children a viewer can see, never persisted.
  parentId: text("parent_id").references((): AnySQLiteColumn => goals.uuid),
  title: text("title").notNull(),
  description: text("description"),
  weight: integer("weight").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  status: text("status", { enum: ["not_started", "in_progress", "completed", "cancelled"] }).notNull().default("not_started"),
  dueDate: integer("due_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("goal_emp_idx").on(t.employeeId), parentIdx: index("goal_parent_idx").on(t.parentId) }));

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
  selfDueDate: integer("self_due_date", { mode: "timestamp_ms" }),
  managerDueDate: integer("manager_due_date", { mode: "timestamp_ms" }),
  state: text("state", { enum: ["DRAFT", "ACTIVE", "CLOSED"] }).notNull().default("DRAFT"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

// One employee's review within a cycle. Employee-owned + code-scoped like goals (own/dept/all). The workflow
// runs self -> manager -> shared -> acknowledged; each stage is skippable. `ratingsJson` holds the per-competency
// scores keyed by competency key (the framework lives in settings/performance); `overallRating` is the summary.
// Manager fields stay hidden from the owner-employee until SHARED (gated in serialize).
export const reviews = sqliteTable("reviews", {
  uuid: pk(),
  code: codeCol(),
  cycleId: text("cycle_id").notNull().references(() => reviewCycles.uuid),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  state: text("state", { enum: ["SELF", "MANAGER", "SHARED", "ACKNOWLEDGED"] }).notNull().default("SELF"),
  selfComment: text("self_comment"),
  selfRatingsJson: text("self_ratings_json"), // {[competencyKey]: number} - the employee's optional self ratings
  ackComment: text("ack_comment"), // optional employee note recorded on acknowledge
  managerComment: text("manager_comment"),
  overallRating: integer("overall_rating"),
  ratingsJson: text("ratings_json"), // {[competencyKey]: number}
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ cycleIdx: index("rev_cycle_idx").on(t.cycleId), empIdx: index("rev_emp_idx").on(t.employeeId) }));

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
  state: text("state", { enum: ["REQUESTED", "SUBMITTED", "DECLINED"] }).notNull().default("REQUESTED"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ reviewIdx: index("rf_review_idx").on(t.reviewId), authorIdx: index("rf_author_idx").on(t.authorId) }));

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
});

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
}, (t) => ({ boardIdx: index("sprint_board_idx").on(t.boardId) }));

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
  swimlaneKey: text("swimlane_key"),
  rank: real("rank").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  assigneeId: text("assignee_id").references(() => employees.uuid),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  labelsJson: text("labels_json").notNull().default("[]"), // string[] of board label-catalog keys
  documentsJson: text("documents_json").notNull().default("[]"), // string[] of org-document uuids linked to this card (link-only; no card-owned storage)
  size: integer("size"), // estimate / story points
  dueDate: integer("due_date", { mode: "timestamp_ms" }),
  blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
  blockReason: text("block_reason"), // optional free-text note on the block
  blockedById: text("blocked_by_id").references((): AnySQLiteColumn => cards.uuid), // the task this one is blocked by (a dependency)
  goalId: text("goal_id").references(() => goals.uuid),
  committedAt: integer("committed_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ boardIdx: index("card_board_idx").on(t.boardId), empIdx: index("card_emp_idx").on(t.employeeId), deptIdx: index("card_dept_idx").on(t.departmentId), assigneeIdx: index("card_assignee_idx").on(t.assigneeId), goalIdx: index("card_goal_idx").on(t.goalId) }));

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
}, (t) => ({ empIdx: index("trn_emp_idx").on(t.employeeId) }));

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
}, (t) => ({ trnIdx: index("trt_trn_idx").on(t.transitionId), assigneeIdx: index("trt_assignee_idx").on(t.assigneeId) }));

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
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("ci_emp_idx").on(t.employeeId) }));

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
}, (t) => ({ empIdx: index("dep_emp_idx").on(t.employeeId) }));

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
}, (t) => ({ empIdx: index("ben_emp_idx").on(t.employeeId), planIdx: index("ben_plan_idx").on(t.planId) }));

// ---- Shift scheduling ----
// An HR-defined shift pattern (flat-coded catalog like leave-types). Times are wall-clock "HH:MM" in the org
// timezone; a roster assignment puts a shift on a date for an employee.
export const shifts = sqliteTable("shifts", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  startTime: text("start_time").notNull().default("09:00"),
  endTime: text("end_time").notNull().default("18:00"),
  breakMinutes: integer("break_minutes").notNull().default(0),
  color: text("color"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

// A roster entry: an employee works a shift on a date. Employee-owned + code-scoped like leave-requests
// (own/dept/all), so an employee sees their own roster, a manager their team's, HR all. References a shift.
export const shiftAssignments = sqliteTable("shift_assignments", {
  uuid: pk(),
  code: codeCol(),
  employeeId: text("employee_id").notNull().references(() => employees.uuid),
  shiftId: text("shift_id").notNull().references(() => shifts.uuid),
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  note: text("note"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("sa_emp_idx").on(t.employeeId), shiftIdx: index("sa_shift_idx").on(t.shiftId), dateIdx: index("sa_date_idx").on(t.date) }));

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
  date: integer("date", { mode: "timestamp_ms" }).notNull(),
  hours: real("hours").notNull().default(0),
  description: text("description"),
  billable: integer("billable", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"] }).notNull().default("DRAFT"),
  decidedBy: text("decided_by").references(() => users.uuid),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("te_emp_idx").on(t.employeeId), projIdx: index("te_proj_idx").on(t.projectId), dateIdx: index("te_date_idx").on(t.date) }));

// ---- Loans / salary advances ----
// An employee's loan or salary advance, recovered over monthly installments. Employee-owned + code-scoped
// (own/dept/all, like leave-requests). Workflow PENDING -> APPROVED -> DISBURSED -> CLOSED (+ REJECTED).
// `monthlyAmount` is computed on approval (principal / installments); `repaid` accrues via recordRepayment;
// outstanding = principal - repaid (derived on the wire). Payroll-deduction integration is deferred.
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
}, (t) => ({ empIdx: index("loan_emp_idx").on(t.employeeId) }));

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
  amount: real("amount").notNull(),
  at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => ({ loanIdx: index("loan_repayment_loan_idx").on(t.loanId), runIdx: index("loan_repayment_run_idx").on(t.runId) }));

// ---- Investment / tax declarations ----
// One declared tax-saving item for a financial year (e.g. 80C: ELSS 50000). Employee-owned + code-scoped
// (own/dept/all, like leave-requests). Workflow DECLARED -> VERIFIED/REJECTED by payroll/HR; `verifiedAmount`
// is what they accept. A proof file attaches via the attachments service (slot "proof"), like reimbursement
// receipts. Feeding verified amounts into the tax computation is deferred.
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
}, (t) => ({ empIdx: index("td_emp_idx").on(t.employeeId), fyIdx: index("td_fy_idx").on(t.financialYear) }));

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
  ip: text("ip"), // request IP (cf-connecting-ip / x-forwarded-for), when available
  userAgent: text("user_agent"), // request User-Agent, when available
  at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  entIdx: index("audit_entity_idx").on(t.entity, t.entityId), // per-entity feed
  atIdx: index("audit_at_idx").on(t.at), // org-wide feed (newest-first keyset paging)
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
}, (t) => ({ statusIdx: index("jobs_status_idx").on(t.status) }));

// One row per scheduled (cron) tick, written by runScheduled: makes "did it run / when / how long / did it
// fail" observable (the crons themselves are stateless Cloudflare triggers that record nothing). Admin-only.
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
}, (t) => ({ cronIdx: index("cron_runs_cron_idx").on(t.cron), startedIdx: index("cron_runs_started_idx").on(t.startedAt) }));

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
}, (t) => ({ typeIdx: index("event_log_type_idx").on(t.type), occurredIdx: index("event_log_occurred_idx").on(t.occurredAt), corrIdx: index("event_log_corr_idx").on(t.correlationId) }));

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
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdBy: text("created_by").references((): AnySQLiteColumn => users.uuid),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ triggerIdx: index("automations_trigger_idx").on(t.triggerType) }));

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
}, (t) => ({ statusIdx: index("workflow_instances_status_idx").on(t.status) }));

// Observability of each firing (like cron_runs): which rule fired for which event, and the per-action outcome.
export const automationRuns = sqliteTable("automation_runs", {
  uuid: pk(),
  code: codeCol(),
  automationId: text("automation_id").notNull().references((): AnySQLiteColumn => automations.uuid),
  eventId: text("event_id").references((): AnySQLiteColumn => eventLog.uuid),
  eventType: text("event_type").notNull(),
  status: text("status", { enum: ["done", "partial", "error", "skipped"] }).notNull(),
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
}, (t) => ({ autoIdx: index("automation_runs_auto_idx").on(t.automationId), startedIdx: index("automation_runs_started_idx").on(t.startedAt), corrIdx: index("automation_runs_corr_idx").on(t.correlationId) }));

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
  payGradeId: text("pay_grade_id").references((): AnySQLiteColumn => payGrades.uuid),
  // Optional salary structure: governs which recurring EARNING components apply to this employee (with
  // per-structure rate overrides). Null = the global component set applies (default behaviour).
  structureId: text("structure_id").references((): AnySQLiteColumn => salaryStructures.uuid),
  effectiveFrom: integer("effective_from", { mode: "timestamp_ms" }).notNull(),
  effectiveTo: integer("effective_to", { mode: "timestamp_ms" }), // null = current
  // Retro arrears owed by a BACKDATED revision: (new base - prior base) x whole months from effective_from to
  // the revision month. Paid as a taxable earning by the next payroll run; paidRunId pins which run (idempotent).
  arrearsAmount: real("arrears_amount").notNull().default(0),
  arrearsPaidRunId: text("arrears_paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  arrearsPaidAt: integer("arrears_paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
  // At most ONE open (current) row per employee, enforced by the DB. A revision closes the open row and inserts
  // a new one in two statements; two concurrent revisions would otherwise both close the same row and leave TWO
  // open rows - an ambiguous current salary, and arrears computed (and paid) twice off the same delta.
}, (t) => ({
  empIdx: index("comp_emp_idx").on(t.employeeId),
  openUniq: uniqueIndex("comp_open_idx").on(t.employeeId).where(sql`${t.effectiveTo} is null`),
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
  note: text("note"),
  effectiveFrom: integer("effective_from", { mode: "timestamp_ms" }).notNull(),
  effectiveTo: integer("effective_to", { mode: "timestamp_ms" }), // null = current
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("pos_emp_idx").on(t.employeeId) }));

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
  // A bonus is an unpaid payable until a payroll run pays it (taxable earning); paidRunId pins which run did,
  // so a rebuild is idempotent (reset first) and it's never double-paid.
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("bonus_emp_idx").on(t.employeeId), batchIdx: index("bonus_batch_idx").on(t.batchId), paidIdx: index("bonus_paid_idx").on(t.paidRunId) }));

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
}, (t) => ({ referrerIdx: index("referral_referrer_idx").on(t.referrerId), hiredIdx: index("referral_hired_idx").on(t.hiredEmployeeId) }));

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
  status: text("status", { enum: ["draft", "open", "on_hold", "closed", "filled"] }).notNull().default("draft"),
  openedDate: integer("opened_date", { mode: "timestamp_ms" }),
  closedDate: integer("closed_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ deptIdx: index("requisition_dept_idx").on(t.departmentId) }));

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
}, (t) => ({ emailIdx: index("candidate_email_idx").on(t.email) }));

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
  appliedDate: integer("applied_date", { mode: "timestamp_ms" }),
  stageChangedDate: integer("stage_changed_date", { mode: "timestamp_ms" }),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ candidateIdx: index("application_candidate_idx").on(t.candidateId), requisitionIdx: index("application_requisition_idx").on(t.requisitionId) }));

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
}, (t) => ({ applicationIdx: index("interview_application_idx").on(t.applicationId) }));

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
}, (t) => ({ interviewIdx: index("if_interview_idx").on(t.interviewId), authorIdx: index("if_author_idx").on(t.authorId) }));

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
}, (t) => ({ applicationIdx: index("offer_application_idx").on(t.applicationId) }));

// Company asset inventory (laptops, phones, etc.). Org-level (flat code); ownership is dynamic via
// `assignedTo` (an employee, nullable when in stock), so the same row can be reassigned over time. The
// employee profile lists assets assigned to that person; the inventory page lists everything.
export const assets = sqliteTable("assets", {
  uuid: pk(),
  code: codeCol(),
  assetTag: text("asset_tag"), // internal label, e.g. LAP-014
  name: text("name").notNull(), // e.g. "MacBook Pro 14"
  category: text("category"), // laptop / phone / monitor / peripheral / furniture / other
  serialNumber: text("serial_number"),
  status: text("status", { enum: ["in_stock", "assigned", "repair", "retired"] }).notNull().default("in_stock"),
  assignedTo: text("assigned_to").references(() => employees.uuid),
  assignedOn: integer("assigned_on", { mode: "timestamp_ms" }),
  purchaseDate: integer("purchase_date", { mode: "timestamp_ms" }),
  tagPrintedAt: integer("tag_printed_at", { mode: "timestamp_ms" }), // last time a physical sticker tag was printed for this asset
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }), // last time the physical asset was sighted (stocktake scan)
  notes: text("notes"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ assignedIdx: index("asset_assigned_idx").on(t.assignedTo), statusIdx: index("asset_status_idx").on(t.status) }));

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
  // Exactly which payables this FnF consumed: {reimbursements,bonuses,encashments,overtime,arrears,loans[],
  // leaveDebits[]} by id. The FnF is the leaver's terminal payout, so it takes those rows OUT of the payroll
  // queues (they would otherwise never be paid - a terminated employee is in no run). Recording the ids is
  // what makes a recompute safe: POSTing a corrected settlement releases exactly what the previous one took
  // before re-pricing, the same release-then-rebuild contract a payroll run has.
  settledJson: text("settled_json"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("settle_emp_idx").on(t.employeeId) }));

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
}, (t) => ({ empIdx: index("encash_emp_idx").on(t.employeeId), stateIdx: index("encash_state_idx").on(t.state) }));

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
});

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
});

export const payComponents = sqliteTable("pay_components", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  // earning = paid, in gross; deduction = withheld from gross (employee side); employer_contribution = the
  // employer's on-top cost (PF/ESI/gratuity), never on the payslip, only in CTC. What is provided (gratuity
  // etc.), at what rate/cap/method, is ALL data: add/remove a row, no code changes.
  kind: text("kind", { enum: ["earning", "deduction", "employer_contribution"] }).notNull(),
  method: text("method", { enum: ["fixed", "percent_base", "rate_qty", "income_tax", "epf", "esi", "pt"] }).notNull().default("fixed"),
  rate: real("rate"),
  cap: real("cap"), // for method "epf": wage ceiling on the base (e.g. 15000); null = apply to full base
  regime: text("regime"), // for method "income_tax": which tax regime block to use (e.g. "new")
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(true),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

export const payPeriods = sqliteTable("pay_periods", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(),
  periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
  periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
  payDate: integer("pay_date", { mode: "timestamp_ms" }).notNull(),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

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
  // When a bank payout file was first generated for this run. Downloading it is the point where the money
  // leaves the company, and deleting a run RELEASES every payable it paid back into the queue - so once this
  // is stamped the run can no longer be deleted, otherwise the next run would pay the same one-offs again.
  bankFileAt: integer("bank_file_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
  // At most ONE committed (APPROVED/PUBLISHED) run per pay period, enforced by the DB. Drafts are unrestricted
  // (many can coexist), but the money commits at APPROVE, so a partial unique index makes a second concurrent
  // approve for the same period fail loudly instead of the check-then-write race paying the monthly salary twice.
}, (t) => ({
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
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ runIdx: index("rri_run_idx").on(t.runId), runEmpUniq: uniqueIndex("rri_run_emp_idx").on(t.runId, t.employeeId) }));

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
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("payslip_emp_idx").on(t.employeeId), runIdx: index("payslip_run_idx").on(t.runId) }));

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
});

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
  paidRunId: text("paid_run_id").references((): AnySQLiteColumn => payrollRuns.uuid), // set when paid via a payroll run
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("reimb_emp_idx").on(t.employeeId), stateIdx: index("reimb_state_idx").on(t.state) }));

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
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

// Vendor master: who the company pays. Flat reference (soft-delete/disable/lock like a category).
export const vendors = sqliteTable("vendors", {
  uuid: pk(),
  code: codeCol(),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  taxId: text("tax_id"), // GSTIN / tax registration
  paymentTerms: text("payment_terms"), // e.g. "Net 30"
  bankDetails: text("bank_details"),
  defaultCategoryId: text("default_category_id").references(() => expenseCategories.uuid),
  notes: text("notes"),
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  lockedBy: text("locked_by"),
  createdAt: created(),
  updatedAt: updated(),
});

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
  paidBy: text("paid_by").references(() => users.uuid),
  paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  // Recurrence: a template row (isRecurring=true) is cloned by the daily cron into concrete expenses.
  isRecurring: integer("is_recurring", { mode: "boolean" }).notNull().default(false),
  recurrenceRule: text("recurrence_rule", { enum: ["monthly", "quarterly", "yearly"] }),
  nextOccurrenceOn: integer("next_occurrence_on", { mode: "timestamp_ms" }),
  lastGeneratedOn: integer("last_generated_on", { mode: "timestamp_ms" }),
  templateId: text("template_id").references((): AnySQLiteColumn => expenses.uuid), // the recurring template this was cloned from
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  empIdx: index("exp_emp_idx").on(t.employeeId),
  stateIdx: index("exp_state_idx").on(t.state),
  deptIdx: index("exp_dept_idx").on(t.departmentId),
  catIdx: index("exp_cat_idx").on(t.categoryId),
  vendorIdx: index("exp_vendor_idx").on(t.vendorId),
}));

// Budget: a spend cap for a (department?, category?, period). NULL dept = org-wide; NULL category = all
// categories. `spent`/`remaining`/`utilization` are derived (never stored) from APPROVED+PAID expenses.
// `alertLevel` records the highest threshold already alerted (0/80/100) so a budget alert fires once.
export const expenseBudgets = sqliteTable("expense_budgets", {
  uuid: pk(),
  code: codeCol(),
  departmentId: text("department_id").references(() => departments.uuid),
  categoryId: text("category_id").references(() => expenseCategories.uuid),
  periodType: text("period_type", { enum: ["monthly", "quarterly", "yearly"] }).notNull(),
  periodKey: text("period_key").notNull(), // "2026" | "2026-Q1" | "2026-07"
  amount: real("amount").notNull(),
  alertLevel: integer("alert_level").notNull().default(0), // highest budget-alert threshold already fired
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ periodIdx: index("expbudget_period_idx").on(t.periodType, t.periodKey) }));

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
}, (t) => ({ empIdx: index("att_emp_idx").on(t.employeeId), openIdx: index("att_open_idx").on(t.clockOut) }));

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
}, (t) => ({ empIdx: index("attreg_emp_idx").on(t.employeeId), stateIdx: index("attreg_state_idx").on(t.state) }));

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
}, (t) => ({ empIdx: index("ot_emp_idx").on(t.employeeId), stateIdx: index("ot_state_idx").on(t.state) }));

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
}, (t) => ({ empIdx: index("rwr_emp_idx").on(t.employeeId), stateIdx: index("rwr_state_idx").on(t.state) }));

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
}, (t) => ({ delegatorIdx: index("appdel_delegator_idx").on(t.delegatorId), delegateIdx: index("appdel_delegate_idx").on(t.delegateId) }));

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
}, (t) => ({ empIdx: index("notice_emp_idx").on(t.employeeId), statusIdx: index("notice_status_idx").on(t.status) }));

// Letter templates: the HR letter/document types (offer, increment, ...). First-class objects so
// per-template access uses the real engine - READ = who may generate this letter type, WRITE =
// who may edit it. Private by default; seed widens read+write to hr_admin. `blocks`/`inputs` are the editable
// template content (see src/domain/letters.ts), stored as JSON.
export const letterTemplates = sqliteTable("letter_templates", {
  uuid: pk(),
  code: codeCol(),
  label: text("label").notNull(),
  category: text("category"), // grouping for the editor + generate pickers (Onboarding, Compensation, ...)
  filename: text("filename"), // download filename template (placeholders ok)
  inputs: text("inputs", { mode: "json" }).$type<unknown[]>(), // fields HR fills in at generation time
  blocks: text("blocks", { mode: "json" }).$type<unknown[]>().notNull(), // ordered content blocks
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
});

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
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete (moderation)
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ submitterIdx: index("sugg_submitter_idx").on(t.submitterId), statusIdx: index("sugg_status_idx").on(t.status) }));

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
}, (t) => ({ recipientIdx: index("notif_recipient_idx").on(t.recipientId), readIdx: index("notif_read_idx").on(t.readTime) }));

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
  deleteTime: integer("delete_time", { mode: "timestamp_ms" }), // soft-delete
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({ empIdx: index("ticket_emp_idx").on(t.employeeId), deptIdx: index("ticket_dept_idx").on(t.departmentId), assigneeIdx: index("ticket_assignee_idx").on(t.assigneeId), stateIdx: index("ticket_state_idx").on(t.state) }));

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
});

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
export const searchDocs = sqliteTable("search_docs", {
  collection: text("collection").notNull(), // wire collection = the authz namespace
  recordId: text("record_id").notNull(), // the source row's uuid
  code: text("code"), // source row's hierarchy code, for applyScope
  ownerId: text("owner_id"), // source row's owner column, for applyScope's "own" breadth
  title: text("title"),
  subtitle: text("subtitle"),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  restricted: integer("restricted", { mode: "boolean" }).notNull().default(false), // non-public per state_visibility
}, (t) => ({
  recordIdx: uniqueIndex("search_docs_record_idx").on(t.collection, t.recordId),
}));
