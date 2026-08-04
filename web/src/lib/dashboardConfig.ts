// Shared dashboard configuration: which KPI cards and which timeline markers each role sees. Stored in the
// `settings/dashboard` blob and edited in Settings → Organization → Dashboard. Consumed by the dashboard
// (Dashboard.tsx) and the team timeline. Keys here MUST match the KPI keys the dashboard renders and the
// marker keys the timeline filters on.

// Per-item visibility audience. `everyone: true` shows it to all; otherwise it's visible to the listed roles OR
// employees (by employee id). A stored audience with NONE of these (everyone off, no roles, no people) is
// DISABLED - nobody sees it. An ABSENT audience (undefined) is unconfigured and falls back to the code default.
// This is display config, not access control - the data behind each KPI/marker stays gated by its collection.
export type Audience = { everyone?: boolean; roles?: string[]; employees?: string[] };
export type DashboardConfig = {
  kpis?: Record<string, Audience>;
  timeline?: Record<string, Audience>;
  // Whole KPI categories the org has switched off - every card in a listed category is hidden for everyone,
  // regardless of its per-card audience. A coarse "turn off this band" org-wide toggle above the per-card rules.
  hiddenKpiCategories?: KpiCategory[];
  // Ordered shortcut tiles at the bottom of the dashboard, as namespaced ids (lib/dashboardShortcuts). Absent =
  // the built-in default set; an empty array = the org turned the row off.
  shortcuts?: string[];
};

// KPI cards group by INTENT, not by module, so the dashboard reads as bands: what's yours personally, what
// needs action now, what's coming up, and a plain snapshot. The order here is the band order top-to-bottom
// on the dashboard.
export type KpiCategory = "personal" | "attention" | "upcoming" | "snapshot";
export const KPI_CATEGORIES: { key: KpiCategory; label: string; blurb: string }[] = [
  { key: "personal", label: "For you", blurb: "Your own items - things to sign, submit or finish." },
  { key: "attention", label: "Needs attention", blurb: "Overdue, blocked or waiting on a decision - act now." },
  { key: "upcoming", label: "Coming up", blurb: "Due soon or pending your action - get ahead of the deadline." },
  { key: "snapshot", label: "At a glance", blurb: "Where the organization stands right now." },
];

// Out-of-the-box visibility for a card with NO explicit audience: "everyone" (any employee), "hr" (HR admins
// only - the HR/recruiting/finance/compliance ops cards), or "none" (nobody - hidden until an admin shares it).
// An explicit audience in settings/dashboard always overrides this. Display default only - the data behind every
// card is still gated by its collection's real grants, so a shared card shows only numbers the viewer may see.
export type KpiDefaultAudience = "everyone" | "hr" | "none";
// The role that "hr" default cards resolve to (single HR role in this app; see lib/roles).
export const HR_ROLE = "hr_admin";

