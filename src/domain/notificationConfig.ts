// In-app notification configuration (org-level, stored as data in settings/notifications). Each EVENT CATEGORY
// (the first segment of a notification `type`, e.g. "leave" for "leave.approved") can be turned on/off and given
// a default priority. The notify() engine consults this before emitting: a disabled category emits nothing, and
// the category's priority is used unless the call passes an explicit one. Pure data + tiny accessors so the
// engine and the Settings UI share one source of truth.

export type NotificationPriority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "urgent"];
export const PRIORITY_RANK: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export type EventCategoryConfig = { enabled: boolean; priority: NotificationPriority };
export type NotificationConfig = { events: Record<string, EventCategoryConfig> };

// The event categories the app emits, with a human label (for the Settings UI) and a sensible default. An
// action category (document review/sign) defaults to high; routine outcomes to normal. Adding a new category
// here makes it appear in the Settings UI and gives it a default automatically.
export const NOTIFICATION_CATEGORIES: { key: string; label: string; defaultPriority: NotificationPriority }[] = [
  { key: "leave", label: "Leave decisions", defaultPriority: "normal" },
  { key: "reimbursement", label: "Reimbursements", defaultPriority: "normal" },
  { key: "loan", label: "Loans & advances", defaultPriority: "normal" },
  { key: "overtime", label: "Overtime", defaultPriority: "normal" },
  { key: "remote", label: "Remote work", defaultPriority: "normal" },
  { key: "regularization", label: "Attendance regularization", defaultPriority: "normal" },
  { key: "encashment", label: "Leave encashment", defaultPriority: "normal" },
  { key: "timesheet", label: "Timesheets", defaultPriority: "normal" },
  { key: "kudos", label: "Kudos", defaultPriority: "normal" },
  { key: "suggestion", label: "Suggestions", defaultPriority: "normal" },
  { key: "announcement", label: "Announcements", defaultPriority: "normal" },
  { key: "document", label: "Documents (review / sign)", defaultPriority: "high" },
  { key: "payslip", label: "Payslips", defaultPriority: "normal" },
  { key: "tax", label: "Tax declarations", defaultPriority: "normal" },
  { key: "transition", label: "Onboarding / offboarding", defaultPriority: "high" },
  { key: "ticket", label: "Support tickets", defaultPriority: "normal" },
  { key: "review", label: "Performance reviews", defaultPriority: "normal" },
  { key: "goal", label: "Goals", defaultPriority: "normal" },
  { key: "checkin", label: "Check-ins / 1:1s", defaultPriority: "normal" },
  { key: "compliance", label: "Compliance calendar", defaultPriority: "high" },
  { key: "referral", label: "Referrals", defaultPriority: "normal" },
  { key: "bonus", label: "Bonuses", defaultPriority: "normal" },
  { key: "benefit", label: "Benefits", defaultPriority: "normal" },
  { key: "board", label: "Boards & cards", defaultPriority: "normal" },
  { key: "notice", label: "Notice periods", defaultPriority: "high" },
  { key: "settlement", label: "Final settlement", defaultPriority: "high" },
  { key: "asset", label: "Assets", defaultPriority: "normal" },
  { key: "shift", label: "Shifts & roster", defaultPriority: "normal" },
  { key: "recruiting", label: "Recruiting", defaultPriority: "normal" },
  { key: "compensation", label: "Compensation", defaultPriority: "high" },
  // Access: someone asking for a grant, someone gaining one, and (with four-eyes on) a permission change
  // waiting for a second approver. High - a change nobody sees is a change nobody reviews.
  { key: "access", label: "Access & permissions", defaultPriority: "high" },
  { key: "system", label: "System", defaultPriority: "normal" },
];

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  events: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.key, { enabled: true, priority: c.defaultPriority }])),
};

// Category of a notification type (the segment before the first dot). "leave.approved" -> "leave".
export const categoryOf = (type: string): string => type.split(".")[0]!;

// Per-user notification preferences (self-service), layered OVER the org config. Stored as a JSON blob on the
// recipient's employee row (employees.notificationPrefs). `muted` silences event categories for the user; the
// notify() engine drops a recipient whose prefs mute the event's category. `digest` opts the user into daily
// batching: informational (no-CTA) low/normal-priority notifications are parked and coalesced into one daily
// summary instead of pinging one-by-one - urgent and actionable ones still arrive immediately.
export type NotificationPrefs = { muted: string[]; digest: boolean };
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { muted: [], digest: false };

// Parse the stored prefs blob leniently (bad/absent JSON -> defaults).
export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return DEFAULT_NOTIFICATION_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { muted: Array.isArray(p.muted) ? p.muted.filter((s) => typeof s === "string") : [], digest: p.digest === true };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

// Whether a notification of this priority + CTA should be deferred into a recipient's daily digest (only when
// they've opted in). Urgent/high always deliver now; an actionable CTA (sign/acknowledge/...) always now -
// digest is for low-signal informational updates, never for things needing a timely decision.
export const isDigestible = (prefs: NotificationPrefs | undefined, priority: NotificationPriority, action: string | null | undefined): boolean =>
  !!prefs?.digest && !action && (priority === "low" || priority === "normal");

// Whether a recipient with these prefs has silenced the given event type's category.
export const isMutedByUser = (prefs: NotificationPrefs | undefined, type: string): boolean =>
  !!prefs?.muted?.includes(categoryOf(type));

// Resolved config for an event type: the configured category, or the category's default, or a global default.
export function eventConfig(cfg: NotificationConfig | undefined, type: string): EventCategoryConfig {
  const cat = categoryOf(type);
  const fromCfg = cfg?.events?.[cat];
  if (fromCfg) return fromCfg;
  const def = NOTIFICATION_CATEGORIES.find((c) => c.key === cat);
  return { enabled: true, priority: def?.defaultPriority ?? "normal" };
}
