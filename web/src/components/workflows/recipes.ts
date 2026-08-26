import type { AutomationDraft } from "./types";
import { SCHEDULE_TRIGGER } from "./types";

// Starting points for a new rule.
//
// "New rule" used to open an empty builder beside a sixty-item trigger list, which is a blank page for anyone
// who has not written one before: the hard part is not the form, it is knowing which shapes are worth writing.
// A recipe fills the trigger, the condition and the actions, and the reader edits from there - the wording is
// meant to be changed, not accepted.
//
// Deliberately only `notify` / `notifyManager` / `notifyAudience` actions: those are the ones any workflow
// admin may author (apiCall and webhook are super-only), so a recipe can never present a rule the reader is
// not allowed to save. Every trigger here is checked against the live event catalog before it is offered, so
// a recipe cannot outlive the event it reacts to.
export type Recipe = {
  key: string;
  label: string;
  /** What the rule does, in the words the reader is deciding with. */
  blurb: string;
  draft: Omit<AutomationDraft, "name" | "description"> & { name: string; description: string };
};

export const RECIPES: Recipe[] = [
  {
    key: "welcome-hire",
    label: "Welcome a new hire",
    blurb: "Greets the new joiner and tells their manager to set up the first week.",
    draft: {
      name: "Welcome a new hire",
      description: "Greets a new joiner and nudges their manager.",
      trigger_type: "employee.created",
      condition: null,
      schedule: null,
      actions: [
        { kind: "notify", recipient: { of: "subject" }, title: "Welcome aboard!", body: "Glad to have you here. Your dashboard has everything you need for week one.", link: "dashboard" },
        { kind: "notifyManager", noun: "new hire - set up their first week" },
      ],
    },
  },
  {
    key: "announce-joiner",
    label: "Announce a new joiner",
    blurb: "Tells the whole company when somebody starts.",
    draft: {
      name: "Announce a new joiner",
      description: "Company-wide notification when an employee record is created.",
      trigger_type: "employee.created",
      condition: null,
      schedule: null,
      actions: [
        { kind: "notifyAudience", audience: { kind: "everyone" }, title: "Someone new has joined", body: "A new colleague has started today - say hello.", link: "directory" },
      ],
    },
  },
  {
    key: "big-expense",
    label: "Flag a large expense",
    blurb: "Pings the manager when a submitted expense is over a threshold you set.",
    draft: {
      name: "Flag a large expense",
      description: "Manager is notified when an expense over the threshold is submitted.",
      trigger_type: "expense.submitted",
      condition: { all: [{ field: "amount", op: "gte", value: 50000 }] },
      schedule: null,
      actions: [{ kind: "notifyManager", noun: "large expense awaiting a decision" }],
    },
  },
  {
    key: "budget-threshold",
    label: "Warn on a budget threshold",
    blurb: "Notifies the manager when a department's spend crosses a budget alert level.",
    draft: {
      name: "Warn on a budget threshold",
      description: "Fires when an expense budget crosses one of its alert levels.",
      trigger_type: "expense.budgetThreshold",
      condition: null,
      schedule: null,
      actions: [{ kind: "notifyManager", noun: "budget threshold crossed" }],
    },
  },
  {
    key: "weekly-reminder",
    label: "A weekly reminder",
    blurb: "A time-driven rule rather than an event one: every Monday, a note to everybody.",
    draft: {
      name: "Weekly reminder",
      description: "A scheduled company-wide nudge.",
      trigger_type: SCHEDULE_TRIGGER,
      condition: null,
      schedule: { freq: "weekly", day: 1, scope: "once" },
      actions: [
        { kind: "notifyAudience", audience: { kind: "everyone" }, title: "Weekly reminder", body: "Log your hours and update your goals before the week closes.", link: "dashboard" },
      ],
    },
  },
];

/** Recipes whose trigger still exists in the live event catalog (a scheduled recipe always qualifies). */
export function usableRecipes(eventTypes: string[]): Recipe[] {
  return RECIPES.filter((r) => r.draft.trigger_type === SCHEDULE_TRIGGER || eventTypes.includes(r.draft.trigger_type));
}
