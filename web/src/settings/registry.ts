import type { LucideIcon } from "lucide-react";
import {
  Building2, Landmark, SlidersHorizontal, Hash, Network, Fingerprint, LayoutDashboard, Trophy,
  CalendarRange, Palmtree, Clock, CalendarClock,
  Coins, Layers, ListOrdered, Percent, Receipt, Wallet, FileSpreadsheet, FolderKanban,
  UserSearch, UserPlus, Target, ClipboardList, HeartPulse,
  FileText, PenLine, FileSignature, Bell, BellRing, LifeBuoy, ListTodo,
  Users, Shield, KeyRound, Wrench, Plus, KanbanSquare, Tag,
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
  key: string; // route segment: #/settings/<key>
  title: string;
  desc: string; // one line, plain language - shown on the hub card and panel header
  group: (typeof SETTINGS_GROUPS)[number];
  icon: LucideIcon;
  scope?: SettingsScope; // default "org"
  hostPage?: string; // non-org: the route page the nav card jumps to and the inline gear lives on
  keywords?: string[]; // extra search terms beyond title/desc
  perm?: string; // capability required beyond settings.write (e.g. "leave-types.write")
  target?: AccessTargetRef; // manage-access affordance on the panel header (object scope fills objectPath at runtime)
};

export const entryScope = (e: SettingsEntry): SettingsScope => e.scope ?? "org";

export const SETTINGS_GROUPS = ["Company", "Time & leave", "Pay & money", "Hiring & growth", "Work management", "Comms & support", "Access & security"] as const;

const org = (label: string): AccessTargetRef => ({ collection: "settings", objectPath: "settings/organization", label });

