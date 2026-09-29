import type { LucideIcon } from "lucide-react";
import { hasCapability } from "../../../src/domain/capabilityMatch";
import {
  Building2, Landmark, SlidersHorizontal, Hash, Network, Fingerprint, Trophy,
  CalendarRange, Palmtree, Clock, CalendarClock, AlarmClock,
  Coins, Layers, ListOrdered, Percent, Receipt, Wallet, FileSpreadsheet, FolderKanban,
  UserSearch, UserPlus, Target, ClipboardList, HeartPulse, History,
  FileText, PenLine, FileSignature, Bell, BellRing, LifeBuoy, ListTodo,
  Users, Shield, KeyRound, Wrench, Plus, KanbanSquare, Tag, Sparkles, AlertTriangle, LogIn, Search,
} from "lucide-react";

// One flat registry of every settings panel. This is the single source of truth for the Settings hub grid,
// the panel-page left rail, the breadcrumb label, and the command palette's "Settings: …" jump entries.
// METADATA ONLY - panel components are mapped by key inside pages/Settings.tsx so this file stays tiny and
// safe to import from the main bundle (palette, nav).
export type AccessTargetRef = { collection: string; objectPath?: string; verb?: string; label: string };

// Most settings are ORG singletons (one leave policy org-wide). Two other scopes share the SAME machinery -
// registry entry, Sheet presentation, gear affordance, ?setting deep-link - so per-instance/per-user config is
// not a divergent parallel system:
//   "object" - configured per instance (e.g. one config PER board). Needs an objectPath at open time; the
//              inline gear lives on the object's own page and passes that path. Access is the object's own
//              `verb` (e.g. boards:configure), not settings.write.
//   "user"   - configured per caller (your own notification preferences). No ACL; visible to everyone.
// Non-org entries never edit in place from the central hub (there is no single instance there): their hub card
// is a NAV card that jumps to `hostPage`, where the real inline gear lives. They stay in the one registry so
// search / command palette / the hub still surface them.
export type SettingsScope = "org" | "object" | "user";
export type SettingsEntry = {
  key: string; // route segment: /settings/<key>
  title: string;
  desc: string; // one line, plain language - shown on the hub card and panel header
  group: (typeof SETTINGS_GROUPS)[number];
  icon: LucideIcon;
  scope?: SettingsScope; // default "org"
  hostPage?: string; // non-org: the route page the nav card jumps to and the inline gear lives on
  keywords?: string[]; // extra search terms beyond title/desc
  perm?: string; // capability required beyond settings.write (e.g. "leave-types.write")
  // A panel made of independently granted steps: shown to whoever holds ANY of these, each step then gating
  // itself. Takes the place of `perm` and `target` in the visibility rule.
  anyPerm?: string[];
  target?: AccessTargetRef; // manage-access affordance on the panel header (object scope fills objectPath at runtime)
  wide?: boolean; // the inline Sheet opens wider than the 760px default - for panels that are a two-pane editor
};

export const entryScope = (e: SettingsEntry): SettingsScope => e.scope ?? "org";

export const SETTINGS_GROUPS = ["Company", "Time & leave", "Pay & money", "Hiring & growth", "Work management", "Comms & support", "Access & security"] as const;

const org = (label: string): AccessTargetRef => ({ collection: "settings", objectPath: "settings/organization", label });

