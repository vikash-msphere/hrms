// Onboarding / offboarding templates (stored in settings/transition-templates; HR edits them, like
// ticket-categories). Pure data. A template is an ordered list of task definitions; starting a transition
// from a template expands them into real tasks with assignees + due dates resolved against the employee.
export type TaskAssignee = { type: "employee" | "manager" | "specific"; employee?: string }; // `employee` = ref when type=specific
// The verification types a template task can spawn. Mirrors background_checks.check_type.
export type BgCheckType = "identity" | "address" | "education" | "employment" | "criminal" | "reference" | "credit";
// `bg_check`: when set, creating a transition from this template also opens a background-verification check of
// that type for the subject, linked to the task (the check's outcome completes the task). HR-only data.
// `doc_type`: when set, this is a typed file-upload task - the assignee uploads a file that is filed as a
// personal-document of this type for the subject (one of CONTRACT/ID/PAYSLIP/POLICY/LETTER/OTHER).
export type TemplateTask = { title: string; description?: string; assignee: TaskAssignee; due_offset_days?: number; bg_check?: BgCheckType; doc_type?: string };
export type TransitionTemplate = { id: string; name: string; kind: "onboarding" | "offboarding"; description?: string; tasks: TemplateTask[] };
export type TransitionTemplates = { templates: TransitionTemplate[] };

export const DEFAULT_TRANSITION_TEMPLATES: TransitionTemplates = {
  templates: [
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
  ],
};
