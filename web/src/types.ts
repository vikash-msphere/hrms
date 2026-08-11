import type { Wire, Embed, Item } from "@/wire";

// Upcoming birthday or work anniversary for the dashboard feed. Birthdays carry day + month only (no year).
export type Celebration = Wire<"celebration">;

export type Employee = Wire<"employee">;

export type Department = Wire<"department">;

export type LeaveRequest = Wire<"leave-request">;

export type OvertimeRequest = Wire<"overtime-request">;

export type Suggestion = Wire<"suggestion">;

export type NoticePeriod = Wire<"notice-period">;

export type RemoteWorkRequest = Wire<"remote-work-request">;

export type Reimbursement = Wire<"reimbursement">;

export type Expense = Wire<"expense">;

export type Vendor = Wire<"vendor">;

export type ExpenseCategory = Wire<"expense-category">;

export type ExpenseBudget = Wire<"expense-budget">;

export type Referral = Wire<"referral">;

export type JobRequisition = Wire<"job-requisition">;

export type Candidate = Wire<"candidate">;

export type Application = Wire<"application">;

export type AtsStage = { key: string; label: string; kind: "active" | "hired" | "rejected" };
export type ScorecardCriterion = { key: string; label: string };
export type AtsConfig = { stages: AtsStage[]; sources: string[]; rejection_reasons: string[]; scorecard_criteria: ScorecardCriterion[] };
export const DEFAULT_ATS_CONFIG: AtsConfig = {
  stages: [
    { key: "applied", label: "Applied", kind: "active" },
    { key: "screening", label: "Screening", kind: "active" },
    { key: "interview", label: "Interview", kind: "active" },
    { key: "offer", label: "Offer", kind: "active" },
    { key: "hired", label: "Hired", kind: "hired" },
  ],
  sources: ["referral", "job_board", "agency", "direct", "linkedin", "career_site"],
  rejection_reasons: ["Not qualified", "Failed interview", "Position filled", "Compensation mismatch", "Candidate withdrew", "Other"],
  scorecard_criteria: [
    { key: "technical", label: "Technical skills" },
    { key: "communication", label: "Communication" },
    { key: "culture", label: "Culture fit" },
    { key: "problem_solving", label: "Problem solving" },
  ],
};

export type Interview = Wire<"interview">;

export type InterviewFeedback = Wire<"interview-feedback">;

export type Offer = Wire<"offer">;

export type ReimbursementCategory = Wire<"reimbursement-category">;

// In-app notification (one row per recipient, emitted server-side). `read` mirrors read_time presence.
export type Notification = Wire<"notification">;

// Per-user in-app notification preferences (self-service), stored on the caller's own employee row.
export type NotificationPrefs = Wire<"notification-prefs">;

export type ApprovalDelegation = Wire<"approval-delegation">;

export type TicketComment = Item<Ticket["comments"]>;

export type TicketTodo = Item<Ticket["todos"]>;

export type Ticket = Wire<"ticket">;

// A row in the `ticket-categories` settings blob: a category, its default auto-assignee, and `members` -
// extra employees who can see every ticket in the category (the basis of category-based visibility).
export type TicketCategory = { key: string; name: string; assignee?: string | null; members?: string[]; department?: string | null };

// A predefined ticket checklist - a first-class, access-controlled collection. Visibility (who sees it in the
// "add from checklist" pickers) is governed by its own read grant via the ACL.
export type TicketChecklist = Wire<"ticket-checklist">;

// A bank's bulk-payment Excel column mapping (config side; the publish-time export fills the template).
export type BankFormatColumn = Wire<"bank-format-column">;

export type BankFormat = Wire<"bank-format">;

// The employer's debit account + currency for one bank (super_admin only). The account number is stored
// encrypted and returned masked; writes send the full number.
export type PayrollDebitAccount = Wire<"payroll-debit-account">;

// A clock-in -> clock-out session. `open` (clock_out absent) = currently clocked in. Breaks = multiple/day.
export type AttendanceSession = Wire<"attendance">;

export type AttendanceRegularization = Wire<"attendance-regularization">;

// Effective-dated base pay; POST creates a revision (increment). `current` = the active salary.
export type Compensation = Wire<"compensation">;

// A rung on the org salary-grade ladder + its salary band (min/mid/max base pay). HR-managed catalog.
export type PayGrade = Wire<"pay-grade">;