export const SETTINGS_REGISTRY: SettingsEntry[] = [
  // Company
  { key: "identity", title: "Name & branding", desc: "Company name, legal name, logo, address, the letterheads documents print on, and how the sidebar wordmark renders.", group: "Company", icon: Building2, keywords: ["logo", "brand", "company name", "address", "anniversary", "wordmark", "letterhead", "stationery", "watermark", "footer"], target: org("Organization identity") },
  { key: "banks-currency", title: "Banks & currency", desc: "Allowed currencies, the default currency, and the bank list used in pickers.", group: "Company", icon: Landmark, keywords: ["money", "inr", "usd", "fx"], target: org("Banks & currency") },
  { key: "defaults", title: "Probation & holiday defaults", desc: "Default probation length for new hires, the optional-holiday allowance and deadline, and the subscribable holiday calendar.", group: "Company", icon: SlidersHorizontal, keywords: ["probation months", "optional holidays", "pick deadline", "holiday feed", "subscribe", "ics", "webcal"], target: { collection: "settings", objectPath: "settings/probation", label: "Defaults" } },
  { key: "employee-ids", title: "Employee IDs", desc: "The EMP-0042 style scheme new hires are auto-numbered with.", group: "Company", icon: Hash, keywords: ["number", "emp", "id format", "sequence"], target: { collection: "settings", objectPath: "settings/employee-number", label: "Employee IDs" } },
  { key: "departments", title: "Departments", desc: "The org's department tree - used by the directory, org chart and reporting.", group: "Company", icon: Network, perm: "departments.write", target: { collection: "departments", label: "Departments" } },
  { key: "employee-fields", title: "Employee identity fields", desc: "PAN, Aadhaar and other identity details collected per employee.", group: "Company", icon: Fingerprint, keywords: ["pan", "aadhaar", "uan", "custom fields", "sensitive"], target: { collection: "settings", objectPath: "settings/employee_fields", label: "Employee fields" } },
  { key: "dashboard", title: "Dashboard visibility", desc: "Which roles or people see each KPI card and timeline marker, the shortcut tiles, and how far ahead birthdays and anniversaries show.", group: "Company", icon: SlidersHorizontal, keywords: ["kpi", "timeline markers", "widgets", "shortcuts", "tiles", "celebrations", "birthday", "birthdays", "work anniversary", "anniversaries", "days ahead"], target: { collection: "settings", objectPath: "settings/dashboard", label: "Dashboard" } },
  { key: "kudos", title: "Kudos levels", desc: "The recognition levels and their icons on the praise wall.", group: "Company", icon: Trophy, keywords: ["recognition", "praise", "badges"], target: { collection: "settings", objectPath: "settings/kudos", label: "Kudos levels" } },
  { key: "asset-tags", title: "Asset tags", desc: "The tag pattern, the asset categories and their tag codes, sticker-sheet formats, label content, and whether custody has to be proved by scanning the tag.", group: "Company", icon: Tag, keywords: ["sticker", "label", "qr", "print", "inventory", "a4-65", "tag format", "categories", "category", "tag code", "custody", "scan", "acknowledge", "stocktake", "verify"], target: { collection: "settings", objectPath: "settings/asset-tags", label: "Asset tags" } },
  { key: "quick-actions", title: "Quick create menu", desc: "Which items appear in the top-bar + (New) menu, and their order.", group: "Company", icon: Plus, keywords: ["new menu", "plus menu", "quick create", "shortcuts", "actions", "+ new"], target: org("Quick create menu") },
  // Go-live setup: what happened before the org used HRMS. Each section is its own verb, so the panel is anyone's
  // who may run one of them.
  { key: "opening-balances", title: "Opening balances", desc: "Bring in what happened before your org started using HRMS, so nobody's attendance, pay or leave is worked out from history the app never saw.", group: "Company", icon: History, anyPerm: ["employees.setTrackedFrom", "leave-adjustments.importOpenings", "leave-requests.importHistory", "payroll-openings.importOpenings"], keywords: ["go-live", "migration", "import", "before hrms", "records start", "tracked from", "leave balance", "leave history", "payroll openings", "tds so far", "legacy"] },
  { key: "search-synonyms", title: "Search synonyms", desc: "Words your organisation uses that the records do not, so searching one finds the others.", group: "Company", icon: Search, keywords: ["⌘k", "search", "synonyms", "vocabulary", "abbreviations", "aliases"], target: { collection: "settings", objectPath: "settings/search-synonyms", label: "Search synonyms" } },

  // Time & leave
  { key: "leave-policy", title: "Leave policy", desc: "Carry-forward and encashment caps, accrual rounding, back-dating, and the org-wide leave restrictions.", group: "Time & leave", icon: CalendarRange, keywords: ["carry forward", "encash", "accrual", "backdated", "notice", "sandwich", "blackout", "quota", "restriction", "notice period", "joining"], target: { collection: "settings", objectPath: "settings/leave_caps", label: "Leave policy" } },
  { key: "leave-types", title: "Leave types", desc: "Casual, sick, earned - quotas, accrual, carry-forward, encashment and restrictions per type.", group: "Time & leave", icon: Palmtree, perm: "leave-types.write", keywords: ["vacation", "sick", "casual", "earned", "quota", "notice", "sandwich", "blackout", "restriction"], target: { collection: "leave-types", label: "Leave types" } },
  { key: "attendance", title: "Attendance schedule", desc: "Shift window, grace, working days, week start, flexible hours and loss-of-pay rules.", group: "Time & leave", icon: Clock, keywords: ["late", "grace", "working days", "week start", "lop", "timezone", "punch"], target: { collection: "settings", objectPath: "settings/attendance", label: "Attendance schedule" } },
  { key: "late-early", title: "Late & early policy", desc: "Who may ask to arrive late or leave early and when, what an approval does to the day, and what unexcused lateness costs in pay.", group: "Time & leave", icon: AlarmClock, keywords: ["late arrival", "early departure", "late coming", "early going", "permission", "short leave", "late mark", "penalty", "punctuality", "allowance", "auto approve"], target: { collection: "settings", objectPath: "settings/punctuality", label: "Late & early policy" } },
  { key: "shifts", title: "Shift patterns", desc: "Named shifts (morning, night…) assignable on the team roster.", group: "Time & leave", icon: CalendarClock, perm: "shifts.write", keywords: ["roster", "schedule"], target: { collection: "shifts", label: "Shifts" } },
  { key: "work-patterns", title: "Schedules", desc: "Repeating weeks and rotations of shifts and rest days, assigned to people on the roster.", group: "Time & leave", icon: CalendarClock, perm: "work-patterns.write", keywords: ["roster", "rotation", "part-time", "working week", "shift pattern"], target: { collection: "work-patterns", label: "Schedules" } },

  // Pay & money
  { key: "pay-components", title: "Pay components", desc: "The earning and deduction lines salaries are built from.", group: "Pay & money", icon: Coins, perm: "pay-components.write", keywords: ["basic", "hra", "pf", "esi", "earning", "deduction"], target: { collection: "pay-components", label: "Pay components" } },
  { key: "pay-grades", title: "Pay grades", desc: "Salary bands with min/mid/max used for compa-ratio checks.", group: "Pay & money", icon: Layers, perm: "pay-grades.write", keywords: ["band", "compa"], target: { collection: "pay-grades", label: "Pay grades" } },
  { key: "salary-structures", title: "Salary structures", desc: "Reusable sets of earning components applied to an employee's compensation.", group: "Pay & money", icon: ListOrdered, perm: "salary-structures.write", keywords: ["ctc split", "structure"], target: { collection: "salary-structures", label: "Salary structures" } },
  { key: "payroll-policy", title: "Payroll policy", desc: "CTC provisions (gratuity, employer ESI), overtime pricing and Professional Tax slabs.", group: "Pay & money", icon: Percent, perm: "pay-components.write", keywords: ["gratuity", "esi", "overtime rate", "professional tax", "pt slabs"], target: { collection: "settings", objectPath: "settings/ctc", label: "Payroll policy" } },
  { key: "payslip-design", title: "Payslip design", desc: "The blocks a generated payslip is laid out from - sections, wording, typeface and accent colour.", group: "Pay & money", icon: FileText, keywords: ["payslip", "template", "layout", "design", "pdf", "salary slip", "branding"], target: { collection: "settings", objectPath: "settings/payslip", label: "Payslip design" } },
  { key: "reimbursements", title: "Reimbursements", desc: "How approved claims are paid out, and the claim categories.", group: "Pay & money", icon: Receipt, perm: "reimbursement-categories.write", keywords: ["expense", "claim", "payout", "categories"], target: { collection: "settings", objectPath: "settings/reimbursements", label: "Reimbursement payout" } },
  { key: "expenses", title: "Expenses", desc: "Auto-approval, recurring generation, budget-alert thresholds, and expense categories.", group: "Pay & money", icon: Wallet, perm: "expense-categories.write", keywords: ["operational", "vendor", "budget", "recurring", "categories", "spend", "gl code"], target: { collection: "settings", objectPath: "settings/expenses", label: "Expense settings" } },
  { key: "bank-formats", title: "Bank payout formats", desc: "Excel/CSV templates for uploading salary payouts to your bank.", group: "Pay & money", icon: FileSpreadsheet, perm: "bank-formats.write", keywords: ["excel", "csv", "salary upload", "neft"], target: { collection: "bank-formats", label: "Bank formats" } },
  { key: "projects", title: "Projects", desc: "The projects time entries are logged against on timesheets.", group: "Pay & money", icon: FolderKanban, perm: "projects.write", keywords: ["timesheet", "time tracking"], target: { collection: "projects", label: "Projects" } },

  // Hiring & growth
  { key: "recruiting", title: "Recruiting pipeline", desc: "Hiring board stages, candidate sources, rejection reasons and scorecard criteria.", group: "Hiring & growth", icon: UserSearch, keywords: ["ats", "stages", "sources", "scorecard", "hiring"], target: { collection: "settings", objectPath: "settings/ats", label: "Recruiting settings" } },
  { key: "referrals", title: "Referral bonuses", desc: "When referral bonuses are awarded and how much, with join-speed tiers.", group: "Hiring & growth", icon: UserPlus, keywords: ["bonus", "refer", "milestone"], target: { collection: "settings", objectPath: "settings/referrals", label: "Referral settings" } },
  { key: "performance", title: "Performance framework", desc: "Rating scale, review criteria and review cycles.", group: "Hiring & growth", icon: Target, perm: "review-cycles.write", keywords: ["review cycle", "ratings", "360"], target: { collection: "review-cycles", label: "Performance" } },
  { key: "goal-templates", title: "Goal templates", desc: "Reusable goal blueprints, applied to a person or a whole team in one press.", group: "Hiring & growth", icon: Target, perm: "goal-templates.write", keywords: ["goal", "okr", "template", "blueprint", "ramp"], target: { collection: "goal-templates", label: "Goal templates" } },
  { key: "onboarding-templates", title: "Onboarding & offboarding", desc: "Task checklists applied when someone joins or leaves.", group: "Hiring & growth", icon: ClipboardList, perm: "transitions.write", keywords: ["joining", "exit", "checklist", "transition"], target: { collection: "transitions", label: "Onboarding templates" } },
  { key: "benefit-plans", title: "Benefit plans", desc: "Health, dental and other plans employees can enrol in.", group: "Hiring & growth", icon: HeartPulse, perm: "benefit-plans.write", keywords: ["insurance", "health", "enrolment"], target: { collection: "benefit-plans", label: "Benefit plans" } },

  // Work management (per-instance)
  { key: "board-config", scope: "object", hostPage: "boards", title: "Board configuration", desc: "Columns, WIP limits, swimlanes and labels - set per board, on the board itself.", group: "Work management", icon: KanbanSquare, keywords: ["kanban", "scrum", "columns", "wip", "swimlane", "label", "sprint", "board"], target: { collection: "boards", verb: "configure", label: "Configure board" } },

  // Comms & support
  { key: "letters", title: "Letter templates", desc: "The offer, appointment and HR letter templates, with a block editor and preview.", group: "Comms & support", icon: FileText, keywords: ["offer letter", "template", "contract", "document"], target: { collection: "letter-templates", label: "Letter templates" }, wide: true },
  { key: "letter-defaults", title: "Letter defaults", desc: "Signatory, HR contact and offer terms stamped into generated letters.", group: "Comms & support", icon: PenLine, keywords: ["signatory", "signature", "hr contact", "offer validity"], target: org("Letter defaults") },
  { key: "esign", title: "E-signature", desc: "Master switch + Aadhaar vendor settings; the signing method is chosen per template and per document.", group: "Comms & support", icon: FileSignature, keywords: ["esign", "aadhaar", "cashfree", "digital signature", "sign", "vendor", "in-app"], target: { collection: "settings", objectPath: "settings/esign", label: "E-signature" } },
  { key: "notifications", title: "Notifications", desc: "Which events notify people in-app, and at what priority.", group: "Comms & support", icon: Bell, keywords: ["bell", "alerts", "priority"], target: { collection: "settings", objectPath: "settings/notifications", label: "Notification settings" } },
  { key: "notification-prefs", scope: "user", hostPage: "notifications", title: "Your notification preferences", desc: "Mute notification categories for yourself, layered over the org config.", group: "Comms & support", icon: BellRing, keywords: ["mute", "silence", "personal", "my notifications", "preferences", "unsubscribe"] },
  { key: "ticket-categories", title: "Ticket categories", desc: "Help-desk categories with default assignees and members.", group: "Comms & support", icon: LifeBuoy, keywords: ["support", "helpdesk", "assignee", "routing"], target: { collection: "settings", objectPath: "settings/ticket-categories", label: "Ticket categories" } },
  { key: "ticket-checklists", title: "Ticket checklists", desc: "Reusable task lists an assignee can drop onto a ticket.", group: "Comms & support", icon: ListTodo, keywords: ["support tasks", "todo"], target: { collection: "ticket-checklists", label: "Ticket checklists" } },

  // Access & security
  // Also whoever may only reset a forgotten app PIN (HR, by default): the lock screen sends people to this panel for
  // it, and RolesPanel hides the account and role editing from anyone without `users.write`.
  { key: "users", title: "Users", desc: "Sign-in accounts and the roles each person holds.", group: "Access & security", icon: Users, anyPerm: ["users.write", "users.resetPin"], keywords: ["accounts", "login", "assign role", "reset pin", "app lock", "forgot pin"], target: { collection: "users", label: "Users" } },
  { key: "sign-in", title: "Sign-in", desc: "What the app takes from someone's Google account when they sign in.", group: "Access & security", icon: LogIn, keywords: ["google", "oauth", "sso", "login", "profile photo", "picture", "avatar", "face"], target: { collection: "settings", objectPath: "settings/sign-in", label: "Sign-in" } },
  { key: "roles", title: "Roles", desc: "Create and rename the roles permissions attach to.", group: "Access & security", icon: Shield, perm: "users.write", target: { collection: "roles", label: "Roles" } },
  { key: "permissions", title: "Permissions", desc: "What each role can see and do, per collection.", group: "Access & security", icon: KeyRound, perm: "users.write", keywords: ["grants", "access rules", "capabilities"], target: { collection: "access-rules", label: "Roles & permissions" } },
  { key: "api-keys", title: "API keys", desc: "Machine credentials for scripts and integrations, scoped below your own access.", group: "Access & security", icon: KeyRound, perm: "api-keys.read", keywords: ["token", "bearer", "integration", "machine", "service account"], target: { collection: "api-keys", label: "API keys" } },
  { key: "operations", title: "System operations", desc: "Cron runs, background jobs and system health.", group: "Access & security", icon: Wrench, perm: "cron-runs.read", keywords: ["cron", "jobs", "maintenance"], target: { collection: "operations", label: "Operations" } },
  { key: "search-insights", title: "Search insights", desc: "What people search for and do not find, where they find what they open, and how Ask answers. Counts only, no names.", group: "Access & security", icon: Search, perm: "search-insights.read", keywords: ["⌘k", "command palette", "zero results", "synonyms", "ranking", "ask"], target: { collection: "search-insights", label: "Search insights" } },
  // Under Access & security rather than Company, because what this panel decides is which of the org's text a
  // model may read - a data-handling decision, not a preference.
  { key: "ai", title: "AI features", desc: "Which AI-assisted features are switched on, and the daily budget they share. Every feature is off until turned on here, and each one works without AI when it is off.", group: "Access & security", icon: Sparkles, keywords: ["semantic search", "triage", "suggestions", "workers ai", "machine learning", "neurons", "budget", "model"], target: { collection: "settings", objectPath: "settings/ai", label: "AI features" } },
  // Under Company rather than Access & security, unlike the panel above it: nothing here decides what a model
  // may read. These are the lines the dashboard draws around somebody's own work, and they are worked out
  // from dates and progress.
  { key: "attention", title: "Needs you", desc: "When the dashboard calls a goal silent, a task stuck, or a week worth summarising - and whether the weekly roundup is sent. Worked out from dates and progress; no AI is involved.", group: "Company", icon: AlertTriangle, keywords: ["needs you", "attention", "stale", "stuck", "at risk", "digest", "roundup", "weekly", "dashboard", "reminder"], target: { collection: "settings", objectPath: "settings/attention", label: "Needs you" } },
];

