import type { AepResource } from "@/api";

// Upcoming birthday or work anniversary for the dashboard feed. Birthdays carry day + month only (no year).
export type Celebration = {
  employee: string;
  name: string;
  photo?: string;
  kind: "birthday" | "anniversary";
  month: number;
  day: number;
  in_days: number;
  years?: number;
};

export type Employee = AepResource & {
  path: string;
  etag: string;
  first_name: string;
  last_name: string;
  legal_name?: string; // full legal name for official docs/signing; falls back to first+last when unset
  employee_number?: string; // human-facing employee ID (e.g. EMP-0042); auto-assigned, HR-overridable
  work_email: string;
  job_title?: string;
  department?: string;
  manager?: string;
  start_date?: string;
  probation_end_date?: string;
  epf_enrolled?: boolean;
  photo?: string;
  signature?: string; // marker: present when a signature image is on file (fetch via :getSignature)
};

export type Department = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  parent?: string;
  managers?: string[]; // employee resource paths
};

export type LeaveRequest = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  leave_type?: string;
  start_date: string;
  end_date: string;
  days: number;
  start_session?: number; // 1 = first half (AM), 2 = second half (PM)
  end_session?: number;
  state: string;
  reason?: string;
};

export type OvertimeRequest = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  date: string;
  start_time: string;
  end_time: string;
  minutes: number; // derived duration
  reason?: string;
  state: string;
  decided_by?: string;
  decision_note?: string;
  paid?: boolean; // a payroll run has paid this overtime
  paid_run?: string;
};

export type Suggestion = AepResource & {
  path: string;
  etag: string;
  submitter?: string; // omitted when anonymous
  anonymous: boolean;
  category?: string;
  title: string;
  body: string;
  status: "new" | "under_review" | "planned" | "implemented" | "declined";
  response?: string;
  responded_by?: string;
  upvotes: number;
  downvotes: number;
  my_vote: -1 | 0 | 1;
  own: boolean;
};

export type NoticePeriod = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  type: "resignation" | "termination" | "retirement" | "other";
  notice_date: string;
  last_working_day: string;
  total_days: number;
  days_remaining?: number;
  status: "serving" | "completed" | "withdrawn";
  reason?: string;
  notes?: string;
  transition?: string; // linked offboarding transition (transitions/{id})
};

export type RemoteWorkRequest = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  start_date: string;
  end_date: string;
  start_session?: number; // 1 = first half (AM), 2 = second half (PM)
  end_session?: number;
  days: number;
  location?: string;
  reason?: string;
  state: string;
  decided_by?: string;
  decision_note?: string;
};

export type Reimbursement = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  category?: string;
  amount: number;
  incurred_on?: string;
  description?: string;
  state: string;
  has_receipt?: boolean;
  paid_run?: string;
  paid_time?: string;
};

export type Expense = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  vendor?: string;
  category?: string;
  department?: string;
  amount: number;
  tax_amount?: number;
  incurred_on?: string;
  description?: string;
  invoice_number?: string;
  payment_method?: string;
  payment_ref?: string;
  state: string;
  reimbursable?: boolean;
  reimbursement?: string;
  has_invoice?: boolean;
  paid_time?: string;
  recurring?: boolean;
  recurrence_rule?: string;
  next_occurrence_on?: string;
  template?: string;
};

export type Vendor = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  contact_email?: string;
  contact_phone?: string;
  tax_id?: string;
  payment_terms?: string;
  bank_details?: string;
  default_category?: string;
  notes?: string;
  disabled?: boolean;
};

export type ExpenseCategory = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  requires_receipt?: boolean;
  gl_code?: string;
  disabled?: boolean;
};

export type ExpenseBudget = AepResource & {
  path: string;
  etag: string;
  department?: string;
  category?: string;
  period_type: string;
  period_key: string;
  amount: number;
  spent?: number;
  remaining?: number;
  utilization?: number;
};

export type Referral = AepResource & {
  path: string;
  etag: string;
  referrer?: string;
  candidate_name: string;
  candidate_email?: string;
  candidate_phone?: string;
  position_title?: string;
  department?: string;
  notes?: string;
  status: string;
  hired_employee?: string;
  has_resume?: boolean;
  bonus?: string;
  bonus_status?: string;
  bonus_amount?: number;
  bonus_eligible_time?: string;
  bonus_paid_time?: string;
};

