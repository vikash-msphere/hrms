// The table builder's catalogue rules: WHICH collections may be the base of a custom grid, which of their
// columns may become a column of one, and which extra per-employee sources hang off a row.
//
// Pure (no db, no schema imports) so the authz middleware can import `TABLE_SOURCE_COLLECTIONS` for its
// fan-out - exactly as it does with domain/peopleAnalytics and domain/dashboardSummary. The half that needs
// the schema (columns, foreign keys) is derived in services/tableCatalog.ts from these rules.
//
// The safety argument the whole feature rests on: a grid column is only ever a field of a collection the
// caller may LIST, over rows that collection's own list scope allows. Nothing here grants anything; this
// file only decides what a builder is allowed to OFFER.
import { METRICS } from "./peopleAnalytics";

/** What a value IS, so one formatter serves every column and the SPA needs no table of its own. */
export type FieldKind = "text" | "number" | "money" | "date" | "datetime" | "bool" | "enum" | "ref";

/**
 * A base collection: the thing one row of the grid IS. Registered explicitly rather than derived from the
 * table registry, because being listable is not the same as being safely projectable - see EXCLUDED_BASES.
 */
export type BaseDef = {
  /** Plural label for the base picker. */
  label: string;
  /**
   * Columns never offered, on top of the global rules below. Every entry names a column whose WIRE form is
   * conditional (the serializer hides it for some rows or some callers), so projecting the raw column would
   * be a way round that rule. Keep the reason with the entry.
   */
  deny?: readonly string[];
  /** Money columns that the name heuristic misses, or non-money numbers it wrongly claims. */
  money?: readonly string[];
  notMoney?: readonly string[];
};

/**
 * The bases. A collection is here only once its list has been read and found to narrow by SCOPE alone (plus
 * benign presentation filters like a state or a date range) - `applyScope` is then the whole story, and a
 * generic scope-bound query over the table returns exactly the rows that collection's own list would.
 */
export const BASES: Record<string, BaseDef> = {
  employees: { label: "People", deny: ["notificationPrefs"] }, // per-user JSON blob, never a wire field
  departments: { label: "Departments" },
  positions: { label: "Role history" },
  compensation: { label: "Compensation history" },
  payslips: { label: "Payslips" },
  bonuses: { label: "Bonuses" },
  loans: { label: "Loans & advances" },
  settlements: { label: "Full & final settlements" },
  "leave-requests": { label: "Leave requests" },
  "leave-balances": { label: "Leave balances" },
  "leave-types": { label: "Leave types" },
  "leave-encashments": { label: "Leave encashments" },
  holidays: { label: "Holidays" },
  "attendance-regularizations": { label: "Attendance corrections" },
  "overtime-requests": { label: "Overtime requests" },
  "remote-work-requests": { label: "Remote work requests" },
  shifts: { label: "Shifts" },
  "shift-assignments": { label: "Roster assignments" },
  projects: { label: "Projects" },
  "time-entries": { label: "Time entries" },
  reimbursements: { label: "Reimbursements" },
  "reimbursement-categories": { label: "Reimbursement categories" },
  expenses: { label: "Expenses" },
  "expense-categories": { label: "Expense categories" },
  "expense-budgets": { label: "Expense budgets" },
  vendors: { label: "Vendors" },
  assets: { label: "Assets" },
  "asset-categories": { label: "Asset categories" },
  "asset-requests": { label: "Asset requests" },
  stocktakes: { label: "Stocktakes" },
  tickets: { label: "Tickets" },
  "ticket-checklists": { label: "Ticket checklists" },
  boards: { label: "Boards" },
  cards: { label: "Tasks" },
  sprints: { label: "Sprints" },
  goals: { label: "Goals" },
  "review-cycles": { label: "Review cycles" },
  // The manager's assessment is withheld from the employee until the review is SHARED (http/serialize.ts
  // toReviewResource `_managerVisible`), and every employee holds `reviews`/`reviews.me.**` read - so without
  // this an employee builds a grid on Reviews, adds these two columns and reads the draft verdict on their own
  // review while it is still being written. `ratings_json` / `goal_ratings_json` are already caught by the
  // global DENY_PATTERN; these two are plain columns and were not. The grid has no per-row state filter, so
  // denying the columns is the only available answer - the same call domain/searchIndex.ts and
  // services/peopleAnalytics.ts each make for the same invariant.
  reviews: { label: "Reviews", deny: ["managerComment", "overallRating"] },
  transitions: { label: "Onboarding / offboarding" },
  "transition-tasks": { label: "Transition tasks" },
  "notice-periods": { label: "Notice periods" },
  "benefit-plans": { label: "Benefit plans" },
  "benefit-enrollments": { label: "Benefit enrollments" },
  dependents: { label: "Dependents" },
  "tax-declarations": { label: "Tax declarations" },
  referrals: { label: "Referrals" },
  "job-requisitions": { label: "Job requisitions" },
  candidates: { label: "Candidates" },
  applications: { label: "Applications" },
  interviews: { label: "Interviews" },
  offers: { label: "Offers" },
  "compliance-events": { label: "Compliance events" },
  "compliance-rules": { label: "Compliance rules" },
  "background-checks": { label: "Background checks" },
  events: { label: "Calendar events" },
  suggestions: { label: "Suggestions", deny: ["submitterId"] }, // hidden by the serializer when `anonymous`
  "pay-components": { label: "Pay components" },
  "pay-grades": { label: "Pay grades" },
  "salary-structures": { label: "Salary structures" },
  "pay-periods": { label: "Pay periods" },
  "payroll-runs": { label: "Payroll runs" },
  "payroll-budgets": { label: "Payroll budgets" },
  "document-acknowledgements": { label: "Policy acknowledgements" },
  "letter-templates": { label: "Letter templates" },
  letterheads: { label: "Letterheads" },
  "approval-delegations": { label: "Approval delegations" },
};