export const settingsEntry = (key: string): SettingsEntry | undefined => SETTINGS_REGISTRY.find((e) => e.key === key);

// Which settings surface inline (as a gear on the host feature page) and where. Data, not scattered JSX:
// PageHeader renders <PageSettings host="…"/> which reads this map into one settings menu, a row per key. A new setting
// self-wires by adding a row here; "which pages carry inline config" stays inspectable. The host key is the
// page's route name (router.ts Route.page). Access & security, org identity/defaults etc. stay Settings-only.
export const HOST_SETTINGS: Record<string, string[]> = {
  // Time & leave
  "leave-requests": ["leave-policy", "leave-types"],
  // The calendar also reads the work schedule (working days, which weekday a grid starts on), so its gear
  // reaches that too - otherwise "why does my week start on Sunday" is a hunt through Settings.
  "leave-calendar": ["leave-policy", "leave-types", "attendance"],
  attendance: ["attendance", "late-early"],
  // The requests are judged against the shift the schedule sets, so the page that files them reaches both.
  "late-early": ["late-early", "attendance"],
  // The holiday page's breaks are computed from the working week, and its optional-pick allowance lives in
  // Defaults - both are reachable from its gear so neither is a hunt through Settings.
  holidays: ["defaults", "attendance"],
  schedule: ["shifts"],
  timesheets: ["projects"],
  // Pay & money
  // `late-early` because its penalties are charged as loss of pay on the run.
  "payroll-runs": ["pay-components", "payroll-policy", "payslip-design", "pay-grades", "salary-structures", "bank-formats", "late-early"],
  payslips: ["payslip-design", "pay-components", "payroll-policy", "pay-grades", "salary-structures", "bank-formats"],
  reimbursements: ["reimbursements"],
  expenses: ["expenses"],
  // the budget-alert thresholds a budget page colours "at risk" by live in the expenses panel, so the gear
  // reaches them from the page that shows their effect.
  "expense-budgets": ["expenses"],
  benefits: ["benefit-plans"],
  // Hiring & growth
  pipeline: ["recruiting"],
  "job-requisitions": ["recruiting"],
  candidates: ["recruiting"],
  referrals: ["referrals"],
  reviews: ["performance"],
  goals: ["performance", "goal-templates"],
  transitions: ["onboarding-templates"],
  // Comms & support
  documents: ["letters", "letter-defaults", "esign"],
  tickets: ["ticket-categories", "ticket-checklists"],
  notifications: ["notifications"],
  // Company
  employees: ["employee-fields", "employee-ids"],
  // Counts are governed by the same blob as the tags they scan (custody rules + the staleness window that
  // decides what "sighted recently" means on the Stocktakes page).
  assets: ["asset-tags"],
  stocktakes: ["asset-tags"],
  dashboard: ["dashboard"],
  announcements: ["kudos"],
  "org-chart": ["departments"],
};

