// The wire shape of every resource, derived from the OpenAPI contract.
//
// openapi.yaml is the single source of truth for what the API sends. `npm run api:types` compiles it to
// openapi.d.ts; this module turns those generated schemas into the types BOTH sides of the app use - the
// serializers annotate their return type with `Wire<"employee">`, and the SPA's `Employee` is the same type.
// One artifact, checked at both ends: a field the serializer emits but the spec omits fails to compile, and a
// field the spec promises but the serializer drops fails to compile too.
//
// ## Why ALWAYS_PRESENT exists
//
// Optionality cannot come entirely from the spec. A resource schema is $ref'd by its own POST and PATCH
// bodies as well as its responses (AEP-133/134 require exactly that), and Prism - which every local request
// goes through via `npm run dev:proxy` - enforces `required` on request bodies. It does honour the OpenAPI
// rule that a readOnly property is required in responses only, so server-assigned fields (path, etag,
// timestamps, computed rollups) ARE listed `required:` in the spec and arrive non-optional here for free.
//
// Writable fields cannot be: marking `first_name` required would make a two-field merge-patch a 422. Those are
// listed below instead. The list is a claim about the serializer, and annotating the serializers makes tsc
// check the claim rather than trust it - so this stays honest.
//
// To add a field: put it in openapi.yaml. Only add a name here if the serializer emits it UNCONDITIONALLY and
// it is writable - a `?? undefined`, a `ref(...)` (undefined for a null id) or a `...(cond ? {} : {})` spread
// means it is optional and belongs nowhere near this table.
import type { components } from "./openapi";

type Schemas = components["schemas"];

// Writable fields the serializer emits on every response. readOnly fields are handled by the spec's own
// `required:` lists (see above) and must not be repeated here.
type AlwaysPresent = {
  "personal-document": "display_name" | "document_type";
  "org-document": "display_name" | "document_type";
  "notification-prefs": "muted";
  "payroll-line": "code" | "name" | "kind" | "amount";
  "payroll-debit-account": "bank";
  "bank-format": "columns";
  "bank-format-column": "col" | "header" | "source";
  "identity-field": "key" | "label" | "mandatory" | "sensitive" | "has_value" | "has_doc";
  "access-rule": "subject_kind" | "subject" | "collection" | "scope" | "effect";
  announcement: "kind" | "title" | "body";
  application: "stage" | "status";
  "approval-delegation": "from_date" | "to_date";
  asset: "name" | "status";
  "attendance-regularization": "date" | "sessions";
  automation: "name" | "trigger_type" | "condition" | "actions" | "schedule" | "enabled";
  "background-check": "check_type" | "status";
  "benefit-enrollment": "status" | "dependents";
  "benefit-plan": "name" | "category" | "employee_cost" | "employer_cost" | "cost_period" | "allows_dependents" | "auto_enroll";
  board: "name" | "task_prefix" | "mode" | "columns" | "swimlane_mode" | "swimlanes" | "labels" | "hide_empty_lanes" | "reassign_lane_on_move";
  bonus: "amount" | "currency_code" | "award_date";
  candidate: "name";
  card: "column_key" | "rank" | "title" | "priority" | "labels" | "blocked";
  "check-in": "action_items";
  "table-view": "display_name" | "base" | "columns" | "filters" | "sort" | "params";
  compensation: "annual_ctc" | "currency_code" | "effective_from";
  "compliance-event": "title" | "frequency" | "due_date" | "status";
  "compliance-rule": "title" | "frequency" | "due_day" | "active";
  cron_run: "path" | "cron" | "status";
  department: "display_name" | "managers";
  dependent: "name" | "relationship";
  employee: "first_name" | "last_name" | "work_email" | "epf_enrolled" | "eps_excluded";
  event: "title" | "start_time" | "end_time" | "all_day" | "count_as_work" | "requires_clock_in" | "attendees";
  expense: "amount" | "tax_amount" | "reimbursable" | "recurring";
  "expense-budget": "period_type" | "period_key" | "amount" | "recurring";
  "expense-category": "display_name" | "requires_receipt";
  goal: "title" | "weight" | "progress" | "status";
  holiday: "display_name" | "date" | "kind";
  interview: "title" | "mode" | "interviewers" | "status";
  "interview-feedback": "ratings";
  "job-requisition": "title" | "openings" | "status";
  "leave-encashment": "days";
  "leave-request": "start_date" | "end_date" | "start_session" | "end_session";
  "leave-type": "display_name" | "accrual_frequency" | "paid" | "available_during_probation" | "probation_accrual_days_per_year" | "encashable" | "min_balance_retained_days" | "carry_forward";
  "letter-template": "label" | "blocks";
  loan: "kind" | "principal" | "installments";
  "notice-period": "type" | "notice_date" | "last_working_day" | "status";
  notification: "read";
  offer: "currency_code" | "status";
  "overtime-request": "start_time" | "end_time";
  "pay-component": "display_name" | "kind" | "method" | "recurring";
  "pay-grade": "display_name" | "level" | "currency_code";
  "pay-period": "display_name" | "period_start" | "period_end" | "pay_date";
  policy: "key" | "value";
  position: "effective_from";
  preference: "key" | "value";
  project: "name" | "billable" | "status";
  referral: "candidate_name" | "status";
  reimbursement: "amount";
  "reimbursement-category": "display_name" | "requires_receipt";
  "remote-work-request": "start_date" | "end_date" | "start_session" | "end_session";
  "review-cycle": "name";
  role: "name" | "label" | "protected";
  "salary-structure": "display_name" | "lines";
  setting: "key" | "value";
  settlement: "settlement_date" | "currency_code" | "leave_days" | "notice_shortfall_days";
  shift: "name" | "start" | "end" | "break_minutes";
  sprint: "name" | "state";
  suggestion: "anonymous" | "title" | "body";
  "tax-declaration": "financial_year" | "section" | "declared_amount";
  ticket: "subject" | "priority";
  "ticket-checklist": "display_name" | "items";
  "ticket-comment": "body";
  "ticket-todo": "text" | "done";
  "time-entry": "hours" | "billable";
  transition: "kind" | "name";
  user: "role" | "status";
  vendor: "display_name";
};

