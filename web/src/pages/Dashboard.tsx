import { useEffect, useMemo, useState, type ReactNode } from "react";
// KPI-card icons live in lib/kpiIcons (shared with Settings); only icons used elsewhere on the page (clock
// widget, section headers, quick actions) are imported here.
import {
  Users,
  CalendarCheck,
  CalendarDays,
  Megaphone,
  ArrowRight,
  Plus,
  Cake,
  PartyPopper,
  Clock,
  LogIn,
  LogOut,
  ReceiptText,
} from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { PageSettings } from "@/components/common/SettingsButton";
import { get, invoke } from "@/api";
import { fmtDuration, DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import type { AttendanceSession } from "@/types";
import { useToast } from "@/components/ui/use-toast";
import { cn, formatDate, formatMoney, idOf } from "@/lib/utils";
import { useApprovals } from "@/lib/approvals";
import { navigate } from "@/router";
import { fireIntent } from "@/lib/intent";
import type { Announcement, Celebration, Employee, Event, Holiday, LeaveRequest, LeaveType, Ticket, Me, Transition, JobRequisition, Expense, ComplianceEvent, Asset, Goal, Loan, Application, Interview, Referral, Review, TaxDeclaration, BackgroundCheck, Suggestion, BenefitEnrollment, Card as CardT, ExpenseBudget, DocumentResource, NoticePeriod, RemoteWorkRequest, TimeEntry, ReviewCycle, Offer } from "@/types";
import { type DashboardConfig, type KpiCategory, KPI_DEFS, KPI_CATEGORIES, KPI_DEFAULT_AUDIENCE, kpiDefaultVisible, MARKER_DEFS, visibleToViewer } from "@/lib/dashboardConfig";
import { KPI_ICONS, CATEGORY_ICONS } from "@/lib/kpiIcons";
import { StatCard } from "@/components/common/StatCard";
import { TeamTimeline } from "@/components/common/TeamTimeline";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { kudosCardArtUrl, isKudosSticker, KUDOS_ART_DIECUT_SM } from "@/lib/kudosArt";
import { AccessTarget } from "@/components/access/AccessTarget";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useOrg, currencyDecimals, orgAnniversary, CELEBRATION_WEEK_DAYS } from "@/lib/org";

const todayStr = () => new Date().toISOString().slice(0, 10);

// Category colors: a legend-dot background and a matching card left-border accent, so a card's band reads at a
// glance and ties back to its legend pill. Attention = warning, Coming up = primary, At a glance = neutral.
const CAT_DOT: Record<KpiCategory, string> = {
  attention: "bg-warning",
  upcoming: "bg-primary",
  snapshot: "bg-muted-foreground/50",
};
const CAT_ACCENT: Record<KpiCategory, string> = {
  attention: "border-l-4 border-l-warning",
  upcoming: "border-l-4 border-l-primary",
  snapshot: "border-l-4 border-l-muted-foreground/30",
};

