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
};

export type NavItem = {
  key: string; // route page key (for a workspace, this is the default/first tab's key)
  label: string;
  icon: LucideIcon;
  perm?: string; // single-page items: shown only with this capability
  // Shown when the caller has ANY of these capabilities (e.g. an Approvals hub for anyone who can approve
  // at least one request type). Takes precedence over `perm` when set.
  anyPerm?: string[];
  // When present, this item is a WORKSPACE: clicking it opens the first tab, and the page renders a tab bar
  // letting the caller switch between the sibling pages without returning to the sidebar.
  tabs?: NavTab[];
};

// Whether a nav item is visible for a capability set. Workspaces show if any tab is permitted; items with
// `anyPerm` show if any of those are held; otherwise the single `perm` gate (or always, if none).
export function itemVisible(item: NavItem, has: (perm: string) => boolean): boolean {
  if (item.tabs) return item.tabs.some((t) => !t.perm || has(t.perm));
  if (item.anyPerm) return item.anyPerm.some((p) => has(p));
  return !item.perm || has(item.perm);
}

// Capabilities that grant access to the Approvals hub (any one is enough). Reused by the nav item gate.
export const APPROVAL_CAPS = [
  "leave-requests.approve",
  "reimbursements.approve",
  "overtime-requests.approve",
  "remote-work-requests.approve",
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
          { key: "org-chart", label: "Org Chart" },
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
          { key: "leave-calendar", label: "Calendar" },
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
      { key: "documents", label: "Documents", icon: FileText },
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
      { key: "assets", label: "Assets", icon: Laptop, perm: "assets.read" },
    ],
  },
  {
    label: "Admin",
    items: [
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
