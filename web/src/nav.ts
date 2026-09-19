import {
  LayoutDashboard,
  Users,
  CalendarCheck,
  Clock,
  Megaphone,
  FileText,
  PlayCircle,
  UserCircle,
  Settings,
  Workflow,
  Laptop,
  Target,
  FileCheck,
  CheckCheck,
  UserPlus,
  ScrollText,
  ReceiptText,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { RupeeCircle } from "./components/icons/RupeeCircle";
import { SETTINGS_REGISTRY } from "./settings/registry";
// A workspace tab: a route key that renders inside a sibling workspace instead of as its own nav entry.
export type NavTab = {
  key: string; // route page key + collection segment
  label: string;
  perm?: string; // tab shows only when the caller's capability set includes this "collection.action"
  // The access-control collection this tab manages, so the workspace tab bar can carry the per-tab
  // "manage access" key (instead of the page heading). Set it whenever the tab maps to a collection (and
  // it differs from `key`, e.g. schedule -> shift-assignments); omit for view-only tabs (org chart, calendar).
  collection?: string;
  // A page ABOUT OTHER PEOPLE - a manager's queue of their reports' rows, not the caller's own. Set it to the
  // collection whose BREADTH the page needs, and the entry also requires reach past the caller's own rows
  // (users/me `caller_access.read_scopes`). `perm` alone cannot say this: the capability set is scope-stripped,
  // so the self-service grant every employee holds on goals, attendance, reviews and payslips is spelled
  // exactly like an org-wide one, and a "Team goals" entry gated on it sits in every employee's sidebar over a
  // page that can only ever list their own. Leave it unset for a self-service page - that IS the stripped
  // question, and `/goals` is the same collection answered honestly for everybody.
  others?: string;
};

export type NavItem = {
  key: string; // route page key (for a workspace, this is the default/first tab's key)
  label: string;
  icon: LucideIcon;
  perm?: string; // single-page items: shown only with this capability
  // Shown when the caller has ANY of these capabilities (e.g. an Approvals hub for anyone who can approve
  // at least one request type). Takes precedence over `perm` when set.
  anyPerm?: string[];
  /** As NavTab#others: this page is about other people, so it also needs reach past the caller's own rows. */
  others?: string;
  // When present, this item is a WORKSPACE: clicking it opens the first tab, and the page renders a tab bar
  // letting the caller switch between the sibling pages without returning to the sidebar.
  tabs?: NavTab[];
};

// The capability that gates a nav entry (item or tab): explicit `perm` wins, else `<collection>.read` is
// derived - an entry tied to a collection the caller cannot read at ANY scope must not render (a
// self-scoped grant still strips to `<collection>.read`, so ordinary self-service pages stay visible).
// Entries with neither (dashboard, profile) are identity surfaces, visible to every signed-in user.
export function navPerm(t: { perm?: string; collection?: string }): string | undefined {
  return t.perm ?? (t.collection ? `${t.collection}.read` : undefined);
}

// Both gates for one entry: the capability, and - for an entry that declares `others` - the BREADTH past the
// caller's own rows. `reachesOthers` is required rather than optional so every nav consumer has to answer it;
// an omitted argument would have re-opened the entry silently in whichever surface forgot.
export function navAdmits(
  t: { perm?: string; collection?: string; others?: string },
  has: (perm: string) => boolean,
  reachesOthers: (collection: string) => boolean,
): boolean {
  const p = navPerm(t);
  if (p && !has(p)) return false;
  return !t.others || reachesOthers(t.others);
}

// Whether a nav item is visible for a capability set. Workspaces show if any tab is permitted; items with
// `anyPerm` show if any of those are held; otherwise the single derived gate (or always, if none).
export function itemVisible(item: NavItem, has: (perm: string) => boolean, reachesOthers: (collection: string) => boolean): boolean {
  if (item.tabs) return item.tabs.some((t) => navAdmits(t, has, reachesOthers));
  if (item.anyPerm) return item.anyPerm.some((p) => has(p)) && (!item.others || reachesOthers(item.others));
  return navAdmits(item, has, reachesOthers);
}

// Capabilities that grant access to the Approvals hub (any one is enough). Reused by the nav item gate.
export const APPROVAL_CAPS = [
  "leave-requests.approve",
  "reimbursements.approve",
  "overtime-requests.approve",
  "remote-work-requests.approve",
  "asset-requests.approve",
  "attendance-regularizations.approve",
  "leave-encashments.approve",
  "loans.approve",
  "time-entries.approve",
  "expenses.approve",
  "tax-verifications.read", // prior-employer tax declarations to verify (super by default; HR/payroll via ACL)
];

export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Home",
    items: [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { key: "approvals", label: "Approvals", icon: CheckCheck, anyPerm: APPROVAL_CAPS },
      { key: "profile", label: "My Profile", icon: UserCircle },
    ],
  },
  {
    label: "Workforce",
    items: [
      {
        key: "employees",
        label: "Team",
        icon: Users,
        tabs: [
          { key: "employees", label: "Directory", collection: "employees" },
          { key: "org-chart", label: "Org Chart", perm: "employees.read" },
          // Per-person reporting ACROSS the roster, so it needs reach past the caller's own record: the
          // employee grant everybody holds is the bare list capability (rows scoped to own), which strips to
          // the same `employees.read` HR holds org-wide. Gated on that alone, "Analytics" sat in every
          // employee's sidebar over a report about one person - themselves.
          { key: "team-analytics", label: "Analytics", perm: "employees.read", others: "employees" },
          { key: "transitions", label: "Onboarding", perm: "transitions.read", collection: "transitions" },
          { key: "notice-periods", label: "Offboarding", perm: "notice-periods.read", collection: "notice-periods" },
          { key: "background-checks", label: "Background Checks", perm: "background-checks.read", collection: "background-checks" },
        ],
      },
      {
        key: "boards",
        label: "Progress",
        icon: Target,
        tabs: [
          { key: "boards", label: "Boards", perm: "boards.read", collection: "boards" },
          { key: "goals", label: "Goals", perm: "goals.read", collection: "goals" },
          // A manager's triage of their reports' OPEN goals, not a step in a review cycle - it reads `goals`
          // and presses goal verbs. Named for what it is, next to the reviews tab that scores them later.
          // `others`, because this page is the REPORTS' goals: `goals.read` is true for every employee (their
          // own), so gated on the capability alone this sat in everybody's sidebar over a triage queue that
          // could only ever list the goals they set for themselves.
          { key: "team-goals", label: "Team goals", perm: "goals.read", collection: "goals", others: "goals" },
          { key: "reviews", label: "Reviews", perm: "reviews.read", collection: "reviews" },
          { key: "check-ins", label: "1:1s", perm: "check-ins.read", collection: "check-ins" },
        ],
      },
      {
        key: "announcements",
        label: "Connect",
        icon: Megaphone,
        tabs: [
          { key: "announcements", label: "Feed", collection: "announcements" },
          { key: "suggestions", label: "Suggestions", perm: "suggestions.read", collection: "suggestions" },
          { key: "events", label: "Events", perm: "events.read", collection: "events" },
        ],
      },
      {
        key: "pipeline",
        label: "Hiring",
        icon: UserPlus,
        tabs: [
          { key: "pipeline", label: "Pipeline", perm: "applications.read", collection: "applications" },
          { key: "job-requisitions", label: "Jobs", perm: "job-requisitions.read", collection: "job-requisitions" },
          { key: "candidates", label: "Candidates", perm: "candidates.read", collection: "candidates" },
          { key: "interviews", label: "Interviews", perm: "interviews.read", collection: "interviews" },
          { key: "offers", label: "Offers", perm: "offers.read", collection: "offers" },
          { key: "referrals", label: "Referrals", perm: "referrals.read", collection: "referrals" },
          { key: "recruiting-analytics", label: "Analytics", perm: "applications.read" },
        ],
      },
    ],
  },
  {
    label: "Employment",
    items: [
      {
        key: "attendance",
        label: "Time",
        icon: Clock,
        tabs: [
          { key: "attendance", label: "Attendance", collection: "attendance" },
          { key: "schedule", label: "Schedule", perm: "shift-assignments.read", collection: "shift-assignments" },
          { key: "timesheets", label: "Timesheets", perm: "time-entries.read", collection: "time-entries" },
          { key: "overtime", label: "Overtime", perm: "overtime-requests.read", collection: "overtime-requests" },
          { key: "remote-work", label: "Remote Work", perm: "remote-work-requests.read", collection: "remote-work-requests" },
          { key: "delegations", label: "Delegation", perm: "approval-delegations.read", collection: "approval-delegations" },
        ],
      },
      {
        key: "leave-requests",
        label: "Leave",
        icon: CalendarCheck,
        tabs: [
          { key: "leave-requests", label: "My Leave", collection: "leave-requests" },
          { key: "leave-calendar", label: "Calendar", perm: "leave-requests.read" },
          { key: "holidays", label: "Holidays", collection: "holidays" },
        ],
      },
      {
        key: "payslips",
        label: "Pay",
        icon: RupeeCircle,
        tabs: [
          { key: "payslips", label: "Payslips", collection: "payslips" },
          { key: "reimbursements", label: "Reimbursements", collection: "reimbursements" },
          { key: "loans", label: "Loans", perm: "loans.read", collection: "loans" },
          { key: "tax-declarations", label: "Tax", perm: "tax-declarations.read", collection: "tax-declarations" },
          { key: "benefits", label: "Benefits", perm: "benefit-plans.read", collection: "benefit-plans" },
        ],
      },
      { key: "payroll-runs", label: "Payroll", icon: PlayCircle, perm: "payroll-runs.read" },
    ],
  },
  {
    label: "Company",
    items: [
      { key: "documents", label: "Documents", icon: FileText, anyPerm: ["org-documents.read", "personal-documents.read"] },
      {
        key: "expenses",
        label: "Expenses",
        icon: ReceiptText,
        tabs: [
          { key: "expenses", label: "Expenses", collection: "expenses" },
          { key: "vendors", label: "Vendors", perm: "vendors.read", collection: "vendors" },
          { key: "expense-budgets", label: "Budgets", perm: "expense-budgets.read", collection: "expense-budgets" },
        ],
      },
      { key: "compliance", label: "Compliance", icon: FileCheck, perm: "compliance-events.read" },
      // The inventory and the counts of it are one workspace: you walk the office from the inventory and read
      // the result on Stocktakes, and the counts tab is private-by-default so it only appears once granted.
      {
        key: "assets",
        label: "Assets",
        icon: Laptop,
        tabs: [
          { key: "assets", label: "Inventory", collection: "assets" },
          { key: "stocktakes", label: "Stocktakes", collection: "stocktakes" },
        ],
      },
    ],
  },
  {
    label: "Admin",
    items: [
      // Custom grids. Private by default (no seeded grant names `table-views`), so the item only appears for
      // somebody an admin has granted it to.
      { key: "tables", label: "Tables", icon: Table2, perm: "table-views.read" },
      { key: "workflows", label: "Workflows", icon: Workflow, perm: "automations.read" },
      { key: "activity", label: "Activity", icon: ScrollText, perm: "audit.read" },
      { key: "settings", label: "Settings", icon: Settings, perm: "settings.write" },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((g) => g.items);
export function navItem(key: string): NavItem | undefined {
  return ALL_ITEMS.find((i) => i.key === key || i.tabs?.some((t) => t.key === key));
}

// The workspace item a route key belongs to (matches any of its tabs), or undefined for standalone pages.
export function workspaceForKey(key: string): NavItem | undefined {
  return ALL_ITEMS.find((i) => i.tabs?.some((t) => t.key === key));
}

// Route keys that render another page's component and therefore borrow its gate: the Settings deep links
// (a settings panel reached by its old top-level URL) and the pages reached from chrome rather than the
// sidebar (the top bar's Support entry, the bell). A key absent from both the nav and this map is an
// identity surface open to every signed-in user (dashboard, profile).
const ALIAS_GATE: Record<string, { perm?: string; anyPerm?: string[] }> = {
  departments: { perm: "settings.write" },
  "leave-types": { perm: "settings.write" },
  "pay-components": { perm: "settings.write" },
  users: { perm: "settings.write" },
  operations: { perm: "settings.write" },
  "pay-periods": { perm: "payroll-runs.read" }, // merged into Payroll Runs, which is where it renders
  kudos: { perm: "announcements.read" }, // the board, opened on its kudos filter
  tickets: { perm: "tickets.read" },
  // The bell. Named in this map's own header and missing from it, so `pageGate("notifications")` was undefined
  // and `/notifications` rendered for a caller with no `notifications.read` - an empty feed (useCollection
  // gates the read) rather than a wall, which is a "hide, never disable" miss.
  notifications: { perm: "notifications.read" },
};

// What a ROUTE requires, so a page is never rendered to someone the nav hides it from. Deep-linking (or
// typing) the URL of a page you have no access to must not hand you the page: the nav gate and the route
// gate are the same answer, computed here once for the sidebar, the command palette, the g-chords and the
// router. `undefined` means the route is ungated.
export function pageGate(key: string): { perm?: string; anyPerm?: string[]; others?: string } | undefined {
  for (const item of ALL_ITEMS) {
    const tab = item.tabs?.find((t) => t.key === key);
    if (tab) return { perm: navPerm(tab), others: tab.others };
    if (item.key === key) return item.anyPerm ? { anyPerm: item.anyPerm, others: item.others } : { perm: navPerm(item), others: item.others };
  }
  return ALIAS_GATE[key];
}

/**
 * Whether `has` (a capability test) and `reachesOthers` (the breadth test) admit this route. Ungated routes
 * are open to every signed-in user. The route answer has to ask BOTH, exactly as the sidebar does, or a page
 * hidden from the nav for want of breadth would still serve itself to anyone who typed its URL.
 */
export function pageVisible(key: string, has: (perm: string) => boolean, reachesOthers: (collection: string) => boolean): boolean {
  const gate = pageGate(key);
  if (!gate) return true;
  if (gate.others && !reachesOthers(gate.others)) return false;
  if (gate.anyPerm) return gate.anyPerm.some(has);
  return !gate.perm || has(gate.perm);
}

// Every page key reachable from a nav item: the item itself plus each of its workspace tabs. Used to roll a
// notification badge up from its target page to the sidebar item that owns it (sum over the subtree).
export function itemPageKeys(item: NavItem): string[] {
  return [item.key, ...(item.tabs?.map((t) => t.key) ?? [])];
}

// Standalone pages that present URL-routed top-level tabs (same UX as the sidebar workspaces, but every tab
// renders within one page component rather than as a separate route). Maps tab key -> label for the breadcrumb;
// the page itself owns which tabs actually render (permission-gated). First entry is the default tab.
export const PAGE_TAB_LABELS: Record<string, Record<string, string>> = {
  "payroll-runs": { runs: "Runs", periods: "Pay periods", bonuses: "Bonuses" },
  // Settings panels come from the registry - one breadcrumb label per panel key (legacy keys resolve
  // before they reach the breadcrumb, so only canonical keys need entries).
  settings: Object.fromEntries(SETTINGS_REGISTRY.map((e) => [e.key, e.title])),
};

// Breadcrumb for the top bar: group › workspace-label › active-tab (sub). Workspace tabs are their own route
// `key`, so `sub` is derived from the page. Standalone tabbed pages (Payroll Runs, Settings) carry the active
// tab in the second route segment, passed here as `sub`. Returns undefined for keys not in the nav.
/**
 * The human name of a route, for the tab title and the navigation announcement.
 *
 * `navBreadcrumb` only knows keys that are in NAV, and nine of App's route cases are not: seven Settings
 * deep-link aliases (`/departments` renders the same screen the titled `/settings/departments` does) plus the
 * two pages reached from the chrome rather than the sidebar - Tickets, from the top bar's Support menu, and
 * Notifications, from the bell. For those the tab read a bare app name and the live region was set to "" -
 * which announces NOTHING - the two failures `useRouteAnnounce` exists to fix.
 */
const OFF_NAV_LABELS: Record<string, string> = {
  ...Object.fromEntries(SETTINGS_REGISTRY.map((e) => [e.key, e.title])),
  notifications: "Notifications",
  tickets: "Support tickets",
  kudos: "Kudos",
  "pay-periods": "Pay periods",
};

export function pageLabel(key: string, sub?: string): string | undefined {
  const crumb = navBreadcrumb(key, sub);
  if (crumb) return [crumb.label, crumb.sub].filter(Boolean).join(" · ");
  return OFF_NAV_LABELS[key];
}

export function navBreadcrumb(key: string, sub?: string): { group: string; label: string; sub?: string } | undefined {
  for (const g of NAV) {
    for (const it of g.items) {
      if (it.tabs) {
        const tab = it.tabs.find((t) => t.key === key);
        if (tab) return { group: g.label, label: it.label, sub: tab.label };
      } else if (it.key === key) {
        const labels = PAGE_TAB_LABELS[key];
        if (labels) {
          const tabKey = sub && labels[sub] ? sub : Object.keys(labels)[0];
          return { group: g.label, label: it.label, sub: labels[tabKey] };
        }
        return { group: g.label, label: it.label };
      }
    }
  }
  return undefined;
}
