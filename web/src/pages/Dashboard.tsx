import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
// KPI-card icons live in lib/kpiIcons (shared with Settings); only icons used elsewhere on the page (clock
// widget, section headers, my-day tiles) are imported here; shortcut tiles carry their own icons.
import {
  Users,
  CalendarCheck,
  CalendarDays,
  ScanLine,
  Megaphone,
  ArrowRight,
  Cake,
  PartyPopper,
  Clock,
  LogIn,
  LogOut,
  EyeOff,
  Eye,
  Pin,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  SlidersHorizontal,
  Plane,
  Banknote,
  ListTodo,
  BellRing,
  ChevronDown,
} from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { useEmployee } from "@/hooks/useEmployee";
import { useVisibleRegions } from "@/hooks/useInView";
import { usePermission } from "@/lib/perm";
import { PageSettings } from "@/components/common/SettingsButton";
import { get, invoke } from "@/api";
import { fmtDuration, DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import { useClock, useElapsedMinutes } from "@/lib/clock";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { cn, formatDate, formatMoney, idOf } from "@/lib/utils";
import { addDaysYmd, orgDayFromToday, todayStr, weekStartYmd } from "@/lib/orgDay";
import { useApprovals } from "@/lib/approvals";
import { boardTime } from "@/lib/boardOrder";
import { useNotifications, timeAgo } from "@/lib/notifications";
import { navigate } from "@/router";
import { fireIntent } from "@/lib/intent";
import { useMedia } from "@/hooks/useMedia";
import type { Announcement, Celebration, Employee, Event, Holiday, LeaveRequest, LeaveType, Ticket, Me, Transition, JobRequisition, Expense, ComplianceEvent, Asset, Goal, Loan, Application, Interview, Referral, Review, TaxDeclaration, BackgroundCheck, Suggestion, BenefitEnrollment, Card as CardT, ExpenseBudget, DocumentResource, NoticePeriod, RemoteWorkRequest, TimeEntry, ReviewCycle, Offer, LeaveBalance, PayPeriod } from "@/types";
import { type DashboardConfig, type KpiCategory, KPI_DEFS, KPI_CATEGORIES, KPI_DEFAULT_AUDIENCE, kpiDefaultVisible, MARKER_DEFS, visibleToViewer } from "@/lib/dashboardConfig";
import { useDashPrefs } from "@/lib/dashboardPrefs";
import { KPI_ICONS, CATEGORY_ICONS } from "@/lib/kpiIcons";
import { StatCard } from "@/components/common/StatCard";
import { StatRow } from "@/components/common/StatRow";
import { CARD_CAPS, TILE_CAPS, ACTION_CAPS } from "@/lib/statRows";
import { TeamTimeline } from "@/components/common/TeamTimeline";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { kudosCardArtUrl, ART_DIECUT_SM } from "@/lib/kudosArt";
import { AccessTarget } from "@/components/access/AccessTarget";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveDashboardShortcuts } from "@/lib/dashboardShortcuts";
import { AccessAction } from "@/components/access/AccessAction";
import { useOrg, currencyDecimals, orgAnniversary, CELEBRATION_WEEK_DAYS } from "@/lib/org";
import { getSetting } from "@/lib/settingsStore";


// Category colors: a legend-dot background and a matching card left-border accent, so a card's band reads at a
// glance and ties back to its legend pill. For you = success, Attention = warning, Coming up = primary,
// At a glance = neutral.
const CAT_DOT: Record<KpiCategory, string> = {
  personal: "bg-success",
  attention: "bg-warning",
  upcoming: "bg-primary",
  snapshot: "bg-muted-foreground/50",
};
const CAT_ACCENT: Record<KpiCategory, string> = {
  personal: "border-l-4 border-l-success",
  attention: "border-l-4 border-l-warning",
  upcoming: "border-l-4 border-l-primary",
  snapshot: "border-l-4 border-l-muted-foreground/30",
};

// Collections whose :reject verb accepts an optional `note` in the body (relayed to the requester). Mirrors
// the Approvals inbox.
const REJECT_NOTE = new Set(["overtime-requests", "remote-work-requests"]);

// The dashboard's movable sections, in default order. The viewer reorders/hides them in the "Customize
// layout" popover (hero row); the choice persists per user via preferences/dashboard. Rendering uses CSS
// `order` on a flex column, so a reorder never remounts a section (the team timeline keeps its state).
type SectionKey = "shortcuts" | "myday" | "kpis" | "approvals" | "timeline" | "calendar" | "board";
const DASH_SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "shortcuts", label: "Shortcuts" },
  { key: "myday", label: "My day" },
  { key: "kpis", label: "KPI cards" },
  { key: "approvals", label: "Awaiting your approval" },
  { key: "timeline", label: "Team timeline" },
  { key: "calendar", label: "Holidays & celebrations" },
  { key: "board", label: "Board & announcements" },
];

// KPI keys GET /v1/dashboard-summary can aggregate server-side. Must stay in step with the server registry
// (src/services/dashboardSummary.ts); an unknown key is simply absent from the response and falls back to
// the row fetch.
const SUMMARY_KEYS = [
  "open_tickets", "expenses_pending", "recurring_expenses_due",
  "compliance_due", "compliance_week", "compliance_overdue",
  "assets_assigned", "goals_active", "loans_outstanding",
  "candidates_pipeline", "interviews_upcoming", "referrals_open", "reviews_open",
  "tax_verify", "bgchecks_open", "suggestions_open", "benefits_enrolled",
  "headcount", "joiners", "probation_ending", "on_leave",
  "cards_blocked", "cards_overdue", "cards_due_week", "my_open_cards",
  "notice_serving", "remote_today", "timesheets_draft", "timesheet_week", "team_hours_week",
  "reviews_due_soon", "offers_pending", "transitions_active", "onboarding_tasks_pending", "open_positions",
];

// Deep-link into a page with a DataTable filter pre-applied, using the table's own URL-state format
// (t.<key>={"f":{col:value}} - see DataTable), so a KPI click lands on exactly the rows the number counted.
const navigateFiltered = (page: string, tableKey: string, filters: Record<string, string>) =>
  navigate(`${page}?t.${tableKey}=${encodeURIComponent(JSON.stringify({ f: filters }))}`);

// Relative day label for a celebration that occurs `inDays` from today (0 = today).
const whenLabel = (inDays: number) => (inDays === 0 ? "Today" : inDays === 1 ? "Tomorrow" : `In ${inDays} days`);

// Same label as a node, with a day-of celebration picked out in success green so today's birthdays and
// anniversaries pop out of the list.
const CelebWhen = ({ inDays }: { inDays: number }) =>
  inDays === 0 ? <span className="font-medium text-success">Today</span> : <>{whenLabel(inDays)}</>;

// Loading placeholder for the avatar-and-two-lines list cards (holidays, celebrations); the leading shape
// matches the loaded row (square date chip vs round avatar) so nothing jumps when data lands.
const ListSkeleton = ({ avatarClass, rows = 3 }: { avatarClass: string; rows?: number }) => (
  <div className="space-y-3">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex items-center gap-3">
        <Skeleton className={avatarClass} />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    ))}
  </div>
);

// Relative label for a calendar date ("YYYY-MM-DD"): Today / Tomorrow / In N days, escalating to weeks then
// months so a holiday two months out reads "In 2 months" rather than "In 61 days".
function relativeDay(date: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 14) return `In ${days} days`;
  if (days < 60) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