// A named salary structure: an ordered set of earning components (with optional per-structure rate overrides)
// that defines which allowances apply to an assigned employee. HR-managed catalog.
export type SalaryStructureLine = Item<SalaryStructure["lines"]>; // component = pay-components/{id}
export type SalaryStructure = Wire<"salary-structure">;

export type Position = Wire<"position">;

export type Bonus = Wire<"bonus">;

export type Asset = Wire<"asset">;

export type SettlementLine = Item<Settlement["lines"]>;
export type Settlement = Wire<"settlement">;

export type LeaveType = Wire<"leave-type">;

export type LeaveEncashment = Wire<"leave-encashment">;

export type LeaveBalance = Wire<"leave-balance">;

// Where a board card's sticker sits, once the author has moved/resized/faded it. Everything is a fraction of the
// card's own width, so the placement holds at any card size - see components/common/CardSticker.tsx.
// How the card's words behave around a placed element, in word-processor terms. See CardSticker.tsx for what
// each one does to a card.
export type WrapMode = "inline" | "square" | "tight" | "through" | "top-bottom" | "behind" | "front";
export type StickerLayout = { x: number; y: number; size: number; opacity: number; wrap?: WrapMode };
// A kudos card's recipient block is moved and resized like the art, but never faded - a half-transparent photo of
// the person being recognized is not a look anyone needs.
export type RecipientLayout = { x: number; y: number; size: number; wrap?: WrapMode };

export type Announcement = Wire<"announcement">;

export type GoalStatus = "not_started" | "in_progress" | "completed" | "cancelled";
export type Goal = Wire<"goal">;

// ---- Agile kanban ----
// One audit-trail entry from the on-demand activity feed (GET /v1/activity).
export type ActivityDiff = Record<string, { from: unknown; to: unknown }>;
export type Activity = {
  path: string;
  action: string;
  entity?: string; // touched collection (org-wide feed)
  entity_ref?: string; // touched record as a wire ref `<collection>/<token>` (org-wide feed), when it has an id
  entity_name?: string; // resolved display name of the touched record (server-enriched)
  actor?: string;
  actor_email: string;
  actor_name?: string; // resolved actor employee name (server-enriched; falls back to email)
  create_time: string;
  ip?: string;
  user_agent?: string;
  meta?: { diff?: ActivityDiff; fields?: string[]; [k: string]: unknown };
};
export type ActivityPage = { results: Activity[]; next_page_token?: string };

// One cross-collection hit from global search (GET /v1/search?q=). `name` is the wire ref `<collection>/<token>`
// of the matched record; `collection` names its type so the palette can label and colour it.
export type SearchHit = { name: string; collection: string; title: string | null; subtitle: string | null };
export type SearchPage = { results: SearchHit[] };

export type WipScope = "column" | "assignee";
export type BoardColumn = Item<Board["columns"]>;
export type SwimlaneMode = "none" | "assignee" | "goal" | "priority" | "department" | "custom";
export type Swimlane = Item<Board["swimlanes"]>;
export type Label = Item<Board["labels"]>;
export type BoardMode = "kanban" | "scrum";
export type Board = Wire<"board">;
export type CardPriority = "low" | "medium" | "high" | "urgent";
export type Card = Wire<"card">;
export type CardComment = Item<Card["comments"]>;
export type CardTodo = Item<Card["todos"]>;
export type SprintState = "planning" | "active" | "completed";
export type Sprint = Wire<"sprint">;
export type BoardMetrics = {
  columns: { key: string; label: string }[];
  cfd: { date: string; counts: Record<string, number> }[];
  lead_time: { p50: number; p85: number; avg: number; count: number };
  cycle_time: { p50: number; p85: number; avg: number; count: number };
  throughput: { delivered: number; per_week: number };
};

export type ReviewCycleState = "DRAFT" | "ACTIVE" | "CLOSED";
export type ReviewCycle = Wire<"review-cycle">;

export type ReviewState = "SELF" | "MANAGER" | "SHARED" | "ACKNOWLEDGED";
export type Review = Wire<"review">;

export type ReviewFeedbackState = "REQUESTED" | "SUBMITTED" | "DECLINED";
export type ReviewFeedback = Wire<"review-feedback">;

