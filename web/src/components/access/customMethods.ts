// The custom methods (AEP `:verb`) the ACL modal can grant/deny per collection - the custom-method subset of
// the server's ACCESS_VERBS (src/http/accessHint.ts), with the standard methods (update/delete) dropped.
// Mirrored here because the web bundle can't import from src/; kept in lock-step by test/customMethodsDrift.
// A custom method is fail-closed: allowed ONLY by an explicit verb-allow grant; a verb-deny always wins.
export const CUSTOM_METHODS: Record<string, string[]> = {
  "api-keys": ["revoke"],
  employees: ["enrollDefaultBenefits"],
  departments: [],
  attendance: ["clockIn", "clockOut"],
  "attendance-regularizations": ["approve", "reject", "cancel"],
  "overtime-requests": ["approve", "reject", "cancel"],
  "remote-work-requests": ["approve", "reject", "cancel"],
  "asset-requests": ["approve", "reject", "cancel", "issue"],
  operations: ["run"],
  "cron-runs": ["run"],
  "leave-requests": ["approve", "reject", "cancel", "upload", "download"],
  goals: ["updateProgress", "comment"],
  boards: ["configure", "metrics"],
  cards: ["move", "block", "unblock", "assign", "prioritize", "comment", "addTodos", "toggleTodo", "removeTodo"],
  sprints: ["activate", "complete"],
  "review-cycles": ["launch", "enroll", "close", "reopen"],
  reviews: ["submitSelf", "submitManager", "acknowledge", "skipStage", "nominate", "nudge", "pdf"],
  "review-feedback": ["submitFeedback", "decline"],
  "time-entries": ["submit", "approve", "reject"],
  loans: ["approve", "reject", "disburse", "recordRepayment"],
  "tax-declarations": ["verify", "reject", "upload", "download"],
  transitions: ["complete", "cancel", "reopen", "appendTask"],
  "transition-tasks": ["complete", "reopen", "upload"],
  announcements: ["post", "giveKudos", "markRead", "markAllRead", "react", "reply", "vote", "publish", "unpublish", "disable", "enable", "lock", "unlock", "pin", "unpin"],
  holidays: [],
  events: ["respond"],
  "leave-types": [],
  "letter-templates": [],
  "pay-components": [],
  "pay-grades": [],
  "salary-structures": [],
  "pay-periods": [],
  "payroll-runs": ["submit", "approve", "publish", "build", "bankFile", "statutoryReport", "previewPayslip"],
  reimbursements: ["approve", "reject", "cancel", "pay", "upload", "download"],
  "leave-encashments": ["approve", "reject", "cancel"],
  "reimbursement-categories": [],
  "ticket-checklists": [],
  assets: ["verify", "acknowledge", "printTag", "reissueTag", "batchCreate"],
  stocktakes: ["restore", "recordFound", "close"],
  bonuses: ["award"],
  // `tickets` omitted on purpose: ticket actions are managed by their own verb-scoped icons (verbMode), so the
  // collection/row icons manage only the level and don't show a drill-in chip for every verb. Mirrors the
  // server's ACCESS_VERBS (kept in sync by customMethodsDrift).
  "bank-formats": ["uploadTemplate"],
  payslips: ["preview", "download"],
  "org-documents": ["download", "acknowledge", "remindAck"],
  "personal-documents": ["download", "sign", "refreshEsign"],
  "document-acknowledgements": [],
  suggestions: ["respond", "upvote", "downvote", "merge"],
  referrals: ["upload", "download", "award"],
  "job-requisitions": [],
  candidates: ["upload", "download"],
  applications: ["advance", "hire", "reject"],
  interviews: ["complete", "cancel", "invite"],
  "interview-feedback": [],
  offers: ["approve", "extend", "accept", "decline", "rescind", "letter"],
  expenses: ["submit", "approve", "reject", "cancel", "pay", "upload", "download"],
  automations: ["enable", "disable", "test"],
  "access-rules": ["preview", "requestAccess", "approve", "reject"],
};

// The standard methods that live on the level ladder (read/write/admin), NOT grantable as custom methods.
export const STANDARD_METHODS = new Set(["update", "delete"]);

// Applicable custom methods for a collection (empty when none).
export function customMethodsFor(collection: string): string[] {
  return CUSTOM_METHODS[collection] ?? [];
}

// Is `verb` a custom method (gets its own manage icon) rather than a standard method covered by the level?
export function isCustomMethod(verb: string | undefined): boolean {
  return !!verb && !STANDARD_METHODS.has(verb);
}