export default function Dashboard({ me }: { me: Me }) {
  // ---- Read on sight -----------------------------------------------------------------------------------
  // The dashboard is a column of widgets over a dozen collections, and most of them start below the fold. So
  // nothing here reads on mount: each section carries a probe (`regionRef`), and its collections are gated on
  // that slot reaching the viewport. Two consequences worth stating:
  //  - CHEAP FIRST PAINT. A cold open reads only what is actually on screen - typically the KPI wall and the
  //    reader's own numbers - instead of every widget's page of rows, most of which are never looked at.
  //  - FEW REQUESTS. Every region already on screen is reported in ONE observer callback, so their reads fire
  //    in one commit and the coalescer collapses them into a single POST /v1/batch:run. A scroll down is one
  //    more batch, not a request per widget. (Nothing per-widget is wired for that: see lib/getCoalescer.ts.)
  // A cached collection still renders instantly from the store while off screen - gating decides who FETCHES,
  // not what may be shown.
  const { regionRef, seen } = useVisibleRegions();
  // Everything awaiting the caller's decision - ALL request types, from the same session-wide provider that
  // feeds the sidebar badge and the Approvals inbox, so the three never disagree. Counts first, rows only for
  // the queues the count says are non-empty; empty (and free) for callers who can't approve anything.
  const approvals = useApprovals();
  // Read up here because whether this caller DECIDES leave also decides whether the wall below needs leave
  // rows: an approver's card reads the approvals count instead of counting requests.
  const canDecide = usePermission("leave-requests.approve");
  // "Approver" for KPI purposes: can decide leave, or has anything (of any type) awaiting their decision.
  const isApprover = canDecide || approvals.total > 0;
  const wantMyDay = seen("myday");
  const wantKpis = seen("kpis");
  const wantApprovals = seen("approvals");
  const wantTimeline = seen("timeline");
  const wantCalendar = seen("calendar");
  const wantBoard = seen("board");

  // Shared reads, each gated on the union of the sections that actually consume it. Generous by design: a
  // section listed here fetches the collection the moment it is on screen, so no widget can render a number
  // computed from rows it never asked for.
  //  holidays    - the holidays card, "is today a holiday" (not-clocked-in), timeline day shading, my-day.
  const { rows: holidays, state: holidaysState } = useCollection<Holiday>("holidays", { enabled: wantCalendar || wantKpis || wantTimeline || wantMyDay, all: true });
  const { rows: announcements, state: announcementsState } = useCollection<Announcement>("announcements", { enabled: wantBoard });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types", { enabled: wantMyDay || wantTimeline });
  // Org events (private-by-default; yields [] for callers without events.read). Marked as bands on the timeline.
  const { rows: events } = useCollection<Event>("events", { enabled: wantKpis || wantTimeline });
  // `employees` and `leave-requests` - the two widest reads on the page - are further down, where the summary
  // has settled and their gates can tell whether the wall still needs rows at all.

  // Birthdays and anniversaries: the celebrations card, the "celebrating this week" KPI and the timeline's
  // markers. Scans the directory server-side, so it waits for one of those three to be on screen.
  const wantCelebrations = wantCalendar || wantKpis || wantTimeline;
  const [celebrations, setCelebrations] = useState<Celebration[]>([]);
  const [celebsLoading, setCelebsLoading] = useState(true);
  useEffect(() => {
    if (!wantCelebrations) return;
    let live = true;
    get<{ results: Celebration[] }>("employees:upcomingCelebrations")
      .then((r) => live && setCelebrations(r.results ?? []))
      .catch(() => live && setCelebrations([]))
      .finally(() => live && setCelebsLoading(false));
    return () => {
      live = false;
    };
  }, [wantCelebrations]);

  const canTimeline = usePermission("timeline.read");
  // Events are private by default, so the events card is dropped entirely for callers without the grant
  // rather than shown reading a permanent zero (an absent kpiData entry hides the card - see allBands).
  const canEvents = usePermission("events.read");
  // Bumped whenever the caller clocks in/out, so the open-sessions read below and the team timeline both
  // refresh and reflect the change immediately.
  const [attendanceRefresh, setAttendanceRefresh] = useState(0);
  const onClockChange = () => setAttendanceRefresh((n) => n + 1);

  // Open attendance sessions come from the session-wide clock state (one read for the whole app, shared with
  // the top-bar chip and the Attendance page): the clocked-in KPI counts them and the clock widget finds the
  // caller's own session in the same result.
  const openSessions = useClock().openSessions;
  const clockedIn = openSessions.length;

  // Role-based dashboard config (which KPIs + timeline markers each role sees). Read is open; default (unset)
  // shows everything. Edited in Settings → Organization → Dashboard.
  const [dashCfg, setDashCfg] = useState<DashboardConfig>({});
  const [cfgReady, setCfgReady] = useState(false);
  useEffect(() => {
    getSetting<DashboardConfig>("dashboard")
      .then((s) => setDashCfg(s.value ?? {}))
      .catch(() => setDashCfg({}))
      .finally(() => setCfgReady(true));
  }, []);
  // The viewer's PERSONAL layer on top of the org config: focused band, hide-all-clear, pinned/hidden cards
  // and the mobile timeline state - synced cross-device via /v1/preferences.
  const [prefs, updatePrefs] = useDashPrefs();
  const catFilter = prefs.catFilter ?? null;
  const setCatFilter = (v: KpiCategory | null) => updatePrefs({ catFilter: v });
  const hideClear = !!prefs.hideClear;
  const toggleHideClear = () => updatePrefs({ hideClear: !hideClear });
  const pinnedKpis = useMemo(() => new Set(prefs.pinnedKpis ?? []), [prefs.pinnedKpis]);
  const hiddenKpis = useMemo(() => new Set(prefs.hiddenKpis ?? []), [prefs.hiddenKpis]);
  const togglePin = (key: string) =>
    updatePrefs({ pinnedKpis: pinnedKpis.has(key) ? [...pinnedKpis].filter((k) => k !== key) : [...pinnedKpis, key] });
  const hideKpi = (key: string) => updatePrefs({ hiddenKpis: [...hiddenKpis, key] });
  // Whole-section layout: the viewer's saved order (unknown keys dropped, unsaved sections appended in
  // default order) and the sections they switched off. Sections render inside a flex column with CSS
  // `order`, so reordering is visual only and never remounts a section mid-session.
  const sectionOrderResolved = useMemo<SectionKey[]>(() => {
    const known = new Set(DASH_SECTIONS.map((s) => s.key));
    const saved = ((prefs.sectionOrder ?? []) as SectionKey[]).filter((k) => known.has(k));
    return [...saved, ...DASH_SECTIONS.map((s) => s.key).filter((k) => !saved.includes(k))];
  }, [prefs.sectionOrder]);
  const hiddenSections = useMemo(
    () => new Set(((prefs.hiddenSections ?? []) as SectionKey[]).filter((k) => DASH_SECTIONS.some((s) => s.key === k))),
    [prefs.hiddenSections],
  );
  const sectionStyle = (k: SectionKey) => ({ order: sectionOrderResolved.indexOf(k) });
  const showSection = (k: SectionKey) => !hiddenSections.has(k);
  const moveSection = (k: SectionKey, dir: -1 | 1) => {
    const order = [...sectionOrderResolved];
    const i = order.indexOf(k);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    updatePrefs({ sectionOrder: order });
  };
  const toggleSection = (k: SectionKey) =>
    updatePrefs({ hiddenSections: hiddenSections.has(k) ? [...hiddenSections].filter((x) => x !== k) : [...hiddenSections, k] });
  const layoutCustomized = (prefs.sectionOrder?.length ?? 0) > 0 || hiddenSections.size > 0;

  // KPI visibility. A configured KPI follows its explicit role/user audience. An UNCONFIGURED one falls back to
  // its default audience: everyone, HR admins only (HR-related cards), or none (hidden until shared).
  const kpiVisible = (key: string) => visibleToViewer(dashCfg.kpis?.[key], me.role, me.employee_id, kpiDefaultVisible(KPI_DEFAULT_AUDIENCE[key], me.role));
  // Timeline markers this viewer may NOT see -> hidden on the timeline.
  const hiddenMarkers = useMemo(
    () => MARKER_DEFS.filter((m) => !visibleToViewer(dashCfg.timeline?.[m.key], me.role, me.employee_id)).map((m) => m.key),
    [dashCfg, me.role, me.employee_id],
  );

  // ---- Aggregated KPI counts: GET /v1/dashboard-summary computes every count/sum below server-side (one
  // request, one D1 batch, numbers only), gated per backing collection by the caller's real list decision.
  // Keys the server omits (not listable, older server) fall back to the per-collection row fetches below, so
  // the wall renders identically either way - the summary only decides who pays for the counting.
  type SummaryEntry = { value: number; extra?: number };
  const [summary, setSummary] = useState<Record<string, SummaryEntry> | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (!cfgReady) return;
    // Counts, but not before they are wanted: every key below belongs to the KPI wall, bar the one my-day tile
    // that rides along (assets_pending_scan). Each aggregate is a scoped COUNT server-side, so this one
    // request replaces a page of rows per card - but it is still work, and an off-screen wall doesn't need it.
    if (!wantKpis && !wantMyDay) return;
    const wanted = new Set(SUMMARY_KEYS.filter((k) => kpiVisible(k)));
    // Not-clocked-in is arithmetic over three other numbers, so it needs all three even when their own cards
    // are hidden: the headcount denominator, plus who is legitimately away (remote / on leave).
    if (kpiVisible("not_clocked_in")) for (const k of ["headcount", "remote_today", "on_leave"]) wanted.add(k);
    // Several cards read "of N people" in their hint, so the headcount count earns its place whenever one of
    // them shows - otherwise the hint would have to fall back to counting a page of the directory.
    if (["on_leave", "remote_today", "joiners", "benefits_enrolled"].some((k) => kpiVisible(k))) wanted.add("headcount");
    if (wanted.size === 0) {
      setSummary({});
      setSummaryState("ready");
      return;
    }
    let live = true;
    get<{ kpis?: Record<string, SummaryEntry> }>(`dashboard-summary?keys=${[...wanted].join(",")}`)
      .then((r) => { if (live) { setSummary(r.kpis ?? {}); setSummaryState("ready"); } })
      .catch(() => { if (live) { setSummary(null); setSummaryState("error"); } });
    return () => { live = false; };
    // kpiVisible closes over dashCfg/me; re-request when the config (or viewer) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgReady, dashCfg, me.role, me.employee_id, wantKpis, wantMyDay]);
  // Do the rows for this KPI still need fetching? Yes if the summary failed, or settled without the key. Until
  // the wall is on screen the summary hasn't been asked for, so nothing falls back to rows either.
  const needRows = (key: string) => summaryState === "error" || (summaryState === "ready" && !summary?.[key]);
  const wantRows = (key: string) => wantKpis && kpiVisible(key) && needRows(key);
  // Summary-first value/extra, falling back to the row-computed number.
  const sv = (key: string, fallback: number) => summary?.[key]?.value ?? fallback;
  const sx = (key: string, fallback: number) => summary?.[key]?.extra ?? fallback;

  // ---- The two widest reads on the page, and the only two whose gate needs the summary to have settled -----
  // The directory: the timeline draws every person on it, the approval rows and a kudos post show names. The
  // KPI wall's four directory numbers (headcount, joiners, probation, and the not-clocked-in denominator) are
  // scoped COUNTs server-side, so the wall reaches for a page of rows only if the summary came back without
  // them - and then it is counting one page rather than the org, which is exactly why the counts exist.
  // A hidden card whose number feeds a VISIBLE one still needs its number, so the not-clocked-in arithmetic
  // gets the same treatment here as it does in the summary request above.
  const forNotClockedIn = (key: string) => wantKpis && kpiVisible("not_clocked_in") && needRows(key);
  const readEmployees =
    wantTimeline || wantApprovals || wantBoard ||
    wantRows("headcount") || wantRows("joiners") || wantRows("probation_ending") || forNotClockedIn("headcount");
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees", { all: true, enabled: readEmployees });
  // Leave: the timeline's away bands, my-day's next time off, and - for a caller who decides nothing - their
  // own pending count (an approver's card reads the approvals count instead, which costs no rows). Gated on
  // the PERMISSION rather than on `isApprover`, because the approvals count arrives asynchronously and a gate
  // that flips with it would have fetched the rows before the answer landed. "On leave today" is a server-side
  // count like the directory numbers above.
  const { rows: leave } = useCollection<LeaveRequest>("leave-requests", {
    enabled: wantMyDay || wantTimeline || (wantKpis && !canDecide) || wantRows("on_leave") || forNotClockedIn("on_leave"),
  });

  // The greeting wants ONE row - the caller's own - and it paints before any section is in view, so it reads
  // that row by id rather than pulling a 100-row directory page for a first name. Once a section that needs
  // the directory has loaded it, that row wins (same data, and it stays fresh with the list); on a cached
  // revisit the list answers straight away and the by-id read never happens.
  const selfFromList = me.employee_id ? employees.find((e) => idOf(e.path) === me.employee_id) : undefined;
  const { emp: selfRow } = useEmployee(me.employee_id && !selfFromList ? me.employee_id : null);
  const selfEmp = selfFromList ?? selfRow ?? undefined;
  // Recent joiner (started within the last 60 days): also fetch transitions so the "your onboarding" tile can
  // show the caller's own checklist even when no transition KPI is shared with them.
  const recentJoiner = useMemo(() => {
    if (!selfEmp?.start_date) return false;
    return selfEmp.start_date >= orgDayFromToday(-60);
  }, [selfEmp?.start_date]);

  // ---- Module KPIs (one collection each). Private by default, and read only as a LAST resort: `wantRows`
  // requires the wall to be on screen, the card to be visible to this viewer, and the summary above to have
  // settled WITHOUT the count - so a viewer who can't see the card, or whose number arrived aggregated, or who
  // never scrolled this far, never pays the D1 read. The card also stays gated by the collection's real grants
  // (an empty list -> a "0" the viewer is entitled to see). Each drills through to its module page.
  // Open support tickets the caller can see (scoped server-side); count of those still OPEN drives a KPI.
  const { rows: tickets } = useCollection<Ticket>("tickets", { enabled: wantRows("open_tickets") });
  const openTickets = useMemo(() => tickets.filter((t) => (t.state ?? "").toUpperCase() === "OPEN").length, [tickets]);
  // Also the new joiner's own onboarding checklist, which is a my-day tile rather than a KPI.
  const { rows: transitions } = useCollection<Transition>("transitions", { enabled: wantRows("transitions_active") || wantRows("onboarding_tasks_pending") || (wantMyDay && recentJoiner) });
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions", { enabled: wantRows("open_positions") });
  const { rows: expenses } = useCollection<Expense>("expenses", { enabled: wantRows("expenses_pending") || wantRows("recurring_expenses_due") });
  const { rows: complianceEvents } = useCollection<ComplianceEvent>("compliance-events", { enabled: wantRows("compliance_due") || wantRows("compliance_overdue") || wantRows("compliance_week") });
  const { rows: assets } = useCollection<Asset>("assets", { enabled: wantRows("assets_assigned") });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: wantRows("goals_active") });
  const { rows: loans } = useCollection<Loan>("loans", { enabled: wantRows("loans_outstanding") });
  const { rows: applications } = useCollection<Application>("applications", { enabled: wantRows("candidates_pipeline") });
  const { rows: interviews } = useCollection<Interview>("interviews", { enabled: wantRows("interviews_upcoming") });
  const { rows: referrals } = useCollection<Referral>("referrals", { enabled: wantRows("referrals_open") });
  const { rows: reviews } = useCollection<Review>("reviews", { enabled: wantRows("reviews_open") });
  const { rows: taxDeclarations } = useCollection<TaxDeclaration>("tax-declarations", { enabled: wantRows("tax_verify") });
  const { rows: backgroundChecks } = useCollection<BackgroundCheck>("background-checks", { enabled: wantRows("bgchecks_open") });
  const { rows: suggestions } = useCollection<Suggestion>("suggestions", { enabled: wantRows("suggestions_open") });
  const { rows: benefitEnrollments } = useCollection<BenefitEnrollment>("benefit-enrollments", { enabled: wantRows("benefits_enrolled") });
  // One flat `cards` read feeds the board KPIs; enabled if the viewer can see any of them and the summary
  // didn't already count them.
  const { rows: cards } = useCollection<CardT>("cards", { enabled: wantRows("cards_blocked") || wantRows("cards_overdue") || wantRows("my_open_cards") || wantRows("cards_due_week") });
  // Budget utilization is a service-derived rollup, not a column - not summarizable; the rows stay.
  const { rows: budgets } = useCollection<ExpenseBudget>("expense-budgets", { enabled: wantKpis && kpiVisible("budget_over") });
  // Document ack/sign state is per-caller (join against acknowledgements) - the rows stay too.
  const { rows: orgDocuments } = useCollection<DocumentResource>("org-documents", { enabled: wantKpis && kpiVisible("docs_to_ack") });
  const { rows: personalDocuments } = useCollection<DocumentResource>("personal-documents", { enabled: wantKpis && (kpiVisible("docs_expiring") || kpiVisible("letters_to_sign")) });
  const { rows: noticePeriods } = useCollection<NoticePeriod>("notice-periods", { enabled: wantRows("notice_serving") });
  // Remote-work rows also feed the "not clocked in" math (people working remotely aren't missing).
  const { rows: remoteRequests } = useCollection<RemoteWorkRequest>("remote-work-requests", { enabled: wantRows("remote_today") || (wantKpis && kpiVisible("not_clocked_in") && needRows("remote_today")) });
  const { rows: timeEntries } = useCollection<TimeEntry>("time-entries", { enabled: wantRows("timesheet_week") || wantRows("timesheets_draft") || wantRows("team_hours_week") });
  const { rows: reviewCycles } = useCollection<ReviewCycle>("review-cycles", { enabled: wantRows("reviews_due_soon") });
  const { rows: offers } = useCollection<Offer>("offers", { enabled: wantRows("offers_pending") });

  // ---- My-day data: the caller's own numbers (leave balance, payday, own upcoming leave, own onboarding,
  // recent request outcomes). All self-scoped or already-loaded - no org-wide reads.
  const { rows: leaveBalances, state: balancesState } = useCollection<LeaveBalance>("leave-balances", { enabled: wantMyDay && !!me.employee_id });
  const { rows: payPeriods, state: payPeriodsState } = useCollection<PayPeriod>("pay-periods", { enabled: wantMyDay && !!me.employee_id });
  const { notifications } = useNotifications();

  // Org work schedule (working week + shift times) for the timeline's shading and per-day attendance status.
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  const today = todayStr();

  const upcomingHolidays = useMemo(
    // `applies === false` is a regional holiday for another location - not this viewer's day off.
    () => holidays.filter((h) => h.date >= today && !h.disabled && h.applies !== false).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5),
    [holidays, today]
  );
  const isHolidayToday = useMemo(() => holidays.some((h) => h.date === today && !h.disabled), [holidays, today]);
  // Org events whose window overlaps the next 7 days, soonest first. Computed from the rows the timeline
  // already loaded, so this KPI costs no extra read. Instants compare on the date part, so an all-day event
  // counts for its whole day (and a running multi-day event still counts as "this week").
  const upcomingEvents = useMemo(() => {
    // `addDaysYmd`, not a local-parse/UTC-serialize round trip: building a Date from `${today}T00:00:00` parses
    // at LOCAL midnight, stepping it is local arithmetic, and `toISOString()` serializes UTC - so the window was
    // six days east of UTC and eight days west of it.
    const in7Str = addDaysYmd(today, 7);
    const day = (v: string | undefined) => (v ?? "").slice(0, 10);
    return events
      .filter((e) => !e.delete_time && day(e.end_time) >= today && day(e.start_time) <= in7Str)
      .sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
  }, [events, today]);
  const eventsToday = useMemo(
    () => upcomingEvents.filter((e) => (e.start_time ?? "").slice(0, 10) <= today).length,
    [upcomingEvents, today]
  );
  const latestNews = useMemo(
    () =>
      announcements
        // Official announcements only - generic board posts live on the Board page, not the dashboard feed.
        .filter((a) => (a.kind ?? "announcement") === "announcement" && a.published !== false && !a.disabled)
        // By when it went live, the same date the card prints (lib/boardOrder) - an announcement published on
        // the spot carries no publish_time, so sorting on that field alone sank the newest ones to the end.
        // Not the pin-aware key: this card is the LATEST news, not the board's curated order.
        .sort((a, b) => boardTime(b) - boardTime(a))
        .slice(0, 4),
    [announcements]
  );
  // Unread board items (any kind) from the last 7 days the caller has no read receipt for. Merged into the
  // board card below: unread rows first (marked with a dot), then the latest announcements.
  const unread = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return announcements
      .filter((a) => a.read === false && a.published !== false && !a.disabled)
      .filter((a) => boardTime(a) >= weekAgo)
      .sort((a, b) => boardTime(b) - boardTime(a));
  }, [announcements]);
  // One board card, not two: unread items lead (any kind), then the latest announcements that aren't already
  // in the unread set, capped at 5 rows.
  const boardRows = useMemo(() => {
    const unreadPaths = new Set(unread.map((a) => a.path));
    return [...unread, ...latestNews.filter((a) => !unreadPaths.has(a.path))].slice(0, 5);
  }, [unread, latestNews]);
  const pending = useMemo(() => leave.filter((l) => l.state?.toUpperCase() === "PENDING"), [leave]);

  // A board row's display label: kudos carry no title (the message is the body + the recipient the subject), so
  // fall back to a "Kudos for <name>" line; other kinds use their title, then their body, so nothing renders blank.
  const postLabel = (a: Announcement) => {
    if (a.title?.trim()) return a.title;
    if (a.kind === "kudos") {
      const r = a.recipient ? employees.find((e) => e.path === a.recipient) : undefined;
      return r ? `Kudos for ${`${r.first_name} ${r.last_name}`.trim()}` : a.recipient_department ? "Kudos for the team" : "Kudos";
    }
    return (a.body ?? "").trim() || "Post";
  };

  // Open the board and scroll to / highlight a specific post (the Announcements page consumes the "open-post"
  // intent once it mounts).
  const openPost = (a: Announcement) => { navigate("announcements"); fireIntent("open-post", a.path); };

  // ---- Dynamic KPIs (computed from already-loaded data; reflect only what the caller may see) ----
  const approved = useMemo(() => leave.filter((l) => l.state?.toUpperCase() === "APPROVED"), [leave]);

  // Distinct people whose approved leave spans today.
  const onLeaveToday = useMemo(() => {
    const ids = new Set<string>();
    for (const l of approved) {
      if (l.employee && l.start_date <= today && l.end_date >= today) ids.add(idOf(l.employee));
    }
    return ids.size;
  }, [approved, today]);

  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  type ApprovalItem = { path: string; collection: string; etag?: string; can: string[]; employee?: string; when?: string; kind: string; desc: string };
  const approvalItems = useMemo(() => {
    const item = (collection: string, kind: string) => (r: { path: string; etag?: string; access?: { can?: string[] }; employee?: string; create_time?: string }, desc: string): ApprovalItem =>
      ({ path: r.path, collection, etag: r.etag, can: r.access?.can ?? [], employee: r.employee, when: r.create_time, kind, desc });
    const items: ApprovalItem[] = [
      ...approvals.leaves.map((r) => item("leave-requests", "Leave")(r, `${formatDate(r.start_date)} to ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}`)),
      ...approvals.reimbs.map((r) => item("reimbursements", "Reimbursement")(r, money(r.amount))),
      ...approvals.overtimes.map((r) => item("overtime-requests", "Overtime")(r, `${formatDate(r.date)} · ${Math.round(r.minutes / 6) / 10}h`)),
      ...approvals.remotes.map((r) => item("remote-work-requests", "Remote work")(r, `${formatDate(r.start_date)} to ${formatDate(r.end_date)}`)),
      ...approvals.regularizations.map((r) => item("attendance-regularizations", "Attendance")(r, formatDate(r.date))),
      ...approvals.encashments.map((r) => item("leave-encashments", "Encashment")(r, `${r.days} day${r.days === 1 ? "" : "s"}`)),
      ...approvals.loans.map((r) => item("loans", r.kind === "advance" ? "Advance" : "Loan")(r, money(r.principal))),
      ...approvals.timeEntries.map((r) => item("time-entries", "Timesheet")(r, `${r.hours}h`)),
    ];
    return items.sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvals, org.default_currency]);
  // How long the oldest item awaiting the caller's decision has been waiting (for the approvals KPI hint).
  const oldestPendingDays = useMemo(() => {
    const t = approvalItems[0]?.when;
    return t ? Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 86_400_000)) : 0;
  }, [approvalItems]);
  // The server count covers queues this page doesn't read, so it can exceed what the card holds - never the
  // other way round. Taking the larger of the two keeps the badge honest while a queue is still arriving.
  const approvalsAwaiting = Math.max(approvals.total, approvalItems.length);

  // Inline decision state for the approvals card. Approve is one click; reject confirms via a small dialog
  // (with an optional note where the collection's :reject accepts one), exactly like the Approvals inbox.
  const { toast } = useToast();
  const confirm = useConfirm();
  const [deciding, setDeciding] = useState<string | null>(null); // path being decided (disables its row buttons)
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  async function decideInline(it: ApprovalItem, verb: "approve" | "reject", note?: string) {
    // Rejection arrives from its own dialog (which collects the note); approval is the bare click, and on a
    // dashboard it sits among widgets people scroll past rather than in a queue they came to work through.
    const who = it.employee ? employees.find((e) => idOf(e.path) === idOf(it.employee!)) : undefined;
    const whose = who ? `${who.first_name} ${who.last_name}'s` : "this";
    if (verb === "approve" && !(await confirmDecision(confirm, "approve", `${whose} ${it.kind.toLowerCase()} request (${it.desc})`))) return;
    setDeciding(it.path);
    try {
      const body = verb === "reject" && note?.trim() && REJECT_NOTE.has(it.collection) ? { note: note.trim() } : undefined;
      await invoke(`${it.collection}/${idOf(it.path)}`, verb, it.etag, body);
      toast({ title: verb === "approve" ? "Approved" : "Rejected", variant: "success" });
      setRejecting(null);
      setRejectNote("");
      // No approvals.reload() here: invoke() already invalidates the decided collection, which refreshes
      // the shared approvals provider without re-fetching all eight request collections.
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDeciding(null);
    }
  }

  // The org's own incorporation anniversary, announced in the Celebrations widget alongside the per-employee
  // feed (but NOT merged into `celebrations`, so the timeline is left untouched). Shown within the same 30-day
  // window as the rest and sorted in by proximity.
  const orgAnniv = useMemo(() => orgAnniversary(org.incorporation_date), [org.incorporation_date]);
  const celebRows = useMemo(() => {
    const rows = celebrations.map((c) => ({ org: false as const, in_days: c.in_days, c }));
    const merged: ({ org: false; in_days: number; c: Celebration } | { org: true; in_days: number; years: number })[] = [...rows];
    if (orgAnniv && orgAnniv.in_days <= 30) merged.push({ org: true, in_days: orgAnniv.in_days, years: orgAnniv.years });
    return merged.sort((a, b) => a.in_days - b.in_days).slice(0, 6);
  }, [celebrations, orgAnniv]);

  // Celebrations within the next 7 days (employee + org anniversary) + the very next one overall, used by the
  // StatCard. `celebRows` is already sorted by proximity, so its head is the soonest celebration.
  const celebsThisWeek = useMemo(
    () => celebRows.filter((r) => r.in_days <= CELEBRATION_WEEK_DAYS),
    [celebRows],
  );
  const nextCeleb = celebRows[0];
  const nextCelebLabel = nextCeleb ? (nextCeleb.org ? org.name : nextCeleb.c.name.split(" ")[0]) : null;

  // New joiners in the last 30 days (by start date).
  const newJoiners = useMemo(() => {
    const cutoff = addDaysYmd(today, -30);
    return employees.filter((e) => e.start_date && e.start_date >= cutoff && e.start_date <= today).length;
  }, [employees, today]);

  // The date 30 days out, used by the several "next 30 days" KPIs below. Both ends of every window below come
  // from the ORG's day: a UTC bound compared against an org-local `today` is a 29- or 31-day window depending on
  // which side of UTC the org sits, which is the failure the celebration window's note describes. Keyed on
  // `today` rather than `[]` so a tab left open overnight follows the org day instead of holding yesterday's
  // bound while `today` moves.
  const in30 = useMemo(() => addDaysYmd(today, 30), [today]);
  // Probations ending within the next 30 days - the window HR watches for confirm/extend decisions.
  const probationEnding = useMemo(
    () => employees.filter((e) => e.probation_end_date && e.probation_end_date >= today && e.probation_end_date <= in30).length,
    [employees, today, in30],
  );
  // Live onboarding/offboarding runs (ACTIVE), split so the hint can read "N onboarding · M exiting".
  const activeTransitions = useMemo(() => transitions.filter((t) => t.state === "ACTIVE"), [transitions]);
  const onboardingCount = useMemo(() => activeTransitions.filter((t) => t.kind === "onboarding").length, [activeTransitions]);
  // Open reqs + total openings across them (a req can have several seats).
  const openReqs = useMemo(() => reqs.filter((r) => (r.status ?? "").toLowerCase() === "open"), [reqs]);
  const openSeats = useMemo(() => openReqs.reduce((n, r) => n + (r.openings ?? 1), 0), [openReqs]);
  // Company expenses still awaiting an approval decision (distinct from personal reimbursements). The
  // awaiting state on the expense workflow is SUBMITTED (there is no "pending" state).
  const expensesPending = useMemo(() => expenses.filter((e) => (e.state ?? "").toUpperCase() === "SUBMITTED"), [expenses]);
  const expensesPendingAmount = useMemo(() => expensesPending.reduce((n, e) => n + (e.amount ?? 0), 0), [expensesPending]);
  // Statutory filings due (still pending) within 30 days; count any already past due for the hint.
  const complianceDue = useMemo(
    () => complianceEvents.filter((c) => c.status === "pending" && c.due_date <= in30),
    [complianceEvents, in30],
  );
  const complianceOverdue = useMemo(() => complianceDue.filter((c) => c.due_date < today).length, [complianceDue, today]);
  // Assets currently issued to people (of the whole inventory).
  const assetsAssigned = useMemo(() => assets.filter((a) => a.status === "assigned").length, [assets]);
  // Goals in flight (not_started or in_progress) and how many have slipped past their due date.
  const activeGoals = useMemo(() => goals.filter((g) => g.status === "not_started" || g.status === "in_progress"), [goals]);
  const goalsOverdue = useMemo(() => activeGoals.filter((g) => g.due_date && g.due_date < today).length, [activeGoals, today]);
  // Disbursed loans/advances with a balance still owed, plus the total outstanding for the hint.
  const outstandingLoans = useMemo(() => loans.filter((l) => l.status === "DISBURSED" && l.outstanding > 0), [loans]);
  const outstandingTotal = useMemo(() => outstandingLoans.reduce((n, l) => n + (l.outstanding ?? 0), 0), [outstandingLoans]);
  // Candidates still moving through the funnel (application status "active").
  const pipelineCount = useMemo(() => applications.filter((a) => a.status === "active").length, [applications]);
  // Interviews scheduled from now on, and how many fall on today (for the hint).
  const upcomingInterviews = useMemo(() => {
    const now = new Date().toISOString();
    return interviews.filter((i) => i.status === "scheduled" && (i.scheduled_start_time ?? "") >= now);
  }, [interviews]);
  const interviewsToday = useMemo(() => {
    const t = new Date().toDateString();
    return upcomingInterviews.filter((i) => i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === t).length;
  }, [upcomingInterviews]);
  // Referrals still live (not yet joined or rejected).
  const openReferrals = useMemo(() => referrals.filter((r) => r.status !== "joined" && r.status !== "rejected"), [referrals]);
  // Performance reviews not yet closed out (state before ACKNOWLEDGED).
  const openReviews = useMemo(() => reviews.filter((r) => r.state !== "ACKNOWLEDGED"), [reviews]);
  // Tax-saving declarations awaiting HR verification of the uploaded proof.
  const taxToVerify = useMemo(() => taxDeclarations.filter((d) => d.status === "DECLARED").length, [taxDeclarations]);
  // Background checks not yet resolved (still pending or running).
  const openBgChecks = useMemo(() => backgroundChecks.filter((c) => c.status === "pending" || c.status === "in_progress").length, [backgroundChecks]);
  // Suggestions the team hasn't responded to yet.
  const openSuggestions = useMemo(() => suggestions.filter((s) => s.status === "new" || s.status === "under_review").length, [suggestions]);
  // Active benefit enrollments (excludes explicit waivers).
  const enrolledBenefits = useMemo(() => benefitEnrollments.filter((e) => e.status === "enrolled").length, [benefitEnrollments]);
  // A card is "open" until it's delivered (deliver_time set). Board KPIs work off that.
  const openCards = useMemo(() => cards.filter((c) => !c.deliver_time), [cards]);
  const blockedCards = useMemo(() => openCards.filter((c) => c.blocked).length, [openCards]);
  const overdueCards = useMemo(() => openCards.filter((c) => c.due_date && c.due_date < today).length, [openCards, today]);
  const myOpenCards = useMemo(
    () => (me.employee_id ? openCards.filter((c) => c.assignee && idOf(c.assignee) === me.employee_id).length : 0),
    [openCards, me.employee_id],
  );
  // Expense budgets that have hit or exceeded their allocation (utilization >= 100, or a negative remaining).
  const budgetsOver = useMemo(
    () => budgets.filter((b) => (b.utilization ?? 0) >= 100 || (b.remaining ?? 0) < 0).length,
    [budgets],
  );
  // Statutory filings already past their due date and still not filed.
  const complianceOverdueCount = useMemo(
    () => complianceEvents.filter((c) => c.status === "pending" && c.due_date < today).length,
    [complianceEvents, today],
  );
  // Org policy docs that require the caller's acknowledgement and aren't signed yet.
  const policiesToSign = useMemo(() => orgDocuments.filter((d) => d.requires_ack && !d.acknowledged).length, [orgDocuments]);
  // Personal documents (IDs, visas, certificates) expiring within 30 days.
  const docsExpiring = useMemo(() => {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return personalDocuments.filter((d) => d.expire_time && d.expire_time >= now && d.expire_time <= cutoff).length;
  }, [personalDocuments]);
  // Employees currently working their notice period.
  const servingNotice = useMemo(() => noticePeriods.filter((n) => n.status === "serving").length, [noticePeriods]);
  // People on approved remote work spanning today.
  const remoteToday = useMemo(() => {
    const ids = new Set<string>();
    for (const r of remoteRequests) {
      if (r.state?.toUpperCase() === "APPROVED" && r.employee && r.start_date <= today && r.end_date >= today) ids.add(idOf(r.employee));
    }
    return ids.size;
  }, [remoteRequests, today]);
  // Hours logged on timesheets in the current week (Mon-Sun): the caller's OWN hours for the "For you" card,
  // and everyone-visible hours for the separate team card - a manager's team total must not masquerade as
  // their personal week.
  // The week is derived from `today`, which is the ORG's day - not from a fresh `new Date()`. The two halves
  // of this window used to come from different clocks: the upper bound was `todayStr()` and the lower was a
  // local-parts Date serialized with `toISOString()`, which is UTC. In IST that put Monday one day early, so
  // the count silently included the previous Sunday.
  const weekEntries = useMemo(() => {
    const monday = weekStartYmd(today);
    return timeEntries.filter((t) => t.date && t.date >= monday && t.date <= today);
  }, [timeEntries, today]);
  const myHoursWeek = useMemo(
    () => (me.employee_id ? weekEntries.filter((t) => t.employee && idOf(t.employee) === me.employee_id).reduce((n, t) => n + (t.hours ?? 0), 0) : 0),
    [weekEntries, me.employee_id],
  );
  const teamHoursWeek = useMemo(() => weekEntries.reduce((n, t) => n + (t.hours ?? 0), 0), [weekEntries]);

  // ---- Proactive / leading KPIs: due-soon windows and pending self-service actions, so you act ahead of the
  // deadline rather than after it. The date 7 days out bounds the "this week" windows.
  const in7 = useMemo(() => addDaysYmd(today, 7), [today]);
  // Open cards falling due within the next 7 days (not already overdue - that's a separate card).
  const cardsDueWeek = useMemo(() => openCards.filter((c) => c.due_date && c.due_date >= today && c.due_date <= in7).length, [openCards, today, in7]);
  // Statutory filings due within the next 7 days and not yet filed (not overdue).
  const complianceWeek = useMemo(
    () => complianceEvents.filter((c) => c.status === "pending" && c.due_date >= today && c.due_date <= in7).length,
    [complianceEvents, today, in7],
  );
  // Live review cycles with a self- or manager-review deadline inside the next 7 days.
  const reviewsDueSoon = useMemo(
    () => reviewCycles.filter((c) => c.state === "ACTIVE" && [c.self_due_date, c.manager_due_date].some((d) => d && d >= today && d <= in7)).length,
    [reviewCycles, today, in7],
  );
  // Outstanding onboarding/offboarding checklist items across live transitions.
  const onboardingTasksPending = useMemo(
    () => activeTransitions.reduce((n, t) => n + Math.max(0, (t.task_count ?? 0) - (t.done_count ?? 0)), 0),
    [activeTransitions],
  );
  // Generated letters/contracts awaiting the owner's e-signature.
  const lettersToSign = useMemo(() => personalDocuments.filter((d) => d.requires_signature && !d.signed_time).length, [personalDocuments]);
  // Offers extended to candidates and still awaiting their response.
  const offersPending = useMemo(() => offers.filter((o) => o.status === "extended").length, [offers]);
  // Draft time entries the caller still needs to submit (their own unsubmitted work).
  const timesheetsDraft = useMemo(
    () => (me.employee_id ? timeEntries.filter((t) => t.status === "DRAFT" && t.employee && idOf(t.employee) === me.employee_id).length : 0),
    [timeEntries, me.employee_id],
  );
  // Recurring expenses whose next occurrence falls within the next 7 days (raise them before they're due).
  const recurringExpensesDue = useMemo(
    () => expenses.filter((e) => e.recurring && e.next_occurrence_on && e.next_occurrence_on >= today && e.next_occurrence_on <= in7).length,
    [expenses, today, in7],
  );

  // ---- My-day derivations ----
  // The caller's own leave balances, named via the leave-types list, largest first.
  const myBalances = useMemo(() => {
    if (!me.employee_id) return [];
    const names = new Map(leaveTypes.map((t) => [idOf(t.path), t.display_name]));
    return leaveBalances
      .filter((b) => b.employee && idOf(b.employee) === me.employee_id)
      .map((b) => ({ name: (b.leave_type && names.get(idOf(b.leave_type))) || "Leave", days: b.balance_days }))
      .sort((a, b) => b.days - a.days)
      .slice(0, 3);
  }, [leaveBalances, leaveTypes, me.employee_id]);
  // The next payday from the pay-periods calendar.
  const nextPayday = useMemo(
    () => payPeriods.filter((p) => p.pay_date && p.pay_date >= today && !p.disabled && !p.delete_time).sort((a, b) => a.pay_date!.localeCompare(b.pay_date!))[0],
    [payPeriods, today],
  );
  // The caller's own next approved leave (running or upcoming).
  const myNextLeave = useMemo(
    () =>
      me.employee_id
        ? approved
            .filter((l) => l.employee && idOf(l.employee) === me.employee_id && l.end_date >= today)
            .sort((a, b) => a.start_date.localeCompare(b.start_date))[0]
        : undefined,
    [approved, me.employee_id, today],
  );
  // The caller's own live onboarding checklist (new joiners): their ACTIVE onboarding transition + open tasks.
  const myOnboarding = useMemo(
    () => (me.employee_id ? activeTransitions.find((t) => t.kind === "onboarding" && t.employee && idOf(t.employee) === me.employee_id) : undefined),
    [activeTransitions, me.employee_id],
  );
  const myOnboardingOpen = useMemo(() => (myOnboarding?.tasks ?? []).filter((t) => t.status !== "DONE"), [myOnboarding]);
  // Recent decisions on the caller's own requests (leave.approved, reimbursement.rejected, ...) - the
  // notifications feed already carries these, so this costs no extra read.
  const myOutcomes = useMemo(
    () => notifications.filter((n) => /\.(approved|rejected)$/.test(n.type ?? "")).slice(0, 4),
    [notifications],
  );
  // Assets handed to the caller that are still waiting for them to scan the tag. The number rides the summary
  // the page already fetches (scoped to their own rows server-side), so the ask costs no extra read.
  const myAssetsToConfirm = summary?.assets_pending_scan?.value ?? 0;
  const showMyDay = !!me.employee_id && (myBalances.length > 0 || !!nextPayday || !!myNextLeave || !!upcomingHolidays[0] || !!myOnboarding || myOutcomes.length > 0 || myAssetsToConfirm > 0);
  // WHICH my-day tiles exist is an answer from the data, so "no tiles" and "not read yet" look identical from
  // here. Placeholders hold the row until its own reads have settled - both while it waits to come into view
  // and while the reads it triggered are in flight - so the row never appears, vanishes and reappears.
  const myDayPending = !wantMyDay || balancesState === "loading" || payPeriodsState === "loading" || holidaysState === "loading";

  // Per-KPI card data keyed by KPI key. Label, icon and category all come from KPI_DEFS + KPI_ICONS (shared
  // with the Settings editor); `label` here overrides the config label only when the card wants a shorter
  // on-dashboard title. Rendered grouped into category bands below - see kpiBands.
  type KpiTone = "primary" | "success" | "warning" | "muted";
  type KpiDatum = { value: ReactNode; tone: KpiTone; hint?: ReactNode; label?: string; target?: AccessTargetRef; onClick?: () => void };
  // Effective KPI numbers: the summary's aggregate when it arrived, else the row-computed fallback. Cards
  // below read ONLY these, so they don't care which side did the counting.
  const openTicketsV = sv("open_tickets", openTickets);
  const expensesPendingV = sv("expenses_pending", expensesPending.length);
  const expensesPendingAmountV = sx("expenses_pending", expensesPendingAmount);
  const recurringDueV = sv("recurring_expenses_due", recurringExpensesDue);
  const complianceDueV = sv("compliance_due", complianceDue.length);
  const complianceDueOverdueV = sx("compliance_due", complianceOverdue);
  const complianceWeekV = sv("compliance_week", complianceWeek);
  const complianceOverdueV = sv("compliance_overdue", complianceOverdueCount);
  const assetsAssignedV = sv("assets_assigned", assetsAssigned);
  const assetsTotalV = sx("assets_assigned", assets.length);
  const goalsActiveV = sv("goals_active", activeGoals.length);
  const goalsOverdueV = sx("goals_active", goalsOverdue);
  const loansOutstandingV = sv("loans_outstanding", outstandingLoans.length);
  const loansTotalV = sx("loans_outstanding", outstandingTotal);
  const pipelineV = sv("candidates_pipeline", pipelineCount);
  const interviewsUpcomingV = sv("interviews_upcoming", upcomingInterviews.length);
  const interviewsTodayV = sx("interviews_upcoming", interviewsToday);
  const referralsOpenV = sv("referrals_open", openReferrals.length);
  const reviewsOpenV = sv("reviews_open", openReviews.length);
  const taxVerifyV = sv("tax_verify", taxToVerify);
  const bgChecksV = sv("bgchecks_open", openBgChecks);
  const suggestionsV = sv("suggestions_open", openSuggestions);
  const benefitsV = sv("benefits_enrolled", enrolledBenefits);
  const cardsBlockedV = sv("cards_blocked", blockedCards);
  const cardsOverdueV = sv("cards_overdue", overdueCards);
  const cardsDueWeekV = sv("cards_due_week", cardsDueWeek);
  const myOpenCardsV = sv("my_open_cards", myOpenCards);
  const noticeServingV = sv("notice_serving", servingNotice);
  const remoteTodayV = sv("remote_today", remoteToday);
  const timesheetsDraftV = sv("timesheets_draft", timesheetsDraft);
  const myHoursV = sv("timesheet_week", myHoursWeek);
  const teamHoursV = sv("team_hours_week", teamHoursWeek);
  const reviewsDueSoonV = sv("reviews_due_soon", reviewsDueSoon);
  const offersPendingV = sv("offers_pending", offersPending);
  const transitionsActiveV = sv("transitions_active", activeTransitions.length);
  const transitionsOnboardingV = sx("transitions_active", onboardingCount);
  const onbTasksV = sv("onboarding_tasks_pending", onboardingTasksPending);
  const openPositionsV = sv("open_positions", openReqs.length);
  const openSeatsV = sx("open_positions", openSeats);
  // The four directory/leave numbers the wall used to derive from loaded rows. Server-side they are scoped
  // COUNTs over the whole org; the row fallbacks behind them only run when the summary omitted the key.
  const headcountV = sv("headcount", employees.length);
  const joinersV = sv("joiners", newJoiners);
  const probationEndingV = sv("probation_ending", probationEnding);
  const onLeaveV = sv("on_leave", onLeaveToday);
  const people = `${headcountV} ${headcountV === 1 ? "person" : "people"}`;
  // How many people are unaccounted for right now: not clocked in, not on approved leave, not on approved
  // remote work. On an org holiday nobody is expected in, so the card reads 0 with a holiday hint. The
  // denominator is the org's headcount, not the page of employees this browser happens to have loaded.
  const notClockedIn = isHolidayToday ? 0 : Math.max(0, headcountV - clockedIn - onLeaveV - remoteTodayV);
  const kpiData: Record<string, KpiDatum> = {
    // --- For you (the caller's own items) ---
    docs_to_ack: { value: policiesToSign, tone: policiesToSign > 0 ? "warning" : "muted", hint: policiesToSign === 0 ? "All acknowledged" : "Needs your signature", target: { collection: "org-documents", label: "Org documents" }, onClick: () => navigate("documents") },
    letters_to_sign: { value: lettersToSign, tone: lettersToSign > 0 ? "primary" : "muted", hint: lettersToSign === 0 ? "Nothing to sign" : "Awaiting e-signature", target: { collection: "personal-documents", label: "Personal documents" }, onClick: () => navigate("documents") },
    timesheets_draft: { value: timesheetsDraftV, tone: timesheetsDraftV > 0 ? "primary" : "muted", hint: timesheetsDraftV === 0 ? "Nothing in draft" : "Submit for approval", target: { collection: "time-entries", label: "Time entries" }, onClick: () => navigate("timesheets") },
    my_open_cards: { value: myOpenCardsV, tone: myOpenCardsV > 0 ? "primary" : "muted", hint: myOpenCardsV === 0 ? "All done" : "Assigned to you", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    timesheet_week: { value: Math.round(myHoursV * 10) / 10, tone: myHoursV > 0 ? "primary" : "muted", hint: "by you this week", target: { collection: "time-entries", label: "Time entries" }, onClick: () => navigate("timesheets") },
    // --- Needs attention ---
    pending: isApprover
      // Approvers: the full cross-type approvals queue (same number as the sidebar badge), not just leave.
      // "Oldest waiting" reads `approvalItems[0]`, which only holds the queues this page fetches - so with a
      // non-zero total and no loaded rows (a count made up of expenses or asset requests, or a queue still in
      // flight) it rendered "Oldest waiting 0d". Say where the items are instead.
      ? { label: "Pending approvals", value: approvals.total, tone: approvals.total > 0 ? "warning" : "muted", hint: approvals.total === 0 ? "All clear" : approvalItems.length === 0 ? "In the approvals inbox" : `Oldest waiting ${oldestPendingDays}d`, target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("approvals") }
      : { label: "My pending leave", value: pending.length, tone: pending.length > 0 ? "warning" : "muted", hint: pending.length === 0 ? "All clear" : "Awaiting decision", target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("leave-requests") },
    open_tickets: { label: "Open tickets", value: openTicketsV, tone: openTicketsV > 0 ? "warning" : "muted", hint: openTicketsV === 0 ? "All clear" : "Awaiting resolution", target: { collection: "tickets", label: "Support tickets" }, onClick: () => navigate("tickets") },
    expenses_pending: { value: expensesPendingV, tone: expensesPendingV > 0 ? "warning" : "muted", hint: expensesPendingV === 0 ? "All clear" : money(expensesPendingAmountV), target: { collection: "expenses", label: "Expenses" }, onClick: () => navigateFiltered("expenses", "expenses", { state: "SUBMITTED" }) },
    cards_blocked: { value: cardsBlockedV, tone: cardsBlockedV > 0 ? "warning" : "muted", hint: cardsBlockedV === 0 ? "Nothing blocked" : "Needs unblocking", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    cards_overdue: { value: cardsOverdueV, tone: cardsOverdueV > 0 ? "warning" : "muted", hint: cardsOverdueV === 0 ? "On track" : "Past due date", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    budget_over: { value: budgetsOver, tone: budgetsOver > 0 ? "warning" : "muted", hint: budgetsOver === 0 ? "All within budget" : `of ${budgets.length} ${budgets.length === 1 ? "budget" : "budgets"}`, target: { collection: "expense-budgets", label: "Expense budgets" }, onClick: () => navigate("expense-budgets") },
    compliance_overdue: { value: complianceOverdueV, tone: complianceOverdueV > 0 ? "warning" : "muted", hint: complianceOverdueV === 0 ? "Nothing overdue" : "Past due, not filed", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigateFiltered("compliance", "compliance-events", { status: "Overdue" }) },
    tax_verify: { value: taxVerifyV, tone: taxVerifyV > 0 ? "warning" : "muted", hint: taxVerifyV === 0 ? "All clear" : "Needs verifying", target: { collection: "tax-declarations", label: "Tax declarations" }, onClick: () => navigate("tax-declarations?focus=awaiting") },
    bgchecks_open: { label: "Background checks", value: bgChecksV, tone: bgChecksV > 0 ? "warning" : "muted", hint: bgChecksV === 0 ? "None open" : "Pending or running", target: { collection: "background-checks", label: "Background checks" }, onClick: () => navigate("background-checks?focus=open") },
    suggestions_open: { value: suggestionsV, tone: suggestionsV > 0 ? "warning" : "muted", hint: suggestionsV === 0 ? "All answered" : "Awaiting a reply", target: { collection: "suggestions", label: "Suggestions" }, onClick: () => navigate("suggestions") },
    docs_expiring: { label: "Documents expiring", value: docsExpiring, tone: docsExpiring > 0 ? "warning" : "muted", hint: docsExpiring === 0 ? "None in 30 days" : "Within 30 days", target: { collection: "personal-documents", label: "Personal documents" }, onClick: () => navigate("documents") },
    probation_ending: { label: "Probation ending", value: probationEndingV, tone: probationEndingV > 0 ? "warning" : "muted", hint: probationEndingV === 0 ? "None in 30 days" : "Confirm or extend", target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    notice_serving: { value: noticeServingV, tone: noticeServingV > 0 ? "warning" : "muted", hint: noticeServingV === 0 ? "None exiting" : "Working notice", target: { collection: "notice-periods", label: "Notice periods" }, onClick: () => navigateFiltered("notice-periods", "notice-periods", { status: "serving" }) },
    // --- Coming up (leading; toned neutral-to-primary - a runway window is not a breach) ---
    ...(canEvents ? { events_upcoming: { value: upcomingEvents.length, tone: upcomingEvents.length > 0 ? "primary" : "muted", hint: upcomingEvents[0] ? (eventsToday > 0 ? `${eventsToday} today` : `Next: ${relativeDay((upcomingEvents[0].start_time ?? "").slice(0, 10))}`) : "None in 7 days", target: { collection: "events", label: "Events" }, onClick: () => navigate("events?focus=upcoming") } } : {}),
    compliance_due: { label: "Compliance due", value: complianceDueV, tone: complianceDueOverdueV > 0 ? "warning" : complianceDueV > 0 ? "primary" : "muted", hint: complianceDueV === 0 ? "None in 30 days" : complianceDueOverdueV > 0 ? `${complianceDueOverdueV} overdue` : "Within 30 days", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigate("compliance") },
    compliance_week: { value: complianceWeekV, tone: complianceWeekV > 0 ? "primary" : "muted", hint: complianceWeekV === 0 ? "Nothing due soon" : "File before due", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigate("compliance?focus=dueSoon") },
    cards_due_week: { value: cardsDueWeekV, tone: cardsDueWeekV > 0 ? "primary" : "muted", hint: cardsDueWeekV === 0 ? "Nothing due soon" : "Plan ahead", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    reviews_due_soon: { value: reviewsDueSoonV, tone: reviewsDueSoonV > 0 ? "primary" : "muted", hint: reviewsDueSoonV === 0 ? "None due this week" : "Wrap up before due", target: { collection: "reviews", label: "Reviews" }, onClick: () => navigate("reviews") },
    interviews_upcoming: { value: interviewsUpcomingV, tone: interviewsUpcomingV > 0 ? "primary" : "muted", hint: interviewsUpcomingV === 0 ? "None scheduled" : interviewsTodayV > 0 ? `${interviewsTodayV} today` : "Upcoming", target: { collection: "interviews", label: "Interviews" }, onClick: () => navigate("interviews?focus=scheduled") },
    onboarding_tasks_pending: { value: onbTasksV, tone: onbTasksV > 0 ? "primary" : "muted", hint: onbTasksV === 0 ? "All checklists done" : transitionsActiveV > 0 ? `in ${transitionsActiveV} ${transitionsActiveV === 1 ? "transition" : "transitions"}` : "Open checklist items", target: { collection: "transitions", label: "Transitions" }, onClick: () => navigate("transitions") },
    offers_pending: { value: offersPendingV, tone: offersPendingV > 0 ? "primary" : "muted", hint: offersPendingV === 0 ? "None outstanding" : "Chase candidates", target: { collection: "offers", label: "Offers" }, onClick: () => navigate("offers?focus=extended") },
    recurring_expenses_due: { value: recurringDueV, tone: recurringDueV > 0 ? "primary" : "muted", hint: recurringDueV === 0 ? "Nothing due soon" : "Raise before due", target: { collection: "expenses", label: "Expenses" }, onClick: () => navigate("expenses") },
    // --- At a glance (snapshot) ---
    on_leave: { value: onLeaveV, tone: onLeaveV > 0 ? "primary" : "muted", hint: `of ${people}`, target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("leave-requests") },
    clocked_in: { value: clockedIn, tone: clockedIn > 0 ? "success" : "muted", hint: "On the clock now", target: { collection: "attendance", label: "Attendance" }, onClick: () => navigate("attendance") },
    not_clocked_in: { value: notClockedIn, tone: "muted", hint: isHolidayToday ? "Holiday today" : "excl. leave & remote", target: { collection: "attendance", label: "Attendance" }, onClick: () => navigate("attendance") },
    remote_today: { value: remoteTodayV, tone: remoteTodayV > 0 ? "primary" : "muted", hint: `of ${people}`, target: { collection: "remote-work-requests", label: "Remote work" }, onClick: () => navigate("remote-work") },
    celebrations: { value: celebsThisWeek.length, tone: celebsThisWeek.length > 0 ? "success" : "muted", hint: nextCeleb ? `Next: ${nextCelebLabel}` : "None this week", target: { collection: "employees", label: "Celebrations (employee data)" }, onClick: () => document.getElementById("dash-celebrations")?.scrollIntoView({ behavior: "smooth", block: "center" }) },
    joiners: { value: joinersV, tone: joinersV > 0 ? "primary" : "muted", hint: `${headcountV} total ${headcountV === 1 ? "employee" : "employees"}`, target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    headcount: { value: headcountV, tone: "primary", hint: "across the org", target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    transitions_active: { value: transitionsActiveV, tone: transitionsActiveV > 0 ? "primary" : "muted", hint: transitionsActiveV === 0 ? "Nothing in progress" : `${transitionsOnboardingV} joining · ${transitionsActiveV - transitionsOnboardingV} exiting`, target: { collection: "transitions", label: "Transitions" }, onClick: () => navigate("transitions") },
    open_positions: { value: openPositionsV, tone: openPositionsV > 0 ? "primary" : "muted", hint: openPositionsV === 0 ? "No open reqs" : `${openSeatsV} seat${openSeatsV === 1 ? "" : "s"} to fill`, target: { collection: "job-requisitions", label: "Job requisitions" }, onClick: () => navigate("job-requisitions?focus=open") },
    candidates_pipeline: { value: pipelineV, tone: pipelineV > 0 ? "primary" : "muted", hint: pipelineV === 0 ? "Pipeline empty" : "Active applications", target: { collection: "applications", label: "Applications" }, onClick: () => navigate("pipeline?focus=active") },
    referrals_open: { value: referralsOpenV, tone: referralsOpenV > 0 ? "primary" : "muted", hint: referralsOpenV === 0 ? "None in flight" : "In progress", target: { collection: "referrals", label: "Referrals" }, onClick: () => navigate("referrals?focus=progress") },
    reviews_open: { value: reviewsOpenV, tone: reviewsOpenV > 0 ? "primary" : "muted", hint: reviewsOpenV === 0 ? "All closed out" : "Not yet acknowledged", target: { collection: "reviews", label: "Reviews" }, onClick: () => navigate("reviews") },
    assets_assigned: { value: assetsAssignedV, tone: assetsAssignedV > 0 ? "primary" : "muted", hint: `of ${assetsTotalV} total`, target: { collection: "assets", label: "Assets" }, onClick: () => navigate("assets") },
    goals_active: { value: goalsActiveV, tone: goalsOverdueV > 0 ? "warning" : goalsActiveV > 0 ? "primary" : "muted", hint: goalsActiveV === 0 ? "None in flight" : goalsOverdueV > 0 ? `${goalsOverdueV} past due` : "In progress", target: { collection: "goals", label: "Goals" }, onClick: () => navigate("goals") },
    loans_outstanding: { value: loansOutstandingV, tone: loansOutstandingV > 0 ? "primary" : "muted", hint: loansOutstandingV === 0 ? "Nothing owed" : money(loansTotalV), target: { collection: "loans", label: "Loans" }, onClick: () => navigate("loans") },
    benefits_enrolled: { value: benefitsV, tone: benefitsV > 0 ? "primary" : "muted", hint: `across ${people}`, target: { collection: "benefit-enrollments", label: "Benefit enrollments" }, onClick: () => navigate("benefits") },
    team_hours_week: { value: Math.round(teamHoursV * 10) / 10, tone: teamHoursV > 0 ? "primary" : "muted", hint: "across your team", target: { collection: "time-entries", label: "Time entries" }, onClick: () => navigate("timesheets") },
  };
  // Group the visible cards into their category bands (band order from KPI_CATEGORIES). A card shows only if
  // the viewer may see it, the org hasn't switched its whole category off (hiddenKpiCategories), and the
  // viewer hasn't personally hidden it.
  const hiddenCats = new Set(dashCfg.hiddenKpiCategories ?? []);
  // An "all-clear" card is a zero with nothing to say (muted tone). Informative muted cards (e.g. a non-zero
  // "Not clocked in") never match, so the declutter toggle only ever drops true zeros.
  const isAllClear = (d: KpiDatum) => d.tone === "muted" && typeof d.value === "number" && d.value === 0;
  // Cards with live signal sort before all-clear zeros within each band (stable within each group), so the
  // problems cluster at the top-left instead of interleaving with quiet cards.
  const bySeverity = (a: { key: string }, b: { key: string }) => Number(isAllClear(kpiData[a.key]!)) - Number(isAllClear(kpiData[b.key]!));
  const allBands = KPI_CATEGORIES
    .filter((cat) => !hiddenCats.has(cat.key))
    .map((cat) => ({ cat, defs: KPI_DEFS.filter((d) => d.category === cat.key && kpiData[d.key] && kpiVisible(d.key) && !hiddenKpis.has(d.key)).sort(bySeverity) }))
    .filter((b) => b.defs.length > 0);
  // Personally hidden cards the viewer WOULD otherwise see (for the "restore" affordance).
  const personallyHidden = KPI_DEFS.filter((d) => hiddenKpis.has(d.key) && kpiData[d.key] && kpiVisible(d.key) && !hiddenCats.has(d.category)).length;
  const allClearCount = allBands.reduce((n, b) => n + b.defs.filter((d) => isAllClear(kpiData[d.key]!)).length, 0);
  const declutteredBands = hideClear
    ? allBands.map((b) => ({ ...b, defs: b.defs.filter((d) => !isAllClear(kpiData[d.key]!)) })).filter((b) => b.defs.length > 0)
    : allBands;
  // Pinned cards float to a leading group in the grid regardless of band (their accent still shows the band).
  const pinnedDefs = declutteredBands.flatMap(({ cat, defs }) => defs.filter((d) => pinnedKpis.has(d.key)).map((d) => ({ cat, d })));
  // Snapshot renders as a compact strip, not full cards, so the two action bands own the visual space. A
  // PINNED snapshot card is promoted into the pinned card group - pinning is "make this big and first".
  const kpiBands = declutteredBands.map((b) => ({ ...b, defs: b.defs.filter((d) => !pinnedKpis.has(d.key)) })).filter((b) => b.defs.length > 0);
  const cardBands = kpiBands.filter(({ cat }) => cat.key !== "snapshot");
  const snapshotDefs = kpiBands.find(({ cat }) => cat.key === "snapshot")?.defs ?? [];

  // Personal greeting: time-of-day salutation + the caller's real first name (directory record), falling
  // back to a humanized email local part for logins without a linked employee.
  // The dashboard's shortcut tiles: the org's chosen mix of create flows and destinations, in its order,
  // gated to what this caller can use (Settings → Dashboard → Shortcuts). Empty = the row is switched off.
  const shortcuts = useMemo(() => resolveDashboardShortcuts(me, dashCfg.shortcuts), [me, dashCfg.shortcuts]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName =
    selfEmp?.first_name ||
    (me.email.split("@")[0] ?? me.email)
      .replace(/[._-]+/g, " ")
      .split(" ")[0]
      .replace(/^\w/, (c) => c.toUpperCase());
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // The team timeline is heavy (14 days x every visible employee of attendance), so on phones it stays
  // collapsed until asked for - and the choice sticks via the same personal prefs row.
  const isMobile = useMedia("(max-width: 767px)");
  const timelineOpen = !isMobile || !!prefs.timelineOpen;

  return (
    <div>
      {/* Greeting hero: salutation + date on the left, the clock-in/out control on the right. */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">{todayLabel}</p>
            <PageSettings me={me} host="dashboard" />
            {/* Personal layout: reorder or switch off whole sections; persists per user (cross-device). */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" title="Customize layout" aria-label="Customize dashboard layout">
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2">
                <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dashboard layout</p>
                <div className="space-y-0.5">
                  {sectionOrderResolved.map((k, i) => {
                    const def = DASH_SECTIONS.find((s) => s.key === k)!;
                    const hidden = hiddenSections.has(k);
                    return (
                      <div key={k} className={cn("flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent/50", hidden && "opacity-50")}>
                        <span className="flex-1 truncate text-sm">{def.label}</span>
                        {/* Reordering the dashboard is a phone-friendly job (it is where the layout matters
                            most), so these three keep a real target on touch. */}
                        <Button variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" disabled={i === 0} onClick={() => moveSection(k, -1)} aria-label={`Move ${def.label} up`}>
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" disabled={i === sectionOrderResolved.length - 1} onClick={() => moveSection(k, 1)} aria-label={`Move ${def.label} down`}>
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" onClick={() => toggleSection(k)} aria-label={hidden ? `Show ${def.label}` : `Hide ${def.label}`} title={hidden ? "Show" : "Hide"}>
                          {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {layoutCustomized && (
                  <Button variant="ghost" size="sm" className="mt-1 w-full justify-start text-muted-foreground" onClick={() => updatePrefs({ sectionOrder: [], hiddenSections: [] })}>
                    <RotateCcw className="h-3.5 w-3.5" /> Reset layout
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          </div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-foreground">
            {greeting}, {firstName}
          </h1>
          {/* One-line day summary: what's waiting on you, who's away, what's next on the calendar. Renders
              only the parts that apply, so quiet days show nothing rather than a row of zeros. */}
          {(approvals.total > 0 || onLeaveToday > 0 || upcomingHolidays[0]) && (
            <p className="mt-1 text-sm text-muted-foreground">
              {[
                approvals.total > 0 ? `${approvals.total} approval${approvals.total === 1 ? "" : "s"} waiting on you` : null,
                onLeaveToday > 0 ? `${onLeaveToday} ${onLeaveToday === 1 ? "person" : "people"} away today` : null,
                upcomingHolidays[0] ? `${upcomingHolidays[0].display_name} ${relativeDay(upcomingHolidays[0].date).toLowerCase()}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
        <div className="w-full lg:w-[480px]">
          <ClockWidget onClockChange={onClockChange} />
        </div>
      </div>

      {/* Movable sections: a flex column ordered by the viewer's saved layout (CSS `order`, so a reorder is
          visual-only and nothing remounts). A hidden section renders nothing at all - hiding the timeline
          also skips its attendance fan-out. */}
      <div className="flex flex-col">

      {/* Shortcut tiles: the org's own pick of create flows and destinations (Settings → Dashboard →
          Shortcuts), capability-gated per caller. They lead the page - a dashboard's first job is "do the
          thing I came here for". Nothing configured for this person = no row at all. */}
      {showSection("shortcuts") && shortcuts.length > 0 && (
        <StatRow caps={ACTION_CAPS} gap={{ base: "0.75rem" }} style={sectionStyle("shortcuts")} className="mb-6">
          {shortcuts.map((s) => (
            <QuickAction key={s.id} label={s.label} icon={s.icon} onClick={s.run} />
          ))}
        </StatRow>
      )}

      {/* My day: the caller's own numbers - leave balance, payday, next time off, onboarding checklist and
          recent decisions on their requests. Self-scoped data only; hidden for logins with no employee.
          Which tiles there are is itself an answer from the data, so until the reads have happened the row
          holds its slot with placeholders - a probe with no height would sit at the top of the page and read as
          "in view" whatever the reader is actually looking at. */}
      {showSection("myday") && !!me.employee_id && myDayPending && (
        <StatRow ref={regionRef("myday")} caps={TILE_CAPS} gap={{ base: "1rem" }} style={sectionStyle("myday")} className="mb-6">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
        </StatRow>
      )}
      {/* Which tiles exist is data (a tile appears only when it has something to say), so the row is split
          into balanced rows rather than poured into fixed columns - five tiles are 3+2, never 4-and-a-hole. */}
      {showSection("myday") && !myDayPending && showMyDay && (
        <StatRow caps={TILE_CAPS} gap={{ base: "1rem" }} style={sectionStyle("myday")} className="mb-6">
          {myBalances.length > 0 && (
            <MyDayTile icon={Plane} title="Leave balance" target={{ collection: "leave-balances", label: "Leave balances" }} onClick={() => navigate("leave-requests")}>
              <div className="space-y-1">
                {myBalances.map((b) => (
                  <div key={b.name} className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">{b.name}</span>
                    <span className="text-sm font-semibold tabular-nums">{Math.round(b.days * 10) / 10}<span className="ml-1 text-xs font-normal text-muted-foreground">d</span></span>
                  </div>
                ))}
              </div>
            </MyDayTile>
          )}
          {nextPayday && (
            <MyDayTile icon={Banknote} title="Next payday" target={{ collection: "pay-periods", label: "Pay periods" }} onClick={() => navigate("payslips")}>
              <p className="text-lg font-semibold">{formatDate(nextPayday.pay_date)}</p>
              <p className="text-xs text-muted-foreground">{relativeDay(nextPayday.pay_date!)}{nextPayday.display_name ? ` · ${nextPayday.display_name}` : ""}</p>
            </MyDayTile>
          )}
          {(myNextLeave || upcomingHolidays[0]) && (
            <MyDayTile icon={CalendarDays} title="Time off ahead" target={{ collection: "leave-requests", label: "Leave requests" }} onClick={() => navigate("leave-requests")}>
              {myNextLeave ? (
                <>
                  <p className="text-sm font-semibold">{formatDate(myNextLeave.start_date)}{myNextLeave.end_date !== myNextLeave.start_date ? ` to ${formatDate(myNextLeave.end_date)}` : ""}</p>
                  <p className="text-xs text-muted-foreground">Your approved leave · {relativeDay(myNextLeave.start_date)}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">{upcomingHolidays[0]!.display_name}</p>
                  <p className="text-xs text-muted-foreground">Next holiday · {relativeDay(upcomingHolidays[0]!.date)}</p>
                </>
              )}
            </MyDayTile>
          )}
          {myOnboarding && (
            <MyDayTile icon={ListTodo} title="Your onboarding" target={{ collection: "transitions", label: "Transitions" }}>
              <p className="text-sm font-semibold tabular-nums">{myOnboarding.done_count ?? 0}/{myOnboarding.task_count ?? 0} tasks done</p>
              {myOnboardingOpen[0] && <p className="truncate text-xs text-muted-foreground">Next: {myOnboardingOpen[0].title}</p>}
            </MyDayTile>
          )}
          {myAssetsToConfirm > 0 && (
            <MyDayTile icon={ScanLine} title="Confirm an asset" target={{ collection: "assets", label: "Assets" }} onClick={() => navigate("assets")}>
              <p className="text-sm font-semibold tabular-nums">{myAssetsToConfirm} waiting for you</p>
              <p className="text-xs text-muted-foreground">Scan its tag to confirm you have it</p>
            </MyDayTile>
          )}
          {myOutcomes.length > 0 && (
            <MyDayTile icon={BellRing} title="Recent decisions" target={{ collection: "notifications", label: "Notifications" }} onClick={() => navigate("notifications")}>
              <div className="space-y-1">
                {myOutcomes.slice(0, 3).map((n) => (
                  <div key={n.path} className="flex items-center justify-between gap-2">
                    <span className={cn("truncate text-xs", n.type?.endsWith(".approved") ? "text-success" : "text-destructive")}>{n.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(n.create_time)}</span>
                  </div>
                ))}
              </div>
            </MyDayTile>
          )}
        </StatRow>
      )}

      {/* KPIs render in ONE dense grid so rows always fill (separate per-band grids left ragged last rows).
          Cards are ordered by band and carry a category-colored left accent; the legend pills above name each band,
          show its count, and double as a focus filter (click to show only that band). Snapshot cards render as a
          compact strip below the grid. Org visibility in Settings; pin/hide are the viewer's own. */}
      {/* First-paint skeleton, which doubles as the wall's probe: until this grid has been in view the wall's
          collections are not read at all. Once they are, the wall waits for the aggregate counts, and for the
          directory only if it turned out to need the rows - a wall answered entirely by counts must NOT wait
          on a read that will never happen. Cached revisits settle immediately and skip straight to the real
          cards - no flash. */}
      {showSection("kpis") && (!wantKpis || summaryState === "loading" || (readEmployees && employeesState === "loading") ? (
        <StatRow ref={regionRef("kpis")} caps={CARD_CAPS} gap={{ base: "1rem" }} style={sectionStyle("kpis")} className="mb-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-14" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-10 w-10 rounded-lg" />
              </div>
            </Card>
          ))}
        </StatRow>
      ) : allBands.length > 0 && (
        <div style={sectionStyle("kpis")} className="mb-6 space-y-3">
          {/* The category filters scroll as one row on a phone rather than wrapping to three - the KPI cards
              they filter are what the dashboard is for, and they should not start below the fold. */}
          <div className="scroll-shadow-x no-scrollbar -mx-1 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            {kpiBands.map(({ cat, defs }) => {
              const CatIcon = CATEGORY_ICONS[cat.key];
              const active = catFilter === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setCatFilter(active ? null : cat.key)}
                  title={cat.blurb}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                    active ? "border-transparent bg-foreground text-background" : "hover:bg-accent",
                    !active && catFilter !== null && "opacity-50",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", CAT_DOT[cat.key])} aria-hidden />
                  <CatIcon className="h-3.5 w-3.5" />
                  {cat.label}
                  <span className={cn("rounded-full px-1.5 tabular-nums", active ? "bg-background/20" : "bg-muted text-muted-foreground")}>{defs.length}</span>
                </button>
              );
            })}
            {catFilter && (
              <button type="button" onClick={() => setCatFilter(null)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">Show all</button>
            )}
            {personallyHidden > 0 && (
              <button
                type="button"
                onClick={() => updatePrefs({ hiddenKpis: [] })}
                title="Restore the cards you hid"
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent coarse:min-h-9 coarse:px-3.5"
              >
                <Eye className="h-3.5 w-3.5" />
                Show {personallyHidden} hidden
              </button>
            )}
            {(allClearCount > 0 || hideClear) && (
              <button
                type="button"
                onClick={toggleHideClear}
                aria-pressed={hideClear}
                title="Hide zero-valued cards with nothing needing attention"
                className={cn(
                  "ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                  hideClear ? "border-transparent bg-foreground text-background" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <EyeOff className="h-3.5 w-3.5" />
                {hideClear ? `${allClearCount} all-clear hidden` : "Hide all-clear"}
              </button>
            )}
          </div>
          {kpiBands.length > 0 || pinnedDefs.length > 0 ? (
            <>
              {(pinnedDefs.length > 0 || cardBands.length > 0) && (
                // Two across on a phone. One per row put eight full-width cards - eight screens of scrolling -
                // between the user and everything the dashboard is actually for; the card is built to be read
                // at half width (see StatCard). Three across on a tablet: without the `md` step it stayed at
                // two there and left a third of the row empty. How many cards there are is the viewer's own
                // (pins, hides, all-clear, the band filter), so the rows are balanced rather than poured into
                // four columns - eleven cards are 4+4+3 and not 4+4+2-and-a-hole.
                <StatRow caps={CARD_CAPS} gap={{ base: "0.75rem", sm: "1rem" }}>
                  {pinnedDefs
                    .filter(({ cat }) => !catFilter || cat.key === catFilter)
                    .map(({ cat, d }) => {
                      const c = kpiData[d.key]!;
                      return (
                        <StatCard key={d.key} label={c.label ?? d.label} value={c.value} icon={KPI_ICONS[d.key]!} tone={c.tone} hint={c.hint} target={c.target} onClick={c.onClick} accentClass={CAT_ACCENT[cat.key]} pinned onPin={() => togglePin(d.key)} onHide={() => hideKpi(d.key)} />
                      );
                    })}
                  {cardBands
                    .filter(({ cat }) => !catFilter || cat.key === catFilter)
                    .flatMap(({ cat, defs }) =>
                      defs.map((d) => {
                        const c = kpiData[d.key]!;
                        return (
                          <StatCard key={d.key} label={c.label ?? d.label} value={c.value} icon={KPI_ICONS[d.key]!} tone={c.tone} hint={c.hint} target={c.target} onClick={c.onClick} accentClass={CAT_ACCENT[cat.key]} onPin={() => togglePin(d.key)} onHide={() => hideKpi(d.key)} />
                        );
                      }),
                    )}
                </StatRow>
              )}
              {/* At-a-glance strip: snapshot numbers as one compact row instead of a wall of cards. */}
              {snapshotDefs.length > 0 && (!catFilter || catFilter === "snapshot") && (
                <Card className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    {snapshotDefs.map((d) => {
                      const c = kpiData[d.key]!;
                      const Icon = KPI_ICONS[d.key]!;
                      return (
                        <span key={d.key} className="group/mini inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={c.onClick}
                            disabled={!c.onClick}
                            className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
                          >
                            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm font-semibold tabular-nums">{c.value}</span>
                            <span className="text-xs text-muted-foreground">{c.label ?? d.label}</span>
                          </button>
                          {c.target && <AccessTarget target={c.target} />}
                          <button
                            type="button"
                            onClick={() => togglePin(d.key)}
                            title="Pin as a card"
                            aria-label={`Pin ${c.label ?? d.label}`}
                            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/mini:opacity-100"
                          >
                            <Pin className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => hideKpi(d.key)}
                            title="Hide for me"
                            aria-label={`Hide ${c.label ?? d.label}`}
                            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/mini:opacity-100"
                          >
                            <EyeOff className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </Card>
              )}
            </>
          ) : (
            <p className="rounded-xl border border-dashed py-6 text-center text-sm text-muted-foreground">
              Everything is all clear. Nothing needs your attention right now.
            </p>
          )}
        </div>
      ))}

      {/* Needs-you first: everything awaiting the caller's decision, across every request type, oldest first,
          with one-click approve and a confirm-first reject right here. */}
      {/* Awaiting-your-decision rows come from the shared approvals provider (count first, then rows only for
          the queues the count says are non-empty), so this card has nothing of its own to defer. Its probe is
          here for the sake of the NAMES on those rows, which come from the directory. */}
      {/* Gated on the rows this card actually HAS, not on `approvals.total`. The total is the server count
          across every queue the caller may decide in, including the three the dashboard deliberately does not
          read (company expenses, asset requests, tax verifications - decided on their own pages). Gating on it
          gave a manager whose only pending items were expenses a card headed "Awaiting your approval · 3" with
          no rows under it and nothing to explain the emptiness. The total still appears, as the badge and as
          the "more in the inbox" line, which is where a number the card cannot show belongs. */}
      {showSection("approvals") && approvalItems.length > 0 && (
        <Card ref={regionRef("approvals")} style={sectionStyle("approvals")} className="mb-6 border-warning/40">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarCheck className="h-4 w-4 text-warning" /> Awaiting your approval
              <span className="rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-foreground">{approvalsAwaiting}</span>
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("approvals")}>
              Review all <ArrowRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {approvalItems.slice(0, 5).map((it) => {
                const who = it.employee ? employees.find((e) => idOf(e.path) === idOf(it.employee!)) : undefined;
                const waited = it.when ? Math.max(0, Math.floor((Date.now() - new Date(it.when).getTime()) / 86_400_000)) : 0;
                const busy = deciding === it.path;
                return (
                  <div key={it.path} className="flex w-full items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <button type="button" onClick={() => navigate("approvals")} className="flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-80">
                      <PhotoAvatar employeeId={it.employee ? idOf(it.employee) : ""} name={who ? `${who.first_name} ${who.last_name}` : "Someone"} photo={who?.photo} className="h-8 w-8 shrink-0" />
                      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                        <span className="truncate">
                          <span className="font-medium">{who ? `${who.first_name} ${who.last_name}` : "Someone"}</span>
                          <span className="text-muted-foreground"> · {it.desc}</span>
                        </span>
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{it.kind}</span>
                      </span>
                      <span className={`shrink-0 text-xs ${waited >= 7 ? "font-medium text-warning" : "text-muted-foreground"}`}>
                        {waited === 0 ? "Today" : `Waiting ${waited} day${waited === 1 ? "" : "s"}`}
                      </span>
                    </button>
                    {/* Inline decision, following the row's own access.can exactly like the Approvals inbox. */}
                    <span className="flex shrink-0 items-center gap-1">
                      {it.can.includes("approve") && (
                        <AccessAction collection={it.collection} objectPath={it.path} verb="approve" can={it.can} label="Approve">
                          <Button size="sm" variant="success" loading={busy} onClick={() => decideInline(it, "approve")} aria-label={`Approve ${it.kind.toLowerCase()}`}>
                            <Check className="h-4 w-4" />
                          </Button>
                        </AccessAction>
                      )}
                      {it.can.includes("reject") && (
                        <AccessAction collection={it.collection} objectPath={it.path} verb="reject" can={it.can} label="Reject">
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => { setRejecting(it); setRejectNote(""); }} aria-label={`Reject ${it.kind.toLowerCase()}`}>
                            <X className="h-4 w-4" />
                          </Button>
                        </AccessAction>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {approvalsAwaiting > Math.min(5, approvalItems.length) && (
              <p className="mt-2 text-xs text-muted-foreground">
                And {approvalsAwaiting - Math.min(5, approvalItems.length)} more in the approvals inbox.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reject confirmation: prevents an accidental one-click reject and, where the collection supports it,
          carries an optional note to the requester. */}
      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) setRejecting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this {rejecting?.kind.toLowerCase()}?</DialogTitle>
            <DialogDescription>{rejecting?.desc}</DialogDescription>
          </DialogHeader>
          {rejecting && REJECT_NOTE.has(rejecting.collection) && (
            <Textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Reason for rejecting (optional, shared with the requester)"
              rows={3}
            />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button variant="destructive" loading={deciding === rejecting?.path} onClick={() => rejecting && decideInline(rejecting, "reject", rejectNote)}>
              <X className="h-4 w-4" /> Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showSection("timeline") && canTimeline && (
        <div ref={regionRef("timeline")} style={sectionStyle("timeline")} className="mb-6">
          {timelineOpen ? (
            // The heaviest widget on the page: 14 days x every visible employee of attendance, on top of the
            // five collections it draws over. It stays unmounted - and none of that is read - until its slot
            // is in view, so a reader who never scrolls this far never pays for it.
            wantTimeline ? (
              <TeamTimeline me={me} employees={employees} leaves={leave} leaveTypes={leaveTypes} holidays={holidays} celebrations={celebrations} events={events} schedule={schedule} hiddenMarkers={hiddenMarkers} refreshKey={attendanceRefresh} onCollapse={isMobile ? () => updatePrefs({ timelineOpen: false }) : undefined} />
            ) : (
              <Skeleton className="h-64 w-full rounded-xl" />
            )
          ) : (
            // Mount-on-open on phones: the timeline's attendance fan-out doesn't run until asked for.
            <Button variant="outline" className="w-full" onClick={() => updatePrefs({ timelineOpen: true })}>
              <Users className="h-4 w-4" /> Show team timeline <ChevronDown className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Holidays + celebrations side by side. Both cards already draw a list skeleton while their read is
          outstanding, and a gated read stays "loading" - so the probe is all this section needs. */}
      {showSection("calendar") && (
        <div ref={regionRef("calendar")} style={sectionStyle("calendar")} className="mb-6 grid gap-6 md:grid-cols-2">
          {/* Upcoming holidays */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-4 w-4 text-success" /> Upcoming holidays
                <AccessTarget target={{ collection: "holidays", label: "Holidays" }} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {holidaysState === "loading" ? (
                <ListSkeleton avatarClass="h-10 w-10 rounded-lg" />
              ) : upcomingHolidays.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <CalendarDays className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                  <p className="text-sm text-muted-foreground">No holidays scheduled.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {upcomingHolidays.map((h) => {
                    const rel = relativeDay(h.date);
                    const near = rel === "Today" || rel === "Tomorrow";
                    return (
                      <div key={h.path} className="flex items-center gap-3">
                        {/* Parse as local midnight (not UTC) so the day/month chip never drifts a day in
                            negative-offset timezones. */}
                        <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-accent text-accent-foreground">
                          <span className="text-sm font-bold leading-none">{new Date(`${h.date}T00:00:00`).getDate()}</span>
                          <span className="text-[10px] uppercase">
                            {new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, { month: "short" })}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{h.display_name}</p>
                          {/* Weekday matters when planning around a holiday (a Friday reads very differently
                              from a Wednesday), so it rides along with the relative label. */}
                          <p className={cn("text-xs", near ? "font-medium text-primary" : "text-muted-foreground")}>
                            {new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" })} · {rel}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming birthdays + work anniversaries. The id anchors the celebrations KPI's drill-through. */}
          <Card id="dash-celebrations">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cake className="h-4 w-4 text-primary" /> Celebrations
                <AccessTarget target={{ collection: "employees", label: "Celebrations (employee data)" }} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {celebsLoading ? (
                <ListSkeleton avatarClass="h-9 w-9 rounded-full" />
              ) : celebRows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <Cake className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                  <p className="text-sm text-muted-foreground">Nothing in the next 30 days.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {celebRows.map((row) =>
                    row.org ? (
                      <div key="org-anniversary" className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
                          {org.logo ? <img src={org.logo} alt="" className="h-full w-full object-cover" /> : <PartyPopper className="h-4 w-4 text-success" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{org.name}</p>
                          <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            <PartyPopper className="h-3 w-3 text-success" /> {row.years}-year company anniversary
                            <span aria-hidden> · </span>
                            <CelebWhen inDays={row.in_days} />
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div key={`${row.c.kind}-${row.c.employee}`} className="flex items-center gap-3">
                        <PhotoAvatar employeeId={idOf(row.c.employee)} name={row.c.name} photo={row.c.photo} className="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{row.c.name}</p>
                          <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            {row.c.kind === "birthday" ? (
                              <><Cake className="h-3 w-3 text-primary" /> Birthday</>
                            ) : (
                              <><PartyPopper className="h-3 w-3 text-success" /> {row.c.years}-year anniversary</>
                            )}
                            <span aria-hidden> · </span>
                            <CelebWhen inDays={row.c.in_days} />
                          </p>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* The board, one card: unread items lead (dot-marked), then the latest announcements. Bottom of the
          page by default, so its read is the one most often skipped entirely. */}
      {showSection("board") && (
        <Card ref={regionRef("board")} style={sectionStyle("board")} className="mb-6">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="h-4 w-4 text-primary" /> Latest from the board
              {unread.length > 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">{unread.length} unread</span>
              )}
              <AccessTarget target={{ collection: "announcements", label: "Announcements" }} />
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("announcements")}>
              Open board <ArrowRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {announcementsState === "loading" ? (
              <div className="space-y-4 py-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                ))}
              </div>
            ) : boardRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Megaphone className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                <p className="text-sm text-muted-foreground">No announcements yet.</p>
              </div>
            ) : (
              <div className="divide-y">
                {boardRows.map((a) => (
                  <button key={a.path} type="button" onClick={() => openPost(a)} className="flex w-full gap-3 py-3 text-left first:pt-0 last:pb-0 hover:opacity-80">
                    {/* The sticker the author chose, as a thumbnail - the same picture the board card leads with,
                        so a post is recognisable here before its title is read. */}
                    {a.illustration && (
                      <img
                        // Keyed by the PICTURE, not by the row: the hide below is a write into a node React
                        // owns, and React knows nothing about it - so on a row keyed by the announcement, one
                        // picture that 404s left every later picture in that slot invisible under a
                        // `display: none` nothing would ever clear. A new file is a new node here, exactly as
                        // in the two picker grids (StickerField, KudosArtPicker).
                        key={a.illustration}
                        src={kudosCardArtUrl(a.illustration)}
                        alt=""
                        aria-hidden
                        loading="lazy"
                        className={cn("h-10 w-10 shrink-0 self-center object-contain", ART_DIECUT_SM)}
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          {a.read === false && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden title="Unread" />}
                          <span className="truncate font-medium">{postLabel(a)}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{a.publish_time || a.create_time ? formatDate(a.publish_time ?? a.create_time) : ""}</span>
                      </span>
                      {/* The teaser wants prose, not markdown source - the server derives body_text for exactly this. */}
                      {(a.body_text ?? a.body) && <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{a.body_text ?? a.body}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* end of the movable-sections flex column */}
      </div>
    </div>
  );
}

// One "My day" tile: icon + title header, free-form body, optional drill-through.
function MyDayTile({ icon: Icon, title, target, onClick, style, children }: { icon: typeof Users; title: string; target?: AccessTargetRef; onClick?: () => void; style?: CSSProperties; children: ReactNode }) {
  return (
    <Card
      className={cn("p-4", onClick && "cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover")}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {target && <span className="ml-auto" onClick={(e) => e.stopPropagation()}><AccessTarget target={target} /></span>}
      </div>
      {children}
    </Card>
  );
}

// Compact self-service clock in/out on the dashboard. Shows live clocked-in duration; links to Attendance.
// Am I on the clock comes from the session-wide clock state, so this widget, the top-bar chip and the
// Attendance page can never disagree; `onClockChange` fires after a punch so the page's org-wide KPI and the
// team timeline (which read their own attendance snapshot) refresh too.
function ClockWidget({ onClockChange }: { onClockChange?: () => void }) {
  const clockState = useClock();
  const open = clockState.mine ?? null;
  const busy = clockState.busy;
  // BEFORE the early return, not after. `enabled` is derived from settings and the caller's employee record,
  // both of which arrive asynchronously - so it flips false -> true on an ordinary page load. With the hook
  // below the `return null`, that flip renders one more hook than the previous pass and React throws
  // ("Rendered more hooks than during the previous render"), taking the dashboard down. The hook is cheap and
  // idempotent with no argument: `useElapsedMinutes(undefined)` starts no interval and returns 0.
  const elapsed = useElapsedMinutes(open?.clock_in);
  // Nothing to punch without an employee record (the clock still reports who else is on it, for presence).
  if (!clockState.enabled) return null;
  async function clock(verb: "clockIn" | "clockOut") {
    await clockState.punch(verb);
    onClockChange?.();
  }
  return (
    <Card className="flex flex-col items-start justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${open ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
          <Clock className="h-5 w-5" />
          {/* Live indicator: a pulsing dot while a session is open, so "on the clock" reads before the text. */}
          {open && (
            <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success ring-2 ring-card" />
            </span>
          )}
        </span>
        <div className="min-w-0">
          <p className="whitespace-nowrap text-sm font-semibold">{open ? "Clocked in" : "Not clocked in"}</p>
          <p className="whitespace-nowrap text-xs text-muted-foreground">
            {open
              ? `Since ${new Date(open.clock_in).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtDuration(elapsed)}`
              : "Start your day from here."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          <AccessAction collection="attendance" verb="clockOut" label="Clock out">
            <Button size="sm" variant="destructive" loading={busy} onClick={() => clock("clockOut")}><LogOut className="h-4 w-4" /> Clock out</Button>
          </AccessAction>
        ) : (
          <AccessAction collection="attendance" verb="clockIn" label="Clock in">
            <Button size="sm" loading={busy} onClick={() => clock("clockIn")}><LogIn className="h-4 w-4" /> Clock in</Button>
          </AccessAction>
        )}
        <Button size="sm" variant="ghost" onClick={() => navigate("attendance")}>Attendance <ArrowRight className="h-4 w-4" /></Button>
      </div>
    </Card>
  );
}

function QuickAction({ label, icon: Icon, onClick, style }: { label: string; icon: typeof Users; onClick: () => void; style?: CSSProperties }) {
  return (
    <button
      onClick={onClick}
      style={style}
      className="group flex items-center justify-between rounded-xl border bg-card p-4 text-left text-sm font-medium shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        {label}
      </span>
      <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