export type TransitionKind = "onboarding" | "offboarding";
export type TransitionState = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type TransitionTask = Wire<"transition-task">;
// `tasks` is a $ref to transition-task in the spec, so it arrives with the schema's own (all-optional)
// shape - Wire's required-key list applies to the resource it names, not through an embedded ref. Re-point
// the embedded items at the aliased child so an embedded task reads the same as a fetched one.
export type Transition = Embed<Wire<"transition">, "tasks", TransitionTask>;

export type CheckInActionItem = { text: string; done?: boolean };
export type CheckIn = Wire<"check-in">;

export type BenefitCategory = "health" | "dental" | "vision" | "life" | "disability" | "retirement" | "other";
export type BenefitPlan = Wire<"benefit-plan">;
export type DependentRelationship = "spouse" | "child" | "parent" | "domestic_partner" | "other";
export type Dependent = Wire<"dependent">;
export type BenefitEnrollment = Wire<"benefit-enrollment">;

export type Shift = Wire<"shift">;
export type ShiftAssignment = Wire<"shift-assignment">;

export type Project = Wire<"project">;
export type TimeEntryStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type TimeEntry = Wire<"time-entry">;

export type LoanStatus = "PENDING" | "APPROVED" | "DISBURSED" | "CLOSED" | "REJECTED";
export type Loan = Wire<"loan">;

export type TaxDeclarationStatus = "DECLARED" | "VERIFIED" | "REJECTED";
export type TaxDeclaration = Wire<"tax-declaration">;

export type Event = Wire<"event">;

export type Holiday = Wire<"holiday">;

export type ComplianceEvent = Wire<"compliance-event">;

export type BackgroundCheck = Wire<"background-check">;

export type ComplianceRule = Wire<"compliance-rule">;

// The Documents page renders org-documents and personal-documents in one list, so it needs a shape that spans
// both collections: everything is optional except what both endpoints always send. Which collection a row came
// from is recovered from its path (see docCollection), not from the type.
export type DocumentResource = Wire<"personal-document"> &
  Partial<Wire<"org-document">>;

// A signature box on a rendered PDF: PDF points, bottom-left origin, 1-based page. (x1,y1) top-left,
// (x2,y2) bottom-right. Shared by the placement UI and the stored anchor.
export type SignBox = NonNullable<Wire<"org-document">["sign_anchor"]>;

// An employee's acknowledgement (e-signature) of an org-document version.
export type DocumentAcknowledgement = Wire<"document-acknowledgement">;

export type Payslip = Wire<"payslip">;

export type PayComponent = Wire<"pay-component">;

export type TaxSlabRow = Wire<"tax-slab">;
export type TaxDetails = Wire<"tax">;

export type PayPeriod = Wire<"pay-period">;

export type PayrollRun = Wire<"payroll-run">;

export type PayrollLine = Wire<"payroll-line">;

// One employee's computed payroll for a run (the review breakdown).
// `lines` $refs payroll-line, so the embedded items arrive with the child schema's raw shape; re-point them
// at the aliased child (same reason as Transition.tasks).
export type PayrollRunItem = Embed<Wire<"payroll-run-item">, "lines", PayrollLine>;

export type Operation = Wire<"operation">;

// A recorded cron tick (admin-only; from /v1/cron-runs).
export type CronRun = Wire<"cron_run">;

export type User = Wire<"user">;

// A machine credential. It acts as its `owner`, narrowed by `scope` - never wider than that user's own
// access. `secret` is present ONLY on the create response: it is stored one-way and can never be read back.
export type ApiKey = Wire<"api-key">;

// `capabilities` is the server-computed, scope-stripped capability set (e.g. "holidays.write",
// "leave-requests.approve"); UI gating reads it via <Can>/usePermission. The server still enforces.
export type Me = { email: string; role: string; employee_id: string | null; capabilities: string[] };

export type IdentityField = Wire<"identity-field">;
// `fields` $refs identity-field, so re-point the embedded items at the aliased child (see Transition.tasks).
export type IdentityDetails = Embed<Wire<"identity">, "fields", IdentityField>;
export type EmployeeFieldDef = { key: string; label: string; mandatory: boolean; sensitive: boolean; document?: "none" | "allowed" | "required" };

export type PersonalDetails = Wire<"personal-info">;

export type BankDetails = Wire<"bank-account">;

// ---- Workflow & automation engine ----
export type Automation = Wire<"automation">;

export type AutomationRun = Wire<"automation_run">;

export type EventLogEntry = Wire<"event_log_entry">;