export type JobRequisition = AepResource & {
  path: string;
  etag: string;
  title: string;
  department?: string;
  hiring_manager?: string;
  location?: string;
  employment_type?: string;
  openings?: number;
  description?: string;
  status: string;
  applicant_count?: number;
  opened_time?: string;
  closed_time?: string;
};

export type Candidate = AepResource & {
  path: string;
  etag: string;
  name: string;
  email?: string;
  phone?: string;
  source?: string;
  source_detail?: string;
  referral?: string;
  tags?: string;
  notes?: string;
  has_resume?: boolean;
};

export type Application = AepResource & {
  path: string;
  etag: string;
  candidate?: string;
  requisition?: string;
  stage: string;
  status: string;
  rejection_reason?: string;
  source?: string;
  referral?: string;
  applied_time?: string;
  stage_changed_time?: string;
};

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

export type Interview = AepResource & {
  path: string;
  etag: string;
  application?: string;
  title: string;
  mode: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
  interviewers?: string[];
  location?: string;
  status: string;
};

export type InterviewFeedback = AepResource & {
  path: string;
  etag: string;
  interview?: string;
  author?: string;
  ratings?: Record<string, number>;
  overall_rating?: number;
  recommendation?: string;
  comment?: string;
};

export type Offer = AepResource & {
  path: string;
  etag: string;
  application?: string;
  base_comp?: number;
  currency_code?: string;
  offer_time?: string;
  join_time?: string;
  expiry_time?: string;
  status: string;
  approver?: string;
  notes?: string;
  created_employee?: string;
  transition?: string;
};

export type ReimbursementCategory = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  requires_receipt?: boolean;
};

// In-app notification (one row per recipient, emitted server-side). `read` mirrors read_time presence.
export type Notification = AepResource & {
  path: string;
  etag: string;
  recipient?: string; // employees/{id}
  type: string;
  title: string;
  body?: string;
  link?: string; // web route to open (page key, optional /id)
  subject?: string; // resource path this is about (e.g. "overtime-requests/{id}") - flags the matching row "New"
  priority: "low" | "normal" | "high" | "urgent";
  action?: string; // CTA verb (e.g. "sign"); informational when absent
  actor?: string; // display name of the person who caused this (drives the avatar + attribution); absent = system
  actor_id?: string; // employees/{id} of the actor, for a profile deep-link
  snooze_until_time?: string; // ISO; set while snoozed (the row is otherwise filtered out of the feed)
  read_time?: string;
  read: boolean;
};

// Per-user in-app notification preferences (self-service), stored on the caller's own employee row.
export type NotificationPrefs = { muted: string[]; digest?: boolean };

export type ApprovalDelegation = AepResource & {
  delegator?: string; // employees/{id} who is away
  delegate?: string; // employees/{id} who covers
  from_date: string; // YYYY-MM-DD
  to_date: string;
  reason?: string;
};

export type TicketComment = {
  author?: string; // employees/{id}
  author_email?: string;
  body: string;
  create_time: string;
};

export type TicketTodo = {
  id: string; // handle for :toggleTodo / :removeTodo
  text: string;
  done: boolean;
  create_time: string;
};

export type Ticket = AepResource & {
  path: string;
  etag: string;
  employee?: string; // requester, employees/{id}
  category?: string; // category key (ticket-categories settings blob)
  department?: string; // servicing department, departments/{id}
  assignee?: string; // employees/{id}
  subject: string;
  description?: string;
  priority: "low" | "medium" | "high";
  state: string; // OPEN | IN_PROGRESS | RESOLVED | CLOSED | CANCELLED
  todo_done?: number; // checklist progress; present on list and get
  todo_total?: number;
  comments?: TicketComment[]; // present on Get only
  todos?: TicketTodo[]; // checklist, present on Get only
};

// A row in the `ticket-categories` settings blob: a category, its default auto-assignee, and `members` -
// extra employees who can see every ticket in the category (the basis of category-based visibility).
export type TicketCategory = { key: string; name: string; assignee?: string | null; members?: string[]; department?: string | null };

// A predefined ticket checklist - a first-class, access-controlled collection. Visibility (who sees it in the
// "add from checklist" pickers) is governed by its own read grant via the ACL.
export type TicketChecklist = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  items: string[];
};

