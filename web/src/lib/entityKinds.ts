// How a collection is NAMED and COLOURED wherever a mixed list of things is shown (global search results, the
// org-wide activity feed). A result list that blends a person, a settings page and a leave request is only
// readable if each carries its own type word and tone, so both live here rather than in each component.
import { navItem } from "@/nav";
import { SETTINGS_REGISTRY } from "@/settings/registry";
import { pageKeyForCollection, settingsPanelForCollection } from "@/lib/resourceRoute";
import { FileText, type LucideIcon } from "lucide-react";

// Collections whose wire name isn't the user-facing word. Everything else is de-kebabed and sentence-cased.
const ENTITY_LABEL: Record<string, string> = {
  cards: "Tasks",
  attendance: "Attendance",
  "check-ins": "1:1s",
  "org-documents": "Company documents",
  "personal-documents": "My documents",
  automations: "Workflows",
};
// Irregular singulars (the default just drops a trailing "s").
const ENTITY_SINGULAR: Record<string, string> = {
  cards: "Task",
  attendance: "Attendance",
  "check-ins": "1:1",
  "org-documents": "Company document",
  "personal-documents": "Document",
  automations: "Workflow",
  "background-checks": "Background check",
  holidays: "Holiday",
  expenses: "Expense",
  "expense-categories": "Expense category",
  "reimbursement-categories": "Reimbursement category",
  "compliance-events": "Compliance event",
  "compliance-rules": "Compliance rule",
  "notice-periods": "Notice period",
  "transition-tasks": "Onboarding task",
  transitions: "Transition",
  "review-cycles": "Review cycle",
  "review-feedback": "Feedback",
  "interview-feedback": "Scorecard",
  "job-requisitions": "Job",
  "salary-structures": "Salary structure",
  "pay-periods": "Pay period",
  "pay-components": "Pay component",
  "pay-grades": "Pay grade",
  "ticket-checklists": "Ticket checklist",
  "shift-assignments": "Shift assignment",
  "approval-delegations": "Delegation",
  "benefit-plans": "Benefit plan",
  "benefit-enrollments": "Enrolment",
  "expense-budgets": "Budget",
  "attendance-regularizations": "Attendance correction",
};

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plural, user-facing name of a collection — for type filters and group headings. */
export function entityLabel(collection: string): string {
  return ENTITY_LABEL[collection] ?? sentence(collection.replace(/-/g, " "));
}

/** Singular, user-facing name of one record — for the type badge on a search hit. */
export function entityLabelSingular(collection: string): string {
  if (ENTITY_SINGULAR[collection]) return ENTITY_SINGULAR[collection];
  const plural = entityLabel(collection);
  return plural.endsWith("ies") ? `${plural.slice(0, -3)}y` : plural.endsWith("s") ? plural.slice(0, -1) : plural;
}

// ---- Tones -------------------------------------------------------------------------------------------------
// One tone per broad area of the app, plus the three non-record result types. Class strings are written out in
// full (no interpolation) so Tailwind keeps them.
export type Tone = "action" | "page" | "setting" | "people" | "time" | "work" | "money" | "hiring" | "docs" | "support" | "admin";

export const TONE_CLS: Record<Tone, string> = {
  action: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  page: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  setting: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  people: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  time: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  work: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  money: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  hiring: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
  docs: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  support: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  admin: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
};

const TONE_OF: Record<string, Tone> = {
  employees: "people", departments: "people", positions: "people", dependents: "people",
  "leave-requests": "time", "leave-encashments": "time", "leave-types": "time", holidays: "time",
  attendance: "time", "attendance-regularizations": "time", "overtime-requests": "time",
  "remote-work-requests": "time", "approval-delegations": "time", shifts: "time",
  "shift-assignments": "time", projects: "time", "time-entries": "time",
  goals: "work", boards: "work", sprints: "work", cards: "work", "review-cycles": "work",
  reviews: "work", "review-feedback": "work", "check-ins": "work",
  reimbursements: "money", "reimbursement-categories": "money", expenses: "money",
  "expense-categories": "money", "expense-budgets": "money", vendors: "money", loans: "money",
  bonuses: "money", "tax-declarations": "money", "pay-components": "money", "pay-grades": "money",
  "salary-structures": "money", "pay-periods": "money", "benefit-plans": "money", "benefit-enrollments": "money",
  "job-requisitions": "hiring", candidates: "hiring", applications: "hiring", interviews: "hiring",
  "interview-feedback": "hiring", offers: "hiring", referrals: "hiring",
  "org-documents": "docs", "personal-documents": "docs", "letter-templates": "docs",
  announcements: "docs", events: "docs", "compliance-events": "docs", "compliance-rules": "docs",
  transitions: "docs", "transition-tasks": "docs", "notice-periods": "docs", "background-checks": "docs",
  tickets: "support", "ticket-checklists": "support", suggestions: "support", assets: "support",
  notifications: "support",
  automations: "admin",
};

/** The tone for a record of this collection; unmapped collections fall back to the neutral admin tone. */
export function toneOf(collection: string): Tone {
  return TONE_OF[collection] ?? "admin";
}

/** The icon a record of this collection should show — borrowed from the nav item or Settings panel that owns
 *  it, so search never drifts from what the sidebar shows. */
export function iconOf(collection: string): LucideIcon {
  const page = pageKeyForCollection(collection);
  const fromNav = page ? navItem(page)?.icon : undefined;
  if (fromNav) return fromNav;
  const panel = settingsPanelForCollection(collection);
  const fromSettings = panel ? SETTINGS_REGISTRY.find((s) => s.key === panel)?.icon : undefined;
  return fromSettings ?? FileText;
}