export const SETTINGS_REGISTRY: SettingsEntry[] = [
  // Company
  { key: "identity", title: "Name & branding", desc: "Company name, legal name, logo, address and how the sidebar wordmark renders.", group: "Company", icon: Building2, keywords: ["logo", "brand", "company name", "address", "anniversary", "wordmark"], target: org("Organization identity") },
  { key: "banks-currency", title: "Banks & currency", desc: "Allowed currencies, the default currency, and the bank list used in pickers.", group: "Company", icon: Landmark, keywords: ["money", "inr", "usd", "fx"], target: org("Banks & currency") },
  { key: "defaults", title: "Probation & holiday defaults", desc: "Default probation length for new hires and the optional-holiday allowance.", group: "Company", icon: SlidersHorizontal, keywords: ["probation months", "optional holidays"], target: { collection: "settings", objectPath: "settings/probation", label: "Defaults" } },
  { key: "employee-ids", title: "Employee IDs", desc: "The EMP-0042 style scheme new hires are auto-numbered with.", group: "Company", icon: Hash, keywords: ["number", "emp", "id format", "sequence"], target: { collection: "settings", objectPath: "settings/employee-number", label: "Employee IDs" } },
  { key: "departments", title: "Departments", desc: "The org's department tree - used by the directory, org chart and reporting.", group: "Company", icon: Network, perm: "departments.write", target: { collection: "departments", label: "Departments" } },
  { key: "employee-fields", title: "Employee identity fields", desc: "PAN, Aadhaar and other identity details collected per employee.", group: "Company", icon: Fingerprint, keywords: ["pan", "aadhaar", "uan", "custom fields", "sensitive"], target: { collection: "settings", objectPath: "settings/employee_fields", label: "Employee fields" } },
  { key: "dashboard", title: "Dashboard visibility", desc: "Which roles or people see each KPI card and timeline marker, and the shortcut tiles.", group: "Company", icon: LayoutDashboard, keywords: ["kpi", "timeline markers", "widgets", "shortcuts", "tiles"], target: { collection: "settings", objectPath: "settings/dashboard", label: "Dashboard" } },
  { key: "kudos", title: "Kudos levels", desc: "The recognition levels and their icons on the praise wall.", group: "Company", icon: Trophy, keywords: ["recognition", "praise", "badges"], target: { collection: "settings", objectPath: "settings/kudos", label: "Kudos levels" } },
  { key: "asset-tags", title: "Asset tags", desc: "The tag pattern, category codes, sticker-sheet formats and label content for printed asset tags.", group: "Company", icon: Tag, keywords: ["sticker", "label", "qr", "print", "inventory", "a4-65", "tag format"], target: { collection: "settings", objectPath: "settings/asset-tags", label: "Asset tags" } },
  { key: "quick-actions", title: "Quick create menu", desc: "Which items appear in the top-bar + (New) menu, and their order.", group: "Company", icon: Plus, keywords: ["new menu", "plus menu", "quick create", "shortcuts", "actions", "+ new"], target: org("Quick create menu") },

  // Time & leave
  { key: "leave-policy", title: "Leave policy", desc: "Carry-forward and encashment caps, accrual rounding, back-dated requests.", group: "Time & leave", icon: CalendarRange, keywords: ["carry forward", "encash", "accrual", "backdated"], target: { collection: "settings", objectPath: "settings/leave_caps", label: "Leave policy" } },
  { key: "leave-types", title: "Leave types", desc: "Casual, sick, earned - quotas, accrual, carry-forward and encashment per type.", group: "Time & leave", icon: Palmtree, perm: "leave-types.write", keywords: ["vacation", "sick", "casual", "earned", "quota"], target: { collection: "leave-types", label: "Leave types" } },
  { key: "attendance", title: "Attendance schedule", desc: "Shift window, grace, working days, flexible hours and loss-of-pay rules.", group: "Time & leave", icon: Clock, keywords: ["late", "grace", "working days", "lop", "timezone", "punch"], target: { collection: "settings", objectPath: "settings/attendance", label: "Attendance schedule" } },
  { key: "shifts", title: "Shift patterns", desc: "Named shifts (morning, night…) assignable on the team roster.", group: "Time & leave", icon: CalendarClock, perm: "shifts.write", keywords: ["roster", "schedule"], target: { collection: "shifts", label: "Shifts" } },

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
  { key: "onboarding-templates", title: "Onboarding & offboarding", desc: "Task checklists applied when someone joins or leaves.", group: "Hiring & growth", icon: ClipboardList, perm: "transitions.write", keywords: ["joining", "exit", "checklist", "transition"], target: { collection: "transitions", label: "Onboarding templates" } },
  { key: "benefit-plans", title: "Benefit plans", desc: "Health, dental and other plans employees can enrol in.", group: "Hiring & growth", icon: HeartPulse, perm: "benefit-plans.write", keywords: ["insurance", "health", "enrolment"], target: { collection: "benefit-plans", label: "Benefit plans" } },

  // Work management (per-instance)
  { key: "board-config", scope: "object", hostPage: "boards", title: "Board configuration", desc: "Columns, WIP limits, swimlanes and labels - set per board, on the board itself.", group: "Work management", icon: KanbanSquare, keywords: ["kanban", "scrum", "columns", "wip", "swimlane", "label", "sprint", "board"], target: { collection: "boards", verb: "configure", label: "Configure board" } },

  // Comms & support
  { key: "letters", title: "Letter templates", desc: "The offer, appointment and HR letter templates, with a block editor and preview.", group: "Comms & support", icon: FileText, keywords: ["offer letter", "template", "contract", "document"], target: { collection: "letter-templates", label: "Letter templates" } },
  { key: "letter-defaults", title: "Letter defaults", desc: "Signatory, HR contact and offer terms stamped into generated letters.", group: "Comms & support", icon: PenLine, keywords: ["signatory", "signature", "hr contact", "offer validity"], target: org("Letter defaults") },
  { key: "esign", title: "E-signature", desc: "Master switch + Aadhaar vendor settings; the signing method is chosen per template and per document.", group: "Comms & support", icon: FileSignature, keywords: ["esign", "aadhaar", "cashfree", "digital signature", "sign", "vendor", "in-app"], target: { collection: "settings", objectPath: "settings/esign", label: "E-signature" } },
  { key: "notifications", title: "Notifications", desc: "Which events notify people in-app, and at what priority.", group: "Comms & support", icon: Bell, keywords: ["bell", "alerts", "priority"], target: { collection: "settings", objectPath: "settings/notifications", label: "Notification settings" } },
  { key: "notification-prefs", scope: "user", hostPage: "notifications", title: "Your notification preferences", desc: "Mute notification categories for yourself, layered over the org config.", group: "Comms & support", icon: BellRing, keywords: ["mute", "silence", "personal", "my notifications", "preferences", "unsubscribe"] },
  { key: "ticket-categories", title: "Ticket categories", desc: "Help-desk categories with default assignees and members.", group: "Comms & support", icon: LifeBuoy, keywords: ["support", "helpdesk", "assignee", "routing"], target: { collection: "settings", objectPath: "settings/ticket-categories", label: "Ticket categories" } },
  { key: "ticket-checklists", title: "Ticket checklists", desc: "Reusable task lists an assignee can drop onto a ticket.", group: "Comms & support", icon: ListTodo, keywords: ["support tasks", "todo"], target: { collection: "ticket-checklists", label: "Ticket checklists" } },

  // Access & security
  { key: "users", title: "Users", desc: "Sign-in accounts and the roles each person holds.", group: "Access & security", icon: Users, perm: "users.write", keywords: ["accounts", "login", "assign role"], target: { collection: "users", label: "Users" } },
  { key: "roles", title: "Roles", desc: "Create and rename the roles permissions attach to.", group: "Access & security", icon: Shield, perm: "users.write", target: { collection: "roles", label: "Roles" } },
  { key: "permissions", title: "Permissions", desc: "What each role can see and do, per collection.", group: "Access & security", icon: KeyRound, perm: "users.write", keywords: ["grants", "access rules", "capabilities"], target: { collection: "access-rules", label: "Roles & permissions" } },
  { key: "operations", title: "System operations", desc: "Cron runs, background jobs and system health.", group: "Access & security", icon: Wrench, perm: "cron-runs.read", keywords: ["cron", "jobs", "maintenance"], target: { collection: "operations", label: "Operations" } },
];