// A bank's bulk-payment Excel column mapping (config side; the publish-time export fills the template).
export type BankFormatColumn = {
  col: number; // 1-based sheet column
  header: string; // the bank's header label
  source: string; // ColumnSource (mirror of the server vocabulary)
  value?: string; // literal columns
  intra?: string; // transaction_type: within-bank value (employee bank == this format's bank), e.g. IFT
  inter?: string; // transaction_type: other-banks value, e.g. NEFT
};

export type BankFormat = {
  path?: string;
  bank?: string;
  template_name?: string | null;
  r2_key?: string | null;
  sheet?: string;
  header_row?: number;
  data_start_row?: number;
  columns: BankFormatColumn[];
};

// The employer's debit account + currency for one bank (super_admin only). The account number is stored
// encrypted and returned masked; writes send the full number.
export type PayrollDebitAccount = {
  path?: string;
  bank: string;
  debit_account_number_masked?: string;
  currency_code?: string;
  on_file?: boolean;
};

// A clock-in -> clock-out session. `open` (clock_out absent) = currently clocked in. Breaks = multiple/day.
export type AttendanceSession = AepResource & {
  path: string;
  employee?: string;
  clock_in: string;
  clock_out?: string;
  open?: boolean;
  source?: "clock" | "correction";
  note?: string;
};

export type AttendanceRegularization = AepResource & {
  path: string;
  employee?: string;
  date: string;
  sessions: { clock_in: string; clock_out: string }[];
  reason?: string;
  state: string;
  decided_by?: string;
};

// Effective-dated base pay; POST creates a revision (increment). `current` = the active salary.
export type Compensation = AepResource & {
  path: string;
  employee?: string;
  annual_ctc: number; // authoritative figure; everything leads with this
  base_pay: number; // derived: the monthly basic the split resolved to
  special_allowance?: number; // derived: the balancing plug of the split
  currency_code?: string;
  pay_grade?: string; // resource path: pay-grades/{id}
  pay_grade_name?: string;
  compa_ratio?: number; // base_pay / band midpoint
  band_status?: "below" | "in_band" | "above";
  salary_structure?: string; // resource path: salary-structures/{id}
  salary_structure_name?: string;
  effective_from: string;
  effective_to?: string;
  current?: boolean;
  arrears_amount?: number; // retro arrears owed by a backdated revision
  arrears_paid?: boolean;
};

// A rung on the org salary-grade ladder + its salary band (min/mid/max base pay). HR-managed catalog.
export type PayGrade = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  level: number;
  band_min?: number;
  band_mid?: number;
  band_max?: number;
  currency_code?: string;
  description?: string;
};

// A named salary structure: an ordered set of earning components (with optional per-structure rate overrides)
// that defines which allowances apply to an assigned employee. HR-managed catalog.
export type SalaryStructureLine = { component: string; rate?: number | null }; // component = pay-components/{id}
export type SalaryStructure = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  description?: string;
  lines: SalaryStructureLine[];
};

export type Position = AepResource & {
  path: string;
  employee?: string;
  job_title?: string;
  department?: string;
  location?: string;
  note?: string;
  effective_from: string;
  effective_to?: string;
  current?: boolean;
};

export type Bonus = AepResource & {
  path: string;
  employee?: string;
  amount: number;
  currency_code?: string;
  kind?: string;
  reason?: string;
  award_date: string;
  scope?: "company" | "department" | "individual";
  scope_ref?: string; // departments/{id} for a department-wide award
  batch_id?: string; // groups the rows of one company/department award
  paid?: boolean; // a payroll run has paid this bonus
  paid_run?: string; // payroll-runs/{id}
};

export type Asset = AepResource & {
  path: string;
  asset_tag?: string;
  name: string;
  category?: string;
  serial_number?: string;
  status: "in_stock" | "assigned" | "repair" | "retired";
  assigned_to?: string; // employees/{id}
  assigned_on?: string;
  purchase_date?: string;
  notes?: string;
};

export type SettlementLine = { name: string; kind: "earning" | "deduction"; amount: number };
export type Settlement = AepResource & {
  path: string;
  employee?: string;
  settlement_date: string;
  currency_code?: string;
  leave_days: number;
  notice_shortfall_days: number;
  lines: SettlementLine[];
  total_earnings: number;
  total_deductions: number;
  net: number;
};