/**
 * Collections deliberately NOT projectable, with the reason. A collection whose list narrows for a reason
 * `applyScope` does not express, or whose serializer redacts per caller, cannot be projected column-by-column
 * without re-implementing that rule in a second place - and a rule implemented twice is a rule that will
 * disagree with itself. Read by test/tableFields.test.ts, which fails if one of these turns up in BASES.
 */
export const EXCLUDED_BASES: Record<string, string> = {
  announcements: "the list narrows by publication state and audience (services/announcements visibleWhere), not by scope alone",
  "check-ins": "the serializer serves each side's private note to its author only",
  notifications: "recipient-private; the row is the delivery, not a record about anyone",
  "event-log": "payload is redacted below super",
  "automation-runs": "admin observability over other people's events",
  "cron-runs": "machine history, no subject",
  "api-keys": "carries a credential prefix; the token is masked in the serializer",
  users: "identity + role escalation surface, super-only by policy",
  roles: "policy data, keyed by name rather than by the uuid lane",
  policy: "policy data - the global manifest, edited through its own guarded surface",
  "access-rules": "policy data - a grid of who may do what is the ACL editor's job, with its own audit",
  "review-feedback": "360 feedback is author-confidential",
  "interview-feedback": "scorecards are interviewer-confidential",
  "personal-documents": "document metadata rides its own access lane (per-document ACL + download audit)",
  "org-documents": "document metadata rides its own access lane (publication state + acknowledgement + download audit)",
  "payroll-debit-accounts": "sensitive debit configuration, private by default",
  // The list is not a scoped list at all: services/holidaySelections.ts pins `employee_id` to the CALLER and
  // ignores the grant, so everyone - HR included - sees only their own picks through the API. A generic
  // scope-bound projection of the table is therefore a different query from the collection's own list, and the
  // difference only shows up once somebody holds a wider grant: the endpoint would keep answering with their
  // own picks while a grid handed over everybody's. Also why it never worked as a base - the table is absent
  // from LIST_OWNER_COLUMNS (nothing generic reads it), so `applyScope` at own breadth bound no owner column
  // and the grid was permanently empty.
  "holiday-selections": "the list pins the caller's own picks (services/holidaySelections.ts), so it narrows by the actor and not by scope",
};

