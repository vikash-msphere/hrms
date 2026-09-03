import {
  CalendarPlus, ReceiptText, LifeBuoy, Sparkles, Megaphone,
  Target, Timer, House, MessagesSquare, UserPlus, Lightbulb, Upload, KanbanSquare, Clock,
  HandCoins, FileCheck, UserSearch, Briefcase, UserRoundPlus, Zap, Laptop, Bug,
  type LucideIcon,
} from "lucide-react";
import { navigate } from "@/router";
import { sentryEnabled } from "@/instrument";
import { hasCapability } from "@/lib/perm";
import { fireIntent } from "@/lib/intent";
import type { Me } from "@/types";

// Global "do something" actions, surfaced in the command palette (⌘K) and the top-bar "+" menu. Each one
// navigates to the owning page and fires an intent that opens its create flow - so any common task is one
// step from anywhere, instead of: open sidebar → find page → find the New button.
// Default sections the "+" menu is split into, in display order, by what the user is doing:
//   Request - you're asking for something that enters an approval / verification / servicing flow.
//   Create  - you're authoring a record directly (no one has to approve the act).
// One flat dropdown, no submenus. Built-in default only; orgs can rename/reorder/reassign in
// Settings → Quick create menu.
export const QUICK_ACTION_GROUPS = ["Request", "Create"] as const;
export type QuickActionGroup = (typeof QUICK_ACTION_GROUPS)[number];

export type QuickAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Page the action navigates to before firing its intent. Empty = open in place, wherever the caller is. */
  route: string;
  intent: string;
  group: QuickActionGroup;
  visible: (me: Me) => boolean;
};

export const QUICK_ACTIONS: QuickAction[] = [
  // Request - submitted for approval / verification / servicing
  { id: "request-leave", label: "Request leave", icon: CalendarPlus, route: "leave-requests", intent: "request-leave", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "leave-requests.write") },
  { id: "new-overtime", label: "Log overtime", icon: Timer, route: "overtime", intent: "new-overtime", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "overtime-requests.write") },
  { id: "new-remote", label: "Request remote work", icon: House, route: "remote-work", intent: "new-remote", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "remote-work-requests.write") },
  // Lands on the profile's Assets tab, which is where a person's kit and their requests for it both live.
  { id: "new-asset-request", label: "Request an asset", icon: Laptop, route: "profile", intent: "new-asset-request", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "asset-requests.write") },
  { id: "new-reimbursement", label: "New reimbursement", icon: ReceiptText, route: "reimbursements", intent: "new-reimbursement", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "reimbursements.write") },
  { id: "new-expense", label: "New expense", icon: ReceiptText, route: "expenses", intent: "new-expense", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "expenses.write") },
  { id: "quick-expense", label: "Quick expense", icon: Zap, route: "expenses", intent: "quick-expense", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "expenses.write") },
  { id: "new-loan", label: "Request a loan", icon: HandCoins, route: "loans", intent: "new-loan", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "loans.write") },
  { id: "new-tax", label: "Declare tax investment", icon: FileCheck, route: "tax-declarations", intent: "new-tax", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "tax-declarations.write") },
  { id: "new-referral", label: "Refer someone", icon: UserPlus, route: "referrals", intent: "new-referral", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "referrals.write") },
  { id: "new-suggestion", label: "Submit a suggestion", icon: Lightbulb, route: "suggestions", intent: "new-suggestion", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "suggestions.write") },
  { id: "new-ticket", label: "Raise a support ticket", icon: LifeBuoy, route: "tickets", intent: "new-ticket", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "tickets.write") },
  // "Something is broken", as distinct from "I need something". Raises a ticket like the above, but from a
  // dialog that opens IN PLACE - no route, deliberately: sending someone to the Tickets page to report a bug
  // takes away the screen the bug is on, and half of a useful report is what was on it. It also attaches the
  // session recording, which is the whole reason it is a separate entry point rather than a category on the
  // normal raise form. Hidden without Sentry: there would be no recording to attach, and it would then be the
  // raise-a-ticket flow wearing a different label.
  { id: "report-problem", label: "Report a problem", icon: Bug, route: "", intent: "report-problem", group: "Request", visible: (me) => sentryEnabled && !!me.employee_id && hasCapability(me.capabilities, "tickets.write") },
  // Punching is state-dependent, so it can't be a "New ..." menu item: the top-bar clock chip is its real
  // affordance. This entry exists so ⌘K can reach it too - it opens Attendance and punches the way that
  // matches the caller's current state.
  { id: "clock-toggle", label: "Clock in / clock out", icon: Clock, route: "attendance", intent: "clock-toggle", group: "Request", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "attendance.clockIn") },
  // Create - authored directly
  { id: "new-card", label: "Create a task", icon: KanbanSquare, route: "boards", intent: "new-card", group: "Create", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "cards.write") },
  { id: "new-goal", label: "Set a goal", icon: Target, route: "goals", intent: "new-goal", group: "Create", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "goals.write") },
  { id: "new-checkin", label: "Log a 1:1", icon: MessagesSquare, route: "check-ins", intent: "new-checkin", group: "Create", visible: (me) => !!me.employee_id && hasCapability(me.capabilities, "check-ins.write") },
  { id: "new-job", label: "Open a job", icon: Briefcase, route: "job-requisitions", intent: "new-job", group: "Create", visible: (me) => hasCapability(me.capabilities, "job-requisitions.write") },
  { id: "new-candidate", label: "Add a candidate", icon: UserSearch, route: "candidates", intent: "new-candidate", group: "Create", visible: (me) => hasCapability(me.capabilities, "candidates.write") },
  { id: "new-post", label: "Post to the board", icon: Megaphone, route: "announcements", intent: "new-post", group: "Create", visible: (me) => hasCapability(me.capabilities, "announcements.write") || hasCapability(me.capabilities, "announcements.post") },
  { id: "new-document", label: "Upload a document", icon: Upload, route: "documents", intent: "new-document", group: "Create", visible: (me) => hasCapability(me.capabilities, "org-documents.write") || hasCapability(me.capabilities, "personal-documents.write") },
  { id: "new-employee", label: "Add an employee", icon: UserRoundPlus, route: "employees", intent: "new-employee", group: "Create", visible: (me) => hasCapability(me.capabilities, "employees.write") },
  // Give kudos is surfaced as its own always-visible top-bar button, not inside the "+" menu.
  { id: "give-kudos", label: "Give kudos", icon: Sparkles, route: "announcements", intent: "give-kudos", group: "Create", visible: (me) => hasCapability(me.capabilities, "announcements.giveKudos") },
];