export type LeaveType = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  accrual_days_per_year?: number;
  accrual_frequency?: "monthly" | "semi_monthly";
  paid: boolean;
  color?: string | null;
  available_during_probation?: boolean;
  probation_accrual_days_per_year?: number;
  probation_cap_days?: number | null;
  encashable?: boolean;
  encashment_cap_days_per_year?: number | null;
  min_balance_retained_days?: number;
  carry_forward?: boolean;
  carry_forward_cap_days?: number | null;
};

export type LeaveEncashment = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  leave_type?: string;
  days: number;
  rate_per_day?: number;
  amount?: number;
  currency_code?: string;
  state: string;
  paid_run?: string;
  paid_time?: string;
};

export type LeaveBalance = AepResource & {
  path: string;
  employee?: string;
  leave_type?: string;
  balance_days: number;
};

// Where a board card's sticker sits, once the author has moved/resized/faded it. Everything is a fraction of the
// card's own width, so the placement holds at any card size - see components/common/CardSticker.tsx.
// How the card's words behave around a placed element, in word-processor terms. See CardSticker.tsx for what
// each one does to a card.
export type WrapMode = "inline" | "square" | "tight" | "through" | "top-bottom" | "behind" | "front";
export type StickerLayout = { x: number; y: number; size: number; opacity: number; wrap?: WrapMode };
// A kudos card's recipient block is moved and resized like the art, but never faded - a half-transparent photo of
// the person being recognized is not a look anyone needs.
export type RecipientLayout = { x: number; y: number; size: number; wrap?: WrapMode };

export type Announcement = AepResource & {
  path: string;
  etag: string;
  kind?: "announcement" | "post" | "poll" | "kudos"; // official (HR) / generic post / poll / peer recognition
  title: string;
  body: string; // markdown-lite source - render with <RichText> (lib/richText.tsx), never as HTML
  body_text?: string; // the same words with the markup stripped, for teasers/exports (server-derived)
  title_align?: "left" | "center" | "right"; // heading alignment; absent = start-aligned
  body_valign?: "top" | "middle" | "bottom"; // where the words ride in a card taller than they are; absent = top
  author?: string; // employees/{id} (the giver, for kudos)
  publish_time?: string;
  // Kudos (kind="kudos"): the recognized employee + recognition meta (the message is `body`, the giver is
  // `author`). Absent for every other kind.
  recipient?: string; // employees/{id} - a kudo to one person (mutually exclusive with recipient_department)
  recipient_department?: string; // departments/{id} - a kudo to a whole team; no per-head leaderboard points
  value?: string; // free-text company value tag
  category?: string; // HR-configurable kudos category (settings/kudos)
  level?: string; // recognition tier (settings/kudos)
  points?: number; // weight of the chosen level, snapshotted server-side (feeds the leaderboard)

  // Card art, on any kind: a `<category>/<slug>` illustration (lib/illustrations) or a `<file>.png` brand sticker
  // (lib/kudosArt), told apart by the suffix. Absent means no art, on every kind alike.
  illustration?: string;
  illustration_layout?: StickerLayout; // free placement; absent = the card's default placement
  recipient_layout?: RecipientLayout; // kudos only: the recipient block, placed by the giver

  read?: boolean; // whether the calling viewer has opened this post (drives the unread widget)
  read_count?: number; // reader count; present only for the author and HR
  read_by?: string[]; // reader employee refs; present only for the author and HR
  reactions?: { emoji: string; count: number; reacted: boolean }[]; // grouped emoji reactions
  reply_count?: number; // number of replies
  replies?: {
    id?: string; // reply handle, for reacting to a reply
    author?: string;
    author_email?: string;
    body: string;
    create_time: string;
    reactions?: { emoji: string; count: number; reacted: boolean }[];
  }[]; // thread, oldest-first
  poll?: {
    multiple: boolean; // a voter may pick more than one option
    closes_time?: string; // optional deadline after which voting locks
    closed: boolean; // voting is closed (locked or past the deadline)
    total_votes: number; // distinct voters
    voted: boolean; // the caller has cast a vote
    options: { id: string; label: string; votes: number; voted: boolean }[];
  };
};