// ---- Global column rules -------------------------------------------------------------------------------

// Never offered, whatever the collection: identity/plumbing columns, encrypted blobs, JSON blobs (not a
// grid cell - the sub-resource sources below are how their contents are reached), object-store keys and
// secrets. Matched on the DRIZZLE property name (`identityDetailsEnc`), which is what the derivation walks.
const DENY_PATTERN = /(Enc|Json|Hash|Secret|Key)$/;
const DENY_EXACT = new Set(["uuid", "code", "deleteTime", "lockedBy"]);

/** May `column` of `collection` be offered as a grid column? */
export function columnAllowed(collection: string, column: string): boolean {
  if (DENY_EXACT.has(column) || DENY_PATTERN.test(column)) return false;
  // `keyPrefix` (a card's board prefix) is a display value, not a key - the suffix rule is about r2Key /
  // photoKey / tagSecret, so one explicit exception rather than a looser pattern.
  if (column === "keyPrefix") return true;
  return !(BASES[collection]?.deny ?? []).includes(column);
}

// A number column that is an AMOUNT rather than a count. Money renders in the org currency and totals in the
// footer; a count must not. Name-based, with per-base overrides for what the names miss.
const MONEY_NAME = /(amount|ctc|pay|salary|gross|net|cost|price|total|principal|balance|rate|tds|tax|allowance|deduction|emi|budget|spend)/i;
export function isMoneyColumn(collection: string, column: string): boolean {
  const def = BASES[collection];
  if (def?.money?.includes(column)) return true;
  if (def?.notMoney?.includes(column)) return false;
  return MONEY_NAME.test(column);
}

/** `startDate` -> "Start date", `ctcAnnual` -> "Ctc annual" (then fixed up by LABEL_FIXES). */
export function humanize(column: string): string {
  const spaced = column.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  return LABEL_FIXES[label] ?? label;
}

// Acronyms and terms the mechanical humanizer gets wrong.
const LABEL_FIXES: Record<string, string> = {
  "Ctc annual": "Annual CTC",
  "Epf enrolled": "EPF enrolled",
  "Eps excluded": "EPS excluded",
  "Ifsc code": "IFSC code",
  "Pan": "PAN",
  "Uan": "UAN",
  "Tds": "TDS",
  "Emi": "EMI",
  "Id": "ID",
  "Up count": "Upvotes",
  "Down count": "Downvotes",
};

// ---- Per-employee sources ------------------------------------------------------------------------------

/**
 * A source is a bundle of fields that is NOT a column of the base table: an employee's identity fields, their
 * current compensation, the salary breakdown, a leave balance per type, a measure over a window. Each names
 * the collection whose LIST decision gates it, exactly like a MetricDef.
 */
export type SourceDef = {
  key: string;
  label: string;
  /** The collection whose list decision gates every field of this source. */
  collection: string;
  /** Further collections the values lean on; without them the value would lie, so the source is dropped. */
  needs?: readonly string[];
  /**
   * The employee sub-resource these fields live under, when they are field-access-controlled. Set makes each
   * field additionally gated by `employees.<code>.<subresource>[.<key>]` - the same decision the profile
   * endpoint gets, taken per row and per field, in memory.
   */
  subresource?: string;
  /** The values are PII the profile endpoint masks; raw values need the `unmask` capability. */
  maskable?: boolean;
  /** Fields depend on config (identity fields, pay components, leave types), so they are built per request. */
  dynamic?: boolean;
};

export const SOURCES: readonly SourceDef[] = [
  { key: "identity", label: "Identity", collection: "employees", subresource: "identity", maskable: true, dynamic: true },
  { key: "personal", label: "Personal & contact", collection: "employees", subresource: "personal-info" },
  { key: "bank", label: "Bank account", collection: "employees", subresource: "bank-account", maskable: true },
  { key: "comp", label: "Compensation", collection: "compensation", needs: ["pay-components"], dynamic: true },
  { key: "position", label: "Current role", collection: "positions" },
  { key: "payslip", label: "Payslip (selected period)", collection: "payslips", needs: ["pay-periods"] },
  { key: "leave", label: "Leave balances", collection: "leave-balances", needs: ["leave-types"], dynamic: true },
  { key: "asset", label: "Assets held", collection: "assets" },
  { key: "loan", label: "Loans", collection: "loans" },
  { key: "benefit", label: "Benefits", collection: "benefit-enrollments", needs: ["benefit-plans"] },
  { key: "dependent", label: "Dependents", collection: "dependents" },
  { key: "tax", label: "Tax declarations", collection: "tax-declarations" },
  { key: "metric", label: "Measures", collection: "employees" }, // each measure carries its own collection
];

