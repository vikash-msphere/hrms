// What a collection is CALLED, for people: the plural and singular word the app shows for it (search result
// groups and badges, the activity feed) and the words an `in:` filter in ⌘K accepts for it. Pure data, shared by
// the server (services/globalSearch.ts, which resolves `in:` / `-in:`) and the web (lib/entityKinds.ts, which
// labels results, and lib/paletteQuery.ts, which completes `in:`), so a name shown on screen is always a name
// the filter takes. When they lived apart, the palette said "Tasks" and `in:tasks` found nothing.

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
  "asset-categories": "Asset category",
  "asset-requests": "Asset request",
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
  "work-patterns": "Schedule",
  "work-pattern-assignments": "Schedule assignment",
  "approval-delegations": "Delegation",
  "benefit-plans": "Benefit plan",
  "benefit-enrollments": "Enrolment",
  "expense-budgets": "Budget",
  "attendance-regularizations": "Attendance correction",
};
// Words people use for a collection that are neither its wire name nor its label. Only for `in:`; nothing is
// shown with these. Kept short: every alias is one more word that names the collection.
const ENTITY_ALIASES: Record<string, string[]> = {
  employees: ["people", "person"], // the palette's own section for them is "People", its badge "Person"
  // "Company documents" and "My documents" are both documents: `in:docs` / `in:documents` means either.
  "org-documents": ["document", "docs"],
  "personal-documents": ["docs"],
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

// A name as an `in:` word spells it: lower case, every run of anything but letters and digits one `-`.
const nameSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Every word that names `collection` for `in:`: its wire name, its plural and singular labels, its aliases. */
export function namesOf(collection: string): string[] {
  return [...new Set([collection, nameSlug(entityLabel(collection)), nameSlug(entityLabelSingular(collection)), ...(ENTITY_ALIASES[collection] ?? [])])];
}

/**
 * The collections, out of `collections`, that an `in:` / `-in:` word names. Forgiving on purpose, because people
 * type what they call the thing: any of its names (`namesOf`) exactly, in the singular or the plural either way
 * round (`ticket` for `tickets`, `documents` for `document`), or the start of a name (`leave` names leave
 * requests, leave types and leave encashments). A start needs three letters, so `in:a` names nothing rather than
 * half the app.
 */
export function collectionsNamed(word: string, collections: readonly string[]): string[] {
  const w = nameSlug(word);
  if (!w) return [];
  const flat = w.replace(/-/g, "");
  const plural = (a: string, b: string) => a === `${b}s` || a === `${b}es`;
  const names = (n: string) => n === w || plural(n, w) || plural(w, n)
    || (w.length >= 3 && (n.startsWith(w) || n.replace(/-/g, "").startsWith(flat)));
  return collections.filter((c) => namesOf(c).some(names));
}