export type GoalStatus = "not_started" | "in_progress" | "completed" | "cancelled";
export type Goal = AepResource & {
  path: string;
  etag: string;
  employee?: string; // employees/{id} (owner; defaults to the caller)
  title: string;
  description?: string;
  weight?: number; // relative importance 0-100
  progress?: number; // completion 0-100
  status: GoalStatus;
  due_date?: string; // YYYY-MM-DD
};

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
export type BoardColumn = { key: string; label: string; wipLimit: number | null; limitScope?: WipScope; policy: string; isCommitment: boolean; isDelivery: boolean };
export type SwimlaneMode = "none" | "assignee" | "goal" | "priority" | "department" | "custom";
export type Swimlane = { key: string; label: string };
export type Label = { key: string; label: string; color?: string };
export type BoardMode = "kanban" | "scrum";
export type Board = AepResource & {
  path: string;
  etag: string;
  name: string;
  description?: string;
  task_prefix: string;
  mode: BoardMode;
  columns: BoardColumn[];
  swimlane_mode: SwimlaneMode;
  swimlanes: Swimlane[];
  labels: Label[];
  hide_empty_lanes?: boolean; // board view: hide lanes with no visible cards
  reassign_lane_on_move?: boolean; // board view: cross-lane drops reassign the swimlane (off = lanes locked)
  no_lane_label?: string; // custom mode: label for the catch-all bucket (default "No lane")
  card_count?: number;
};
export type CardPriority = "low" | "medium" | "high" | "urgent";
export type Card = AepResource & {
  path: string;
  etag: string;
  board?: string; // boards/{id}
  key?: string; // human task key, e.g. MS-12
  sprint?: string; // sprints/{id} (scrum; absent = product backlog)
  employee?: string; // owner
  department?: string; // the card's department; absent = none (defaults to the org default at create)
  column_key: string;
  swimlane_key?: string;
  rank?: number;
  title: string;
  description?: string;
  assignee?: string; // employees/{id}
  priority: CardPriority;
  labels?: string[];
  size?: number;
  due_date?: string;
  blocked?: boolean;
  block_reason?: string;
  blocked_by?: string; // cards/{id} — the task this one is blocked by
  goal?: string; // goals/{id}
  commit_time?: string;
  start_time?: string;
  deliver_time?: string;
  comments?: CardComment[]; // present on Get
  todos?: CardTodo[]; // checklist items, present on Get
  todo_done?: number; // compact checklist progress on the list (board tiles)
  todo_total?: number;
};
export type CardComment = { author?: string; author_email?: string; body: string; create_time?: string };
export type CardTodo = { id: string; text: string; done: boolean; create_time?: string };
export type SprintState = "planning" | "active" | "completed";
export type Sprint = AepResource & {
  path: string;
  etag: string;
  board?: string; // boards/{id}
  name: string;
  goal?: string;
  start_date?: string; // YYYY-MM-DD
  end_date?: string;
  state: SprintState;
};
export type BoardMetrics = {
  columns: { key: string; label: string }[];
  cfd: { date: string; counts: Record<string, number> }[];
  lead_time: { p50: number; p85: number; avg: number; count: number };
  cycle_time: { p50: number; p85: number; avg: number; count: number };
  throughput: { delivered: number; per_week: number };
};

export type ReviewCycleState = "DRAFT" | "ACTIVE" | "CLOSED";
export type ReviewCycle = AepResource & {
  path: string;
  etag: string;
  name: string;
  period_start?: string;
  period_end?: string;
  self_due_date?: string;
  manager_due_date?: string;
  state: ReviewCycleState;
  review_count?: number;
};

export type ReviewState = "SELF" | "MANAGER" | "SHARED" | "ACKNOWLEDGED";
export type Review = AepResource & {
  path: string;
  etag: string;
  cycle?: string; // review-cycles/{id}
  employee?: string; // employees/{id}
  state: ReviewState;
  self_comment?: string;
  // Manager fields are present only once SHARED, or always to the manager/HR (server-gated).
  manager_comment?: string;
  overall_rating?: number;
  ratings?: Record<string, number>;
  // Embedded 360 feedback. Manager/HR see every entry with `author`; the employee sees submitted ones without it.
  feedback?: { id?: string; state: ReviewFeedbackState; comment?: string; overall_rating?: number; author?: string }[];
};