// Relative day label for a celebration that occurs `inDays` from today (0 = today).
const whenLabel = (inDays: number) => (inDays === 0 ? "Today" : inDays === 1 ? "Tomorrow" : `In ${inDays} days`);

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
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { rows: announcements } = useCollection<Announcement>("announcements");
  const { rows: leave } = useCollection<LeaveRequest>("leave-requests");
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  // Org events (private-by-default; yields [] for callers without events.read). Marked as bands on the timeline.
  const { rows: events } = useCollection<Event>("events");

  const [celebrations, setCelebrations] = useState<Celebration[]>([]);
  useEffect(() => {
    let live = true;
    get<{ results: Celebration[] }>("employees:upcomingCelebrations")
      .then((r) => live && setCelebrations(r.results ?? []))
      .catch(() => live && setCelebrations([]));
    return () => {
      live = false;
    };
  }, []);

  const canDecide = usePermission("leave-requests.approve");
  const canTimeline = usePermission("timeline.read");
  // Bumped whenever the caller clocks in/out, so the team timeline re-fetches attendance and reflects the
  // change on their own row immediately.
  const [attendanceRefresh, setAttendanceRefresh] = useState(0);
  const onClockChange = () => setAttendanceRefresh((n) => n + 1);

  // Open support tickets the caller can see (scoped server-side); count of those still OPEN drives a KPI.
  const { rows: tickets } = useCollection<Ticket>("tickets");
  const openTickets = useMemo(() => tickets.filter((t) => (t.state ?? "").toUpperCase() === "OPEN").length, [tickets]);
  // Who's clocked in right now (server-scoped to what the caller can see).
  const [clockedIn, setClockedIn] = useState(0);
  useEffect(() => {
    let live = true;
    get<{ results: AttendanceSession[] }>("attendance?open=true")
      .then((r) => live && setClockedIn((r.results ?? []).length))
      .catch(() => live && setClockedIn(0));
    return () => { live = false; };
  }, [attendanceRefresh]);

  // Role-based dashboard config (which KPIs + timeline markers each role sees). Read is open; default (unset)
  // shows everything. Edited in Settings → Organization → Dashboard.
  const [dashCfg, setDashCfg] = useState<DashboardConfig>({});
  useEffect(() => {
    get<{ value?: DashboardConfig }>("settings/dashboard")
      .then((s) => setDashCfg(s.value ?? {}))
      .catch(() => setDashCfg({}));
  }, []);
  // Which KPI band the viewer has focused (legend pill click); null = show all. Client-only, not persisted.
  const [catFilter, setCatFilter] = useState<KpiCategory | null>(null);
  // KPI visibility. A configured KPI follows its explicit role/user audience. An UNCONFIGURED one falls back to
  // its default audience: everyone, HR admins only (HR-related cards), or none (hidden until shared).
  const kpiVisible = (key: string) => visibleToViewer(dashCfg.kpis?.[key], me.role, me.employee_id, kpiDefaultVisible(KPI_DEFAULT_AUDIENCE[key], me.role));
  // Timeline markers this viewer may NOT see -> hidden on the timeline.
  const hiddenMarkers = useMemo(
    () => MARKER_DEFS.filter((m) => !visibleToViewer(dashCfg.timeline?.[m.key], me.role, me.employee_id)).map((m) => m.key),
    [dashCfg, me.role, me.employee_id],
  );

  // ---- Module KPIs (one collection each). Private by default: the fetch is gated on kpiVisible, so a viewer
  // who can't see the card never pays the D1 read. The card also stays gated by the collection's real grants
  // (an empty list -> a "0" the viewer is entitled to see). Each drills through to its module page.
  const { rows: transitions } = useCollection<Transition>("transitions", { enabled: kpiVisible("transitions_active") || kpiVisible("onboarding_tasks_pending") });
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions", { enabled: kpiVisible("open_positions") });
  const { rows: expenses } = useCollection<Expense>("expenses", { enabled: kpiVisible("expenses_pending") || kpiVisible("recurring_expenses_due") });
  const { rows: complianceEvents } = useCollection<ComplianceEvent>("compliance-events", { enabled: kpiVisible("compliance_due") || kpiVisible("compliance_overdue") || kpiVisible("compliance_week") });
  const { rows: assets } = useCollection<Asset>("assets", { enabled: kpiVisible("assets_assigned") });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: kpiVisible("goals_active") });
  const { rows: loans } = useCollection<Loan>("loans", { enabled: kpiVisible("loans_outstanding") });
  const { rows: applications } = useCollection<Application>("applications", { enabled: kpiVisible("candidates_pipeline") });
  const { rows: interviews } = useCollection<Interview>("interviews", { enabled: kpiVisible("interviews_upcoming") });
  const { rows: referrals } = useCollection<Referral>("referrals", { enabled: kpiVisible("referrals_open") });
  const { rows: reviews } = useCollection<Review>("reviews", { enabled: kpiVisible("reviews_open") });
  const { rows: taxDeclarations } = useCollection<TaxDeclaration>("tax-declarations", { enabled: kpiVisible("tax_verify") });
  const { rows: backgroundChecks } = useCollection<BackgroundCheck>("background-checks", { enabled: kpiVisible("bgchecks_open") });
  const { rows: suggestions } = useCollection<Suggestion>("suggestions", { enabled: kpiVisible("suggestions_open") });
  const { rows: benefitEnrollments } = useCollection<BenefitEnrollment>("benefit-enrollments", { enabled: kpiVisible("benefits_enrolled") });
  // One flat `cards` read feeds three board KPIs; enabled if the viewer can see any of them.
  const { rows: cards } = useCollection<CardT>("cards", { enabled: kpiVisible("cards_blocked") || kpiVisible("cards_overdue") || kpiVisible("my_open_cards") || kpiVisible("cards_due_week") });
  const { rows: budgets } = useCollection<ExpenseBudget>("expense-budgets", { enabled: kpiVisible("budget_over") });
  const { rows: orgDocuments } = useCollection<DocumentResource>("org-documents", { enabled: kpiVisible("docs_to_ack") });
  const { rows: personalDocuments } = useCollection<DocumentResource>("personal-documents", { enabled: kpiVisible("docs_expiring") || kpiVisible("letters_to_sign") });
  const { rows: noticePeriods } = useCollection<NoticePeriod>("notice-periods", { enabled: kpiVisible("notice_serving") });
  const { rows: remoteRequests } = useCollection<RemoteWorkRequest>("remote-work-requests", { enabled: kpiVisible("remote_today") });
  const { rows: timeEntries } = useCollection<TimeEntry>("time-entries", { enabled: kpiVisible("timesheet_week") || kpiVisible("timesheets_draft") });
  const { rows: reviewCycles } = useCollection<ReviewCycle>("review-cycles", { enabled: kpiVisible("reviews_due_soon") });
  const { rows: offers } = useCollection<Offer>("offers", { enabled: kpiVisible("offers_pending") });

  // Org work schedule (working week + shift times) for the timeline's shading and per-day attendance status.
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    get<{ value?: Partial<AttendanceSchedule> }>("settings/attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  const today = todayStr();

  const upcomingHolidays = useMemo(
    () => holidays.filter((h) => h.date >= today && !h.disabled).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5),
    [holidays, today]
  );
  const latestNews = useMemo(
    () =>
      announcements
        // Official announcements only - generic board posts live on the Board page, not the dashboard feed.
        .filter((a) => (a.kind ?? "announcement") === "announcement" && a.published !== false && !a.disabled)
        .sort((a, b) => (b.publish_time ?? "").localeCompare(a.publish_time ?? ""))
        .slice(0, 4),
    [announcements]
  );
  // Unread board items (any kind) from the last 7 days the caller has no read receipt for. Drives the unread
  // widget above the timeline, which renders only when this is non-empty.
  const unread = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return announcements
      .filter((a) => a.read === false && a.published !== false && !a.disabled)
      .filter((a) => +new Date(a.publish_time ?? a.create_time ?? 0) >= weekAgo)
      .sort((a, b) => (b.publish_time ?? b.create_time ?? "").localeCompare(a.publish_time ?? a.create_time ?? ""));
  }, [announcements]);
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
  // Everything awaiting the caller's decision - ALL request types, from the same session-wide provider that
  // feeds the sidebar badge and the Approvals inbox, so the three never disagree. Merged oldest-first for the
  // "Awaiting your approval" card; empty (and free) for callers who can't approve anything.
  const approvals = useApprovals();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const approvalItems = useMemo(() => {
    const items: { path: string; employee?: string; when?: string; kind: string; desc: string }[] = [
      ...approvals.leaves.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Leave", desc: `${formatDate(r.start_date)} to ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}` })),
      ...approvals.reimbs.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Reimbursement", desc: money(r.amount) })),
      ...approvals.overtimes.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Overtime", desc: `${formatDate(r.date)} · ${Math.round(r.minutes / 6) / 10}h` })),
      ...approvals.remotes.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Remote work", desc: `${formatDate(r.start_date)} to ${formatDate(r.end_date)}` })),
      ...approvals.regularizations.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Attendance", desc: formatDate(r.date) })),
      ...approvals.encashments.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Encashment", desc: `${r.days} day${r.days === 1 ? "" : "s"}` })),
      ...approvals.loans.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: r.kind === "advance" ? "Advance" : "Loan", desc: money(r.principal) })),
      ...approvals.timeEntries.map((r) => ({ path: r.path, employee: r.employee, when: r.create_time, kind: "Timesheet", desc: `${r.hours}h` })),
    ];
    return items.sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvals, org.default_currency]);
  // How long the oldest item awaiting the caller's decision has been waiting (for the approvals KPI hint).
  const oldestPendingDays = useMemo(() => {
    const t = approvalItems[0]?.when;
    return t ? Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 86_400_000)) : 0;
  }, [approvalItems]);
  // "Approver" for KPI purposes: can decide leave, or has anything (of any type) awaiting their decision.
  const isApprover = canDecide || approvals.total > 0;

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
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    return employees.filter((e) => e.start_date && e.start_date >= cutoff && e.start_date <= today).length;
  }, [employees, today]);

  // The date 30 days out, used by the several "next 30 days" KPIs below.
  const in30 = useMemo(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), []);
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
  // Company expenses still awaiting an approval decision (distinct from personal reimbursements).
  const expensesPending = useMemo(() => expenses.filter((e) => (e.state ?? "").toLowerCase() === "pending"), [expenses]);
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
  // Hours logged on timesheets in the current week (Mon-Sun), across everyone the caller can see.
  const hoursThisWeek = useMemo(() => {
    const d = new Date();
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).toISOString().slice(0, 10);
    return timeEntries.filter((t) => t.date && t.date >= monday && t.date <= today).reduce((n, t) => n + (t.hours ?? 0), 0);
  }, [timeEntries, today]);

  // ---- Proactive / leading KPIs: due-soon windows and pending self-service actions, so you act ahead of the
  // deadline rather than after it. The date 7 days out bounds the "this week" windows.
  const in7 = useMemo(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), []);
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

  // Per-KPI card data keyed by KPI key. Label, icon and category all come from KPI_DEFS + KPI_ICONS (shared
  // with the Settings editor); `label` here overrides the config label only when the card wants a shorter
  // on-dashboard title. Rendered grouped into category bands below - see kpiBands.
  type KpiTone = "primary" | "success" | "warning" | "muted";
  type KpiDatum = { value: ReactNode; tone: KpiTone; hint?: ReactNode; label?: string; target?: AccessTargetRef; onClick?: () => void };
  const kpiData: Record<string, KpiDatum> = {
    // --- Needs attention ---
    pending: isApprover
      // Approvers: the full cross-type approvals queue (same number as the sidebar badge), not just leave.
      ? { label: "Pending approvals", value: approvals.total, tone: approvals.total > 0 ? "warning" : "muted", hint: approvals.total === 0 ? "All clear" : `Oldest waiting ${oldestPendingDays} day${oldestPendingDays === 1 ? "" : "s"}`, target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("approvals") }
      : { label: "My pending leave", value: pending.length, tone: pending.length > 0 ? "warning" : "muted", hint: pending.length === 0 ? "All clear" : "Awaiting decision", target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("leave-requests") },
    open_tickets: { label: "Open tickets", value: openTickets, tone: openTickets > 0 ? "warning" : "muted", hint: openTickets === 0 ? "All clear" : "Awaiting resolution", target: { collection: "tickets", label: "Support tickets" }, onClick: () => navigate("tickets") },
    expenses_pending: { value: expensesPending.length, tone: expensesPending.length > 0 ? "warning" : "muted", hint: expensesPending.length === 0 ? "All clear" : money(expensesPendingAmount), target: { collection: "expenses", label: "Expenses" }, onClick: () => navigate("expenses") },
    cards_blocked: { value: blockedCards, tone: blockedCards > 0 ? "warning" : "muted", hint: blockedCards === 0 ? "Nothing blocked" : "Needs unblocking", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    cards_overdue: { value: overdueCards, tone: overdueCards > 0 ? "warning" : "muted", hint: overdueCards === 0 ? "On track" : "Past due date", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    budget_over: { value: budgetsOver, tone: budgetsOver > 0 ? "warning" : "muted", hint: budgetsOver === 0 ? "All within budget" : `of ${budgets.length} ${budgets.length === 1 ? "budget" : "budgets"}`, target: { collection: "expense-budgets", label: "Expense budgets" }, onClick: () => navigate("expense-budgets") },
    compliance_overdue: { value: complianceOverdueCount, tone: complianceOverdueCount > 0 ? "warning" : "muted", hint: complianceOverdueCount === 0 ? "Nothing overdue" : "Past due, not filed", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigate("compliance") },
    tax_verify: { value: taxToVerify, tone: taxToVerify > 0 ? "warning" : "muted", hint: taxToVerify === 0 ? "All clear" : "Awaiting verification", target: { collection: "tax-declarations", label: "Tax declarations" }, onClick: () => navigate("tax-declarations") },
    bgchecks_open: { label: "Background checks", value: openBgChecks, tone: openBgChecks > 0 ? "warning" : "muted", hint: openBgChecks === 0 ? "None open" : "Pending or running", target: { collection: "background-checks", label: "Background checks" }, onClick: () => navigate("background-checks") },
    suggestions_open: { value: openSuggestions, tone: openSuggestions > 0 ? "warning" : "muted", hint: openSuggestions === 0 ? "All answered" : "Awaiting a response", target: { collection: "suggestions", label: "Suggestions" }, onClick: () => navigate("suggestions") },
    docs_to_ack: { value: policiesToSign, tone: policiesToSign > 0 ? "warning" : "muted", hint: policiesToSign === 0 ? "All acknowledged" : "Awaiting your signature", target: { collection: "org-documents", label: "Org documents" }, onClick: () => navigate("documents") },
    docs_expiring: { label: "Documents expiring", value: docsExpiring, tone: docsExpiring > 0 ? "warning" : "muted", hint: docsExpiring === 0 ? "None in 30 days" : "Within 30 days", target: { collection: "personal-documents", label: "Personal documents" }, onClick: () => navigate("documents") },
    probation_ending: { label: "Probation ending", value: probationEnding, tone: probationEnding > 0 ? "warning" : "muted", hint: probationEnding === 0 ? "None in 30 days" : "Confirm or extend", target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    notice_serving: { value: servingNotice, tone: servingNotice > 0 ? "warning" : "muted", hint: servingNotice === 0 ? "None exiting" : "Working notice period", target: { collection: "notice-periods", label: "Notice periods" }, onClick: () => navigate("notice-periods") },
    // --- Coming up (leading; toned neutral-to-primary - a runway window is not a breach) ---
    compliance_due: { label: "Compliance due", value: complianceDue.length, tone: complianceOverdue > 0 ? "warning" : complianceDue.length > 0 ? "primary" : "muted", hint: complianceDue.length === 0 ? "None in 30 days" : complianceOverdue > 0 ? `${complianceOverdue} overdue` : "Within 30 days", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigate("compliance") },
    compliance_week: { value: complianceWeek, tone: complianceWeek > 0 ? "primary" : "muted", hint: complianceWeek === 0 ? "Nothing due soon" : "File before the deadline", target: { collection: "compliance-events", label: "Compliance events" }, onClick: () => navigate("compliance") },
    cards_due_week: { value: cardsDueWeek, tone: cardsDueWeek > 0 ? "primary" : "muted", hint: cardsDueWeek === 0 ? "Nothing due soon" : "Plan ahead", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    reviews_due_soon: { value: reviewsDueSoon, tone: reviewsDueSoon > 0 ? "primary" : "muted", hint: reviewsDueSoon === 0 ? "No deadlines this week" : "Wrap up before due date", target: { collection: "reviews", label: "Reviews" }, onClick: () => navigate("reviews") },
    interviews_upcoming: { value: upcomingInterviews.length, tone: upcomingInterviews.length > 0 ? "primary" : "muted", hint: upcomingInterviews.length === 0 ? "None scheduled" : interviewsToday > 0 ? `${interviewsToday} today` : "Upcoming", target: { collection: "interviews", label: "Interviews" }, onClick: () => navigate("interviews") },
    onboarding_tasks_pending: { value: onboardingTasksPending, tone: onboardingTasksPending > 0 ? "primary" : "muted", hint: onboardingTasksPending === 0 ? "All checklists done" : `across ${activeTransitions.length} ${activeTransitions.length === 1 ? "transition" : "transitions"}`, target: { collection: "transitions", label: "Transitions" }, onClick: () => navigate("transitions") },
    letters_to_sign: { value: lettersToSign, tone: lettersToSign > 0 ? "primary" : "muted", hint: lettersToSign === 0 ? "Nothing to sign" : "Awaiting e-signature", target: { collection: "personal-documents", label: "Personal documents" }, onClick: () => navigate("documents") },
    offers_pending: { value: offersPending, tone: offersPending > 0 ? "primary" : "muted", hint: offersPending === 0 ? "None outstanding" : "Follow up with candidates", target: { collection: "offers", label: "Offers" }, onClick: () => navigate("offers") },
    timesheets_draft: { value: timesheetsDraft, tone: timesheetsDraft > 0 ? "primary" : "muted", hint: timesheetsDraft === 0 ? "Nothing in draft" : "Submit for approval", target: { collection: "time-entries", label: "Time entries" }, onClick: () => navigate("timesheets") },
    recurring_expenses_due: { value: recurringExpensesDue, tone: recurringExpensesDue > 0 ? "primary" : "muted", hint: recurringExpensesDue === 0 ? "Nothing due soon" : "Raise before the cycle", target: { collection: "expenses", label: "Expenses" }, onClick: () => navigate("expenses") },
    // --- At a glance (snapshot) ---
    on_leave: { value: onLeaveToday, tone: onLeaveToday > 0 ? "primary" : "muted", hint: `of ${employees.length} ${employees.length === 1 ? "person" : "people"}`, target: { collection: "leave-requests", label: "Leave requests" }, onClick: () => navigate("leave-requests") },
    clocked_in: { value: clockedIn, tone: clockedIn > 0 ? "success" : "muted", hint: "Currently on the clock", target: { collection: "attendance", label: "Attendance" }, onClick: () => navigate("attendance") },
    not_clocked_in: { value: Math.max(0, employees.length - clockedIn), tone: "muted", hint: `of ${employees.length} ${employees.length === 1 ? "person" : "people"}`, target: { collection: "attendance", label: "Attendance" }, onClick: () => navigate("attendance") },
    remote_today: { value: remoteToday, tone: remoteToday > 0 ? "primary" : "muted", hint: `of ${employees.length} ${employees.length === 1 ? "person" : "people"}`, target: { collection: "remote-work-requests", label: "Remote work" }, onClick: () => navigate("remote-work") },
    celebrations: { value: celebsThisWeek.length, tone: celebsThisWeek.length > 0 ? "success" : "muted", hint: nextCeleb ? `Next: ${nextCelebLabel} · ${whenLabel(nextCeleb.in_days)}` : "None this week", target: { collection: "employees", label: "Celebrations (employee data)" } },
    joiners: { value: newJoiners, tone: newJoiners > 0 ? "primary" : "muted", hint: `${employees.length} total ${employees.length === 1 ? "employee" : "employees"}`, target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    headcount: { value: employees.length, tone: "primary", hint: "across the organization", target: { collection: "employees", label: "Employees" }, onClick: () => navigate("employees") },
    transitions_active: { value: activeTransitions.length, tone: activeTransitions.length > 0 ? "primary" : "muted", hint: activeTransitions.length === 0 ? "Nothing in progress" : `${onboardingCount} joining · ${activeTransitions.length - onboardingCount} exiting`, target: { collection: "transitions", label: "Transitions" }, onClick: () => navigate("transitions") },
    open_positions: { value: openReqs.length, tone: openReqs.length > 0 ? "primary" : "muted", hint: openReqs.length === 0 ? "No open reqs" : `${openSeats} seat${openSeats === 1 ? "" : "s"} to fill`, target: { collection: "job-requisitions", label: "Job requisitions" }, onClick: () => navigate("job-requisitions") },
    candidates_pipeline: { value: pipelineCount, tone: pipelineCount > 0 ? "primary" : "muted", hint: pipelineCount === 0 ? "Pipeline empty" : "Active applications", target: { collection: "applications", label: "Applications" }, onClick: () => navigate("pipeline") },
    referrals_open: { value: openReferrals.length, tone: openReferrals.length > 0 ? "primary" : "muted", hint: openReferrals.length === 0 ? "None in flight" : "In progress", target: { collection: "referrals", label: "Referrals" }, onClick: () => navigate("referrals") },
    reviews_open: { value: openReviews.length, tone: openReviews.length > 0 ? "primary" : "muted", hint: openReviews.length === 0 ? "All closed out" : "Not yet acknowledged", target: { collection: "reviews", label: "Reviews" }, onClick: () => navigate("reviews") },
    assets_assigned: { value: assetsAssigned, tone: assetsAssigned > 0 ? "primary" : "muted", hint: `of ${assets.length} in inventory`, target: { collection: "assets", label: "Assets" }, onClick: () => navigate("assets") },
    goals_active: { value: activeGoals.length, tone: goalsOverdue > 0 ? "warning" : activeGoals.length > 0 ? "primary" : "muted", hint: activeGoals.length === 0 ? "None in flight" : goalsOverdue > 0 ? `${goalsOverdue} past due` : "In progress", target: { collection: "goals", label: "Goals" }, onClick: () => navigate("goals") },
    loans_outstanding: { value: outstandingLoans.length, tone: outstandingLoans.length > 0 ? "primary" : "muted", hint: outstandingLoans.length === 0 ? "Nothing owed" : money(outstandingTotal), target: { collection: "loans", label: "Loans" }, onClick: () => navigate("loans") },
    benefits_enrolled: { value: enrolledBenefits, tone: enrolledBenefits > 0 ? "primary" : "muted", hint: `across ${employees.length} ${employees.length === 1 ? "person" : "people"}`, target: { collection: "benefit-enrollments", label: "Benefit enrollments" }, onClick: () => navigate("benefits") },
    my_open_cards: { value: myOpenCards, tone: myOpenCards > 0 ? "primary" : "muted", hint: myOpenCards === 0 ? "All done" : "Assigned to you", target: { collection: "cards", label: "Board cards" }, onClick: () => navigate("boards") },
    timesheet_week: { label: "Hours logged", value: Math.round(hoursThisWeek * 10) / 10, tone: hoursThisWeek > 0 ? "primary" : "muted", hint: "this week", target: { collection: "time-entries", label: "Time entries" }, onClick: () => navigate("timesheets") },
  };
  // Group the visible cards into their category bands (band order from KPI_CATEGORIES). A card shows only if
  // the viewer may see it AND the org hasn't switched its whole category off (hiddenKpiCategories).
  const hiddenCats = new Set(dashCfg.hiddenKpiCategories ?? []);
  const kpiBands = KPI_CATEGORIES
    .filter((cat) => !hiddenCats.has(cat.key))
    .map((cat) => ({ cat, defs: KPI_DEFS.filter((d) => d.category === cat.key && kpiData[d.key] && kpiVisible(d.key)) }))
    .filter((b) => b.defs.length > 0);

  // Personal greeting: time-of-day salutation + the caller's real first name (directory record), falling
  // back to a humanized email local part for logins without a linked employee.
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const selfEmp = me.employee_id ? employees.find((e) => idOf(e.path) === me.employee_id) : undefined;
  const firstName =
    selfEmp?.first_name ||
    (me.email.split("@")[0] ?? me.email)
      .replace(/[._-]+/g, " ")
      .split(" ")[0]
      .replace(/^\w/, (c) => c.toUpperCase());
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div>
      {/* Greeting hero: salutation + date on the left, the clock-in/out control on the right. */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">{todayLabel}</p>
            <PageSettings me={me} host="dashboard" />
          </div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-foreground">
            {greeting}, {firstName}
          </h1>
        </div>
        <div className="w-full lg:w-[480px]">
          <ClockWidget me={me} onClockChange={onClockChange} />
        </div>
      </div>

      {/* KPIs render in ONE dense grid so rows always fill (three separate per-band grids left ragged last rows).
          Cards are ordered by band and carry a category-colored left accent; the legend pills above name each band,
          show its count, and double as a focus filter (click to show only that band). Configured in Settings. */}
      {kpiBands.length > 0 && (
        <div className="mb-6 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
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
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kpiBands
              .filter(({ cat }) => !catFilter || cat.key === catFilter)
              .flatMap(({ cat, defs }) =>
                defs.map((d) => {
                  const c = kpiData[d.key]!;
                  return (
                    <StatCard key={d.key} label={c.label ?? d.label} value={c.value} icon={KPI_ICONS[d.key]!} tone={c.tone} hint={c.hint} target={c.target} onClick={c.onClick} accentClass={CAT_ACCENT[cat.key]} />
                  );
                }),
              )}
          </div>
        </div>
      )}

      {/* Needs-you first: everything awaiting the caller's decision, across every request type, oldest first.
          Sits directly under the KPIs because it's the one dashboard item that demands action today. */}
      {approvals.total > 0 && (
        <Card className="mb-6 border-warning/40">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarCheck className="h-4 w-4 text-warning" /> Awaiting your approval
              <span className="rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-foreground">{approvals.total}</span>
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
                return (
                  <button key={it.path} type="button" onClick={() => navigate("approvals")} className="flex w-full items-center gap-3 py-2.5 text-left first:pt-0 last:pb-0 hover:opacity-80">
                    <PhotoAvatar employeeId={it.employee ? idOf(it.employee) : ""} name={who ? `${who.first_name} ${who.last_name}` : "Someone"} photo={who?.photo} className="h-8 w-8 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium">{who ? `${who.first_name} ${who.last_name}` : "Someone"}</span>
                      <span className="text-muted-foreground"> · {it.kind} · {it.desc}</span>
                    </span>
                    <span className={`shrink-0 text-xs ${waited >= 7 ? "font-medium text-warning" : "text-muted-foreground"}`}>
                      {waited === 0 ? "Today" : `Waiting ${waited} day${waited === 1 ? "" : "s"}`}
                    </span>
                  </button>
                );
              })}
            </div>
            {approvals.total > 5 && (
              <p className="mt-2 text-xs text-muted-foreground">And {approvals.total - 5} more in the approvals inbox.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Unread board items from the last week - shown only when there are unread posts/announcements. */}
      {unread.length > 0 && (
        <Card className="mb-6 border-primary/40 bg-primary/[0.03]">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="h-4 w-4 text-primary" /> Unread on the board
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">{unread.length}</span>
              <AccessTarget target={{ collection: "announcements", label: "Announcements" }} />
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("announcements")}>
              Open board <ArrowRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {unread.slice(0, 5).map((a) => (
                <button key={a.path} type="button" onClick={() => openPost(a)} className="flex w-full items-center justify-between gap-3 py-2 text-left first:pt-0 last:pb-0 hover:opacity-80">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span className="truncate font-medium">{postLabel(a)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(a.publish_time ?? a.create_time)}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {canTimeline && (
        <div className="mb-6">
          <TeamTimeline me={me} employees={employees} leaves={leave} leaveTypes={leaveTypes} holidays={holidays} celebrations={celebrations} events={events} schedule={schedule} hiddenMarkers={hiddenMarkers} refreshKey={attendanceRefresh} />
        </div>
      )}

      <div className="space-y-6">
        {/* Holidays + celebrations side by side */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Upcoming holidays */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-4 w-4 text-success" /> Upcoming holidays
                <AccessTarget target={{ collection: "holidays", label: "Holidays" }} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingHolidays.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No holidays scheduled.</p>
              ) : (
                <div className="space-y-3">
                  {upcomingHolidays.map((h) => (
                    <div key={h.path} className="flex items-center gap-3">
                      {/* Parse as local midnight (not UTC) so the day/month chip never drifts a day in
                          negative-offset timezones. */}
                      <div className="flex h-10 w-10 flex-col items-center justify-center rounded-lg bg-accent text-accent-foreground">
                        <span className="text-sm font-bold leading-none">{new Date(`${h.date}T00:00:00`).getDate()}</span>
                        <span className="text-[10px] uppercase">
                          {new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, { month: "short" })}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{h.display_name}</p>
                        <p className="text-xs text-muted-foreground">{relativeDay(h.date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming birthdays + work anniversaries */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cake className="h-4 w-4 text-primary" /> Celebrations
                <AccessTarget target={{ collection: "employees", label: "Celebrations (employee data)" }} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {celebRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing in the next 30 days.</p>
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
                            {whenLabel(row.in_days)}
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
                            {whenLabel(row.c.in_days)}
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

        {/* Latest announcements - always visible, below holidays & celebrations. (The unread board, shown only
            when there are unread items, will sit above the timeline - stage ②.) */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="h-4 w-4 text-primary" /> Latest announcements
              <AccessTarget target={{ collection: "announcements", label: "Announcements" }} />
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("announcements")}>
              View all <ArrowRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {latestNews.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No announcements yet.</p>
            ) : (
              <div className="divide-y">
                {latestNews.map((a) => (
                  <button key={a.path} type="button" onClick={() => openPost(a)} className="flex w-full gap-3 py-3 text-left first:pt-0 last:pb-0 hover:opacity-80">
                    {/* The sticker the author chose, as a thumbnail - the same picture the board card leads with,
                        so a post is recognisable here before its title is read. */}
                    {a.illustration && (
                      <img
                        src={kudosCardArtUrl(a.illustration)}
                        alt=""
                        aria-hidden
                        loading="lazy"
                        className={cn("h-10 w-10 shrink-0 self-center object-contain", isKudosSticker(a.illustration) && KUDOS_ART_DIECUT_SM)}
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className="font-medium">{a.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{a.publish_time ? formatDate(a.publish_time) : ""}</span>
                      </span>
                      {/* The teaser wants prose, not markdown source - the server derives body_text for exactly this. */}
                      <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{a.body_text ?? a.body}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <QuickAction label="View directory" icon={Users} onClick={() => navigate("employees")} />
        <QuickAction label="Request leave" icon={Plus} onClick={() => { navigate("leave-requests"); fireIntent("request-leave"); }} />
        <QuickAction label="My payslips" icon={ReceiptText} onClick={() => navigate("payslips")} />
      </div>
    </div>
  );
}

// Compact self-service clock in/out on the dashboard. Shows live clocked-in duration; links to Attendance.
// `onClockChange` fires after a successful clock in/out so the parent can refresh the team timeline.
function ClockWidget({ me, onClockChange }: { me: Me; onClockChange?: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState<AttendanceSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const reload = () =>
    get<{ results: AttendanceSession[] }>("attendance?open=true")
      .then((r) => setOpen((r.results ?? []).find((s) => s.employee && idOf(s.employee) === me.employee_id) ?? null))
      .catch(() => {});
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function clock(verb: "clockIn" | "clockOut") {
    setBusy(true);
    try {
      await invoke("attendance/me", verb);
      await reload();
      onClockChange?.();
      toast({ title: verb === "clockIn" ? "Clocked in" : "Clocked out", variant: "success" });
    } catch (e) {
      toast({ title: "Clock failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col items-start justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${open ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="whitespace-nowrap text-sm font-semibold">{open ? "Clocked in" : "Not clocked in"}</p>
          <p className="whitespace-nowrap text-xs text-muted-foreground">
            {open ? `${fmtDuration(Math.max(0, Math.round((now - +new Date(open.clock_in)) / 60000)))} elapsed` : "Start your day from here."}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
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

function QuickAction({ label, icon: Icon, onClick }: { label: string; icon: typeof Users; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between rounded-xl border bg-card p-4 text-left text-sm font-medium shadow-sm transition-colors hover:bg-accent"
    >
      <span className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        {label}
      </span>
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}