// A listed name that is not a property of its schema is a stale entry - rename a field in openapi.yaml and
// this fails to compile rather than silently narrowing nothing.
type _NoStaleEntries = {
  [N in keyof AlwaysPresent]: AlwaysPresent[N] extends keyof Schemas[N & keyof Schemas] ? true : ["stale key in AlwaysPresent", N, AlwaysPresent[N]];
};
const _assertNoStaleEntries: _NoStaleEntries[keyof AlwaysPresent] extends true ? true : never = true;
void _assertNoStaleEntries;

// The generated types mark server-assigned fields `readonly`. That reads well as documentation but fights
// both real uses: a serializer BUILDS the object field by field, and the SPA spreads it into edit drafts. Drop
// the modifier once, here, rather than in a wrapper at each end.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Require<T, K extends keyof T> = Omit<Mutable<T>, K> & { [P in K]-?: NonNullable<T[P]> };
type Always<N extends keyof Schemas> = N extends keyof AlwaysPresent ? AlwaysPresent[N] & keyof Schemas[N] : never;

/** The response shape for a collection, by schema name (`employee`, `bank-account`, ...). */
export type Wire<N extends keyof Schemas> = Require<Schemas[N], Always<N>>;

/**
 * Re-point an embedded array at the aliased child type. A parent that $refs a child (`transition.tasks` ->
 * `transition-task`) otherwise gets the child's raw schema, without the always-present narrowing.
 */
export type Embed<T, K extends keyof T, Child> = Omit<T, K> & EmbeddedArray<T, K, Child>;
// Mapped over Pick so the optional modifier is preserved: an embedded array the contract lists as required
// stays required, one it does not stays optional.
type EmbeddedArray<T, K extends keyof T, Child> = { [P in keyof Pick<T, K>]: Child[] };

/** The element type of an embedded array, so a sub-object shape is named once, in the contract. */
export type Item<T> = NonNullable<T> extends readonly (infer E)[] ? E : never;
