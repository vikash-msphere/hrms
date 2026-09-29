import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, Plus, Mail, UserPlus, Clock, LayoutGrid, List, Network, Layers, Search, UserRound, CalendarDays, Laptop } from "lucide-react";
import { create, patch, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useClock } from "@/lib/clock";
import { useDebounced } from "@/hooks/useDebounced";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf, reportsUnder } from "@/lib/utils";
import { addDaysYmd, daysBetweenYmd, todayStr, thisMonthStr } from "@/lib/orgDay";
import { daysSince } from "@/lib/tableDerive";
import { countBy } from "@/lib/tableSignals";
import { BLANK } from "@/lib/tableFilter";
import { navigate } from "@/router";
import type { Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { type TableInsight } from "@/components/common/TableInsights";
import { employeeStateColumn } from "@/components/common/stateColumn";
import { isCurrentEmployee } from "@/lib/employees";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { CopyEmail } from "@/components/common/CopyEmail";
import { Field, FieldRow } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { WriteDialog } from "@/components/common/WriteDialog";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { useChartFocus } from "@/lib/chartFocus";
import { monthlyTotals } from "@/lib/chartTheme";
import { readLocal, writeLocal } from "@/lib/localPref";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";

const NONE = "__none__";
type Form = { first_name: string; last_name: string; legal_name: string; employee_number: string; work_email: string; job_title: string; department: string; manager: string; start_date: string; probation_end_date: string };
const EMPTY: Form = { first_name: "", last_name: "", legal_name: "", employee_number: "", work_email: "", job_title: "", department: NONE, manager: NONE, start_date: "", probation_end_date: "" };

type ViewMode = "table" | "grid";
// Which summary metric the list is currently scoped to (null = the whole directory).
// The metric strip doubles as a filter set; these are the slices it can narrow the list to.
type Focus = null | "clockedIn" | "joined" | "joining" | "probation" | "noManager";
// A probation review is due when the end date falls between today and this many days out.
const PROBATION_SOON_DAYS = 30;
// Spelled out for the "Joined in" column, which is about the month of the year rather than a date.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "New"/"Joining" freshness from start_date alone: joined within the last 30 days, or a future
// start already on the books. Deleted rows never badge.
function joinBadge(e: Employee): "New" | "Joining" | null {
  if (!e.start_date || e.delete_time) return null;
  // A calendar-day question, answered in day strings on the ORG's clock (lib/orgDay#daysBetweenYmd). Turning
  // a date-only value into an instant at the VIEWER's midnight and differencing it against `Date.now()` is
  // wrong for part of every day and by a different amount per viewer - which `isJoiningSoon` five lines down
  // already avoids by comparing day strings.
  const days = daysBetweenYmd(e.start_date, todayStr());
  if (days < 0) return "Joining";
  return days <= 30 ? "New" : null;
}

function fullName(e: Employee) {
  return `${e.first_name} ${e.last_name}`;
}

// A start date still ahead: onboarding to prepare, not a colleague you can find at a desk.
function isJoiningSoon(e: Employee) {
  return !e.delete_time && !!e.start_date && e.start_date > todayStr();
}
// Probation ending today or inside the window: a confirm-or-extend decision somebody owes. A date already
// past is NOT counted: nothing records that a probation was confirmed, so "past" cannot tell an overdue
// review from one settled years ago, and counting it swept in everyone who ever finished probation. Same
// window as the dashboard's `probation_ending` card (services/dashboardSummary.ts), which links here.
function isProbationDue(e: Employee) {
  if (e.delete_time || !e.probation_end_date) return false;
  const days = daysBetweenYmd(todayStr(), e.probation_end_date);
  return days >= 0 && days <= PROBATION_SOON_DAYS;
}

/** Hover peek for a person, built entirely from the already-loaded row (no fetch). Wraps its
 *  children as the hover target; open/close on a short delay so it doesn't flicker on pass-over. */
function PersonPeek({
  e,
  deptLabel,
  managerName,
  clocked,
  children,
}: {
  e: Employee;
  deptLabel: string;
  managerName: string;
  clocked: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const badge = joinBadge(e);
  const arm = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span onMouseEnter={() => arm(true, 350)} onMouseLeave={() => arm(false, 150)}>
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        className="w-72"
        onOpenAutoFocus={(ev) => ev.preventDefault()}
        onMouseEnter={() => arm(true, 0)}
        onMouseLeave={() => arm(false, 150)}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="relative shrink-0">
            <PhotoAvatar employeeId={idOf(e.path)} name={fullName(e)} photo={e.photo} className="h-12 w-12" />
            {clocked && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-popover bg-success" title="Clocked in" />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{fullName(e)}</span>
              {badge && <Badge variant={badge === "New" ? "success" : "info"}>{badge}</Badge>}
            </div>
            {e.job_title && <div className="truncate text-xs text-muted-foreground">{e.job_title}</div>}
            {e.employee_number && <div className="font-mono text-[11px] text-muted-foreground">{e.employee_number}</div>}
          </div>
        </div>
        <dl className="mt-3 space-y-1 text-xs">
          {deptLabel && <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Department</dt><dd className="truncate">{deptLabel}</dd></div>}
          {managerName && <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Manager</dt><dd className="truncate">{managerName}</dd></div>}
          {e.start_date && <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Started</dt><dd>{formatDate(e.start_date)}</dd></div>}
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">Email</dt>
            {/* flex-1 (basis 0), not just min-w-0: as a content-sized flex item the cell would hand CopyEmail a
                max-content width and its inner truncate would never engage, spilling a long address out of the card. */}
            <dd className="min-w-0 flex-1" title={e.work_email}><CopyEmail email={e.work_email} /></dd>
          </div>
        </dl>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => navigate(`employees/${idOf(e.path)}`)}>Profile</Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={() => navigate(`org-chart/${idOf(e.path)}`)}>
            <Network className="h-3.5 w-3.5" /> Org chart
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EmployeeCard({ e, deptLabel, clocked }: { e: Employee; deptLabel: string; clocked: boolean }) {
  const badge = joinBadge(e);
  return (
    // A childless button stretched over the card, rather than `role="button"` on the card itself: ARIA makes a
    // button's children presentational (WAI-ARIA 1.2 §5.2.7), so the org-chart control nested inside one was
    // flattened into the card's accessible name and stopped being a control at all.
    <div className="group relative flex flex-col items-center gap-1 rounded-xl border bg-card p-4 text-center shadow-sm transition hover:border-primary/40 hover:shadow-md focus-within:border-primary/40">
      <button
        type="button"
        onClick={() => navigate(`employees/${idOf(e.path)}`)}
        aria-label={`Open ${fullName(e)}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="View in org chart"
          aria-label={`View ${fullName(e)} in the org chart`}
          onClick={() => navigate(`org-chart/${idOf(e.path)}`)}
        >
          <Network className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className="pointer-events-none relative">
        <PhotoAvatar employeeId={idOf(e.path)} name={fullName(e)} photo={e.photo} className="h-14 w-14" />
        {clocked && <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card bg-success" title="Clocked in" />}
      </span>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="truncate text-sm font-medium">{fullName(e)}</span>
        {badge && <Badge variant={badge === "New" ? "success" : "info"} className="px-1.5 py-0 text-[10px]">{badge}</Badge>}
      </div>
      {e.job_title && <div className="w-full truncate text-xs text-muted-foreground">{e.job_title}</div>}
      {deptLabel && <Badge variant="muted" className="max-w-full truncate font-normal">{deptLabel}</Badge>}
      {/* Above the overlay, so the copy affordance stays pressable - it is a control, not card text. */}
      <div className="relative z-10 mt-0.5 flex w-full items-center justify-center gap-1 text-[11px] text-muted-foreground">
        <Mail className="h-3 w-3 shrink-0" />
        <CopyEmail email={e.work_email} />
      </div>
    </div>
  );
}

export default function Directory({ me }: { me: Me }) {
  // Deleted people are their own view, reached by picking "Deleted" in the State filter (the column offers
  // that value whether or not any is loaded). Never mixed in by default: this list paginates, so carrying the
  // trash always would spend part of the page - and every viewer's D1 reads - on rows nobody asked for, and
  // on a large directory would push live colleagues off it.
  const [stateFilter, setStateFilter] = useState("");
  const deletedOnly = stateFilter === "Deleted";
  // `all`: this read backs the stats strip and the two charts, which claim to describe the whole org - the
  // comment on the second read below says so in as many words. Folded over a page they described the newest
  // hundred hires instead: "Employees · 100 · everyone you can see", a joiners-by-month chart that renders
  // every month before that hundred as zero growth (a steadily hiring company shows a cliff), and a "No
  // manager" count taken from the newest people, which is the opposite of where an orphaned reporting line
  // usually is. The search box was moved server-side for exactly this reason; the numbers above it were not.
  // `hasMore` stays true at ALL_CAP, so the grid's Load more still works.
  const { rows, state, error, reload, loadMore, hasMore } = useCollection<Employee>("employees", { deletedOnly, all: true });
  const { rows: depts } = useCollection<Department>("departments", { all: true });
  const { toast } = useToast();
  const sd = useSoftDelete("employees", "employee", reload);
  const lc = useLifecycle("employees", "employee", reload);
  const writable = usePermission("employees.write");
  const canPurge = usePermission("employees.admin");
  // Whose probation dates this caller holds is the SERVER's answer: `probation_end_date` is a redacted field
  // (src/domain/manifests.ts REDACTED_FIELDS), so it arrives only on the rows their grant reaches it on - HR's
  // everyone, a manager's team, their own. The KPI, the insight chip and the column read nothing else, and
  // vanish for a caller who holds no one else's. The caller's own row is left out of the follow-up count: a
  // probation ending is a review somebody else owes them.
  const isProbationDueToMe = useCallback((e: Employee) => idOf(e.path) !== me.employee_id && isProbationDue(e), [me.employee_id]);
  const seesProbation = useMemo(() => rows.some((e) => idOf(e.path) !== me.employee_id && !!e.probation_end_date), [rows, me.employee_id]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  // Email is required + well-formed only on create (it's not edited here). Empty passes the format check so
  // the inline error fires only on a malformed entry, not a pristine field.
  const emailOk = form.work_email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.work_email.trim());
  // Probation can't end before someone starts - the same rule the profile's employment editor enforces, applied
  // where the dates are first entered rather than only on the record that already has them.
  const datesOk = !form.start_date || !form.probation_end_date || form.probation_end_date >= form.start_date;
  const canSubmit = !!form.first_name.trim() && !!form.last_name.trim() && datesOk && (!!editing || (form.work_email.trim() !== "" && emailOk));
  // Why Save is greyed out, in the order someone fills the form in.
  const whyNot = !form.first_name.trim() || !form.last_name.trim()
    ? "Enter their first and last name."
    : !editing && !form.work_email.trim()
      ? "A work email is how they sign in."
      : !emailOk
        ? "That work email isn't a valid address."
        : !datesOk
          ? "Probation can't end before the start date."
          : undefined;
  // Someone with this name is already on the books. A namesake is legitimate (two Priya Sharmas happen), so
  // this warns and never blocks - a duplicate work email, which the server rejects outright, is a hard error.
  const namesake = useMemo(() => {
    if (editing) return null;
    const full = `${form.first_name.trim()} ${form.last_name.trim()}`.trim().toLowerCase();
    if (full.length < 3) return null;
    return rows.find((e) => !e.delete_time && `${e.first_name} ${e.last_name}`.trim().toLowerCase() === full) ?? null;
  }, [rows, editing, form.first_name, form.last_name]);

  /** Everyone under the person being edited - the manager picker must not offer any of them (`reportsUnder`). */
  const editSubordinateIds = useMemo(() => reportsUnder(rows, editing ? idOf(editing.path) : null), [rows, editing]);

  // Live presence: employee ids with an open clock session (drives the "clocked in" dot). The shared clock
  // (lib/clock.tsx, mounted in the shell) already reads exactly this set for the top-bar chip, so reading it
  // from there costs nothing - fetching it here again was the same query under a different URL, which the GET
  // coalescer can't dedupe.
  const { openSessions } = useClock();
  const clockedIn = useMemo(
    () => new Set(openSessions.map((s) => (s.employee ? idOf(s.employee) : "")).filter(Boolean)),
    [openSessions],
  );

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (path?: string) => (path ? m.get(idOf(path)) ?? "Unknown department" : "");
  }, [depts]);
  const empName = useMemo(() => {
    const m = new Map(rows.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    // A manager outside the caller's slice of the directory is the ordinary case here, and reads as a word
    // rather than as a 26-character wire id (lib/utils.ts `personName`).
    return (path?: string) => (path ? m.get(idOf(path)) ?? "Someone" : "");
  }, [rows]);

  // One search box across the fields people actually look someone up by (name/ID/title/email), instead of
  // hunting for the right per-column filter. It runs on the SERVER (`?q=`, FTS-backed), because a list page
  // caps at 100 rows: filtering here would only ever search the slice already loaded, so anyone past the
  // first page would be unfindable. Department still has its own column filter.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  // Two reads, deliberately: the unfiltered one above backs the stats (which must count the whole org, not
  // the current search) and is the entry every other page shares; this one is the search result set.
  const { rows: searchRows, state: searchState, hasMore: searchHasMore, loadMore: loadMoreSearch } = useCollection<Employee>("employees", {
    deletedOnly,
    q: debouncedQ,
    enabled: searching,
  });
  const visibleRows = searching ? searchRows : rows;

  // View mode (table vs card grid) + grid grouping, remembered locally. Both views render the same
  // already-loaded rows - switching never refetches.
  const [view, setView] = useState<ViewMode>(() => (readLocal("directory:view") === "grid" ? "grid" : "table"));
  const setViewMode = (v: ViewMode) => {
    setView(v);
    writeLocal("directory:view", v);
  };
  const [grouped, setGrouped] = useState(() => readLocal("directory:grouped") === "1");
  const toggleGrouped = () => {
    setGrouped((g) => {
      writeLocal("directory:grouped", g ? "0" : "1");
      return !g;
    });
  };

  // The summary metrics double as filters: clicking one narrows the list to the people it counts, so a
  // number the reader wants to inspect never has to be translated into a filter by hand. Stacks with the
  // department chips and the search box below.
  const [focus, setFocus] = useState<Focus>(null);
  const focusRows = useMemo(() => {
    if (!focus) return visibleRows;
    const live = visibleRows.filter(isCurrentEmployee);
    if (focus === "clockedIn") return live.filter((e) => clockedIn.has(idOf(e.path)));
    if (focus === "joining") return live.filter(isJoiningSoon);
    if (focus === "probation") return live.filter(isProbationDueToMe);
    if (focus === "noManager") return live.filter((e) => !e.manager);
    const month = thisMonthStr();
    return live.filter((e) => (e.start_date ?? "").slice(0, 7) === month);
  }, [visibleRows, focus, clockedIn, isProbationDueToMe]);

  // Department quick-filter chips, counted from the (live) rows the chips actually narrow: whichever row set
  // is showing (browse or search) with the picked metric already applied, and the department dimension itself
  // left out. A count that ignored the metric above it would contradict the list below.
  const [deptChip, setDeptChip] = useState<string | null>(null);
  const deptChips = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const e of focusRows) {
      // Counted over the rows the table is showing: the people still here, or - once the State column is
      // filtered - whichever state was picked, which the table narrows to itself.
      if (!stateFilter && !isCurrentEmployee(e)) continue;
      if (e.department) counts.set(idOf(e.department), (counts.get(idOf(e.department)) ?? 0) + 1);
      else none++;
    }
    const chips = [...counts.entries()]
      .map(([id, n]) => ({ id, name: deptName(id) || id, n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    if (none > 0) chips.push({ id: NONE, name: "No department", n: none });
    // A picked chip the narrowed set no longer has anybody in keeps its place at zero: dropping it would
    // leave the list filtered by a chip with no way left to unpick it.
    if (deptChip && !chips.some((c) => c.id === deptChip)) {
      chips.push({ id: deptChip, name: deptChip === NONE ? "No department" : deptName(deptChip) || deptChip, n: 0 });
    }
    return chips;
  }, [focusRows, deptChip, deptName, stateFilter]);
  const chipRows = useMemo(() => {
    if (!deptChip) return focusRows;
    if (deptChip === NONE) return focusRows.filter((e) => !e.department);
    return focusRows.filter((e) => e.department && idOf(e.department) === deptChip);
  }, [focusRows, deptChip]);

  // The grid is a browsing surface: deleted people stay table-only (that's where restore/purge lives).
  // The org's distribution and its growth, over the WHOLE live directory - never over the narrowed set. A
  // chart drawn from rows its own bar has already filtered collapses to that one bar the moment it is
  // pressed, leaving the reader holding a filter with nothing left to press to undo it. Clicking a
  // department bar picks the same chip the row of chips below would: the chart is a filter, not a picture
  // beside one.
  const orgCharts = useMemo(() => {
    const live = rows.filter(isCurrentEmployee);
    const counts = new Map<string, { id: string; n: number }>();
    for (const e of live) {
      const id = e.department ? idOf(e.department) : NONE;
      const entry = counts.get(id) ?? { id, n: 0 };
      entry.n++;
      counts.set(id, entry);
    }
    const sorted = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    return {
      depts: {
        labels: sorted.map((d) => (d.id === NONE ? "No department" : deptName(d.id) || d.id)),
        values: sorted.map((d) => d.n),
      },
      deptIds: sorted.map((d) => d.id),
      joiners: monthlyTotals(live.filter((e) => e.start_date).map((e) => ({ date: e.start_date!, value: 1 })), 12, todayStr()),
    };
  }, [rows, deptName]);
  const setDeptFilter = (id: string | null) => setDeptChip((c) => (c === id ? null : id));

  // The joiners chart's own filter. The department bar drives the chips below it (that dimension already has
  // a visible control, and two surfaces for one filter is one too many); a start month has no chip, so it
  // gets one of its own in the URL.
  const cf = useChartFocus<Employee, "startMonth">({
    startMonth: {
      keys: orgCharts.joiners.keys,
      label: (k) => orgCharts.joiners.labels[orgCharts.joiners.keys.indexOf(k)] ?? k,
      match: (e, k) => (e.start_date ?? "").slice(0, 7) === k,
    },
  });
  const monthRows = useMemo(
    () => cf.apply(chipRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chipRows, cf.picked?.key],
  );
  // The grid has no State column to filter by, so it only ever shows the people still here.
  const gridRows = useMemo(() => monthRows.filter(isCurrentEmployee), [monthRows]);
  const gridSections = useMemo(() => {
    if (!grouped) return null;
    const by = new Map<string, Employee[]>();
    for (const e of gridRows) {
      const key = deptName(e.department) || "No department";
      const list = by.get(key) ?? [];
      list.push(e);
      by.set(key, list);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [grouped, gridRows, deptName]);

  const stats = useMemo(() => {
    const live = rows.filter(isCurrentEmployee);
    const month = thisMonthStr();
    return {
      total: live.length,
      clockedIn: live.filter((e) => clockedIn.has(idOf(e.path))).length,
      joined: live.filter((e) => (e.start_date ?? "").slice(0, 7) === month).length,
      // Who is still to arrive, whose probation review is due, and who reports to nobody: the three gaps HR
      // otherwise finds by scrolling the table with two hidden columns switched on.
      joining: live.filter(isJoiningSoon).length,
      probation: live.filter(isProbationDueToMe).length,
      noManager: live.filter((e) => !e.manager).length,
    };
  }, [rows, clockedIn, isProbationDueToMe]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  useIntent("new-employee", openCreate);
  function openEdit(e: Employee) {
    setEditing(e);
    setForm({
      first_name: e.first_name,
      last_name: e.last_name,
      legal_name: e.legal_name ?? "",
      employee_number: e.employee_number ?? "",
      work_email: e.work_email,
      job_title: e.job_title ?? "",
      department: e.department ? `departments/${idOf(e.department)}` : NONE,
      manager: e.manager ? `employees/${idOf(e.manager)}` : NONE,
      start_date: e.start_date ?? "",
      probation_end_date: e.probation_end_date ?? "",
    });
    setOpen(true);
  }

  // Throws on failure: WriteDialog pins the reason in the form and keeps everything typed so far.
  async function submit() {
    const dept = form.department === NONE ? null : form.department;
    const mgr = form.manager === NONE ? null : form.manager;
    if (editing) {
      await patch(
        "employees/" + idOf(editing.path),
        {
          first_name: form.first_name,
          last_name: form.last_name,
          legal_name: form.legal_name.trim(),
          employee_number: form.employee_number.trim() || undefined,
          job_title: form.job_title,
          department: dept,
          manager: mgr,
          // `format: date` fields, and "" is not a date - an empty one is left out.
          ...(form.start_date ? { start_date: form.start_date } : {}),
          ...(form.probation_end_date ? { probation_end_date: form.probation_end_date } : {}),
        },
        editing.etag
      );
      toast({ title: "Employee updated", variant: "success" });
    } else {
      await create("employees", {
        first_name: form.first_name,
        last_name: form.last_name,
        legal_name: form.legal_name.trim() || undefined,
        employee_number: form.employee_number.trim() || undefined,
        work_email: form.work_email,
        job_title: form.job_title || undefined,
        department: dept || undefined,
        manager: mgr || undefined,
        start_date: form.start_date || undefined,
        probation_end_date: form.probation_end_date || undefined,
      });
      toast({ title: "Employee added", variant: "success" });
    }
    reload();
  }

  // How many people each person manages, counted from the directory rows themselves. It is a count over what
  // is LOADED, which on a truncated directory is a floor rather than a total - the same caveat the page's own
  // headcount tile already carries.
  const reportCounts = useMemo(
    () => countBy(rows.filter(isCurrentEmployee), (e) => (e.manager ? idOf(e.manager) : null)),
    [rows],
  );
  /** "09" as "September", for the anniversary column and the chip that filters it. */
  const monthName = (mm: string) => MONTH_NAMES[Number(mm) - 1] ?? "";

  // The two dates HR is chased about, and the gap that makes an org chart wrong. Each chip turns on the
  // column it is about, because all three live in the column picker rather than on screen by default.
  const directoryInsights = (es: Employee[]): TableInsight[] => {
    const live = es.filter(isCurrentEmployee);
    const out: TableInsight[] = [];
    const probation = live.filter(isProbationDueToMe);
    if (probation.length > 0) {
      out.push({
        id: "probation",
        label: `${probation.length} finishing probation in ${PROBATION_SOON_DAYS} days`,
        tone: "warning",
        hint: "Confirmation conversations to have before the date passes.",
        filters: { probation_end_date: `${todayStr()}..${addDaysYmd(todayStr(), PROBATION_SOON_DAYS)}` },
        sort: "probation_end_date.asc",
      });
    }
    const joined = live.filter((e) => e.start_date && e.start_date >= addDaysYmd(todayStr(), -30) && e.start_date <= todayStr());
    if (joined.length > 0) {
      out.push({
        id: "joined",
        label: `${joined.length} joined in the last 30 days`,
        tone: "success",
        filters: { start_date: "last30" },
        sort: "start_date.desc",
      });
    }
    const unmanaged = live.filter((e) => !empName(e.manager));
    // One person at the top of the tree reports to nobody and that is correct, so this only speaks up
    // when there are several.
    if (unmanaged.length > 1) {
      out.push({
        id: "no-manager",
        label: `${unmanaged.length} with no manager`,
        hint: "Approvals route up the manager chain, so these have nowhere to send a request.",
        filters: { manager: BLANK },
      });
    }
    // Missing an employee ID. It is what letters, payroll files and statutory reports quote, and the gap is
    // invisible until one of those has to be produced for that person.
    const noNumber = live.filter((e) => !e.employee_number?.trim());
    if (noNumber.length > 0) {
      out.push({
        id: "no-employee-number",
        label: `${noNumber.length} with no employee ID`,
        tone: "warning",
        hint: "Letters, payroll files and statutory reports all quote it.",
        filters: { employee_number: BLANK },
      });
    }
    // Missing a department. It breaks the org chart's rollups and every department-scoped access rule, so
    // the person quietly falls outside their own team's view.
    const noDept = live.filter((e) => !e.department);
    if (noDept.length > 0) {
      out.push({
        id: "no-department",
        label: `${noDept.length} in no department`,
        tone: "warning",
        hint: "They fall outside department rollups and any access rule scoped to a team.",
        filters: { department: BLANK },
      });
    }
    // Work anniversaries this month, which is the one date on this page that produces a nice thing to do
    // rather than a gap to fix. Counted on completed years only, so somebody's first month is not an
    // anniversary.
    const month = todayStr().slice(5, 7);
    const anniversaries = live.filter((e) => {
      if (!e.start_date || e.start_date.slice(5, 7) !== month) return false;
      const days = daysSince(e.start_date);
      return days != null && days >= 365;
    });
    if (anniversaries.length > 0) {
      out.push({
        id: "anniversaries",
        label: `${anniversaries.length} work anniversaries this month`,
        tone: "success",
        hint: "A year or more of service, with the anniversary falling this month.",
        // On the derived month column, not on `start_date`: a date filter of "2026-09" means September of
        // THAT year, and an anniversary is September of any year.
        filters: { anniversary: monthName(month), tenure: ">=1" },
        sort: "tenure.desc",
      });
    }
    return out;
  };

  const columns: Column<Employee>[] = [
    {
      id: "name",
      header: "Name",
      accessor: (e) => `${e.first_name} ${e.last_name}`,
      // A person's name is a way out of this table, not just a value in it. Right-clicking it offers their
      // own pages, which is the difference between a directory and twenty separate lists somebody has to
      // retype a name into.
      actions: (e) => [
        { label: "Open profile", icon: <UserRound className="h-4 w-4" />, onSelect: () => navigate(`employees/${idOf(e.path)}`) },
        { label: "Show in org chart", icon: <Network className="h-4 w-4" />, onSelect: () => navigate(`org-chart/${idOf(e.path)}`) },
        // The profile's tabs are the URL's third segment (see EmployeeProfile), so these are addresses
        // rather than a query the page would have to interpret.
        { label: "Their leave", icon: <CalendarDays className="h-4 w-4" />, onSelect: () => navigate(`employees/${idOf(e.path)}/leave`) },
        // Assets live on the Employment tab rather than one of their own, so that is where this lands.
        { label: "Their kit and employment", icon: <Laptop className="h-4 w-4" />, onSelect: () => navigate(`employees/${idOf(e.path)}/employment`) },
      ],
      cell: (e) => {
        const badge = joinBadge(e);
        return (
          <PersonPeek e={e} deptLabel={deptName(e.department)} managerName={empName(e.manager)} clocked={clockedIn.has(idOf(e.path))}>
            <span className="flex items-center gap-3">
              <span className="relative">
                <PhotoAvatar employeeId={idOf(e.path)} name={`${e.first_name} ${e.last_name}`} photo={e.photo} className="h-9 w-9" />
                {clockedIn.has(idOf(e.path)) && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card bg-success" title="Clocked in" />
                )}
              </span>
              <span className="font-medium">{e.first_name} {e.last_name}</span>
              {badge && <Badge variant={badge === "New" ? "success" : "info"} className="px-1.5 py-0 text-[10px]">{badge}</Badge>}
            </span>
          </PersonPeek>
        );
      },
    },
    { id: "employee_number", header: "Employee ID", accessor: (e) => e.employee_number ?? "", cell: (e) => e.employee_number ? <span className="font-mono text-xs">{e.employee_number}</span> : "-" },
    { id: "title", header: "Title", filter: "select", groupBy: true, accessor: (e) => e.job_title ?? "", cell: (e) => e.job_title ?? "-" },
    { id: "department", header: "Department", filter: "select", groupBy: true, accessor: (e) => deptName(e.department) || "-" },
    {
      id: "email",
      header: "Email",
      accessor: (e) => e.work_email,
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Mail className="h-3.5 w-3.5 shrink-0" /> <CopyEmail email={e.work_email} />
        </span>
      ),
    },
    {
      id: "bio",
      header: "About",
      defaultHidden: true,
      filter: "none",
      accessor: (e) => e.bio ?? "",
      cell: (e) => (e.bio ? <span className="line-clamp-1 max-w-[36ch] text-muted-foreground">{e.bio}</span> : "-"),
    },
    // Grouping the directory by manager is an org chart in list form, and the one most people reach for.
    // The accessor is EMPTY when there is no manager rather than "-": blank is a filterable value
    // ("(Blank)" in the picker, which is how the no-manager chip narrows), a dash is a made-up one.
    { id: "manager", header: "Manager", defaultHidden: true, filter: "select", groupBy: true, accessor: (e) => empName(e.manager), cell: (e) => empName(e.manager) || <span className="text-muted-foreground">-</span> },
    // Both are calendar questions, and both were unaskable: "who joined this quarter" and "whose probation
    // ends before the end of the month" are the two dates HR is chased for.
    { id: "start_date", header: "Start date", defaultHidden: true, filter: "date", dateHint: "past", accessor: (e) => e.start_date ?? "", cell: (e) => (e.start_date ? formatDate(e.start_date) : "-") },
    {
      // Service, in years, from the start date. A date column can only be asked calendar questions, so
      // "everyone past five years" - the service-award list, and the first thing asked of a directory in a
      // review cycle - could not be asked at all. Averaged in the footer, where it reads per department or
      // per manager once the table is grouped.
      id: "tenure", header: "Tenure", align: "right", defaultHidden: true, filter: "number", aggregate: "avg",
      formatTotal: (n) => `${Math.round(n * 10) / 10} yrs`,
      accessor: (e) => {
        const days = daysSince(e.start_date);
        return days == null || days < 0 ? null : Math.round((days / 365.25) * 10) / 10;
      },
      cell: (e) => {
        const days = daysSince(e.start_date);
        if (days == null || days < 0) return <span className="text-muted-foreground">-</span>;
        const years = days / 365.25;
        return <span className="tabular-nums">{years < 1 ? `${Math.max(1, Math.round(days / 30))}m` : `${Math.round(years * 10) / 10}y`}</span>;
      },
    },
    {
      // How many people report to this person, counted from the directory itself. It is the question behind
      // both "who is carrying too many" and "who is a manager on paper only", and neither was answerable
      // from a column that only named somebody's own manager.
      // The month somebody's start date falls in, whatever the year. A date column cannot answer "who has an
      // anniversary in September" - "2026-09" is one September - so the recurring half of a start date needs
      // a column of its own. Groupable, which turns the directory into a service-award calendar.
      id: "anniversary", header: "Joined in", filter: "select", groupBy: true, defaultHidden: true,
      accessor: (e) => (e.start_date ? monthName(e.start_date.slice(5, 7)) : ""),
    },
    {
      id: "reports", header: "Reports", align: "right", defaultHidden: true, filter: "number",
      accessor: (e) => reportCounts.get(idOf(e.path)) ?? 0,
      cell: (e) => {
        const n = reportCounts.get(idOf(e.path)) ?? 0;
        return n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">-</span>;
      },
    },
    ...(seesProbation
      ? [{ id: "probation_end_date", header: "Probation ends", defaultHidden: true, filter: "date" as const, dateHint: "future" as const, accessor: (e: Employee) => e.probation_end_date ?? "", cell: (e: Employee) => (e.probation_end_date ? <span data-sentry-mask>{formatDate(e.probation_end_date)}</span> : "-") }]
      : []),
    // Leavers and switched-off records are held back until this column is filtered for them ("Exited",
    // "Disabled"); "Deleted" is fetched on demand and offered with none loaded.
    employeeStateColumn<Employee>(),
    ...metaColumns<Employee>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (e) => (
        <div onClick={(ev) => ev.stopPropagation()}>
          <SoftDeleteRowActions row={e} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />
        </div>
      ),
    },
  ];

  const gridHasMore = searching ? searchHasMore : hasMore;
  // An empty list under a metric filter names the scope that emptied it, so the reader isn't left guessing
  // why the directory looks empty.
  const emptyLabel =
    focus === "clockedIn" ? "Nobody is clocked in right now"
    : focus === "joined" ? "Nobody joined this month"
    : focus === "joining" ? "Nobody has a future start date"
    : focus === "probation" ? "No probation reviews are due"
    : focus === "noManager" ? "Everybody has a manager"
    : "No employees match";
  const gridEmpty = searching && searchState === "loading" ? "Searching…" : emptyLabel;

  const renderGrid = (people: Employee[]) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {people.map((e) => (
        <EmployeeCard key={e.path} e={e} deptLabel={deptName(e.department)} clocked={clockedIn.has(idOf(e.path))} />
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Directory"
        description="Everyone in the organization."
        actions={<>{writable && <AccessAction collection="employees" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add employee</Button></AccessAction>}<PageSettings me={me} host="employees" /></>}
      />

      {/* The org's shape. A directory lists people one at a time and never says how the company is
          distributed - which department carries the headcount, and when the growth actually happened. */}
      {state === "ready" && rows.length > 3 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Headcount by department" description="Everyone you can see, by the team they sit in.">
            <Chart
              type="bar"
              height={Math.min(320, Math.max(160, orgCharts.depts.labels.length * 34 + 60))}
              labels={orgCharts.depts.labels}
              datasets={[{ name: "People", values: orgCharts.depts.values }]}
              ariaLabel="Headcount by department"
              onSelect={(i) => setDeptFilter(orgCharts.deptIds[i] ?? null)}
              selected={deptChip ? (orgCharts.deptIds.indexOf(deptChip) >= 0 ? orgCharts.deptIds.indexOf(deptChip) : null) : null}
            />
          </ChartCard>
          <ChartCard title="Joiners by month" description="Who started when, over the last twelve months.">
            <Chart
              type="bar"
              height={200}
              labels={orgCharts.joiners.labels}
              datasets={[{ name: "Joiners", values: orgCharts.joiners.values }]}
              format={(v) => `${v} joiner${v === 1 ? "" : "s"}`}
              ariaLabel="How many people started in each of the last twelve months"
              {...cf.chart("startMonth")}
            />
          </ChartCard>
        </div>
      )}

      {/* Each metric focuses the table below it, so the strip sits against the table - under the charts. */}
      <SummaryStrip
        items={[
          // A very large directory still passes ALL_CAP, and at that point the headline stops asserting a
          // completeness it cannot check: the `+` is the vocabulary the pager already uses.
          { label: "Employees", value: `${stats.total}${hasMore ? "+" : ""}`, icon: Users, hint: hasMore ? "loaded so far" : "everyone you can see", onClick: () => setFocus(null), active: focus === null },
          {
            label: "Clocked in now",
            value: stats.clockedIn,
            icon: Clock,
            tone: stats.clockedIn > 0 ? "success" : "muted",
            hint: "on the clock now",
            onClick: () => setFocus((f) => (f === "clockedIn" ? null : "clockedIn")),
            active: focus === "clockedIn",
          },
          {
            label: "Joined this month",
            value: stats.joined,
            icon: UserPlus,
            tone: stats.joined > 0 ? "primary" : "muted",
            hint: "new starters",
            onClick: () => setFocus((f) => (f === "joined" ? null : "joined")),
            active: focus === "joined",
          },
          ...(stats.joining
            ? [{
                label: "Joining soon", value: stats.joining, icon: UserPlus, tone: "primary" as const, hint: "not started yet",
                onClick: () => setFocus((f) => (f === "joining" ? null : "joining")), active: focus === "joining",
              }]
            : []),
          ...(stats.probation
            ? [{
                label: "Probation due", value: stats.probation, icon: Users, tone: "warning" as const, hint: `ends in ${PROBATION_SOON_DAYS}d`,
                onClick: () => setFocus((f) => (f === "probation" ? null : "probation")), active: focus === "probation",
              }]
            : []),
          ...(stats.noManager
            ? [{
                label: "No manager", value: stats.noManager, icon: Users, tone: "warning" as const, hint: "no approver",
                onClick: () => setFocus((f) => (f === "noManager" ? null : "noManager")), active: focus === "noManager",
              }]
            : []),
        ]}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            illustration="team"
                title="No employees yet"
            description="Add your first employee to build the directory."
            action={writable && <AccessAction collection="employees" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add employee</Button></AccessAction>}
          />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {deptChips.length > 1 && (
                // A dozen departments wrapping to four rows of chips pushes the actual list off a phone
                // screen. One scrolling row below `sm` (with an edge shadow so it reads as scrollable),
                // wrapping as before from `sm` up where there is width to wrap into.
                <div className="scroll-shadow-x no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
                  <button
                    onClick={() => setDeptChip(null)}
                    className={cn(
                      "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                      deptChip === null ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    All
                  </button>
                  {deptChips.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setDeptChip(deptChip === c.id ? null : c.id)}
                      className={cn(
                        "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                        deptChip === c.id ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {c.name} <span className="opacity-60">{c.n}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                {view === "grid" && (
                  <Button variant={grouped ? "secondary" : "ghost"} size="sm" onClick={toggleGrouped} title="Group by department">
                    <Layers className="h-4 w-4" /> Grouped
                  </Button>
                )}
                <div className="flex items-center rounded-lg border bg-card p-0.5">
                  <Button variant={view === "table" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setViewMode("table")} title="Table view">
                    <List className="h-4 w-4" />
                  </Button>
                  <Button variant={view === "grid" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setViewMode("grid")} title="Card view">
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <ChartFilterNote label={cf.activeLabel && `Joined ${cf.activeLabel}`} shown={monthRows.length} total={chipRows.length} onClear={cf.clear} />

            {view === "table" ? (
              <DataTable
                columns={columns}
                insights={directoryInsights}
                tableId="employees"
                rows={monthRows}
                getRowId={(e) => e.path}
                onRowClick={(e) => !e.delete_time && navigate(`employees/${idOf(e.path)}`)}
                rowClassName={(e) => (isCurrentEmployee(e) ? undefined : "opacity-60")}
                search={{ value: search, onChange: setSearch, placeholder: "Search people…" }}
                // While searching, the rows ARE the complete server-side result, so the table must not claim to be
                // showing a truncated first page of the collection.
                hasMore={searching ? searchHasMore : undefined}
                onLoadMore={searching ? loadMoreSearch : loadMore}
                emptyTitle={searching && searchState === "loading" ? "Searching…" : emptyLabel}
                accessCollection="employees"
                onFilterChange={(colId, value) => colId === "state" && setStateFilter(value)}
                accessTargetOf={(e) => ({ objectPath: e.path, label: `${e.first_name} ${e.last_name}`, can: e.access?.can })}
              />
            ) : (
              <div>
                <div className="relative mb-3 max-w-sm">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input type="search" value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="Search people…" className="pl-8" />
                </div>
                {gridRows.length === 0 ? (
                  <div className="rounded-xl border bg-card py-12 text-center text-sm text-muted-foreground">{gridEmpty}</div>
                ) : gridSections ? (
                  <div className="space-y-6">
                    {gridSections.map(([name, people]) => (
                      <section key={name}>
                        <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
                          {name} <span className="text-xs font-normal text-muted-foreground">{people.length}</span>
                        </h3>
                        {renderGrid(people)}
                      </section>
                    ))}
                  </div>
                ) : (
                  renderGrid(gridRows)
                )}
                {gridHasMore && (
                  <div className="mt-4 flex justify-center">
                    <Button variant="outline" onClick={searching ? loadMoreSearch : loadMore}>Load more</Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </DataState>

      {/* Scoped to the employee being edited, so a field rule pins to THIS employee. On create there is no
          object yet, so ordinary fields show no icon. */}
      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit employee" : "Add employee"}
        description={
          editing
            ? "Changes apply immediately across the directory, org chart and approval routing."
            : "Creates the record and lets them sign in with their work email. Pay, leave balances and documents are added afterwards from their profile."
        }
        collection="employees"
        objectPath={editing?.path}
        guardLabel="employee"
        form={form}
        draftKey={editing ? undefined : "employee-new"}
        applyDraft={setForm}
        onStartOver={() => setForm(EMPTY)}
        submitLabel={editing ? "Save changes" : "Add employee"}
        canSubmit={canSubmit}
        whyNot={whyNot}
        onSubmit={submit}
        addAnother={editing ? undefined : () => setForm(EMPTY)}
      >
          <FieldRow>
            <Field label="First name">
              <Input autoFocus value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            </Field>
            <Field label="Last name">
              <Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </Field>
          </FieldRow>
          <Field label="Legal name" hint="As on official documents/IDs/bank. Used for signing and letter sign-off. Leave blank to use the display name.">
            <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} placeholder={`${form.first_name} ${form.last_name}`.trim()} />
          </Field>
          <Field label="Employee ID" field="employee_number" hint={editing ? "The human-facing ID. Must be unique." : "Leave blank to auto-assign from the org format (Settings › Organization › Employee IDs)."}>
            <Input value={form.employee_number} onChange={(e) => setForm({ ...form, employee_number: e.target.value })} placeholder={editing ? undefined : "Auto"} className="font-mono" />
          </Field>
          {!editing && (
            <Field label="Work email" error={form.work_email.trim() !== "" && !emailOk ? "Enter a valid email address." : undefined}>
              <Input type="email" value={form.work_email} onChange={(e) => setForm({ ...form, work_email: e.target.value })} placeholder="name@company.com" />
            </Field>
          )}
          <Field label="Job title">
            <Input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
          </Field>
          <Field label="Manager" field="manager" hint="Approves their leave/time requests and sees them in team views.">
            <Combobox
              value={form.manager}
              onValueChange={(v) => setForm({ ...form, manager: v })}
              options={[
                { value: NONE, label: "No manager" },
                // Self AND everyone under them. Pointing somebody's manager at their own report closes the
                // reporting line into a loop, which `assertNoManagerCycle` refuses server-side; excluding them
                // here means the picker stops offering a move that will come back as an error. See
                // `reportsUnder` on why this narrows the list rather than deciding anything.
                ...rows
                  .filter((e) => isCurrentEmployee(e) && (!editing || (e.path !== editing.path && !editSubordinateIds.has(idOf(e.path)))))
                  .map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` })),
              ]}
              placeholder="No manager"
              searchPlaceholder="Search people…"
              emptyText="No one matches."
            />
          </Field>
          <Field label="Department" field="department">
            <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {depts.filter((d) => !d.disabled).map((d) => (
                  <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FieldRow>
            <Field label="Start date" hint="Drives leave accrual.">
              <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </Field>
            <Field
              label="Probation ends"
              error={!datesOk ? "Probation can't end before the start date." : undefined}
              hint={editing ? "Leave blank to clear." : "Blank defaults from start date."}
            >
              <Input type="date" min={form.start_date || undefined} value={form.probation_end_date} onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })} />
            </Field>
          </FieldRow>
          {namesake && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {namesake.first_name} {namesake.last_name} is already in the directory
              {namesake.work_email ? <> ({namesake.work_email})</> : null}. Add this one only if they're a different person.
            </p>
          )}
      </WriteDialog>
    </div>
  );
}