export type ReviewFeedbackState = "REQUESTED" | "SUBMITTED" | "DECLINED";
export type ReviewFeedback = AepResource & {
  path: string;
  etag: string;
  review?: string;
  reviewee?: string; // employees/{id} - who the feedback is about
  author?: string; // employees/{id} - the nominee giving feedback (the caller)
  state: ReviewFeedbackState;
  comment?: string;
  overall_rating?: number;
};

export type TransitionKind = "onboarding" | "offboarding";
export type TransitionState = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type TransitionTask = AepResource & {
  path: string;
  etag: string;
  transition?: string;
  subject?: string; // employees/{id} - who the transition is about
  assignee?: string; // employees/{id} - who does it
  title: string;
  description?: string;
  due_date?: string;
  status: "TODO" | "DONE";
  note?: string;
  background_check?: string; // background-checks/{id} this task tracks (onboarding)
  doc_type?: string; // when set, a typed file-upload task collecting a personal-document of this type
  document?: string; // personal-documents/{id} uploaded for this task, once uploaded
};
export type Transition = AepResource & {
  path: string;
  etag: string;
  employee?: string; // the subject
  kind: TransitionKind;
  name: string;
  anchor_date?: string;
  state: TransitionState;
  task_count?: number;
  done_count?: number;
  tasks?: TransitionTask[];
};

export type CheckInActionItem = { text: string; done?: boolean };
export type CheckIn = AepResource & {
  path: string;
  etag: string;
  employee?: string; // the report
  counterpart?: string; // the other attendee (usually the manager)
  meeting_date?: string;
  notes?: string;
  action_items?: CheckInActionItem[];
};

export type BenefitCategory = "health" | "dental" | "vision" | "life" | "disability" | "retirement" | "other";
export type BenefitPlan = AepResource & {
  path: string;
  etag: string;
  name: string;
  category: BenefitCategory;
  description?: string;
  provider?: string;
  employee_cost: number;
  employer_cost: number;
  cost_period: "month" | "year";
  allows_dependents: boolean;
};
export type DependentRelationship = "spouse" | "child" | "parent" | "domestic_partner" | "other";
export type Dependent = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  name: string;
  relationship: DependentRelationship;
  date_of_birth?: string;
};
export type BenefitEnrollment = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  plan?: string; // benefit-plans/{id}
  status: "enrolled" | "waived";
  effective_date?: string;
  dependents?: string[]; // dependents/{id}
};

export type Shift = AepResource & {
  path: string;
  etag: string;
  name: string;
  start: string; // HH:MM
  end: string;
  break_minutes: number;
  color?: string;
};
export type ShiftAssignment = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  shift?: string; // shifts/{id}
  date?: string; // YYYY-MM-DD
  note?: string;
};

export type Project = AepResource & {
  path: string;
  etag: string;
  name: string;
  client?: string;
  code?: string;
  billable: boolean;
  status: "active" | "archived";
};
export type TimeEntryStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type TimeEntry = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  project?: string; // projects/{id}
  date?: string; // YYYY-MM-DD
  hours: number;
  description?: string;
  billable: boolean;
  status: TimeEntryStatus;
};

export type LoanStatus = "PENDING" | "APPROVED" | "DISBURSED" | "CLOSED" | "REJECTED";
export type Loan = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  kind: "loan" | "advance";
  principal: number;
  installments: number;
  monthly_amount: number;
  repaid: number;
  outstanding: number;
  reason?: string;
  start_date?: string;
  status: LoanStatus;
};

export type TaxDeclarationStatus = "DECLARED" | "VERIFIED" | "REJECTED";
export type TaxDeclaration = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  financial_year: string;
  section: string;
  label?: string;
  declared_amount: number;
  verified_amount?: number;
  status: TaxDeclarationStatus;
  note?: string;
  has_proof: boolean;
};

export type Event = AepResource & {
  path: string;
  etag: string;
  title: string;
  start_time: string; // ISO instant (date-only meaningful when all_day)
  end_time: string;
  all_day: boolean;
  count_as_work: boolean; // event time counts toward attendees' worked minutes
  color?: string;
  description?: string;
  attendees: string[]; // employees/{id}
};

