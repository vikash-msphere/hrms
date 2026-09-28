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

// The pipeline context every application/interview/offer event carries (built once by applicationEventPayload
// in services/ats.ts). Declared once here because it is the SAME block on each of them: a rule written against
// one recruiting event reads the same field names on all of them, and the builder offers the same list. This
// is what makes a rule able to act - draft an offer at the band's midpoint, title an interview after the role,
// route a notification to the hiring manager - instead of only announcing a transition.
export const APPLICATION_EVENT_FIELDS: EventField[] = [
  { name: "stage", type: "string" },
  { name: "stageLabel", type: "string", label: "Stage name" },
  { name: "stageKind", type: "string", label: "Stage kind (active/hired/rejected)" },
  { name: "stageIndex", type: "number", label: "Stage position" },
  { name: "status", type: "string" },
  { name: "applicationId", type: "ref", label: "Application" },
  { name: "candidateId", type: "ref", label: "Candidate" },
  { name: "candidateName", type: "string", label: "Candidate name" },
  { name: "candidateEmail", type: "string", label: "Candidate email" },
  { name: "requisitionId", type: "ref", label: "Requisition" },
  { name: "requisitionTitle", type: "string", label: "Role" },
  { name: "openings", type: "number" },
  { name: "departmentId", type: "ref", label: "Department" },
  { name: "hiringManagerId", type: "ref", label: "Hiring manager" },
  { name: "source", type: "string", label: "Candidate source" },
  { name: "referralId", type: "ref", label: "Referral" },
  { name: "bandMin", type: "number", label: "Pay band minimum" },
  { name: "bandMid", type: "number", label: "Pay band midpoint" },
  { name: "bandMax", type: "number", label: "Pay band maximum" },
  { name: "currency", type: "string" },
  { name: "offerAmount", type: "number", label: "Offer figure the band implies" },
  { name: "offerDate", type: "date", label: "Today" },
  { name: "suggestedJoinDate", type: "date", label: "Proposed start date" },
  { name: "suggestedExpiryDate", type: "date", label: "Proposed offer expiry" },
];

/** An offer event: the pipeline context, plus the terms on the offer itself. */
export const OFFER_EVENT_FIELDS: EventField[] = [
  { name: "offerId", type: "ref", label: "Offer" },
  { name: "offerStatus", type: "string", label: "Offer status" },
  { name: "baseComp", type: "number", label: "Offered CTC" },
  { name: "offerCurrency", type: "string", label: "Offer currency" },
  { name: "joinDate", type: "date", label: "Agreed start date" },
  { name: "expiryDate", type: "date", label: "Offer expires" },
  { name: "approverId", type: "ref", label: "Approver" },
  ...APPLICATION_EVENT_FIELDS,
];

