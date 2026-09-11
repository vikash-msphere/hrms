import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Ban, Check, CalendarPlus, CalendarRange, Users, Wallet, CalendarCheck, Clock, Plane, X, Filter, Inbox, ArrowRight, Coins, CalendarSync, Paperclip, Download, History } from "lucide-react";
import { download, get, invoke, upload } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { navigate, navigateTab } from "@/router";
import { usePermission } from "@/lib/perm";
import { useApprovals } from "@/lib/approvals";
import { leaveBalanceOf, leaveDecisionContext, leaveOverlapCount, leaveSummary } from "@/lib/leaveApproval";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf, cn, personName, round2 } from "@/lib/utils";
import { todayStr, daysBetweenYmd } from "@/lib/orgDay";
import { leaveColor } from "@/lib/leaveColors";
import { readHashQuery, writeHashQuery } from "@/lib/urlQuery";
import { useRoutedTab } from "@/lib/routedTabs";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import { forecastBalance, accrualEntriesThisYear, DEFAULT_CARRY_FORWARD, type CarryForwardMode } from "@/lib/leaveForecast";
import type { LeaveDraft } from "@/lib/leaveDraft";
import type { ApprovalDelegation, Employee, Holiday, LeaveBalance, LeaveEncashment, LeaveRequest, LeaveType, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { Chart, ChartCard } from "@/components/common/Chart";
import { monthlyTotals, topSlices } from "@/lib/chartTheme";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { SummaryStrip, type SummaryItem } from "@/components/common/SummaryStrip";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { ApprovalRow, RejectDialog, type RejectTarget } from "@/components/common/ApprovalRow";
import { ActivitySection } from "@/components/common/ActivitySection";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { Card } from "@/components/ui/card";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import LeaveEncashments from "@/pages/LeaveEncashments";
import { getSetting } from "@/lib/settingsStore";

const upper = (s?: string) => (s ?? "").toUpperCase();
const sumDays = (rs: LeaveRequest[]) => rs.reduce((n, r) => n + (r.days || 0), 0);
// The summary metric currently selected (`?metric=`), i.e. the one lit segment of the strip. Deep-linkable, so
// a shared link opens on the same narrowed view; anything else in the param is ignored.
type StripFocus = "available" | "history" | "inflight" | null;
const STRIP_FOCUS: StripFocus[] = ["available", "history", "inflight"];
const stripFocus = (raw: string | null): StripFocus => (STRIP_FOCUS.includes(raw as StripFocus) ? (raw as StripFocus) : null);
// Whole calendar days between two ymd strings (positive = `to` is later) - lib/orgDay owns the arithmetic.
const daysBetween = daysBetweenYmd;
const inDaysLabel = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
// Half-days are real, so day counts print as 1 / 1.5 rather than 1.5000000000000002.
const fmtDays = (n: number) => String(Math.round(n * 2) / 2);
const shortDay = (ymd: string) => new Date(ymd + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
// "12 Mar" / "12 - 16 Mar" / "28 Mar - 2 Apr" - short enough to sit in a summary tile.
function shortRange(from: string, to: string): string {
  if (from === to) return shortDay(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))} - ${shortDay(to)}` : `${shortDay(from)} - ${shortDay(to)}`;
}

// Relative timing for a live request, so "where's my request" also answers "when is it".
function whenLabel(lr: LeaveRequest, today: string): string | null {
  if (lr.start_date === today) return "starts today";
  if (lr.start_date > today) return `starts ${inDaysLabel(daysBetween(today, lr.start_date))}`;
  if (lr.end_date >= today) return "ongoing";
  return null; // back-dated request - the dates speak for themselves
}

// Short label for a leave's half-day boundaries (null = whole days). Sessions: 1 = first half (morning),
// 2 = second half (afternoon).
function halfLabel(lr: LeaveRequest): string | null {
  const ss = lr.start_session ?? 1, es = lr.end_session ?? 2;
  if (lr.start_date === lr.end_date) {
    if (ss === 1 && es === 1) return "First half";
    if (ss === 2 && es === 2) return "Second half";
    return null;
  }
  const parts: string[] = [];
  if (ss === 2) parts.push("from 2nd half");
  if (es === 1) parts.push("to 1st half");
  return parts.length ? parts.join(", ") : null;
}

export default function Leaves({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<LeaveRequest>("leave-requests");
  const { rows: types } = useCollection<LeaveType>("leave-types");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { toast } = useToast();
  const confirm = useConfirm();
  const canDecide = usePermission("leave-requests.approve");
  const canEncash = usePermission("leave-encashments.read");
  const canRequest = usePermission("leave-requests.write");
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { rows: encashments } = useCollection<LeaveEncashment>("leave-encashments", { enabled: canEncash });
  // Delegations are private by default; the hook returns [] (and fires no request) without read access, so
  // this only ever sharpens the "who decides" line for callers who can already see the cover arrangement. That
  // line exists only on a request still awaiting a decision, so a history with nothing pending never asks.
  const { rows: delegations } = useCollection<ApprovalDelegation>("approval-delegations", {
    enabled: rows.some((r) => (r.state ?? "").toUpperCase() === "PENDING"),
  });

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LeaveDraft | null>(null);
  // Clicking a balance card narrows the tables to that leave type. The narrowing is SERVER-side (`?leave_type=`),
  // so it reaches rows past the 100-row page this list would otherwise window - a client filter of the cached
  // rows would quietly answer "none" for a request that exists. The unfiltered read stays cached alongside it,
  // so toggling the filter off is instant and the summary above keeps counting everything.
  // Deep-linked: the filter lives in the hash query, so a reload, a back button or a pasted link all keep it.
  const [typeFilter, setTypeFilter] = useState<string | null>(() => readHashQuery("leave_type"));
  useEffect(() => { writeHashQuery("leave_type", typeFilter); }, [typeFilter]);
  const filteredRead = useCollection<LeaveRequest>("leave-requests", { params: typeFilter ? { leave_type: typeFilter } : undefined, enabled: !!typeFilter });
  const tabRows = typeFilter ? filteredRead.rows : rows;
  const tabState = typeFilter ? filteredRead.state : state;
  const tabError = typeFilter ? filteredRead.error : error;
  const reloadAll = () => { reload(); if (typeFilter) filteredRead.reload(); };

  // The caller's own slice of the approvals queue: leave requests awaiting THEIR decision, from the session-wide
  // read the inbox and the sidebar badge already share. `decided` hides a row the moment it is acted on here, so
  // the band empties as the approver works even before the refetch lands.
  const approvals = useApprovals();
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<RejectTarget | null>(null);
  const pendingForMe = useMemo(
    () => approvals.leaves.filter((r) => !decided.has(r.path)).sort((a, b) => (a.create_time ?? "").localeCompare(b.create_time ?? "")),
    [approvals.leaves, decided],
  );

  // Org work schedule, for the "this range skips N non-working days" hint on a row (mirrors the leave calendar).
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  // Year-end policy, for the "what lapses on 31 Dec" line. A plain employee may not be able to read the
  // settings row; the catch falls back to the server's own defaults (per-type caps, excess auto-encashed).
  const [caps, setCaps] = useState<CarryForwardMode>(DEFAULT_CARRY_FORWARD);
  useEffect(() => {
    getSetting<{ carry_forward_mode?: string; carry_forward_cumulative_cap_days?: number | null; carry_forward_excess?: string }>("leave_caps")
      .then((s) => setCaps({
        mode: s.value?.carry_forward_mode === "cumulative" ? "cumulative" : "per_type",
        cumulativeCapDays: typeof s.value?.carry_forward_cumulative_cap_days === "number" ? s.value.carry_forward_cumulative_cap_days : null,
        excess: s.value?.carry_forward_excess === "forfeit" ? "forfeit" : "encash",
      }))
      .catch(() => {});
  }, []);
  // Global "Request leave" quick action (⌘K / top-bar +) opens the dialog on arrival.
  useIntent("request-leave", () => { setDraft(null); setOpen(true); });

  const typeOf = useMemo(() => {
    const m = new Map(types.map((t) => [idOf(t.path), t]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [types]);
  // These three - and the predicates further down - are `useCallback`ed because the memos below CALL them:
  // a helper rebuilt every render is a dependency that changes every render, so listing it honestly would
  // defeat the memo and leaving it out is the stale-closure bug the rule exists to catch. Wrapped, each one's
  // identity moves with what it actually reads, which is what the dependency arrays used to restate by hand.
  const typeName = useCallback((p?: string) => (p ? typeOf(p)?.display_name ?? idOf(p) : "-"), [typeOf]);
  // Each type's calendar colour (configured or a stable palette pick), so a type reads the same here, on the
  // leave calendar and on the dashboard timeline.
  const typeColor = useCallback((p?: string) => leaveColor(typeOf(p)?.color, p ? idOf(p) : ""), [typeOf]);

  // Days a range covers but is NOT charged for: non-working weekdays (per the org schedule) and holidays. The
  // server already dropped them when it computed `days` (domain/leave.ts leaveDays); naming them here is what
  // turns a surprising "Mon-Fri = 3 days" into an obvious one.
  const holidayByDay = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of holidays) if (!h.disabled && !h.delete_time && h.date) m.set(h.date.slice(0, 10), h.display_name || "Holiday");
    return m;
  }, [holidays]);
  const workDays = schedule.work_days?.length ? schedule.work_days : DEFAULT_SCHEDULE.work_days;
  type Skipped = { span: number; weekends: number; holidays: string[] };
  function nonWorking(from?: string, to?: string): Skipped {
    const out: Skipped = { span: 0, weekends: 0, holidays: [] };
    if (!from || !to) return out;
    const end = Date.parse(to + "T00:00:00Z");
    for (let t = Date.parse(from + "T00:00:00Z"); t <= end && out.span < 400; t += 86400000) {
      out.span++;
      const ymd = new Date(t).toISOString().slice(0, 10);
      if (!workDays.includes(new Date(t).getUTCDay())) out.weekends++;
      else if (holidayByDay.has(ymd)) out.holidays.push(`${holidayByDay.get(ymd)} (${shortDay(ymd)})`);
    }
    return out;
  }
  const nonWorkingNote = (s: Skipped) =>
    [
      `${s.span} calendar days`,
      s.weekends ? `${s.weekends} non-working day${s.weekends === 1 ? "" : "s"}` : "",
      s.holidays.length ? `holidays: ${s.holidays.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ") + " - these don't come off the balance.";
  const empOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [employees]);
  // The caller's own employee row - start date + probation end feed the accrual forecast on the balance cards.
  const meEmployee = useMemo(
    () => (me.employee_id ? employees.find((e) => idOf(e.path) === me.employee_id) : undefined),
    [employees, me.employee_id],
  );
  const empName = (p?: string) => personName(employees, p, "-") || "-";

  // The ORG's day, not the reader's. Every comparison below is against a date the SERVER decided (a request
  // is upcoming, a balance year has started), and those are stated in the org timezone.
  const today = todayStr();
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const isOwn = useCallback((lr: LeaveRequest) => !!(lr.employee && me.employee_id && idOf(lr.employee) === me.employee_id), [me.employee_id]);
  const isPending = (lr: LeaveRequest) => upper(lr.state) === "PENDING"; // pure over its argument - nothing to depend on
  const isUpcoming = useCallback((lr: LeaveRequest) => upper(lr.state) === "APPROVED" && lr.end_date >= today, [today]);

  // The caller's own requests drive the balance cards below; the Requests/History tab split lives in
  // RequestsHistoryTabs. "Live" for leave includes upcoming-approved (still cancellable), but an approver's
  // History excludes only pending (so freshly-approved future leave still shows org-wide).
  const myAll = useMemo(() => rows.filter(isOwn), [rows, isOwn]);

  // The two pictures under the balance cards, over whatever requests this caller can see: their own on a
  // self-service page, their team's for an approver - the same rows the tables below list, so the charts and
  // the tables can never disagree. Approved only: a pending request is a plan, not a day taken.
  const leaveCharts = useMemo(() => {
    const approved = rows.filter((r) => upper(r.state) === "APPROVED");
    const months = monthlyTotals(approved.map((r) => ({ date: r.start_date, value: r.days || 0 })), 12, today);
    const thisYear = approved.filter((r) => r.start_date >= yearStart);
    const byType = topSlices(thisYear, (r) => typeName(r.leave_type), (r) => r.days || 0, 7);
    return {
      total: approved.length,
      months,
      // Each type keeps the colour it wears everywhere else on the page (the dot beside its name, its balance
      // card, its blocks on the calendar); a leave type that is teal in one place and orange in another is a
      // different leave type as far as the reader is concerned.
      byType: { ...byType, colors: byType.labels.map((label) => typeColor(types.find((t) => t.display_name === label)?.path)) },
    };
  }, [rows, types, today, yearStart, typeName, typeColor]);

  const myBalances = useMemo(
    () => balances.filter((b) => me.employee_id && b.employee && idOf(b.employee) === me.employee_id),
    [balances, me.employee_id],
  );
  // Everyone else's balances the caller can read (a manager's team, HR's whole org) - the "does this person
  // have the days" question an approver asks before deciding. Empty for a plain employee, which is what hides
  // the tab entirely.
  const teamBalances = useMemo(
    () => balances.filter((b) => !(me.employee_id && b.employee && idOf(b.employee) === me.employee_id)),
    [balances, me.employee_id],
  );
  // Used / pending days per (employee, leave type), from the leave requests already loaded.
  const usageByKey = useMemo(() => {
    const m = new Map<string, { used: number; pending: number }>();
    for (const r of rows) {
      if (!r.employee || !r.leave_type) continue;
      const k = `${idOf(r.employee)}|${idOf(r.leave_type)}`;
      const e = m.get(k) ?? { used: 0, pending: 0 };
      if (upper(r.state) === "APPROVED" && r.start_date >= yearStart) e.used += r.days || 0;
      else if (isPending(r)) e.pending += r.days || 0;
      m.set(k, e);
    }
    return m;
  }, [rows, yearStart]);
  const usageOf = (b: LeaveBalance) => usageByKey.get(`${idOf(b.employee ?? "")}|${idOf(b.leave_type ?? "")}`) ?? { used: 0, pending: 0 };

  // Answer-first summary: what's left, what's spent, what's still in flight, and when the next break is.
  const nextLeave = useMemo(
    () => myAll.filter(isUpcoming).sort((a, b) => a.start_date.localeCompare(b.start_date))[0],
    [myAll, isUpcoming],
  );
  const myPending = useMemo(() => myAll.filter(isPending), [myAll]);
  const usedThisYear = useMemo(
    () => sumDays(myAll.filter((r) => upper(r.state) === "APPROVED" && r.start_date >= yearStart)),
    [myAll, yearStart],
  );
  // Only paid (entitlement-tracked) types carry a meaningful "days left"; unpaid leave isn't drawn from a balance.
  const availableDays = useMemo(
    () => myBalances.filter((b) => typeOf(b.leave_type)?.paid !== false).reduce((n, b) => n + (b.balance_days || 0), 0),
    [myBalances, typeOf],
  );
  // Everyone else the caller can already see who is off today - free from the rows this page loaded anyway, and
  // it answers "is my team covered" without a trip to the calendar.
  const outToday = useMemo(
    () => rows.filter((r) => upper(r.state) === "APPROVED" && r.start_date <= today && r.end_date >= today && !isOwn(r)),
    [rows, today, isOwn],
  );

  const onLeaveNow = !!nextLeave && nextLeave.start_date <= today;
  // Which tab the tables below are showing, so the metric that opens a tab is marked active while that tab is
  // the one on screen (RequestsHistoryTabs owns the tabs; the hash is what the two agree on).
  const openTab = useRoutedTab("leave-requests", "requests");
  // The strip is ONE selection: clicking a metric lights that segment and darkens the rest, and the lit segment
  // is only ever the one whose scope the tables below are actually showing. The metrics act on two different
  // dimensions (a tab, or the type narrowing), so the light is the metric last picked INTERSECTED with the state
  // that metric asked for - switching tabs by hand or narrowing to a leave type drops it rather than leaving a
  // segment lit over a view it no longer describes. Deep-linkable as `?metric=`.
  const [picked, setPicked] = useState<StripFocus>(() => stripFocus(readHashQuery("metric")));
  // A tab metric writes the tab to the hash, and `openTab` only catches up on the next hashchange, so a click
  // would briefly look like a tab the pick doesn't match. This holds the tab a click asked for until it lands.
  const pendingTab = useRef<string | null>(null);
  const litTab = (tab: string) => openTab === tab || pendingTab.current === tab;
  const stripActive: StripFocus =
    picked === "history" ? (litTab("history") ? picked : null)
    : picked === "inflight" ? (litTab("requests") ? picked : null)
    : picked === "available" ? (typeFilter ? null : picked)
    : null;
  useEffect(() => { if (pendingTab.current === openTab) pendingTab.current = null; }, [openTab]);
  useEffect(() => { writeHashQuery("metric", stripActive); }, [stripActive]);
  // Spread onto a SummaryStrip item: the metric's own click plus its share of the single selection. `tab` is the
  // tab that click lands on, if any. Clicking the lit segment again puts the strip back to unselected.
  const metric = (key: NonNullable<StripFocus>, act: () => void, tab?: string) => ({
    onClick: () => {
      act();
      if (tab) pendingTab.current = tab;
      setPicked(stripActive === key ? null : key);
    },
    active: stripActive === key,
  });
  // Every metric goes somewhere: a balance clears the type narrowing, spent days open History, in-flight days
  // open the Requests tab, a booked break opens the calendar, and an approver's queue opens the inbox that
  // owns the decision. The three metrics that narrow the tables below share one `active` selection (see
  // `metric`), so clicking a segment lights it and darkens the others.
  const summary: SummaryItem[] = me.employee_id
    ? [
        {
          label: "Days available", icon: Wallet, value: fmtDays(availableDays), tone: availableDays > 0 ? "success" : "muted",
          hint: typeFilter
            ? `showing ${typeName(typeFilter)} only · clear`
            : myBalances.length ? `across ${myBalances.length} type${myBalances.length === 1 ? "" : "s"}` : "nothing accrued yet",
          ...metric("available", () => setTypeFilter(null)),
        },
        {
          label: "Taken this year", icon: CalendarCheck, value: fmtDays(usedThisYear), hint: `since ${shortDay(yearStart)}`,
          tone: usedThisYear ? "default" : "muted",
          ...metric("history", () => navigateTab("leave-requests", "history"), "history"),
        },
        {
          label: "Awaiting approval", icon: Clock, value: myPending.length, tone: myPending.length ? "warning" : "muted",
          hint: myPending.length ? `${fmtDays(sumDays(myPending))} day${sumDays(myPending) === 1 ? "" : "s"} held` : "nothing in flight",
          ...metric("inflight", () => navigateTab("leave-requests", "requests"), "requests"),
        },
        ...(pendingForMe.length
          ? [{
              label: "Awaiting your decision", icon: Clock, value: pendingForMe.length, tone: "warning" as const,
              hint: "from your team, below",
              onClick: () => document.getElementById("leave-pending-band")?.scrollIntoView({ behavior: "smooth", block: "start" }),
            }]
          : []),
        {
          label: onLeaveNow ? "On leave now" : "Next leave", icon: Plane,
          value: nextLeave ? shortRange(nextLeave.start_date, nextLeave.end_date) : "-",
          tone: nextLeave ? "primary" : "muted",
          hint: nextLeave
            ? `${onLeaveNow ? `back ${inDaysLabel(daysBetween(today, nextLeave.end_date) + 1)}` : inDaysLabel(daysBetween(today, nextLeave.start_date))}`
            : "nothing booked",
          onClick: () => navigate("leave-calendar"),
        },
        ...(outToday.length
          ? [{ label: "Colleagues off today", icon: Plane, value: outToday.length, tone: "default" as const, hint: "open the calendar", onClick: () => navigate("leave-calendar") }]
          : []),
      ]
    : [
        { label: "Pending requests", icon: Clock, value: rows.filter(isPending).length, hint: "decide in Approvals", tone: rows.some(isPending) ? "warning" : "muted", onClick: () => navigate("approvals") },
        { label: "Off today", icon: Plane, value: outToday.length, hint: "approved leave", tone: outToday.length ? "default" : "muted", onClick: () => navigate("leave-calendar") },
      ];
  // Balance left after this request and how many colleagues are already off then: the two numbers that decide
  // a leave request, phrased as the Approvals inbox phrases them.
  function decisionFacts(lr: LeaveRequest): string | null {
    const bal = leaveBalanceOf(lr, balances);
    const overlap = leaveOverlapCount(lr, rows);
    const parts: string[] = [];
    if (bal != null) parts.push(bal < lr.days ? `Balance ${fmtDays(bal)}d, not enough for ${fmtDays(lr.days)}d` : `Balance after: ${fmtDays(bal - lr.days)}d`);
    if (overlap > 0) parts.push(`${overlap} ${overlap === 1 ? "person is" : "people are"} already off then`);
    return parts.length ? parts.join(" · ") : null;
  }

  // Deciding straight from the row detail: an approver who opened a request to read its reason and balance
  // shouldn't have to close the sheet and hunt the same row down in the band above. Same verb, same optimistic
  // `decided` hide and badge refresh the band uses, so the two can't disagree about what is still pending.
  async function approveRequest(lr: LeaveRequest) {
    if (!(await confirmDecision(confirm, "approve", `${empName(lr.employee)}'s leave, ${formatDate(lr.start_date)} to ${formatDate(lr.end_date)} (${fmtDays(lr.days)} day${lr.days === 1 ? "" : "s"})`))) return;
    try {
      await invoke("leave-requests/" + idOf(lr.path), "approve", lr.etag);
      toast({ title: "Leave approved", variant: "success" });
      setDecided((d) => new Set(d).add(lr.path));
      approvals.reload();
      reloadAll();
    } catch (e) {
      toast({ title: "Couldn't approve leave request", description: (e as Error).message, variant: "destructive" });
    }
  }

  // The only per-row verb on this page (approve/reject live in the Approvals inbox). Cancelling an approved
  // leave gives up the approval (the server credits the days back), so that variant asks first.
  async function cancelRequest(lr: LeaveRequest) {
    if (upper(lr.state) === "APPROVED") {
      const ok = await confirm({
        title: "Cancel this approved leave?",
        description: `${formatDate(lr.start_date)} – ${formatDate(lr.end_date)} · ${lr.days} day${lr.days === 1 ? "" : "s"} will be credited back to the balance.`,
        confirmLabel: "Cancel leave",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await invoke("leave-requests/" + idOf(lr.path), "cancel", lr.etag);
      toast({ title: "Leave request cancelled", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't cancel leave request", description: (e as Error).message, variant: "destructive" });
    }
  }

  // A filed request is immutable by design (the balance is reserved against it), so "changing the dates" is
  // really cancel + file again. Doing both from one action - and carrying the type/dates/reason into the new
  // form - saves retyping the whole request to move it by a day.
  async function rescheduleRequest(lr: LeaveRequest) {
    const ok = await confirm({
      title: "Move this leave?",
      description: `${formatDate(lr.start_date)} - ${formatDate(lr.end_date)} will be cancelled and the days credited back, then a fresh request opens with the same details.`,
      confirmLabel: "Cancel and re-file",
    });
    if (!ok) return;
    try {
      await invoke("leave-requests/" + idOf(lr.path), "cancel", lr.etag);
      reloadAll();
      setDraft({
        leaveType: lr.leave_type ? `leave-types/${idOf(lr.leave_type)}` : undefined,
        from: lr.start_date,
        to: lr.end_date,
        startSession: lr.start_session ?? 1,
        endSession: lr.end_session ?? 2,
        reason: lr.reason ?? undefined,
      });
      setOpen(true);
    } catch (e) {
      toast({ title: "Couldn't cancel leave request", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Whose desk a pending request is actually on: the requester's manager, or - while an approval delegation
  // covers today - whoever is standing in for them. "Waiting on someone" beats "waiting".
  function deciderFor(lr: LeaveRequest): { name: string; coveringFor?: string; until?: string } | null {
    const managerRef = empOf(lr.employee)?.manager;
    if (!managerRef) return null;
    const active = delegations.find(
      (d) => d.delegator && idOf(d.delegator) === idOf(managerRef) && (d.from_date ?? "") <= today && (d.to_date ?? "") >= today,
    );
    if (active?.delegate) return { name: empName(active.delegate), coveringFor: empName(managerRef), until: active.to_date };
    return { name: empName(managerRef) };
  }

  // A supporting file (sick note, travel paperwork) attaches to the FILED request - the row has to exist for
  // the bytes to hang off, so this lives on the row/drawer rather than in the create form.
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<LeaveRequest | null>(null);
  function pickDocument(lr: LeaveRequest) {
    uploadTarget.current = lr;
    fileRef.current?.click();
  }
  async function onDocumentPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const lr = uploadTarget.current;
    e.target.value = ""; // allow re-picking the same file
    if (!f || !lr) return;
    try {
      await upload(`leave-requests/${idOf(lr.path)}`, f);
      toast({ title: "Document attached", variant: "success" });
      reloadAll();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  }
  const getDocument = (lr: LeaveRequest) => download("leave-requests/" + idOf(lr.path), `leave-${idOf(lr.path)}`);

  // ---- columns -------------------------------------------------------------
  const empCol: Column<LeaveRequest> = { id: "employee", header: "Employee", accessor: (lr) => empName(lr.employee), cell: (lr) => <span className="font-medium">{empName(lr.employee)}</span> };
  const baseCols: Column<LeaveRequest>[] = [
    { id: "type", header: "Type", filter: "select", accessor: (lr) => typeName(lr.leave_type),
      cell: (lr) => (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: typeColor(lr.leave_type) }} />
          {typeName(lr.leave_type)}
        </span>
      ) },
    { id: "start", header: "From", accessor: (lr) => lr.start_date, cell: (lr) => formatDate(lr.start_date) },
    { id: "end", header: "To", accessor: (lr) => lr.end_date, cell: (lr) => formatDate(lr.end_date) },
    { id: "days", header: "Days", align: "right", accessor: (lr) => lr.days, cell: (lr) => {
      const h = halfLabel(lr);
      const skip = nonWorking(lr.start_date, lr.end_date);
      const skipped = skip.weekends + skip.holidays.length;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular-nums">{fmtDays(lr.days)}</span>
          {/* Why the charge is smaller than the span: the server drops weekends and holidays, so name them. */}
          {skipped > 0 && (
            <span className="cursor-help text-xs text-muted-foreground" title={nonWorkingNote(skip)}>of {skip.span}</span>
          )}
          {h && <Badge variant="secondary" className="font-normal">{h}</Badge>}
        </span>
      );
    } },
    { id: "state", header: "Status", filter: "select", accessor: (lr) => lr.state,
      cell: (lr) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge state={lr.state} />
          {lr.has_document && <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-label="Has a supporting document" />}
        </span>
      ) },
    // The reason is masked in session replay (`data-sentry-mask`, see web/src/instrument.ts) while the rest of
    // the page - types, dates, balances, states - stays readable. Leave is the one ordinary-looking request
    // whose free text is routinely a diagnosis, a bereavement or a family emergency, and it is not worth
    // masking a whole page of business data to protect one column, nor worth recording it to keep the column.
    { id: "reason", header: "Reason", defaultHidden: true, accessor: (lr) => lr.reason ?? "", cell: (lr) => <span data-sentry-mask>{lr.reason || "-"}</span> },
  ];

  // Cancellable: a pending request, or an approved leave that hasn't started yet (server restores the balance).
  const isCancellable = (lr: LeaveRequest) => isPending(lr) || (upper(lr.state) === "APPROVED" && lr.start_date > today);
  const cancelCol: Column<LeaveRequest> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (lr) => (
      <div className="flex items-center justify-end gap-1">
        {isCancellable(lr) && canRequest && (
          <AccessAction collection="leave-requests" objectPath={lr.path} verb="cancel" can={lr.access?.can} label="Reschedule">
            <Button size="sm" variant="ghost" onClick={() => rescheduleRequest(lr)} title="Cancel this request and re-file it with the same details">
              <CalendarSync className="h-4 w-4" /> Move
            </Button>
          </AccessAction>
        )}
        {isCancellable(lr) && (
          <AccessAction collection="leave-requests" objectPath={lr.path} verb="cancel" can={lr.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => cancelRequest(lr)}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={lr.path} />
      </div>
    ),
  };
  // On the caller's own Requests tab, "From" also says how far away the leave is (starts in 3 days / ongoing).
  const startWhenCol: Column<LeaveRequest> = {
    id: "start", header: "From", accessor: (lr) => lr.start_date,
    cell: (lr) => {
      const w = whenLabel(lr, today);
      return <span className="inline-flex items-baseline gap-1.5">{formatDate(lr.start_date)}{w && <span className="text-xs text-muted-foreground">{w}</span>}</span>;
    },
  };
  const mineCols = [...baseCols.map((c) => (c.id === "start" ? startWhenCol : c)), ...metaColumns<LeaveRequest>(), cancelCol];
  // Approvers see everyone's settled leave in History, so show whose request it is. (Pending decisions live
  // in the unified Approvals inbox, not a per-page tab.)
  const activityCol: Column<LeaveRequest> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (lr) => <RowActivityButton resource={lr.path} /> };
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, ...metaColumns<LeaveRequest>(), activityCol] : [...baseCols, ...metaColumns<LeaveRequest>(), activityCol]);

  const requestBtn = (
    <AccessAction collection="leave-requests" create label="Request leave">
      <Button onClick={() => { setDraft(null); setOpen(true); }}><Plus className="h-4 w-4" /> Request leave</Button>
    </AccessAction>
  );
  // A balance card's "+" is a shortcut into the form: "spend this balance" opens the dialog already set to that type.
  const requestType = (leaveType?: string) => {
    if (!canRequest || !leaveType) return;
    setDraft({ leaveType: `leave-types/${idOf(leaveType)}` });
    setOpen(true);
  };
  // "Encash days" hands the type to the embedded Encashments tab and switches to it (the tab is a route
  // segment, so this is a normal navigation and stays back-button-able).
  const [encashDraftType, setEncashDraftType] = useState<string | null>(null);
  // "Where did my balance come from" - a derived ledger, not a stored one. Balances are read-only over the
  // API and move ONLY through accrual, a request's reserve/release and an encashment, so replaying those
  // reconstructs the year. The 1 Jan opening figure is the plug that makes it tie out to today's number, and
  // it says so - an invented history that didn't add up would be worse than none.
  const [ledgerPath, setLedgerPath] = useState<string | null>(null);
  const ledgerBalance = ledgerPath ? myBalances.find((b) => b.path === ledgerPath) : undefined;
  const ledger = useMemo(() => {
    if (!ledgerBalance) return null;
    const typeId = ledgerBalance.leave_type ? idOf(ledgerBalance.leave_type) : "";
    const entries: { on: string; label: string; days: number }[] = [];
    for (const a of accrualEntriesThisYear(typeOf(ledgerBalance.leave_type), meEmployee)) entries.push(a);
    for (const r of myAll) {
      if (!r.leave_type || idOf(r.leave_type) !== typeId) continue;
      const state = upper(r.state);
      // The reserve happens when the request is FILED, so that is the date the balance moved.
      if ((r.create_time ?? "") >= yearStart) {
        entries.push({ on: (r.create_time ?? "").slice(0, 10), label: `Requested ${shortRange(r.start_date, r.end_date)}`, days: -(r.days || 0) });
      }
      // …and comes back when the request is refused or withdrawn.
      if ((state === "REJECTED" || state === "CANCELLED") && (r.update_time ?? "") >= yearStart) {
        entries.push({ on: (r.update_time ?? "").slice(0, 10), label: `${state === "REJECTED" ? "Rejected" : "Cancelled"} ${shortRange(r.start_date, r.end_date)}`, days: r.days || 0 });
      }
    }
    for (const e of encashments) {
      if (!e.leave_type || idOf(e.leave_type) !== typeId) continue;
      if (!e.employee || !me.employee_id || idOf(e.employee) !== me.employee_id) continue;
      // An encashment debits on APPROVAL (not when it is filed), so pending ones have not moved the balance.
      if (["APPROVED", "PAID"].includes(upper(e.state)) && (e.update_time ?? "") >= yearStart) {
        entries.push({ on: (e.update_time ?? "").slice(0, 10), label: "Encashed", days: -(e.days || 0) });
      }
    }
    entries.sort((a, b) => a.on.localeCompare(b.on));
    const net = entries.reduce((n, e) => n + e.days, 0);
    // `round2` (lib/utils), not an inline `Math.round(n * 100) / 100`: leave days sit under the same rounding
    // rule as money (src/domain/money.ts is the one helper for both), and the inline form multiplies in float,
    // so a half-day balance can round the opposite way from the same figure everywhere else on the page.
    return { opening: round2(ledgerBalance.balance_days - net), entries };
  }, [ledgerBalance, myAll, encashments, typeOf, meEmployee, yearStart, me.employee_id]);

  // Row detail drawer, addressed by path so it survives a refetch replacing the row objects.
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const detailRow = detailPath ? [...tabRows, ...rows].find((r) => r.path === detailPath) : undefined;
  const encashType = (leaveType?: string) => {
    if (!leaveType) return;
    setEncashDraftType(`leave-types/${idOf(leaveType)}`);
    navigate("leave-requests/encashments");
  };
  // The card body toggles the server-side type filter on the tables below.
  const toggleTypeFilter = (leaveType?: string) => {
    if (!leaveType) return;
    const ref = `leave-types/${idOf(leaveType)}`;
    setTypeFilter((cur) => (cur === ref ? null : ref));
  };

  // Approver view: per-employee, per-type entitlement usage. Balances come from the leave-balances rows the
  // caller can already read (a manager's team, HR's org); used/pending are folded in from the leave requests
  // on this page - hence the truncation notice when that list is only its first page.
  const teamBalanceCols: Column<LeaveBalance>[] = [
    {
      id: "employee", header: "Employee", filter: "select", accessor: (b) => empName(b.employee),
      cell: (b) => (
        <span className="inline-flex items-center gap-2">
          <PhotoAvatar employeeId={b.employee ? idOf(b.employee) : ""} name={empName(b.employee)} photo={empOf(b.employee)?.photo} className="h-6 w-6" />
          <span className="truncate">{empName(b.employee)}</span>
        </span>
      ),
    },
    {
      id: "type", header: "Leave type", filter: "select", accessor: (b) => typeName(b.leave_type),
      cell: (b) => (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: typeColor(b.leave_type) }} />
          {typeName(b.leave_type)}
        </span>
      ),
    },
    { id: "left", header: "Days left", align: "right", accessor: (b) => b.balance_days, cell: (b) => <span className="font-medium tabular-nums">{fmtDays(b.balance_days)}</span> },
    { id: "used", header: "Used this year", align: "right", accessor: (b) => usageOf(b).used, cell: (b) => <span className="tabular-nums">{fmtDays(usageOf(b).used)}</span> },
    {
      id: "pending", header: "Pending", align: "right", accessor: (b) => usageOf(b).pending,
      cell: (b) => { const p = usageOf(b).pending; return <span className={cn("tabular-nums", !p && "text-muted-foreground")}>{fmtDays(p)}</span>; },
    },
    {
      id: "entitled", header: "Entitled/yr", align: "right", accessor: (b) => typeOf(b.leave_type)?.accrual_days_per_year ?? 0,
      cell: (b) => { const e = typeOf(b.leave_type)?.accrual_days_per_year; return <span className="tabular-nums text-muted-foreground">{e ? fmtDays(e) : "-"}</span>; },
    },
  ];
  const teamBalancesTab = (
    <div className="space-y-3">
      <TruncationNotice collection="leave-requests" what="leave requests" />
      <DataTable
        tableId="lv-team-balances"
        columns={teamBalanceCols}
        rows={teamBalances}
        getRowId={(b) => b.path}
        emptyTitle="No team balances"
        emptyDescription="Balances accrue per employee and leave type; nothing is visible to you yet."
        accessCollection="leave-balances"
        accessTargetOf={(b) => ({ objectPath: b.path, label: `${empName(b.employee)} · ${typeName(b.leave_type)}` })}
      />
    </div>
  );

  const renderTable = (search: RequestsHistorySearch, data: LeaveRequest[], columns: Column<LeaveRequest>[], tableId: string, emptyTitle: string, emptyDescription?: string) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      rows={data}
      search={search}
      onRowClick={(lr) => setDetailPath(lr.path)}
      getRowId={(lr) => lr.path}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      accessCollection="leave-requests"
      accessTargetOf={(lr) => ({ objectPath: lr.path, label: `Leave ${lr.start_date}`, can: lr.access?.can })}
    />
  );

  return (
    <div>
      <PageHeader
        title="Leaves"
        actions={
          <>
            <Button variant="outline" asChild><a href="#/leave-calendar"><CalendarRange className="h-4 w-4" /> Calendar</a></Button>
            {requestBtn}
            <PageSettings me={me} host="leave-requests" />
          </>
        }
      />

      {/* Where the year's leave actually went. Balances say what is left; these say what has been taken and
          when - the two questions a leave page is opened with, and the second one has never been answerable
          without reading the table row by row. Both charts are over the requests already on this page, so
          they cost nothing extra to draw. They lead, because everything below them is a filter for the
          tables at the bottom. */}
      {state === "ready" && leaveCharts.total > 0 && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Leave taken by month" description="Approved days, over the last twelve months.">
            <Chart
              type="bar"
              height={200}
              labels={leaveCharts.months.labels}
              datasets={[{ name: "Days", values: leaveCharts.months.values }]}
              format={(v) => fmtDays(v)}
              ariaLabel="Approved leave days taken in each of the last twelve months"
            />
          </ChartCard>
          <ChartCard title="By leave type" description="How the year's approved days divide between types.">
            <Chart
              type="donut"
              height={200}
              labels={leaveCharts.byType.labels}
              datasets={[{ name: "Days", values: leaveCharts.byType.values }]}
              colors={leaveCharts.byType.colors}
              format={(v) => fmtDays(v)}
              ariaLabel="Approved leave days by leave type this year"
            />
          </ChartCard>
        </div>
      )}

      {/* Answer-first: what's left, what's spent, what's in flight, when the next break is. */}
      {state === "ready" && <SummaryStrip items={summary} />}

      {/* Balance dashboard - the caller's own, accrued by the system. A card is two affordances: the card
          narrows the tables below to that type, the "+" requests it. Note the balance is DEBITED when a
          request is made (reserved), so pending days are already out of "days left" - the bar labels say so
          rather than double-counting them. */}
      {myBalances.length > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {myBalances.map((b) => {
            const reqs = myAll.filter((r) => r.leave_type && b.leave_type && idOf(r.leave_type) === idOf(b.leave_type));
            const used = sumDays(reqs.filter((r) => upper(r.state) === "APPROVED" && r.start_date >= yearStart));
            const pending = sumDays(reqs.filter(isPending));
            const type = typeOf(b.leave_type);
            const entitled = type?.accrual_days_per_year;
            const color = typeColor(b.leave_type);
            const usedPct = entitled ? Math.min(100, (used / entitled) * 100) : 0;
            const pendingPct = entitled ? Math.min(100 - usedPct, (pending / entitled) * 100) : 0;
            const active = !!b.leave_type && typeFilter === `leave-types/${idOf(b.leave_type)}`;
            const forecast = forecastBalance(b, type, meEmployee, caps);
            return (
              <div
                key={b.path}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`${active ? "Clear the filter on" : "Show only"} ${typeName(b.leave_type)}`}
                onClick={() => toggleTypeFilter(b.leave_type)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTypeFilter(b.leave_type); } }}
                className={cn(
                  "group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-4 pl-5 text-card-foreground shadow-card transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "ring-2 ring-primary",
                )}
              >
                {/* Colour rail ties the card to the type's pill on the leave calendar and dashboard timeline. */}
                <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{typeName(b.leave_type)}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {type && <Badge variant={type.paid ? "secondary" : "muted"}>{type.paid ? "Paid" : "Unpaid"}</Badge>}
                    {canRequest && (
                      <button
                        type="button"
                        aria-label={`Request ${typeName(b.leave_type)}`}
                        title={`Request ${typeName(b.leave_type)}`}
                        onClick={(e) => { e.stopPropagation(); requestType(b.leave_type); }}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 coarse:flex coarse:h-9 coarse:w-9 coarse:items-center coarse:justify-center coarse:p-0"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tabular-nums">{fmtDays(b.balance_days)}</span>
                  <span className="text-sm text-muted-foreground">days left</span>
                </div>
                {entitled ? (
                  <div className="mt-3">
                    {/* Two segments against the year's entitlement: days already taken, then days held by a
                        pending request (same colour, faded - they are spent unless the request is refused). */}
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full" style={{ width: `${usedPct}%`, backgroundColor: color }} />
                      <div className="h-full" style={{ width: `${pendingPct}%`, backgroundColor: color, opacity: 0.4 }} />
                    </div>
                    <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{fmtDays(used)} used{pending ? ` · ${fmtDays(pending)} held by pending` : ""}</span>
                      <span className="shrink-0">{fmtDays(entitled)}/yr</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-muted-foreground">{fmtDays(used)} used{pending ? ` · ${fmtDays(pending)} held by pending` : ""}</div>
                )}
                {/* What the balance is about to DO: the next credit, and what the year end takes back. Both
                    come from the server's own accrual + carry-forward math (lib/leaveForecast). */}
                {forecast && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs">
                    {forecast.next && (
                      <span className="text-muted-foreground">+{fmtDays(forecast.next.days)} on {shortDay(forecast.next.on)}</span>
                    )}
                    {forecast.excess > 0 && (
                      <span className={forecast.excessFate === "forfeit" ? "font-medium text-warning" : "text-muted-foreground"}>
                        {fmtDays(forecast.excess)} {forecast.excessFate === "forfeit" ? "lapses" : "auto-encashed"} on 31 Dec
                      </span>
                    )}
                  </p>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setLedgerPath(b.path); }}
                  // 12px text makes a 16px-tall target. The two links under a balance card are how anyone
                  // checks where their days went, and they sit on a card that is itself a button, so a near
                  // miss silently applies the card's filter instead. `-my-2 py-2` takes the box to 36px
                  // without moving the text.
                  className="-my-2 mr-3 mt-2 inline-flex items-center gap-1 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline coarse:min-h-9"
                >
                  <History className="h-3.5 w-3.5" /> History
                </button>
                {type?.encashable && canEncash && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); encashType(b.leave_type); }}
                    className="-my-2 mt-2 inline-flex items-center gap-1 py-2 text-xs font-medium text-primary hover:underline coarse:min-h-9"
                  >
                    <Coins className="h-3.5 w-3.5" /> Encash days
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* A new joiner has no balance rows at all, and a page that just omits the grid reads as broken rather
          than as "nothing accrued yet". Say what will happen instead. */}
      {state === "ready" && me.employee_id && myBalances.length === 0 && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium">No leave balance yet</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Balances accrue automatically{meEmployee?.start_date ? ` from your start date (${formatDate(meEmployee.start_date)})` : ""} and are credited on the 1st of each month.
              Unpaid leave types can still be requested now.
            </p>
          </div>
          {requestBtn}
        </Card>
      )}

      {/* Decisions, where the approver is already looking. The queue itself is the SAME session-wide read the
          Approvals inbox and the sidebar badge use (lib/approvals), so nothing is fetched twice and approving
          here updates the badge. Capped at five - the inbox owns the long tail. */}
      {pendingForMe.length > 0 && (
        <Card id="leave-pending-band" className="mb-6 scroll-mt-24 p-4">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4 text-warning" />
              Pending your decision
              <Badge variant="warning">{pendingForMe.length}</Badge>
            </p>
            <Button size="sm" variant="ghost" onClick={() => navigate("approvals")}>
              Open Approvals <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="divide-y">
            {pendingForMe.slice(0, 5).map((r) => (
              <ApprovalRow
                key={r.path}
                collection="leave-requests"
                row={r}
                employeeId={r.employee ? idOf(r.employee) : undefined}
                name={empName(r.employee)}
                photo={empOf(r.employee)?.photo}
                summary={leaveSummary(r, typeName)}
                context={leaveDecisionContext(r, balances, rows)}
                onApproved={(path) => { setDecided((d) => new Set(d).add(path)); approvals.reload(); reloadAll(); }}
                onRejectClick={() => setRejecting({ collection: "leave-requests", row: r, name: empName(r.employee), summary: leaveSummary(r, typeName) })}
              />
            ))}
          </div>
          {pendingForMe.length > 5 && (
            <p className="mt-2 text-xs text-muted-foreground">{pendingForMe.length - 5} more waiting in the Approvals inbox.</p>
          )}
        </Card>
      )}

      {/* Who else is off right now, from rows already loaded - the "can I take Friday too" check. */}
      {outToday.length > 0 && (
        <Card className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            {outToday.length} {outToday.length === 1 ? "person is" : "people are"} off today
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {outToday.slice(0, 6).map((r) => (
              <span key={r.path} className="inline-flex items-center gap-1.5 text-sm">
                <PhotoAvatar employeeId={r.employee ? idOf(r.employee) : ""} name={empName(r.employee)} photo={empOf(r.employee)?.photo} className="h-6 w-6" />
                <span className="truncate">{empName(r.employee)}</span>
                <span className="text-xs text-muted-foreground">back {inDaysLabel(daysBetween(today, r.end_date) + 1)}</span>
              </span>
            ))}
            {outToday.length > 6 && <span className="text-sm text-muted-foreground">+{outToday.length - 6} more</span>}
          </span>
          <a href="#/leave-calendar" className="ml-auto text-sm font-medium text-primary hover:underline">Leave calendar</a>
        </Card>
      )}

      {/* The active type filter, said out loud - a table that silently hides rows is worse than a slow one. */}
      {typeFilter && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Badge variant="secondary" className="gap-1.5 py-1 pl-2 pr-1">
            <Filter className="h-3.5 w-3.5" />
            Showing {typeName(typeFilter)} only
            <button type="button" aria-label="Clear the leave-type filter" onClick={() => setTypeFilter(null)} className="rounded p-0.5 hover:bg-background/60">
              <X className="h-3.5 w-3.5" />
            </button>
          </Badge>
          <span className="text-xs text-muted-foreground">Fetched from the server, so it reaches records past this page.</span>
        </div>
      )}

      <RequestsHistoryTabs
        collection="leave-requests"
        rows={tabRows}
        state={tabState}
        error={tabError}
        reload={reloadAll}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        isLive={(r) => isPending(r) || isUpcoming(r)}
        isPendingDecision={isPending}
        accessLabel="Leave requests"
        listParams={typeFilter ? { leave_type: typeFilter } : undefined}
        extraTabs={[
          ...(canDecide && teamBalances.length > 0 ? [{
            value: "team-balances",
            label: "Team balances",
            accessTarget: { collection: "leave-balances", label: "Leave balances" },
            content: teamBalancesTab,
          }] : []),
          ...(canEncash ? [{
            value: "encashments",
            label: "Encashments",
            accessTarget: { collection: "leave-encashments", label: "Encashments" },
            content: <LeaveEncashments embedded initialType={encashDraftType} meEmployeeId={me.employee_id} />,
          }] : []),
        ]}
        render={(items, mode, search) => {
          // Live requests read soonest-first; history reads most recent first.
          const sorted = [...items].sort((a, b) => (mode === "requests" ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date)));
          return mode === "requests"
            ? sorted.length === 0
              // A truly empty Requests tab gets a CTA into the create flow instead of a bare table shell.
              ? <EmptyState icon={CalendarPlus} title="No active requests" description="Pending and upcoming approved leave appears here." action={requestBtn} />
              : renderTable(search, sorted, mineCols, "leaves-active", "No active requests")
            : renderTable(search, sorted, historyCols, "leaves-history", "No decided leave", "Decided requests (approved, rejected or cancelled) appear here.");
        }}
      />

      {/* Where the balance came from. Derived (see the ledger memo), so the opening figure is labelled as such. */}
      <Sheet open={!!ledgerBalance} onOpenChange={(o) => { if (!o) setLedgerPath(null); }}>
        {ledgerBalance && ledger && (
          <SheetContent className="flex flex-col sm:max-w-lg">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: typeColor(ledgerBalance.leave_type) }} />
                {typeName(ledgerBalance.leave_type)} history
              </SheetTitle>
              <SheetDescription>Every movement this year, ending at today's {fmtDays(ledgerBalance.balance_days)} days.</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <ul className="divide-y text-sm">
                <li className="flex items-baseline justify-between gap-3 py-2">
                  <span>
                    Opening balance
                    <span className="block text-xs text-muted-foreground">1 Jan · derived, so the entries below reconcile</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{fmtDays(ledger.opening)}</span>
                </li>
                {ledger.entries.map((e, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                    <span>
                      {e.label}
                      <span className="block text-xs text-muted-foreground">{formatDate(e.on)}</span>
                    </span>
                    <span className={cn("shrink-0 tabular-nums", e.days < 0 ? "text-destructive" : "text-success")}>
                      {e.days < 0 ? "" : "+"}{fmtDays(e.days)}
                    </span>
                  </li>
                ))}
                <li className="flex items-baseline justify-between gap-3 py-2 font-medium">
                  <span>Balance today</span>
                  <span className="shrink-0 tabular-nums">{fmtDays(ledgerBalance.balance_days)}</span>
                </li>
              </ul>
              {!canEncash && (
                <p className="mt-3 text-xs text-muted-foreground">Encashments aren't visible to you, so any cash-out sits inside the opening figure.</p>
              )}
            </SheetBody>
          </SheetContent>
        )}
      </Sheet>

      {/* Row detail: the whole request in one place - half-day edges, what the range skipped, the reason, and
          the audit trail (mounted only when the Activity disclosure is opened, so no D1 read on open). */}
      <Sheet open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailPath(null); }}>
        {detailRow && (
          <SheetContent className="flex flex-col sm:max-w-lg">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: typeColor(detailRow.leave_type) }} />
                {typeName(detailRow.leave_type)}
              </SheetTitle>
              <SheetDescription>
                {formatDate(detailRow.start_date)} - {formatDate(detailRow.end_date)} · {fmtDays(detailRow.days)} day{detailRow.days === 1 ? "" : "s"}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge state={detailRow.state} />
                {halfLabel(detailRow) && <Badge variant="secondary" className="font-normal">{halfLabel(detailRow)}</Badge>}
                {whenLabel(detailRow, today) && <span className="text-xs text-muted-foreground">{whenLabel(detailRow, today)}</span>}
              </div>
              {canDecide && detailRow.employee && (
                <div className="flex items-center gap-2 text-sm">
                  <PhotoAvatar employeeId={idOf(detailRow.employee)} name={empName(detailRow.employee)} photo={empOf(detailRow.employee)?.photo} className="h-7 w-7" />
                  <span>
                    {empName(detailRow.employee)}
                    {/* The same balance/overlap facts the inbox row carries, from the same helpers - minus the
                        requester's reason, which the sheet already prints in full below. */}
                    <span className="block text-xs text-muted-foreground">{decisionFacts(detailRow)}</span>
                  </span>
                </div>
              )}
              {/* Underscore, not a comma: `grid-cols-[auto,1fr]` compiles to an invalid
                  `grid-template-columns: auto,1fr`, which browsers drop - so this list had been falling back
                  to a single column everywhere. Term and value pair up from `sm`; stacked on a phone, where
                  a label column would leave the values about 150px. */}
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Leave used</dt>
                <dd className="tabular-nums">
                  {fmtDays(detailRow.days)} day{detailRow.days === 1 ? "" : "s"} across {nonWorking(detailRow.start_date, detailRow.end_date).span} calendar days
                  <span className="block text-xs text-muted-foreground">{nonWorkingNote(nonWorking(detailRow.start_date, detailRow.end_date))}</span>
                </dd>
                <dt className="text-muted-foreground">Filed</dt>
                <dd>{formatDate(detailRow.create_time)}</dd>
                <dt className="text-muted-foreground">Reason</dt>
                {/* Masked in replay for the reason given on the `reason` column above. */}
                <dd data-sentry-mask>{detailRow.reason?.trim() || <span className="text-muted-foreground">Not given</span>}</dd>
                {isPending(detailRow) && deciderFor(detailRow) && (
                  <>
                    <dt className="text-muted-foreground">Awaiting</dt>
                    <dd>
                      {deciderFor(detailRow)!.name}
                      {deciderFor(detailRow)!.coveringFor && (
                        <span className="block text-xs text-muted-foreground">
                          covering for {deciderFor(detailRow)!.coveringFor} until {formatDate(deciderFor(detailRow)!.until)}
                        </span>
                      )}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Document</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {detailRow.has_document ? (
                    <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="download" can={detailRow.access?.can} label="Download document">
                      <Button size="sm" variant="outline" onClick={() => getDocument(detailRow)}><Download className="h-4 w-4" /> Download</Button>
                    </AccessAction>
                  ) : (
                    <span className="text-muted-foreground">None attached</span>
                  )}
                  {(detailRow.access?.can ?? []).includes("upload") && (
                    <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="upload" can={detailRow.access?.can} label="Attach document">
                      <Button size="sm" variant="ghost" onClick={() => pickDocument(detailRow)}>
                        <Paperclip className="h-4 w-4" /> {detailRow.has_document ? "Replace" : "Attach"}
                      </Button>
                    </AccessAction>
                  )}
                </dd>
              </dl>
              <ActivitySection resource={detailRow.path} />
            </SheetBody>
            {/* Up to four verbs can be live at once (an HR approver who can also cancel), so the row wraps
                rather than overflowing a phone-width sheet. */}
            <SheetFooter className="flex-wrap gap-y-2">
              {canDecide && isPending(detailRow) && !isOwn(detailRow) && (
                <>
                  <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="approve" can={detailRow.access?.can} label="Approve">
                    <Button variant="success" onClick={() => { const r = detailRow; setDetailPath(null); void approveRequest(r); }}>
                      <Check className="h-4 w-4" /> Approve
                    </Button>
                  </AccessAction>
                  <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="reject" can={detailRow.access?.can} label="Reject">
                    <Button variant="outline" onClick={() => { const r = detailRow; setDetailPath(null); setRejecting({ collection: "leave-requests", row: r, name: empName(r.employee), summary: leaveSummary(r, typeName) }); }}>
                      <X className="h-4 w-4" /> Reject
                    </Button>
                  </AccessAction>
                </>
              )}
              {isCancellable(detailRow) && canRequest && (
                <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="cancel" can={detailRow.access?.can} label="Reschedule">
                  <Button variant="outline" onClick={() => { const r = detailRow; setDetailPath(null); void rescheduleRequest(r); }}>
                    <CalendarSync className="h-4 w-4" /> Move
                  </Button>
                </AccessAction>
              )}
              {isCancellable(detailRow) && (
                <AccessAction collection="leave-requests" objectPath={detailRow.path} verb="cancel" can={detailRow.access?.can} label="Cancel">
                  <Button variant="destructive" onClick={() => { const r = detailRow; setDetailPath(null); void cancelRequest(r); }}>
                    <Ban className="h-4 w-4" /> Cancel leave
                  </Button>
                </AccessAction>
              )}
            </SheetFooter>
          </SheetContent>
        )}
      </Sheet>

      <input ref={fileRef} type="file" className="hidden" onChange={onDocumentPicked} accept="image/*,application/pdf" />
      {open && <RequestLeaveDialog open={open} onOpenChange={setOpen} me={me} initial={draft} onSubmitted={reloadAll} />}
      {/* Same confirm-with-note step the inbox uses - a one-click reject is too easy to do by accident. */}
      <RejectDialog
        target={rejecting}
        onClose={() => setRejecting(null)}
        onRejected={(path) => { setDecided((d) => new Set(d).add(path)); approvals.reload(); reloadAll(); }}
      />
    </div>
  );
}
