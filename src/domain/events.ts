// Domain event registry (PURE - no I/O). The contract shared by three parties: the service emitters
// (services/eventBus.ts), the automation engine (services/automationEngine.ts), and the no-code builder UI.
// Every cross-module reaction in the system reduces to "when <type> [if <condition>] then <actions>", and
// the set of <type>s a rule may trigger on - plus the fields each event carries - is DATA declared here, so
// the trigger dropdown and condition field-list in the UI are generated, never hardcoded per screen.

// A domain event as it flows through emit -> log -> engine. `payload` is event-specific (see EVENT_TYPES);
// `subject` is the "<collection>/<uuid>" the event is about; `employeeId` is the primary employee it concerns
// (used for scoping and the common `employee` condition field).
export type DomainEvent = {
  type: string;
  subject?: string | null;
  actorId?: string | null;
  employeeId?: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

// A field an event carries, surfaced to the condition builder. `type` drives the operator set the UI offers.
export type EventFieldType = "string" | "number" | "boolean" | "date" | "ref";
export type EventField = { name: string; type: EventFieldType; label?: string };

// A known event type: its stable id, a human label, the module it belongs to (UI grouping), and the payload
// fields a condition can test. `subjectCollection` documents what `subject` points at (also a builder hint).
export type EventTypeDef = {
  type: string;
  label: string;
  module: string;
  subjectCollection?: string;
  fields: EventField[];
};

// Fields every event carries regardless of type (the engine always populates these), so a condition can key
// off who/what without the emitter re-declaring them.
export const COMMON_EVENT_FIELDS: EventField[] = [
  { name: "employeeId", type: "ref", label: "Employee" },
  { name: "actorId", type: "ref", label: "Actor" },
  { name: "subject", type: "string", label: "Subject" },
];

// The authoritative event catalog. Adding a new reaction point = emit a new type here + call emitEvent at the
// service tail; the UI and engine pick it up with no further wiring.
export const EVENT_TYPES: EventTypeDef[] = [
  // Leave & time off
  { type: "leave.requested", label: "Leave requested", module: "Leave", subjectCollection: "leave-requests", fields: [{ name: "leaveTypeId", type: "ref" }, { name: "days", type: "number" }, { name: "from", type: "date" }, { name: "to", type: "date" }] },
  { type: "leave.approved", label: "Leave approved", module: "Leave", subjectCollection: "leave-requests", fields: [{ name: "leaveTypeId", type: "ref" }, { name: "days", type: "number" }, { name: "from", type: "date" }, { name: "to", type: "date" }] },
  { type: "leave.rejected", label: "Leave rejected", module: "Leave", subjectCollection: "leave-requests", fields: [{ name: "leaveTypeId", type: "ref" }, { name: "days", type: "number" }] },
  { type: "leave.cancelled", label: "Leave cancelled", module: "Leave", subjectCollection: "leave-requests", fields: [{ name: "leaveTypeId", type: "ref" }, { name: "days", type: "number" }] },
  { type: "leaveEncashment.requested", label: "Leave encashment requested", module: "Leave", subjectCollection: "leave-encashments", fields: [{ name: "days", type: "number" }, { name: "amount", type: "number" }] },
  { type: "leaveEncashment.approved", label: "Leave encashment approved", module: "Leave", subjectCollection: "leave-encashments", fields: [{ name: "days", type: "number" }, { name: "amount", type: "number" }] },

  // Attendance & scheduling
  { type: "attendanceRegularization.requested", label: "Regularization requested", module: "Attendance", subjectCollection: "attendance-regularizations", fields: [{ name: "date", type: "date" }] },
  { type: "attendanceRegularization.approved", label: "Regularization approved", module: "Attendance", subjectCollection: "attendance-regularizations", fields: [{ name: "date", type: "date" }] },
  { type: "overtime.requested", label: "Overtime requested", module: "Attendance", subjectCollection: "overtime-requests", fields: [{ name: "hours", type: "number" }] },
  { type: "overtime.approved", label: "Overtime approved", module: "Attendance", subjectCollection: "overtime-requests", fields: [{ name: "hours", type: "number" }] },
  { type: "remoteWork.requested", label: "Remote work requested", module: "Attendance", subjectCollection: "remote-work-requests", fields: [{ name: "from", type: "date" }, { name: "to", type: "date" }] },
  { type: "remoteWork.approved", label: "Remote work approved", module: "Attendance", subjectCollection: "remote-work-requests", fields: [{ name: "from", type: "date" }, { name: "to", type: "date" }] },

  // Compensation & payroll
  { type: "reimbursement.submitted", label: "Reimbursement submitted", module: "Payroll", subjectCollection: "reimbursements", fields: [{ name: "amount", type: "number" }, { name: "categoryId", type: "ref" }] },
  { type: "reimbursement.approved", label: "Reimbursement approved", module: "Payroll", subjectCollection: "reimbursements", fields: [{ name: "amount", type: "number" }] },
  { type: "reimbursement.rejected", label: "Reimbursement rejected", module: "Payroll", subjectCollection: "reimbursements", fields: [{ name: "amount", type: "number" }] },
  { type: "reimbursement.paid", label: "Reimbursement paid", module: "Payroll", subjectCollection: "reimbursements", fields: [{ name: "amount", type: "number" }] },
  { type: "loan.requested", label: "Loan requested", module: "Payroll", subjectCollection: "loans", fields: [{ name: "amount", type: "number" }] },
  { type: "loan.approved", label: "Loan approved", module: "Payroll", subjectCollection: "loans", fields: [{ name: "amount", type: "number" }, { name: "emiAmount", type: "number" }] },
  { type: "loan.rejected", label: "Loan rejected", module: "Payroll", subjectCollection: "loans", fields: [{ name: "amount", type: "number" }] },
  { type: "loan.disbursed", label: "Loan disbursed", module: "Payroll", subjectCollection: "loans", fields: [{ name: "amount", type: "number" }] },
  { type: "loan.repaymentRecorded", label: "Loan repayment recorded", module: "Payroll", subjectCollection: "loans", fields: [{ name: "amount", type: "number" }, { name: "outstanding", type: "number" }] },
  { type: "loan.closed", label: "Loan fully repaid", module: "Payroll", subjectCollection: "loans", fields: [{ name: "principal", type: "number" }] },
  { type: "payroll.published", label: "Payroll run published", module: "Payroll", subjectCollection: "payroll-runs", fields: [{ name: "payPeriodId", type: "ref" }] },
  { type: "payslip.published", label: "Payslip published", module: "Payroll", subjectCollection: "payslips", fields: [{ name: "netPay", type: "number" }] },

  // Expenses (operational / company spend)
  { type: "expense.submitted", label: "Expense submitted", module: "Expenses", subjectCollection: "expenses", fields: [{ name: "amount", type: "number" }, { name: "categoryId", type: "ref" }, { name: "vendorId", type: "ref" }, { name: "departmentId", type: "ref" }] },
  { type: "expense.approved", label: "Expense approved", module: "Expenses", subjectCollection: "expenses", fields: [{ name: "amount", type: "number" }, { name: "reimbursable", type: "boolean" }] },
  { type: "expense.rejected", label: "Expense rejected", module: "Expenses", subjectCollection: "expenses", fields: [{ name: "amount", type: "number" }] },
  { type: "expense.paid", label: "Expense paid", module: "Expenses", subjectCollection: "expenses", fields: [{ name: "amount", type: "number" }, { name: "paymentMethod", type: "string" }] },
  { type: "expense.budgetThreshold", label: "Expense budget threshold crossed", module: "Expenses", subjectCollection: "expense-budgets", fields: [{ name: "level", type: "number" }, { name: "periodKey", type: "string" }, { name: "spent", type: "number" }, { name: "budget", type: "number" }] },

  // Employee lifecycle
  { type: "employee.created", label: "Employee created", module: "Lifecycle", subjectCollection: "employees", fields: [{ name: "departmentId", type: "ref" }, { name: "startDate", type: "date" }] },
  { type: "transition.completed", label: "Onboarding/offboarding completed", module: "Lifecycle", subjectCollection: "transitions", fields: [{ name: "kind", type: "string" }] },
  // A milestone event emitted by automations (not services): the fan-out point for "new hire is fully onboarded"
  // so several cross-section rules (goals, check-in, team welcome) can react to one signal. See emitEvent action.
  { type: "employee.onboarded", label: "Employee fully onboarded", module: "Lifecycle", subjectCollection: "employees", fields: [] },
  // Automation-emitted milestone (not a service event): raised 7 days after onboarding so several rules can
  // react to a new hire's "first week" from one signal (see bootstrap/collections/automations.ts).
  { type: "milestone.firstWeek", label: "New hire's first week", module: "Lifecycle", subjectCollection: "employees", fields: [] },
  // Automation-emitted milestone: raised 30 days after onboarding (fan-out for the first-month review chain).
  { type: "milestone.thirtyDays", label: "New hire's first month", module: "Lifecycle", subjectCollection: "employees", fields: [] },
  { type: "schedule.probationEnding", label: "Probation ending", module: "Lifecycle", subjectCollection: "employees", fields: [{ name: "probationEndDate", type: "date" }] },
  { type: "schedule.workAnniversary", label: "Work anniversary", module: "Lifecycle", subjectCollection: "employees", fields: [{ name: "years", type: "number" }] },
  { type: "document.expiring", label: "Document expiring", module: "Compliance", subjectCollection: "personal-documents", fields: [{ name: "daysLeft", type: "number" }] },

  // ATS / recruiting
  { type: "offer.accepted", label: "Offer accepted", module: "Recruiting", subjectCollection: "offers", fields: [{ name: "candidateId", type: "ref" }, { name: "applicationId", type: "ref" }, { name: "requisitionId", type: "ref" }, { name: "openings", type: "number" }, { name: "startDate", type: "date" }] },
  { type: "application.stageChanged", label: "Application stage changed", module: "Recruiting", subjectCollection: "applications", fields: [{ name: "stage", type: "string" }, { name: "status", type: "string" }] },
  { type: "referral.awarded", label: "Referral bonus awarded", module: "Recruiting", subjectCollection: "referrals", fields: [{ name: "amount", type: "number" }] },
  { type: "referral.paid", label: "Referral bonus paid", module: "Recruiting", subjectCollection: "referrals", fields: [{ name: "amount", type: "number" }] },

  // Engagement & comms
  { type: "announcement.published", label: "Announcement published", module: "Engagement", subjectCollection: "announcements", fields: [{ name: "title", type: "string" }] },
  { type: "suggestion.submitted", label: "Suggestion submitted", module: "Engagement", subjectCollection: "suggestions", fields: [{ name: "anonymous", type: "boolean" }] },
  { type: "document.published", label: "Document published", module: "Compliance", subjectCollection: "org-documents", fields: [{ name: "requiresAck", type: "boolean" }] },

  // Support
  { type: "ticket.created", label: "Ticket created", module: "Support", subjectCollection: "tickets", fields: [{ name: "category", type: "string" }, { name: "priority", type: "string" }] },
  { type: "ticket.resolved", label: "Ticket resolved", module: "Support", subjectCollection: "tickets", fields: [{ name: "category", type: "string" }] },

  // Performance: goals (the module emitted no events before; these let notifications/automations react to
  // progress - e.g. congratulate on completion, or nudge a stalled goal).
  { type: "goal.progressUpdated", label: "Goal progress updated", module: "Performance", subjectCollection: "goals", fields: [{ name: "progress", type: "number" }, { name: "status", type: "string" }] },
  { type: "goal.completed", label: "Goal completed", module: "Performance", subjectCollection: "goals", fields: [{ name: "progress", type: "number" }] },

  // Performance: agile kanban cards. `board` is the board ref, `column` the destination column key. These are
  // the feedback-loop hooks: notify on delivery, escalate a blocked card, or (with board goal roll-up) chain
  // `card.delivered` -> advance the linked goal.
  { type: "card.created", label: "Card created", module: "Performance", subjectCollection: "cards", fields: [{ name: "board", type: "ref" }, { name: "column", type: "string" }, { name: "priority", type: "string" }] },
  { type: "card.moved", label: "Card moved", module: "Performance", subjectCollection: "cards", fields: [{ name: "board", type: "ref" }, { name: "from", type: "string" }, { name: "to", type: "string" }] },
  { type: "card.committed", label: "Card committed", module: "Performance", subjectCollection: "cards", fields: [{ name: "board", type: "ref" }, { name: "column", type: "string" }] },
  { type: "card.blocked", label: "Card blocked", module: "Performance", subjectCollection: "cards", fields: [{ name: "board", type: "ref" }, { name: "reason", type: "string" }] },
  { type: "card.delivered", label: "Card delivered", module: "Performance", subjectCollection: "cards", fields: [{ name: "board", type: "ref" }, { name: "column", type: "string" }, { name: "goal", type: "ref" }] },
  { type: "sprint.started", label: "Sprint started", module: "Performance", subjectCollection: "sprints", fields: [{ name: "board", type: "ref" }, { name: "name", type: "string" }] },
  { type: "sprint.completed", label: "Sprint completed", module: "Performance", subjectCollection: "sprints", fields: [{ name: "board", type: "ref" }, { name: "name", type: "string" }] },

  // Scheduled (time-driven) trigger. Not emitted by a service - a daily cron scanner synthesizes it when a
  // rule's recurrence matches today (see domain/automations.ts SCHEDULE_TRIGGER). The fields below are what a
  // "perEmployee" firing carries: `weekday`/`dayOfMonth` place the firing in time, and the derived metrics
  // (pendingApprovals/daysSinceLastLeave/leaveBalanceDays) let conditions be genuinely smart - e.g. "every
  // Monday, per employee, if pendingApprovals > 0 -> nudge" - without the pure evaluator learning to query.
  { type: "schedule.recurring", label: "On a schedule", module: "Scheduled", fields: [
    { name: "weekday", type: "number", label: "Weekday (0=Sun)" },
    { name: "dayOfMonth", type: "number", label: "Day of month" },
    { name: "pendingApprovals", type: "number", label: "Pending approvals (as approver)" },
    { name: "daysSinceLastLeave", type: "number", label: "Days since last leave" },
    { name: "leaveBalanceDays", type: "number", label: "Total leave balance (days)" },
  ] },
];

const BY_TYPE = new Map(EVENT_TYPES.map((e) => [e.type, e] as const));

export function eventTypeDef(type: string): EventTypeDef | undefined {
  return BY_TYPE.get(type);
}
export function isKnownEventType(type: string): boolean {
  return BY_TYPE.has(type);
}
// All fields a condition may reference for a given trigger type: the common set + the type's own fields.
export function fieldsForEventType(type: string): EventField[] {
  return [...COMMON_EVENT_FIELDS, ...(BY_TYPE.get(type)?.fields ?? [])];
}