// The KPI cards the dashboard can show. `category` places each in a band (above); order = display order within
// its band. `defaultAudience` (omit = "none") sets who sees it before any config. Keys MUST match the keys the
// dashboard renders and the icon map in lib/kpiIcons.
export const KPI_DEFS: { key: string; label: string; category: KpiCategory; defaultAudience?: KpiDefaultAudience }[] = [
  // --- For you: the caller's OWN items (every card here counts only rows that belong to the viewer) ---
  { key: "docs_to_ack", label: "Policies to sign", category: "personal", defaultAudience: "everyone" },
  { key: "letters_to_sign", label: "Letters to e-sign", category: "personal", defaultAudience: "everyone" },
  { key: "timesheets_draft", label: "Timesheets to submit", category: "personal" },
  { key: "my_open_cards", label: "My open tasks", category: "personal" },
  { key: "timesheet_week", label: "My hours (week)", category: "personal" },
  // --- Needs attention: lagging / problem indicators (something already breached or is waiting on you) ---
  { key: "pending", label: "Pending approvals", category: "attention", defaultAudience: "everyone" },
  { key: "open_tickets", label: "Open support tickets", category: "attention", defaultAudience: "everyone" },
  { key: "expenses_pending", label: "Expenses to approve", category: "attention", defaultAudience: "hr" },
  { key: "cards_blocked", label: "Blocked tasks", category: "attention" },
  { key: "cards_overdue", label: "Overdue tasks", category: "attention" },
  { key: "budget_over", label: "Budgets over", category: "attention", defaultAudience: "hr" },
  { key: "compliance_overdue", label: "Compliance overdue", category: "attention", defaultAudience: "hr" },
  { key: "tax_verify", label: "Tax proofs to verify", category: "attention", defaultAudience: "hr" },
  { key: "bgchecks_open", label: "Background checks open", category: "attention", defaultAudience: "hr" },
  { key: "suggestions_open", label: "Suggestions to answer", category: "attention", defaultAudience: "hr" },
  { key: "docs_expiring", label: "Documents expiring (30 days)", category: "attention", defaultAudience: "hr" },
  { key: "probation_ending", label: "Probation ending (30 days)", category: "attention", defaultAudience: "hr" },
  { key: "notice_serving", label: "Serving notice", category: "attention", defaultAudience: "hr" },
  // --- Coming up: leading / proactive indicators (a runway window, so you act before the deadline) ---
  { key: "compliance_due", label: "Compliance due (30 days)", category: "upcoming", defaultAudience: "hr" },
  { key: "compliance_week", label: "Filings due this week", category: "upcoming", defaultAudience: "hr" },
  { key: "cards_due_week", label: "Tasks due this week", category: "upcoming" },
  { key: "reviews_due_soon", label: "Reviews due soon", category: "upcoming" },
  { key: "interviews_upcoming", label: "Interviews scheduled", category: "upcoming", defaultAudience: "hr" },
  { key: "onboarding_tasks_pending", label: "Onboarding tasks pending", category: "upcoming", defaultAudience: "hr" },
  { key: "offers_pending", label: "Offers awaiting response", category: "upcoming", defaultAudience: "hr" },
  { key: "recurring_expenses_due", label: "Recurring expenses due", category: "upcoming", defaultAudience: "hr" },
  // --- At a glance: current-state snapshot metrics ---
  { key: "on_leave", label: "On leave today", category: "snapshot", defaultAudience: "everyone" },
  { key: "clocked_in", label: "Clocked in now", category: "snapshot", defaultAudience: "everyone" },
  { key: "not_clocked_in", label: "Not clocked in", category: "snapshot" },
  { key: "remote_today", label: "Remote today", category: "snapshot" },
  { key: "celebrations", label: "Celebrations this week", category: "snapshot", defaultAudience: "everyone" },
  { key: "joiners", label: "New joiners (30 days)", category: "snapshot" },
  { key: "headcount", label: "Total employees", category: "snapshot", defaultAudience: "everyone" },
  { key: "transitions_active", label: "Onboarding / offboarding", category: "snapshot", defaultAudience: "hr" },
  { key: "open_positions", label: "Open positions", category: "snapshot", defaultAudience: "hr" },
  { key: "candidates_pipeline", label: "Candidates in pipeline", category: "snapshot", defaultAudience: "hr" },
  { key: "referrals_open", label: "Open referrals", category: "snapshot", defaultAudience: "hr" },
  { key: "reviews_open", label: "Reviews in progress", category: "snapshot", defaultAudience: "hr" },
  { key: "assets_assigned", label: "Assets assigned", category: "snapshot", defaultAudience: "hr" },
  { key: "goals_active", label: "Active goals", category: "snapshot" },
  { key: "loans_outstanding", label: "Outstanding loans", category: "snapshot", defaultAudience: "hr" },
  { key: "benefits_enrolled", label: "Benefit enrollments", category: "snapshot", defaultAudience: "hr" },
  { key: "team_hours_week", label: "Team hours (week)", category: "snapshot" },
];

// key -> default audience ("none" when unset), for the dashboard's visibility fallback and the settings labels.
export const KPI_DEFAULT_AUDIENCE: Record<string, KpiDefaultAudience> = Object.fromEntries(
  KPI_DEFS.map((d) => [d.key, d.defaultAudience ?? "none"]),
);

// Whether a card with no explicit audience shows to this viewer, given its default audience. "none" shows to
// nobody (not even super) - an admin must share it explicitly.
export function kpiDefaultVisible(def: KpiDefaultAudience | undefined, role: string): boolean {
  if (def === "everyone") return true;
  if (def === "hr") return role === HR_ROLE;
  return false;
}

// The timeline marker categories whose visibility is configurable (leaves/holidays/weekends always show).
export const MARKER_DEFS: { key: string; label: string }[] = [
  { key: "events", label: "Events" },
  { key: "birthdays", label: "Birthdays" },
  { key: "anniversaries", label: "Work anniversaries" },
  { key: "joiners", label: "New joiners" },
  { key: "probation", label: "Probation ends" },
];

// Visible to a viewer given a stored audience. An ABSENT audience (undefined) is unconfigured - `unconfiguredVisible`
// decides who sees it (KPIs pass super-or-default-shared; timeline markers pass true/everyone). A PRESENT audience
// is explicit: shown if `everyone`, or the viewer's role/employee id is listed; an explicit audience that names no
// one (everyone off, empty lists) is disabled - nobody sees it.
export function visibleToViewer(a: Audience | undefined, role: string, employeeId: string | null, unconfiguredVisible = true): boolean {
  if (!a) return unconfiguredVisible;
  if (a.everyone) return true;
  if (role && a.roles?.includes(role)) return true;
  if (employeeId && a.employees?.includes(employeeId)) return true;
  return false;
}