export const hostSettings = (host: string): string[] => HOST_SETTINGS[host] ?? [];

// ---- Who may open a settings panel ----------------------------------------------------------------------------
//
// PER PANEL, not one app-wide `settings.write`. Settings are owned by different roles - HR's leave and attendance
// policy, payroll's CTC and tax slabs, super admin's governance switches (four-eyes, sign-in, AI) - and a grant
// names the setting keys it may write (`settings.<key>`), so "may this caller use Settings at all" has no single
// answer any more. A panel is offered to whoever can write what it edits; nobody is offered a panel that would
// 403 on save.

/** May the caller write this one setting key? A broad `settings.**` write answers for every key. */
export const mayWriteSetting = (caps: string[], key: string): boolean =>
  hasCapability(caps, "settings.write") || hasCapability(caps, `settings.${key}.write`);

const settingKeyOf = (e: SettingsEntry): string | null =>
  e.target?.collection === "settings" && e.target.objectPath ? e.target.objectPath.slice("settings/".length) : null;

/**
 * May the caller open this panel? Per-user panels are everyone's. A per-object panel needs the object's verb
 * (the gear on the object decides for the instance). An org panel with `anyPerm` needs one of those; otherwise
 * its `perm` when it names one, and write on the setting when it edits one; with neither, write on the
 * collection it manages.
 */
