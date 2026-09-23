// Onboarding/offboarding templates, mirrored on the web (the bundle can't import from src/). The start dialog
// lists these; HR overrides them via settings/transition-templates. Defaults match src/domain/transitions.ts.
export type TaskAssignee = { type: "employee" | "manager" | "specific"; employee?: string };
export type BgCheckType = "identity" | "address" | "education" | "employment" | "criminal" | "reference" | "credit";
// The personal-document types a file-upload task can collect (mirror VALID_DOC_TYPES).
export const DOC_TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "OTHER"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type TemplateTask = { title: string; description?: string; assignee: TaskAssignee; due_offset_days?: number; bg_check?: BgCheckType; doc_type?: DocType };
export type TransitionTemplate = { id: string; name: string; kind: "onboarding" | "offboarding"; description?: string; tasks: TemplateTask[] };

export const DEFAULT_TRANSITION_TEMPLATES: TransitionTemplate[] = [
  {
    id: "default-onboarding",
    name: "Standard onboarding",
    kind: "onboarding",
    description: "Default first-weeks checklist for a new hire.",
    tasks: [
      { title: "Send welcome email & first-day logistics", assignee: { type: "manager" }, due_offset_days: -2 },
      { title: "Provision laptop & accounts", assignee: { type: "specific" }, due_offset_days: -1 },
      { title: "Complete personal & bank details", assignee: { type: "employee" }, due_offset_days: 1 },
      { title: "Upload a government ID proof", assignee: { type: "employee" }, due_offset_days: 3, doc_type: "ID" },
      { title: "Upload your signed contract", assignee: { type: "employee" }, due_offset_days: 3, doc_type: "CONTRACT" },
      { title: "Identity verification", assignee: { type: "specific" }, due_offset_days: 5, bg_check: "identity" },
      { title: "Education verification", assignee: { type: "specific" }, due_offset_days: 7, bg_check: "education" },
      { title: "Previous employment verification", assignee: { type: "specific" }, due_offset_days: 10, bg_check: "employment" },
      { title: "Team introductions & first 1:1", assignee: { type: "manager" }, due_offset_days: 2 },
      { title: "Set initial goals", assignee: { type: "manager" }, due_offset_days: 14 },
    ],
  },
  {
    id: "default-offboarding",
    name: "Standard offboarding",
    kind: "offboarding",
    description: "Default exit checklist for a departing employee.",
    tasks: [
      { title: "Knowledge transfer & handover doc", assignee: { type: "employee" }, due_offset_days: -5 },
      { title: "Collect company assets", assignee: { type: "manager" }, due_offset_days: 0 },
      { title: "Revoke system access", assignee: { type: "specific" }, due_offset_days: 0 },
      { title: "Exit interview", assignee: { type: "specific" }, due_offset_days: -1 },
      { title: "Final settlement (FnF)", assignee: { type: "specific" }, due_offset_days: 7 },
    ],
  },
];