export type Holiday = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  date: string;
  kind?: "fixed" | "optional";
  selected?: boolean;
  selection?: string;
};

export type ComplianceEvent = AepResource & {
  path: string;
  etag: string;
  title: string;
  category?: string;
  frequency: "one_time" | "monthly" | "quarterly" | "annual";
  due_date: string;
  period_label?: string;
  status: "pending" | "filed" | "waived";
  overdue?: boolean;
  filed_date?: string;
  reference?: string;
  assignee?: string;
  notes?: string;
  rule?: string; // the recurring rule that generated this occurrence (absent for ad-hoc)
};

export type BackgroundCheck = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  transition?: string; // onboarding (transitions/{id}) that requested this check
  check_type: "identity" | "address" | "education" | "employment" | "criminal" | "reference" | "credit" | "other";
  status: "pending" | "in_progress" | "clear" | "discrepancy" | "failed";
  vendor?: string;
  reference_no?: string;
  initiated_date?: string;
  completed_date?: string;
  notes?: string;
};

export type ComplianceRule = AepResource & {
  path: string;
  etag: string;
  title: string;
  category?: string;
  frequency: "monthly" | "quarterly" | "annual";
  due_day: number;
  anchor_month?: number;
  assignee?: string;
  notes?: string;
  active: boolean;
};

export type DocumentResource = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  source_document?: string; // signed copy: the org-document policy it was generated from
  requires_signature?: boolean; // generated letter/contract awaiting the owner's e-signature
  signed_time?: string; // when the owner e-signed (absent until signed)
  signature_name?: string; // the signer's typed full name
  esign_provider?: string; // e-sign driver handling this doc (internal | signyu | ...)
  esign_status?: string; // sent | viewed | signed | declined | expired | failed
  esign_url?: string; // vendor-hosted signing link (external providers)
  financial_year?: string; // Form 16: the FY the doc covers ("2025-26")
  official?: boolean; // Form 16: true = official TRACES copy (uploaded), false/absent = HRMS-generated
  display_name: string;
  document_type: string;
  visibility?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
  expire_time?: string;
  requires_ack?: boolean; // org POLICY docs: must be acknowledged
  ack_version?: number; // current acknowledgement version (bumps on file replace)
  acknowledged?: boolean; // whether the calling employee signed the current version
  ack_method?: "internal" | "cashfree"; // how the ack is signed (required when requires_ack)
  sign_anchor?: SignBox; // where the signature lands on the PDF (required when requires_ack)
  // (esign_url is already declared above — reused by the :acknowledge response for a Cashfree doc)
};

// A signature box on a rendered PDF: PDF points, bottom-left origin, 1-based page. (x1,y1) top-left,
// (x2,y2) bottom-right. Shared by the placement UI and the stored anchor.
export type SignBox = { page: number; x1: number; y1: number; x2: number; y2: number };

// An employee's acknowledgement (e-signature) of an org-document version.
export type DocumentAcknowledgement = AepResource & {
  path: string;
  etag: string;
  employee?: string;
  document?: string;
  version: number;
  signature: string;
  signed_document?: string; // in-place signed copy (personal-documents/{id})
  acknowledged_time?: string; // absent while a Cashfree e-sign is pending
};

export type Payslip = AepResource & {
  path: string;
  payroll_run?: string;
  employee?: string;
  gross: number;
  total_deductions: number;
  tax?: number;
  net: number;
  create_time: string;
};

export type PayComponent = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  kind: string;
  method: string;
  rate?: number;
  cap?: number; // EPF wage ceiling on the base (method "epf")
  regime?: string;
  recurring: boolean;
};

export type TaxSlabRow = { from: number; to: number | null; rate: number; amount: number };
export type TaxDetails = {
  on_file?: boolean;
  regime: string;
  regime_label: string;
  assessment_year: string;
  financial_year: string;
  tds_configured: boolean;
  annual_gross: number;
  standard_deduction: number;
  taxable_income: number;
  slabs: TaxSlabRow[];
  income_tax: number;
  rebate: number;
  income_tax_after_rebate: number;
  surcharge: number;
  cess: number;
  total_tax: number;
  deducted_so_far: number;
  remaining_months: number;
  employed_months: number;
  monthly_tds: number;
  prior_employer_income?: number; // declared
  prior_employer_tds?: number; // declared
  prior_employer_income_effective?: number; // verified-only, as used by the projection
  prior_employer_tds_effective?: number;
  verification_status?: "DECLARED" | "VERIFIED" | "REJECTED" | null;
  verified_income?: number | null;
  verified_tds?: number | null;
};