export function settingsEntryVisible(caps: string[], e: SettingsEntry): boolean {
  const scope = entryScope(e);
  if (scope === "user") return true;
  if (scope === "object") return !!e.target && hasCapability(caps, `${e.target.collection}.${e.target.verb ?? "configure"}`);
  if (e.anyPerm) return e.anyPerm.some((p) => hasCapability(caps, p));
  const key = settingKeyOf(e);
  if (e.perm && !hasCapability(caps, e.perm)) return false;
  if (key) return mayWriteSetting(caps, key);
  return !!e.perm || (!!e.target && hasCapability(caps, `${e.target.collection}.write`));
}

/** Does the caller have ANY org settings panel - which is what decides the Settings nav item and page. */
export const hasAnySettings = (caps: string[]): boolean =>
  SETTINGS_REGISTRY.some((e) => entryScope(e) === "org" && settingsEntryVisible(caps, e));

/**
 * The same question as a capability list, for the nav's `anyPerm` (which takes capabilities, not a predicate):
 * the capability each org panel leads with (every one of an `anyPerm` panel's). Holding any of them means some
 * panel is the caller's; the hub then filters to exactly which with `settingsEntryVisible`.
 */
export const SETTINGS_NAV_PERMS: string[] = [
  "settings.write",
  ...new Set(
    SETTINGS_REGISTRY.filter((e) => entryScope(e) === "org").flatMap((e) => {
      if (e.anyPerm) return e.anyPerm;
      const key = settingKeyOf(e);
      return [key ? `settings.${key}.write` : e.perm ?? `${e.target?.collection}.write`];
    }),
  ),
];