/** An interview event: the pipeline context, plus the round and its panel. */
export const INTERVIEW_EVENT_FIELDS: EventField[] = [
  { name: "interviewId", type: "ref", label: "Interview" },
  { name: "interviewTitle", type: "string", label: "Round" },
  { name: "mode", type: "string" },
  { name: "interviewStatus", type: "string", label: "Interview status" },
  { name: "panelSize", type: "number", label: "Panel size" },
  { name: "scheduledStart", type: "date", label: "Scheduled for" },
  { name: "location", type: "string" },
  ...APPLICATION_EVENT_FIELDS,
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
  // A day re-valued by HR. `credit` is on the payload because it is what a rule would branch on - "tell the
  // payroll channel whenever a day is marked absent" is the obvious first rule anybody writes against this.
  { type: "dayMark.set", label: "Day marked", module: "Attendance", subjectCollection: "attendance-day-marks", fields: [{ name: "date", type: "date" }, { name: "credit", type: "string" }] },
  { type: "overtime.requested", label: "Overtime requested", module: "Attendance", subjectCollection: "overtime-requests", fields: [{ name: "hours", type: "number" }] },
  { type: "overtime.approved", label: "Overtime approved", module: "Attendance", subjectCollection: "overtime-requests", fields: [{ name: "hours", type: "number" }] },
  { type: "remoteWork.requested", label: "Remote work requested", module: "Attendance", subjectCollection: "remote-work-requests", fields: [{ name: "from", type: "date" }, { name: "to", type: "date" }] },
  { type: "remoteWork.approved", label: "Remote work approved", module: "Attendance", subjectCollection: "remote-work-requests", fields: [{ name: "from", type: "date" }, { name: "to", type: "date" }] },
  // `kind` and `minutes` are what a rule branches on ("tell the team channel about late arrivals over an hour");
  // `autoApproved` separates the policy's own approvals from a person's, and `overLimit` the ones filed past the
  // monthly allowance.
  { type: "lateEarly.requested", label: "Late arrival / early departure requested", module: "Attendance", subjectCollection: "late-early-requests", fields: [{ name: "date", type: "date" }, { name: "kind", type: "string" }, { name: "minutes", type: "number" }, { name: "overLimit", type: "boolean" }] },
  { type: "lateEarly.approved", label: "Late arrival / early departure approved", module: "Attendance", subjectCollection: "late-early-requests", fields: [{ name: "date", type: "date" }, { name: "kind", type: "string" }, { name: "minutes", type: "number" }, { name: "autoApproved", type: "boolean" }] },

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
  // The same cap, seen forwards. `budgetThreshold` fires when the money is already spent; this fires as soon
  // as the run rate says the period will not hold, which is weeks earlier and is the point at which somebody
  // can still do something about it. Once per budget per period (`projectionAlertedAt`), so a rate that
  // wobbles either side of the cap does not notify every night.
  { type: "expense.budgetProjectedBreach", label: "Expense budget forecast to breach", module: "Expenses", subjectCollection: "expense-budgets", fields: [{ name: "periodKey", type: "string" }, { name: "spent", type: "number" }, { name: "projected", type: "number" }, { name: "budget", type: "number" }] },

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
  { type: "document.expiring", label: "Document expiring", module: "Compliance", subjectCollection: "personal-documents", fields: [{ name: "daysLeft", type: "number" }, { name: "title", type: "string", label: "Document title" }] },

  // Assets & inventory. The custody events are what make a printed tag actionable: `acknowledged` carries the
  // condition its holder reported (so "arrived damaged" can raise a ticket), and the two chase-up events fire
  // from the nightly tick when a scan that was owed never happened.
  { type: "asset.created", label: "Asset added to inventory", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }] },
  // Every custody event carries the TAG as well as the category: a rule that opens a ticket or writes a message
  // about an asset has to be able to say which physical thing it means, and the tag is what is written on it.
  { type: "asset.verified", label: "Asset verified by scan", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }, { name: "scanned", type: "boolean", label: "Confirmed by scanning the tag" }, { name: "checkedIn", type: "boolean", label: "Counted into stock" }, { name: "condition", type: "string" }] },
  { type: "asset.acknowledged", label: "Asset receipt confirmed by holder", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }, { name: "condition", type: "string" }, { name: "scanned", type: "boolean", label: "Confirmed by scanning the tag" }, { name: "waitedDays", type: "number", label: "Days waiting to be confirmed" }] },
  { type: "asset.custodyOverdue", label: "Asset custody unconfirmed", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }, { name: "name", type: "string", label: "Asset name" }, { name: "kind", type: "string", label: "ack | verification" }, { name: "days", type: "number", label: "Days unconfirmed" }] },
  { type: "asset.stale", label: "Asset not sighted for a long time", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }, { name: "name", type: "string", label: "Asset name" }, { name: "days", type: "number", label: "Days since last sighting" }] },
  // Inventory counts. `stocktakeMissing` fires once per missing asset THAT HAS A HOLDER when a count closes -
  // the rows a nudge can actually act on - which is what turns a missing list into somebody going to look.
  { type: "asset.stocktakeMissing", label: "Asset not found in a stocktake", module: "Assets", subjectCollection: "assets", fields: [{ name: "categoryId", type: "ref" }, { name: "assetTag", type: "string", label: "Asset tag" }, { name: "name", type: "string", label: "Asset name" }, { name: "label", type: "string", label: "Stocktake" }, { name: "days", type: "number", label: "Days since last sighting" }] },
  { type: "stocktake.closed", label: "Stocktake closed", module: "Assets", subjectCollection: "stocktakes", fields: [{ name: "label", type: "string", label: "Stocktake" }, { name: "scopeTotal", type: "number", label: "Assets in scope" }, { name: "sighted", type: "number", label: "Sighted" }, { name: "missing", type: "number", label: "Missing" }, { name: "found", type: "number", label: "Unexpected finds" }, { name: "flagged", type: "number", label: "Reported damaged" }] },
  // Requests for kit. `issued` is the hand-over, so it is the one an org hangs "order another laptop" or
  // "open an IT onboarding ticket" off.
  { type: "assetRequest.requested", label: "Asset requested", module: "Assets", subjectCollection: "asset-requests", fields: [{ name: "categoryId", type: "ref" }, { name: "neededBy", type: "date", label: "Needed by" }] },
  { type: "assetRequest.approved", label: "Asset request approved", module: "Assets", subjectCollection: "asset-requests", fields: [{ name: "categoryId", type: "ref" }] },
  { type: "assetRequest.issued", label: "Asset request fulfilled", module: "Assets", subjectCollection: "asset-requests", fields: [{ name: "categoryId", type: "ref" }, { name: "assetId", type: "ref" }] },

  // ATS / recruiting
  //
  // Every application event carries the SAME context block (see applicationEventPayload in services/ats.ts):
  // the candidate, the requisition, the hiring manager, the pay band and the dates the org's offer policy
  // implies. That is what lets a rule DO the next thing - draft the offer, schedule the round, close the req -
  // rather than only announce that something happened. The fields listed here are what the Workflows builder
  // offers for conditions and `{{templates}}`.
  { type: "offer.accepted", label: "Offer accepted", module: "Recruiting", subjectCollection: "offers", fields: [{ name: "candidateId", type: "ref" }, { name: "applicationId", type: "ref" }, { name: "requisitionId", type: "ref" }, { name: "openings", type: "number" }, { name: "startDate", type: "date" }] },
  { type: "application.created", label: "Application received", module: "Recruiting", subjectCollection: "applications", fields: [...APPLICATION_EVENT_FIELDS] },
  { type: "application.stageChanged", label: "Application stage changed", module: "Recruiting", subjectCollection: "applications", fields: [{ name: "previousStage", type: "string", label: "Previous stage" }, ...APPLICATION_EVENT_FIELDS] },
  { type: "application.hired", label: "Candidate hired", module: "Recruiting", subjectCollection: "applications", fields: [{ name: "viaOffer", type: "boolean", label: "Hired by accepting an offer" }, ...APPLICATION_EVENT_FIELDS] },
  { type: "application.rejected", label: "Application rejected", module: "Recruiting", subjectCollection: "applications", fields: [{ name: "reason", type: "string" }, { name: "notified", type: "boolean", label: "Candidate already told" }, ...APPLICATION_EVENT_FIELDS] },
  { type: "interview.scheduled", label: "Interview scheduled", module: "Recruiting", subjectCollection: "interviews", fields: [...INTERVIEW_EVENT_FIELDS] },
  { type: "interview.completed", label: "Interview held", module: "Recruiting", subjectCollection: "interviews", fields: [...INTERVIEW_EVENT_FIELDS] },
  { type: "interview.cancelled", label: "Interview cancelled", module: "Recruiting", subjectCollection: "interviews", fields: [...INTERVIEW_EVENT_FIELDS] },
  { type: "offer.created", label: "Offer drafted", module: "Recruiting", subjectCollection: "offers", fields: [...OFFER_EVENT_FIELDS] },
  { type: "offer.approved", label: "Offer approved", module: "Recruiting", subjectCollection: "offers", fields: [...OFFER_EVENT_FIELDS] },
  { type: "offer.extended", label: "Offer extended to candidate", module: "Recruiting", subjectCollection: "offers", fields: [...OFFER_EVENT_FIELDS] },
  { type: "offer.declined", label: "Offer declined", module: "Recruiting", subjectCollection: "offers", fields: [...OFFER_EVENT_FIELDS] },
  // The candidate answered, either way. Emitted by the seeded chase rule when its wait is resolved, so "we are
  // no longer waiting on this person" is one signal an org can hang its own reporting or follow-ups off.
  { type: "offer.answered", label: "Offer answered (either way)", module: "Recruiting", subjectCollection: "offers", fields: [{ name: "answer", type: "string", label: "accepted / declined" }, ...OFFER_EVENT_FIELDS] },
  { type: "offer.rescinded", label: "Offer rescinded", module: "Recruiting", subjectCollection: "offers", fields: [...OFFER_EVENT_FIELDS] },
  { type: "interview.scorecardOverdue", label: "Scorecard overdue", module: "Recruiting", subjectCollection: "interviews", fields: [{ name: "title", type: "string" }, { name: "candidate", type: "string" }, { name: "pending", type: "number" }, { name: "daysOpen", type: "number" }] },
  { type: "referral.awarded", label: "Referral bonus awarded", module: "Recruiting", subjectCollection: "referrals", fields: [{ name: "amount", type: "number" }] },
  { type: "referral.paid", label: "Referral bonus paid", module: "Recruiting", subjectCollection: "referrals", fields: [{ name: "amount", type: "number" }] },

  // Engagement & comms
  { type: "announcement.published", label: "Announcement published", module: "Engagement", subjectCollection: "announcements", fields: [{ name: "title", type: "string" }] },
  { type: "suggestion.submitted", label: "Suggestion submitted", module: "Engagement", subjectCollection: "suggestions", fields: [{ name: "anonymous", type: "boolean" }] },
  // A model objected to a public post. The queue is the normal answer to this; the event is what lets an org
  // say "and do something about it without waiting for a person" - take it down, mail the moderators, open a
  // ticket. `subject` is the post itself (`announcements/<id>`, `suggestions/<id>`,
  // `announcement-replies/<id>`), so an `apiCall` action can address it directly.
  //
  // `pass` IS THE FIELD A DESTRUCTIVE RULE MUST CONDITION ON. "hazard" is Llama Guard on its fixed taxonomy
  // of dangerous content; "conduct" is a general model reading this org's own rubric (domain/conduct.ts) and
  // is wrong more often in both directions. A rule that takes posts down on either is a rule that will take
  // down a post somebody merely disagreed with.
  //
  // NO EXCERPT, deliberately: `event_log` rows are readable wherever the activity feed is, and the post's
  // text is already on the queue for whoever may act on it. The title is carried because the same field is
  // already on `announcement.published`, and because an email saying only "a post was flagged" makes the
  // recipient hunt for which one.
  {
    type: "moderation.flagged",
    label: "Post flagged by moderation",
    module: "Engagement",
    fields: [
      { name: "collection", type: "string", label: "Wall" },
      { name: "pass", type: "string", label: "Which pass objected (hazard/conduct)" },
      { name: "hazards", type: "string", label: "Codes (comma-separated)" },
      { name: "hazardLabels", type: "string", label: "Reasons" },
      { name: "title", type: "string", label: "Post title" },
      { name: "anonymous", type: "boolean", label: "Anonymous post" },
    ],
  },
  { type: "document.published", label: "Document published", module: "Compliance", subjectCollection: "org-documents", fields: [{ name: "requiresAck", type: "boolean" }] },
  // Emitted by the daily chase-up once a policy has gone unsigned for two weeks, so escalation (manager ping,
  // a ticket, an email) is a rule someone writes rather than code someone adds.
  { type: "document.ackOverdue", label: "Acknowledgement overdue", module: "Compliance", subjectCollection: "org-documents", fields: [{ name: "title", type: "string" }, { name: "pending", type: "number" }, { name: "daysOpen", type: "number" }] },

  // Support
  { type: "ticket.created", label: "Ticket created", module: "Support", subjectCollection: "tickets", fields: [{ name: "category", type: "string" }, { name: "priority", type: "string" }] },
  { type: "ticket.resolved", label: "Ticket resolved", module: "Support", subjectCollection: "tickets", fields: [{ name: "category", type: "string" }] },

  // Performance: goals (the module emitted no events before; these let notifications/automations react to
  // progress - e.g. congratulate on completion, or nudge a stalled goal).
  { type: "goal.progressUpdated", label: "Goal progress updated", module: "Performance", subjectCollection: "goals", fields: [{ name: "progress", type: "number" }, { name: "status", type: "string" }] },
  { type: "goal.completed", label: "Goal completed", module: "Performance", subjectCollection: "goals", fields: [{ name: "progress", type: "number" }] },
  // The owner's own call turning. Progress events say what happened; this one says what the person closest to
  // the work expects to happen, which is the earlier signal and the one worth escalating on.
  // The goal-setting handshake. `goal.agreed` is the one a rule can hang a "your goals are set" welcome on,
  // and the one an audit of "were these ever agreed?" starts from.
  { type: "goal.proposed", label: "Goal submitted for approval", module: "Performance", subjectCollection: "goals", fields: [{ name: "title", type: "string" }, { name: "weight", type: "number" }] },
  { type: "goal.agreed", label: "Goal agreed", module: "Performance", subjectCollection: "goals", fields: [{ name: "title", type: "string" }, { name: "weight", type: "number" }] },
  { type: "goal.confidenceChanged", label: "Goal confidence changed", module: "Performance", subjectCollection: "goals", fields: [{ name: "confidence", type: "string" }, { name: "previous", type: "string" }, { name: "progress", type: "number" }] },

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
  // (the derived metrics in services/scheduledMetrics.ts) let conditions be genuinely smart - e.g. "every
  // Monday, per employee, if pendingApprovals > 0 -> nudge" - without the pure evaluator learning to query.
  { type: "schedule.recurring", label: "On a schedule", module: "Scheduled", fields: [
    { name: "weekday", type: "number", label: "Weekday (0=Sun)" },
    { name: "dayOfMonth", type: "number", label: "Day of month" },
    { name: "pendingApprovals", type: "number", label: "Pending approvals (as approver)" },
    { name: "daysSinceLastLeave", type: "number", label: "Days since last leave" },
    { name: "leaveBalanceDays", type: "number", label: "Total leave balance (days)" },
    { name: "goalsDueSoon", type: "number", label: "Open goals due within 7 days" },
    { name: "goalsOverdue", type: "number", label: "Open goals past due" },
    // The two that arrive BEFORE a date is missed: a goal a quarter of the way behind its own pace (or one its
    // owner has flagged), and a goal nobody has touched in three weeks.
    { name: "goalsAtRisk", type: "number", label: "Goals at risk" },
    { name: "goalsStale", type: "number", label: "Goals with no update in 3 weeks" },
    // Board work, counted off the ASSIGNEE: the queue a task is actually sitting in is the one it gets
    // chased out of. Blocked is its own number because the move that clears it is somebody else's.
    { name: "tasksDueSoon", type: "number", label: "Open tasks due within 7 days" },
    { name: "tasksOverdue", type: "number", label: "Open tasks past due" },
    { name: "tasksBlocked", type: "number", label: "Open tasks blocked" },
    // Review season, in an ACTIVE cycle only. Who owes what is the review's own state: SELF is theirs to
    // write, MANAGER is their manager's. Goal-setting counts a cycle that named a date for goals against
    // somebody who has filed none.
    { name: "selfReviewsDue", type: "number", label: "Self-assessments they owe" },
    { name: "teamReviewsDue", type: "number", label: "Reviews they owe as a manager" },
    { name: "goalSettingMissing", type: "number", label: "Active cycles they have set no goals in" },
    { name: "teamGoalSettingMissing", type: "number", label: "Reports who have set no goals" },
    // 1 when their active sign-in account has no app PIN (never set, turned off, or reset by an admin).
    { name: "appPinMissing", type: "number", label: "Has not set an app PIN (1 = yes)" },
    // THE PAYROLL CALENDAR, and these are the only fields here that arrive on an ORG-LEVEL ("once") firing
    // rather than a per-employee one - they are facts about the company's month, not about a person, and a
    // perEmployee rule would announce to the whole roster that payroll is unbuilt. Together they are what lets
    // a reminder be planned BACKWARDS from the pay date: "two days before inputs close, if claims are still
    // pending, tell payroll". Days are negative once the date is behind, so "late" and "soon" are the same
    // comparison; 9999 means there is no such date to count towards, which no threshold fires on.
    { name: "daysToPayDate", type: "number", label: "Days until the next pay date" },
    { name: "daysToCutoff", type: "number", label: "Days until that period's inputs close" },
    { name: "payrollRunBuilt", type: "boolean", label: "That period's run has been built" },
    { name: "payrollRunState", type: "string", label: "That period's run state (none/DRAFT/REVIEW/APPROVED/PUBLISHED)" },
    { name: "payrollBankFileDone", type: "boolean", label: "A payout file has been generated for it" },
    { name: "reimbursementsPending", type: "number", label: "Claims still awaiting approval" },
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

// ---- Sensitive payload fields ------------------------------------------------------------------------------
//
// The money an event carries: a payslip's net pay, a loan's principal and instalment, a claim's amount, an
// offer's CTC and the band behind it, a budget's spend. The event log already refuses these below super - its
// serializer redacts payload VALUES for anyone else (http/serialize.ts toEventLogResource) - and a rule is a
// second way to read the same payload: a rule written by somebody who is not a super admin templated
// `{{netPay}}` into a notification to themselves and read every payslip as it published. So the same line
// holds there: a rule no super admin authored is templated over a payload with these masked
// (services/automationEngine.ts), and may not condition on them (services/automations.ts) - a condition is a
// read too, one bit at a time.
//
// By NAME, across every event, rather than flagged per field: a payload can carry a key its catalog entry does
// not list, and a money figure under an unlisted key is exactly the one a per-entry flag would let through.
export const SENSITIVE_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  "amount", "emiAmount", "outstanding", "principal", "netPay",
  "spent", "budget", "projected",
  "baseComp", "offerAmount", "bandMin", "bandMid", "bandMax",
]);
export const REDACTED = "[redacted]";

/** The payload with every sensitive value masked; the keys stay, so a template still resolves them. */
export function redactSensitivePayload(_type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) out[k] = SENSITIVE_PAYLOAD_FIELDS.has(k) && v != null ? REDACTED : v;
  return out;
}

/**
 * The sensitive payload fields a condition reads, however it spells them (`netPay` or `payload.netPay`), found
 * anywhere in the tree (`all`/`any`/`not` nest). Structural, so a condition shape added later is still walked.
 */
export function sensitiveFieldsInCondition(_type: string, condition: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "field" && typeof v === "string") {
        const name = (v.startsWith("payload.") ? v.slice("payload.".length) : v).split(".")[0]!;
        if (SENSITIVE_PAYLOAD_FIELDS.has(name)) found.add(name);
      } else walk(v);
    }
  };
  walk(condition);
  return [...found];
}