export const SOURCE_BY_KEY: ReadonlyMap<string, SourceDef> = new Map(SOURCES.map((s) => [s.key, s]));

/**
 * A source segment is written `@identity`, `@comp`, `@metric` in a field key.
 *
 * The `@` is not decoration: a key is `<fk column>.<segment>.<leaf>` and column names are what the schema
 * calls them, so an unprefixed source key collides the moment a table grows a column of the same name -
 * `payslips.tax` and `transition-tasks.position` already did, which is what this prefix answers. No column
 * name can contain `@`, so the two namespaces cannot meet (pinned by test/tableFields.test.ts).
 */
export const SOURCE_PREFIX = "@";

/** The reserved leading segments, in their written form. */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(SOURCES.map((s) => SOURCE_PREFIX + s.key));

/**
 * Every collection a grid can touch, for the middleware's one fan-out. A link is only offered when its target
 * is itself a registered base (see tableCatalog), so this union is complete: bases, the sources' own
 * collections, and every collection a measure leans on.
 */
export const TABLE_SOURCE_COLLECTIONS: readonly string[] = [
  ...new Set([
    ...Object.keys(BASES),
    ...SOURCES.flatMap((s) => [s.collection, ...(s.needs ?? [])]),
    ...METRICS.flatMap((m) => [m.collection, ...(m.needs ?? [])]),
  ]),
];

/** The capability that turns masked PII (a masked PAN, a masked account number) into the real value. */
export const UNMASK_CAPABILITY = "unmask";

// ---- The saved view's spec ------------------------------------------------------------------------------

/** One column of a saved grid: a catalogue field key plus the presentation the author chose. */
export type ViewColumn = {
  /** Catalogue key: `start_date`, `@identity.pan`, `employee_id.department_id.name`, `@metric.days_present`. */
  field: string;
  /** Author's header override. Defaults to the catalogue label. */
  label?: string;
  hidden?: boolean;
};

/** A filter on one column. Applied server-side against the base table where it can be; in memory otherwise. */
export type ViewFilter = {
  field: string;
  op: "eq" | "ne" | "contains" | "gt" | "gte" | "lt" | "lte" | "in" | "empty" | "not_empty";
  /** Absent for `empty` / `not_empty`; a comma-joined list for `in`. */
  value?: string | number | boolean | null;
};

export type ViewSort = { field: string; dir: "asc" | "desc" };

/** Runtime inputs a grid is parameterised by (the window measures are read over, the payslip period, the FY). */
export type ViewParams = {
  from?: string;
  to?: string;
  pay_period?: string;
  financial_year?: string;
  department?: string;
  employee?: string;
};

export type ViewSpec = {
  base: string;
  columns: ViewColumn[];
  filters?: ViewFilter[];
  sort?: ViewSort[];
  params?: ViewParams;
};

export const FILTER_OPS: readonly ViewFilter["op"][] = ["eq", "ne", "contains", "gt", "gte", "lt", "lte", "in", "empty", "not_empty"];

/** How many columns one view may hold. A grid is a report, not a data dump; the cap keeps one run bounded. */
export const MAX_COLUMNS = 60;

/**
 * How many filters one view may hold.
 *
 * Columns were capped and sorts were capped at four; filters were the one list of the three with no ceiling at
 * all, so the count was caller-controlled - and each one costs a bound parameter in the page query, a pass over
 * the page in the in-memory half, or both. 24 is well above what a report is ever built with and bounds the
 * work one saved view can ask for.
 */
export const MAX_FILTERS = 24;