export type PayPeriod = AepResource & {
  path: string;
  etag: string;
  display_name: string;
  period_start: string;
  period_end: string;
  pay_date: string;
};

export type PayrollRun = AepResource & {
  path: string;
  etag: string;
  pay_period?: string;
  state: string;
  submitted_by?: string;
  submitted_by_name?: string;
  approved_by?: string;
  approved_by_name?: string;
};

export type PayrollLine = { code: string; name: string; kind: "earning" | "deduction"; amount: number; taxable?: boolean };

// One employee's computed payroll for a run (the review breakdown).
export type PayrollRunItem = {
  employee: string;
  employee_name: string;
  code?: string;
  gross: number;
  taxable_gross: number;
  total_deductions: number;
  tax: number;
  net: number;
  lines: PayrollLine[];
};

export type Operation = {
  path: string;
  done: boolean;
  error?: { detail?: string };
  response?: Record<string, unknown>;
  metadata?: {
    kind?: string;
    status?: "queued" | "running" | "done" | "error";
    attempts?: number;
    create_time?: string;
    update_time?: string;
  };
};

// A recorded cron tick (admin-only; from /v1/cron-runs).
export type CronRun = {
  path: string;
  cron: string;
  status: "running" | "done" | "error";
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  error?: string;
  summary?: Record<string, number>;
  create_time?: string;
  update_time?: string;
};

export type User = AepResource & {
  path: string;
  etag: string;
  email: string;
  role: string;
  status: string;
  employee?: string;
  // present on users/me: the caller's capability set + the grantable scope tiers per collection (policy manifest)
  access?: { capabilities?: string[]; scopes?: Record<string, string[]> };
};

// `capabilities` is the server-computed, scope-stripped capability set (e.g. "holidays.write",
// "leave-requests.approve"); UI gating reads it via <Can>/usePermission. The server still enforces.
export type Me = { email: string; role: string; employee_id: string | null; capabilities: string[] };

export type IdentityField = { key: string; label: string; mandatory: boolean; sensitive: boolean; value?: string; has_value?: boolean; denied?: boolean; document?: "none" | "allowed" | "required"; has_doc?: boolean };
export type IdentityDetails = { fields: IdentityField[] };
export type EmployeeFieldDef = { key: string; label: string; mandatory: boolean; sensitive: boolean; document?: "none" | "allowed" | "required" };

export type PersonalDetails = {
  personal_email?: string;
  personal_phone?: string;
  alternate_phone?: string;
  date_of_birth?: string;
  gender?: string;
  marital_status?: string;
  communication_address?: string;
  permanent_address?: string;
  same_as_communication?: boolean;
  emergency_name?: string;
  emergency_phone?: string;
  emergency_relation?: string;
  emergency2_name?: string;
  emergency2_phone?: string;
  emergency2_relation?: string;
  blood_group?: string;
  allergies?: string;
  medical_notes?: string;
};

export type BankDetails = {
  bank_name?: string;
  account_name?: string;
  account_number_masked?: string;
  ifsc_code?: string;
  currency_code?: string;
  on_file?: boolean;
};

// ---- Workflow & automation engine ----
export type Automation = AepResource & {
  name: string;
  description?: string;
  trigger_type: string;
  condition: unknown | null;
  actions: unknown[];
  enabled: boolean;
  schedule?: { freq: "daily" | "weekly" | "monthly"; day?: number; scope?: "once" | "perEmployee" } | null;
};

export type AutomationRun = AepResource & {
  automation: string;
  event?: string;
  event_type: string;
  status: "done" | "partial" | "error" | "skipped";
  result?: { kind: string; status: string; detail?: string }[];
  subject?: string;
  employee?: string;
  correlation_id?: string;
  start_time: string;
  end_time?: string;
};

export type EventLogEntry = AepResource & {
  type: string;
  subject?: string;
  actor?: string;
  employee?: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
  occurred_time: string;
};