// Old routes (parent tabs + renamed children) → today's panel keys, so bookmarks and in-app links keep landing.
export const SETTINGS_LEGACY: Record<string, string> = {
  organization: "identity",
  general: "identity",
  banks: "banks-currency",
  fields: "employee-fields",
  timeoff: "leave-policy",
  policies: "leave-policy",
  payroll: "pay-components",
  policy: "payroll-policy",
  people: "performance",
  onboarding: "onboarding-templates",
  benefits: "benefit-plans",
  support: "ticket-categories",
  access: "users",
  ats: "recruiting",
};

export const settingsEntry = (key: string): SettingsEntry | undefined => SETTINGS_REGISTRY.find((e) => e.key === key);

// Which settings surface inline (as a gear on the host feature page) and where. Data, not scattered JSX:
// PageHeader renders <PageSettings host="…"/> which reads this map and emits one gear per key. A new setting
// self-wires by adding a row here; "which pages carry inline config" stays inspectable. The host key is the
// page's route name (router.ts Route.page). Access & security, org identity/defaults etc. stay Settings-only.
export const HOST_SETTINGS: Record<string, string[]> = {
  // Time & leave
  "leave-requests": ["leave-policy", "leave-types"],
  "leave-calendar": ["leave-policy", "leave-types"],
  attendance: ["attendance"],
  schedule: ["shifts"],
  timesheets: ["projects"],
  // Pay & money
  "payroll-runs": ["pay-components", "payroll-policy", "payslip-design", "pay-grades", "salary-structures", "bank-formats"],
  payslips: ["payslip-design", "pay-components", "payroll-policy", "pay-grades", "salary-structures", "bank-formats"],
  reimbursements: ["reimbursements"],
  expenses: ["expenses"],
  benefits: ["benefit-plans"],
  // Hiring & growth
  pipeline: ["recruiting"],
  "job-requisitions": ["recruiting"],
  candidates: ["recruiting"],
  referrals: ["referrals"],
  reviews: ["performance"],
  goals: ["performance"],
  transitions: ["onboarding-templates"],
  // Comms & support
  documents: ["letters", "letter-defaults", "esign"],
  tickets: ["ticket-categories", "ticket-checklists"],
  notifications: ["notifications"],
  // Company
  employees: ["employee-fields", "employee-ids"],
  assets: ["asset-tags"],
  dashboard: ["dashboard"],
  announcements: ["kudos"],
  "org-chart": ["departments"],
};

export const hostSettings = (host: string): string[] => HOST_SETTINGS[host] ?? [];