// Standalone actions get their own always-visible top-bar affordance, not a "+" menu item, so the org menu
// config never governs them - they stay capability-gated only. These ids are excluded from the config editor
// and every "+" menu resolve path (but still appear in the ⌘K palette).
export const KUDOS_ACTION_ID = "give-kudos";
export const TICKET_ACTION_ID = "new-ticket";
export const REPORT_PROBLEM_ACTION_ID = "report-problem";
export const CLOCK_ACTION_ID = "clock-toggle";
export const STANDALONE_ACTION_IDS = new Set([KUDOS_ACTION_ID, TICKET_ACTION_ID, REPORT_PROBLEM_ACTION_ID, CLOCK_ACTION_ID]);

// Actions the org can arrange into menu sections (everything except the standalone top-bar buttons).
export const CONFIGURABLE_QUICK_ACTIONS = QUICK_ACTIONS.filter((a) => !STANDALONE_ACTION_IDS.has(a.id));

export function visibleQuickActions(me: Me): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => a.visible(me));
}

// ---- Org-wide "+" menu config -------------------------------------------------------------------------------
// The menu is a list of named sections, each holding an ordered list of action ids. This is fully org-editable
// (custom section labels, ordering, membership) in Settings → Quick create menu, stored in the organization
// blob as `quick_actions.groups`. An action id absent from every section is disabled. Per-user capability
// gating still applies at render, so a person only sees the enabled actions they can actually perform.
export type QuickMenuGroup = { id: string; label: string; items: string[] };
export type QuickMenuConfig = { groups: QuickMenuGroup[] };

// Built-in default sections, derived from each action's code `group`. Used until the org customises the menu.
export function defaultQuickMenu(): QuickMenuConfig {
  return {
    groups: QUICK_ACTION_GROUPS.map((g) => ({
      id: g.toLowerCase(),
      label: g,
      items: CONFIGURABLE_QUICK_ACTIONS.filter((a) => a.group === g).map((a) => a.id),
    })).filter((g) => g.items.length > 0),
  };
}

// Coerce whatever is stored in OrgSettings.quick_actions into a QuickMenuConfig. Handles undefined (-> default),
// the current {groups} shape, and the legacy flat {order} shape (distributed into the default code sections,
// preserving the saved order; ids absent from `order` stay off).
export function normalizeQuickMenu(raw?: { groups?: QuickMenuGroup[]; order?: string[] }): QuickMenuConfig {
  if (raw?.groups?.length) return { groups: raw.groups };
  if (raw?.order) {
    const rank = new Map(raw.order.map((id, i) => [id, i]));
    return {
      groups: QUICK_ACTION_GROUPS.map((g) => ({
        id: g.toLowerCase(),
        label: g,
        items: CONFIGURABLE_QUICK_ACTIONS.filter((a) => a.group === g && rank.has(a.id))
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
          .map((a) => a.id),
      })).filter((g) => g.items.length > 0),
    };
  }
  return defaultQuickMenu();
}

// Renderable menu sections for a caller: config sections in order, each with the enabled actions that caller can
// perform, empty sections dropped. Unknown/kudos ids ignored. Pass raw org config; normalization happens here.
export function resolveQuickMenu(me: Me, raw?: { groups?: QuickMenuGroup[]; order?: string[] }): { id: string; label: string; actions: QuickAction[] }[] {
  const byId = new Map(QUICK_ACTIONS.map((a) => [a.id, a]));
  return normalizeQuickMenu(raw)
    .groups.map((g) => ({
      id: g.id,
      label: g.label,
      actions: g.items
        .map((id) => byId.get(id))
        .filter((a): a is QuickAction => !!a && !STANDALONE_ACTION_IDS.has(a.id) && a.visible(me)),
    }))
    .filter((g) => g.actions.length > 0);
}

// Flat list of enabled, visible menu actions (palette "Action" commands); the standalone top-bar actions are
// appended so they stay reachable via ⌘K even though they're absent from the "+" menu.
export function resolveQuickActionList(me: Me, raw?: { groups?: QuickMenuGroup[]; order?: string[] }): QuickAction[] {
  const flat = resolveQuickMenu(me, raw).flatMap((g) => g.actions);
  const standalone = QUICK_ACTIONS.filter((a) => STANDALONE_ACTION_IDS.has(a.id) && a.visible(me));
  return [...flat, ...standalone];
}

export function runQuickAction(a: QuickAction) {
  // A routeless action opens where the caller already is (report-problem). Navigating to "" would land on the
  // dashboard, which for a bug report throws away the screen being reported.
  if (a.route) navigate(a.route);
  fireIntent(a.intent);
}
