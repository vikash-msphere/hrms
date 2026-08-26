import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarDays, Plus, Check, Sparkles, Plane, LayoutGrid, List, CalendarPlus, CalendarRange, Printer, Search,
  Sun, MapPin, Clock3, MoreHorizontal, ListPlus, CalendarSync, Rss, Copy, EyeOff,
} from "lucide-react";
import { create, patch, get, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { navigate } from "@/router";
import { formatDate, idOf, cn } from "@/lib/utils";
import { dmy, longDate, monthLabelOf, todayYmd } from "@/lib/leaveCalendar";
import { breakAround, bestBridge, breakLabel, isWeekendDay, longBreakCount, type Break, type Bridge } from "@/lib/holidayBreaks";
import { buildIcs, downloadIcs } from "@/lib/ics";
import { readHashQuery, writeHashQuery } from "@/lib/urlQuery";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import type { LeaveDraft } from "@/lib/leaveDraft";
import type { Holiday, LeaveBalance, LeaveRequest, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { ActivitySection } from "@/components/common/ActivitySection";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { BulkAddDialog } from "@/components/holidays/BulkAddDialog";
import { CopyYearDialog } from "@/components/holidays/CopyYearDialog";
import { YearGrid, type YearDay } from "@/components/holidays/YearGrid";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { getSetting } from "@/lib/settingsStore";

// The viewer's LOCAL calendar date (toISOString would flip to UTC's date around midnight).
const todayStr = () => new Date().toLocaleDateString("en-CA");
// Weekday of a ymd date ("Fri") - parsed as UTC so the label never shifts with the viewer's offset.
const weekdayOf = (ymd: string) =>
  new Date(ymd.slice(0, 10) + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
const weekdayLongOf = (ymd: string) =>
  new Date(ymd.slice(0, 10) + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
const dayNumOf = (ymd: string) => String(Number(ymd.slice(8, 10)));
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to.slice(0, 10) + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
const inDaysLabel = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
const monthOf = (ymd: string) => ymd.slice(0, 7);
const monthTitle = (ym: string) => monthLabelOf(new Date(ym + "-01T00:00:00Z"));
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// What a card needs beyond the row itself: is this a day off for THIS viewer, what stretch of days off it
// sits in, and the cheapest leave that would make that stretch worth calling a break.
type Info = { h: Holiday; off: boolean; brk: Break | null; bridge: Bridge | null; onWeekend: boolean };

const VIEWS = [
  ["calendar", "Calendar", LayoutGrid],
  ["year", "Year", CalendarRange],
  ["list", "List", List],
] as const;
type View = (typeof VIEWS)[number][0];
const isView = (v: string | null): v is View => VIEWS.some(([k]) => k === v);

type HolidayPolicy = { max_optional?: number; pick_by?: string; feed_enabled?: boolean };

export default function Holidays({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Holiday>("holidays", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("holidays", "holiday", reload);
  const lc = useLifecycle("holidays", "holiday", reload);
  const writable = usePermission("holidays.write");
  const canPurge = usePermission("holidays.admin");
  const isEmployee = !!me.employee_id;

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [form, setForm] = useState({ name: "", date: "", kind: "fixed", location: "", half_day: false });
  const [baseline, setBaseline] = useState({ name: "", date: "", kind: "fixed", location: "", half_day: false });
  const [formErr, setFormErr] = useState<string | null>(null);
  const guardClose = useDiscardGuard();
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const closeDialog = () => { setOpen(false); setFormErr(null); };
  const [selBusy, setSelBusy] = useState(""); // path of the row whose selection is being toggled
  const [year, setYear] = useState(readHashQuery("year") ?? String(new Date().getFullYear()));
  const [view, setView] = useState<View>(isView(readHashQuery("view")) ? (readHashQuery("view") as View) : "calendar");
  const [query, setQuery] = useState(readHashQuery("q") ?? "");
  const [kindFilter, setKindFilter] = useState(readHashQuery("kind") ?? "all");
  const [mineOnly, setMineOnly] = useState(readHashQuery("mine") === "1");
  const [showPast, setShowPast] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [draft, setDraft] = useState<LeaveDraft | null>(null); // a bridge day, handed to the leave form
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const [policy, setPolicy] = useState<HolidayPolicy>({});
  const maxOptional = policy.max_optional ?? 2;
  // The working week decides which days around a holiday are already off, so a "4-day break" means the same
  // thing here as on the leave calendar (a Saturday-working org gets different, correct, answers).
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    getSetting<HolidayPolicy>("holidays")
      .then((s) => { if (s.value) setPolicy(s.value); })
      .catch(() => { /* no setting yet -> defaults */ });
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  useEffect(() => { writeHashQuery("year", year); }, [year]);
  useEffect(() => { writeHashQuery("view", view === "calendar" ? null : view); }, [view]);
  useEffect(() => { writeHashQuery("q", query.trim() || null); }, [query]);
  useEffect(() => { writeHashQuery("kind", kindFilter === "all" ? null : kindFilter); }, [kindFilter]);
  useEffect(() => { writeHashQuery("mine", mineOnly ? "1" : null); }, [mineOnly]);

  const workDays = schedule.work_days?.length ? schedule.work_days : [1, 2, 3, 4, 5];
  const today = todayStr();

  // A holiday is a day OFF for this viewer when it's live, applies to their location, and is either fixed or an
  // optional one they picked (an admin without an employee record has no picks, so they see the org's full set).
  const isDayOff = useCallback(
    (h: Holiday) =>
      !h.delete_time && !h.disabled && h.applies !== false && (h.kind !== "optional" || !isEmployee || !!h.selected),
    [isEmployee],
  );
  const offDates = useMemo(() => new Set(rows.filter(isDayOff).map((h) => h.date.slice(0, 10))), [rows, isDayOff]);
  const isOff = useCallback((d: string) => isWeekendDay(d, workDays) || offDates.has(d), [workDays, offDates]);

  // Year framing: a chip per year present in the data; default to the current year when it exists.
  const years = useMemo(() => [...new Set(rows.map((h) => h.date.slice(0, 4)))].sort().reverse(), [rows]);
  const activeYear = years.includes(year) ? year : "";
  // The optional allowance is per calendar year (services/holidaySelections.ts caps it that way), so the count
  // shown has to be the year's, not every pick ever made.
  const pickYear = activeYear || String(new Date().getFullYear());
  const selectedCount = useMemo(
    () => rows.filter((h) => h.kind === "optional" && h.selected && h.date.slice(0, 4) === pickYear).length,
    [rows, pickYear],
  );
  const atLimit = selectedCount >= maxOptional;
  const pickDeadline = policy.pick_by?.slice(0, 10);
  const pickDaysLeft = pickDeadline ? daysBetween(today, pickDeadline) : null;
  // Locations already in use, so the editor suggests instead of inviting a typo'd second spelling.
  const locations = useMemo(() => [...new Set(rows.map((h) => h.location).filter((l): l is string => !!l))].sort(), [rows]);

  const matchesFilters = useCallback(
    (h: Holiday) => {
      const q = query.trim().toLowerCase();
      if (q && !`${h.display_name} ${h.location ?? ""}`.toLowerCase().includes(q)) return false;
      if (kindFilter !== "all" && (kindFilter === "half" ? !h.half_day : (h.kind ?? "fixed") !== kindFilter)) return false;
      if (mineOnly && !isDayOff(h)) return false;
      return true;
    },
    [query, kindFilter, mineOnly, isDayOff],
  );

  // Upcoming first (soonest top), then past newest-first; deleted rows sink to the bottom.
  const shown = useMemo(() => {
    const inYear = rows.filter((h) => (!activeYear || h.date.slice(0, 4) === activeYear) && matchesFilters(h));
    const live = inYear.filter((h) => !h.delete_time);
    const upcoming = live.filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = live.filter((h) => h.date < today).sort((a, b) => b.date.localeCompare(a.date));
    return [...upcoming, ...past, ...inYear.filter((h) => h.delete_time)];
  }, [rows, activeYear, today, matchesFilters]);

  // "Next holiday" answers "when is my next day OFF", so it uses the same day-off rule as the breaks do.
  const nextHoliday = useMemo(
    () => rows.filter((h) => isDayOff(h) && h.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0],
    [rows, today, isDayOff],
  );

  // One pass over the visible year: each live holiday with the break it sits in, and the bridge worth
  // suggesting. Only upcoming days off get a bridge - and only when they aren't already a long break.
  const infos = useMemo<Info[]>(() => {
    // "Hidden" widens the cards to the rows an admin manages: disabled ones, and deleted ones (whose row
    // actions offer Restore), so recovering a mistake doesn't mean switching to the table.
    return shown
      .filter((h) => showHidden || (!h.delete_time && !h.disabled))
      .map((h) => {
        const ymd = h.date.slice(0, 10);
        const off = isDayOff(h);
        const brk = off ? breakAround(ymd, isOff) : null;
        const bridge = brk && brk.days < 4 && h.date >= today ? bestBridge(brk, isOff) : null;
        return { h, off, brk, bridge, onWeekend: isWeekendDay(ymd, workDays) };
      });
  }, [shown, isDayOff, isOff, today, workDays, showHidden]);

  const daysOffInYear = useMemo(() => infos.filter((i) => i.off).reduce((n, i) => n + (i.h.half_day ? 0.5 : 1), 0), [infos]);
  const upcomingCount = useMemo(() => infos.filter((i) => i.off && i.h.date >= today).length, [infos, today]);
  const longBreaks = useMemo(
    () => longBreakCount(infos.filter((i) => i.off).map((i) => i.h.date.slice(0, 10)), isOff),
    [infos, isOff],
  );
  // Holidays that fall on a day already off: the org declares them, nobody gains a day.
  const wastedCount = useMemo(() => infos.filter((i) => i.onWeekend && !i.h.disabled).length, [infos]);
  // Optional holidays still open to this viewer, soonest first - the nudge band picks from these.
  const isPickable = (i: Info) =>
    i.h.kind === "optional" && !i.h.disabled && !i.h.selected && i.h.date >= today && i.h.applies !== false;
  const pickable = useMemo(
    () => infos.filter(isPickable).map((i) => i.h),
    [infos, today], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Each metric above narrows the calendar/list to the holidays it counted: your own days off, the ones that
  // form a long weekend, the ones landing on a day you were already off, and the optional ones still open.
  // The key IS the selection, so every metric needs its own - two sharing one would light both segments off a
  // single click. "Still to pick" narrows to the subset the nudge band offers, not to every optional holiday.
  const kf = useKpiFocus<Info, "mine" | "breaks" | "wasted" | "optional" | "toPick">({
    mine: { label: "days off for you", match: (i) => i.off },
    breaks: { label: "holidays inside a long weekend", match: (i) => !!i.brk && i.brk.days >= 3 },
    wasted: { label: "holidays on a non-working day", match: (i) => i.onWeekend },
    optional: { label: "optional holidays", match: (i) => i.h.kind === "optional" },
    toPick: { label: "optional holidays still open to you", match: isPickable },
  });
  const focusedInfos = useMemo(() => kf.apply(infos), [infos, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusedPaths = useMemo(() => new Set(focusedInfos.map((i) => i.h.path)), [focusedInfos]);
  const shownRows = kf.focus ? shown.filter((h) => focusedPaths.has(h.path)) : shown;
  const upcomingInfos = focusedInfos.filter((i) => i.h.date >= today);
  const pastInfos = focusedInfos.filter((i) => i.h.date < today);
  const months = useMemo(() => {
    const list = showPast ? [...upcomingInfos, ...pastInfos].sort((a, b) => a.h.date.localeCompare(b.h.date)) : upcomingInfos;
    const groups: { ym: string; items: Info[] }[] = [];
    for (const info of list) {
      const ym = monthOf(info.h.date);
      const last = groups[groups.length - 1];
      if (last?.ym === ym) last.items.push(info);
      else groups.push({ ym, items: [info] });
    }
    return groups;
  }, [upcomingInfos, pastInfos, showPast]);

  function openCreate(date?: string) {
    setEditing(null);
    const next = { name: "", date: date ?? "", kind: "fixed", location: "", half_day: false };
    setForm(next);
    setBaseline(next);
    setFormErr(null);
    setOpen(true);
  }
  function openEdit(h: Holiday) {
    setEditing(h);
    const next = { name: h.display_name, date: h.date, kind: h.kind ?? "fixed", location: h.location ?? "", half_day: !!h.half_day };
    setForm(next);
    setBaseline(next);
    setFormErr(null);
    setOpen(true);
  }

  // Guards the editor states rather than blocks: another holiday already on that date is nearly always a
  // mistake (two rows, two "days off"), and a date that is already a weekend buys nobody anything.
  const clash = useMemo(
    () => rows.find((h) => !h.delete_time && h.date.slice(0, 10) === form.date && h.path !== editing?.path),
    [rows, form.date, editing?.path],
  );
  const formOnOffDay = !!form.date && isWeekendDay(form.date, workDays);
  // What this date actually buys people: the stretch of days off it lands in once it IS a holiday. A Thursday
  // and a Friday differ by a whole weekend, and that is the difference the editor should show while it can
  // still be acted on.
  const formBreak = useMemo(
    () => (form.date && !form.half_day ? breakAround(form.date, (d) => d === form.date || isOff(d)) : null),
    [form.date, form.half_day, isOff],
  );

  async function submit() {
    setBusy(true);
    setFormErr(null);
    try {
      const body = { display_name: form.name, date: form.date, kind: form.kind, location: form.location.trim() || null, half_day: form.half_day };
      if (editing) {
        await patch("holidays/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Holiday updated", variant: "success" });
      } else {
        await create("holidays", body);
        toast({ title: "Holiday added", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSelect(h: Holiday) {
    // Giving a pick back is not symmetrical with taking one: the allowance is capped and the pick-by date can
    // pass, so the day may not be re-selectable. Picking one needs no ceremony.
    if (h.selected && h.selection) {
      const ok = await confirm({
        title: `Give up ${h.display_name}?`,
        description: "The day goes back to the pool and your pick is freed. If the deadline passes or the allowance fills up, you may not get it back.",
        confirmLabel: "Give it up",
        destructive: true,
      });
      if (!ok) return;
    }
    setSelBusy(h.path);
    try {
      if (h.selected && h.selection) {
        await remove(h.selection);
        toast({ title: `Deselected ${h.display_name}`, variant: "success" });
      } else {
        await create("holiday-selections", { holiday: h.path });
        toast({ title: `Selected ${h.display_name}`, variant: "success" });
      }
      reload();
    } catch (e) {
      toast({ title: "Couldn't update your pick", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSelBusy("");
    }
  }

  // The days off you actually get, as a calendar file: fixed holidays plus the optional ones you picked.
  function doIcs() {
    const offs = infos.filter((i) => i.off);
    if (offs.length === 0) return;
    downloadIcs(
      activeYear ? `holidays-${activeYear}` : "holidays",
      buildIcs(
        offs.map(({ h }) => ({
          uid: `${idOf(h.path)}@hrms`,
          start: h.date.slice(0, 10),
          end: h.date.slice(0, 10),
          summary: h.half_day ? `${h.display_name} (half day)` : h.display_name,
          description: [h.kind === "optional" ? "Optional holiday" : "Company holiday", h.location ?? ""].filter(Boolean).join(" · "),
        })),
        activeYear ? `Holidays ${activeYear}` : "Holidays",
      ),
    );
  }

  const feedUrl = me.holiday_feed_token ? `${window.location.origin}/calendar/holidays/${me.holiday_feed_token}` : null;

  /** Optional-holiday pick/unpick, shared by the cards and the table. */
  function selectButton(h: Holiday) {
    if (!isEmployee || h.kind !== "optional" || h.delete_time || h.disabled || h.applies === false) return null;
    return (
      <AccessAction collection="holiday-selections" create label="Holiday selection">
        {!h.selected && atLimit ? (
          // A disabled button swallows its tooltip, so the why lives on a wrapping span.
          <span title={`You've used all ${maxOptional} optional picks - deselect one first`}>
            <Button size="sm" variant="outline" disabled>Select</Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant={h.selected ? "secondary" : "outline"}
            loading={selBusy === h.path}
            onClick={() => toggleSelect(h)}
            title={h.selected ? "Deselect this optional holiday" : "Take this as one of your optional holidays"}
          >
            {h.selected ? (<><Check className="h-4 w-4" /> Selected</>) : "Select"}
          </Button>
        )}
      </AccessAction>
    );
  }

  const columns: Column<Holiday>[] = [
    {
      id: "name",
      header: "Holiday",
      accessor: (h) => h.display_name,
      cell: (h) => (
        <span className="flex items-center gap-1.5">
          <span className="font-medium">{h.display_name}</span>
          {h.half_day && <Badge variant="info">Half day</Badge>}
        </span>
      ),
    },
    {
      id: "date",
      header: "Date",
      accessor: (h) => h.date,
      cell: (h) => `${weekdayOf(h.date)}, ${formatDate(h.date)}`,
    },
    {
      id: "kind",
      header: "Type",
      filter: "select",
      accessor: (h) => (h.kind === "optional" ? "Optional" : "Fixed"),
      cell: (h) => <Badge variant={h.kind === "optional" ? "warning" : "secondary"}>{h.kind === "optional" ? "Optional" : "Fixed"}</Badge>,
    },
    {
      id: "location",
      header: "Applies to",
      filter: "select",
      accessor: (h) => h.location ?? "Everyone",
      cell: (h) => (h.location ? <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-muted-foreground" />{h.location}</span> : <span className="text-muted-foreground">Everyone</span>),
    },
    {
      id: "when",
      header: "When",
      filter: "select",
      accessor: (h) => (h.date >= today ? "Upcoming" : "Past"),
      cell: (h) => <Badge variant={h.date >= today ? "secondary" : "muted"}>{h.date >= today ? "Upcoming" : "Past"}</Badge>,
    },
    stateColumn<Holiday>(),
    ...metaColumns<Holiday>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (h) => (
        <div className="flex items-center justify-end gap-2">
          {selectButton(h)}
          <SoftDeleteRowActions row={h} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Holiday Calendar"
        description="Fixed holidays apply to everyone; optional ones you pick. Breaks are worked out from your org's working week."
        accessCollection="holidays"
        actions={
          <>
            <PageSettings me={me} host="holidays" />
            {feedUrl && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Subscribe in your calendar" title="Subscribe in Google Calendar / Outlook">
                    <Rss className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-2 p-3">
                  <p className="text-sm font-medium">Keep your calendar in sync</p>
                  <p className="text-xs text-muted-foreground">
                    Add this URL to Google Calendar ("Other calendars → From URL") or Outlook. It stays up to
                    date with your days off, including the optional holidays you pick. It's yours - anyone with
                    the link can read it, so don't share it.
                  </p>
                  <div className="flex gap-1.5">
                    <Input readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} className="h-8 font-mono text-[11px]" />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard?.writeText(feedUrl).then(
                          () => toast({ title: "Subscribe URL copied", variant: "success" }),
                          () => toast({ title: "Couldn't copy - select the text instead", variant: "destructive" }),
                        );
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={doIcs}
              disabled={daysOffInYear === 0}
              aria-label="Download as calendar file"
              title="Download .ics for Google Calendar / Outlook"
            >
              <CalendarPlus className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => window.print()} aria-label="Print this calendar" title="Print the holiday list">
              <Printer className="h-4 w-4" />
            </Button>
            {writable && (
              <>
                <AccessAction collection="holidays" create><Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> Add holiday</Button></AccessAction>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-9 w-9" aria-label="More ways to add holidays"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setBulkOpen(true)}><ListPlus className="mr-2 h-4 w-4" /> Add many (paste a list)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setCopyOpen(true)} disabled={years.length === 0}><CalendarSync className="mr-2 h-4 w-4" /> Copy a year</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </>
        }
      />

      {rows.length > 0 && (
        <SummaryStrip
          items={[
            {
              label: "Next day off",
              icon: CalendarDays,
              value: <span className="text-base font-semibold">{nextHoliday ? nextHoliday.display_name : "None scheduled"}</span>,
              hint: nextHoliday ? `${weekdayOf(nextHoliday.date)} · ${inDaysLabel(daysBetween(today, nextHoliday.date))}` : "none left this year",
              // The next day off is one row, so the metric opens it rather than filtering to a list of one.
              ...(nextHoliday ? { onClick: () => openEdit(nextHoliday) } : {}),
            },
            {
              label: activeYear ? `Days off in ${activeYear}` : "Days off",
              value: daysOffInYear,
              tone: daysOffInYear ? "primary" : "muted",
              hint: `${upcomingCount} still to come`,
              ...kf.kpi("mine"),
            },
            {
              label: "Long weekends",
              icon: Sparkles,
              value: longBreaks,
              tone: longBreaks ? "success" : "muted",
              hint: "3+ days off in a row",
              ...kf.kpi("breaks"),
            },
            {
              label: "Lost to weekends",
              icon: Sun,
              value: wastedCount,
              tone: wastedCount ? "warning" : "muted",
              hint: wastedCount ? "on a non-working day" : "none wasted",
              ...kf.kpi("wasted"),
            },
            ...(isEmployee
              ? [{
                  label: "Optional picks",
                  value: `${selectedCount} of ${maxOptional}`,
                  tone: atLimit ? ("warning" as const) : ("default" as const),
                  hint:
                    pickDeadline && pickDaysLeft !== null && pickDaysLeft >= 0
                      ? `Close ${formatDate(pickDeadline)}`
                      : atLimit
                        ? "All picks used"
                        : `${plural(maxOptional - selectedCount, "pick")} left`,
                  ...kf.kpi("optional"),
                }]
              : []),
            ...(isEmployee && pickable.length
              ? [{
                  label: "Still to pick",
                  value: pickable.length,
                  tone: "warning" as const,
                  hint: "open to you",
                  ...kf.kpi("toPick"),
                }]
              : []),
          ]}
        />
      )}

      {/* Toolbar: which year, what's in scope, and which shape it's drawn in. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2" data-print-hide>
        <div className="flex flex-wrap items-center gap-1.5">
          {years.length > 1 && ["", ...years].map((y) => (
            <button
              key={y || "all"}
              type="button"
              onClick={() => setYear(y)}
              aria-pressed={activeYear === y}
              disabled={view === "year" && !y}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                activeYear === y ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {y || "All years"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search holidays"
              className="h-8 w-40 pl-7 text-xs sm:w-52"
              aria-label="Search holidays by name or location"
            />
          </div>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="h-8 w-[8.5rem] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="fixed">Fixed only</SelectItem>
              <SelectItem value="optional">Optional only</SelectItem>
              <SelectItem value="half">Half days</SelectItem>
            </SelectContent>
          </Select>
          {isEmployee && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Hide optional holidays you haven't picked and other locations' holidays">
              <Checkbox checked={mineOnly} onCheckedChange={(v) => setMineOnly(v === true)} /> My days off
            </label>
          )}
          {writable && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Include disabled holidays">
              <Checkbox checked={showHidden} onCheckedChange={(v) => setShowHidden(v === true)} /> <EyeOff className="h-3.5 w-3.5" /> Hidden
            </label>
          )}
          <div className="inline-flex rounded-lg bg-muted p-0.5" role="group" aria-label="Holiday view">
            {VIEWS.map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => { setView(v); if (v === "year" && !activeYear) setYear(years[0] ?? String(new Date().getFullYear())); }}
                aria-pressed={view === v}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* An unused optional pick is a day off going to waste, so it gets said out loud once. */}
      {view !== "list" && isEmployee && !atLimit && pickable.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/20" data-print-hide>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {plural(maxOptional - selectedCount, "optional holiday")} left to pick
            {pickDeadline && pickDaysLeft !== null && pickDaysLeft >= 0 ? ` · closes ${formatDate(pickDeadline)}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pickable.slice(0, 8).map((h) => (
              <AccessAction key={h.path} collection="holiday-selections" create label="Holiday selection">
                <Button
                  size="sm"
                  variant="outline"
                  loading={selBusy === h.path}
                  onClick={() => toggleSelect(h)}
                  title={`Take ${h.display_name} as one of your optional holidays`}
                >
                  {h.display_name} <span className="text-muted-foreground">· {dmy(h.date)}</span>
                </Button>
              </AccessAction>
            ))}
          </div>
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No holidays set"
            description="Add public and company holidays so everyone can plan ahead - one at a time, or paste a whole year at once."
            action={writable && (
              <div className="flex flex-wrap justify-center gap-2">
                <AccessAction collection="holidays" create><Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> Add holiday</Button></AccessAction>
                <Button variant="outline" onClick={() => setBulkOpen(true)}><ListPlus className="h-4 w-4" /> Paste a list</Button>
              </div>
            )}
          />
        ) : view === "list" ? (
          /* The table keeps what a grid can't: filters, export, and the deleted/disabled rows an admin manages. */
          <DataTable
            columns={columns}
            tableId="holidays"
            rows={shownRows}
            getRowId={(h) => h.path}
            rowClassName={(h) => (h.delete_time || h.date < today ? "opacity-60" : undefined)}
            emptyTitle={kf.activeLabel ? `No ${kf.activeLabel}` : activeYear ? `No holidays in ${activeYear}` : "No holidays match"}
            accessCollection="holidays"
            accessTargetOf={(h) => ({ objectPath: h.path, label: h.display_name, can: h.access?.can })}
          />
        ) : view === "year" ? (
          <YearView
            year={activeYear || String(new Date().getFullYear())}
            infos={focusedInfos}
            isOff={isOff}
            workDays={workDays}
            weekStart={schedule.week_start ?? 0}
            me={me}
            onSelectDay={(ymd) => {
              const hit = infos.find((i) => i.h.date.slice(0, 10) === ymd);
              if (hit) openEdit(hit.h);
              else if (writable) openCreate(ymd);
              else navigate(`leave-calendar?d=${ymd}`);
            }}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            {months.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {kf.activeLabel
                  ? `No ${kf.activeLabel}.`
                  : query.trim() || kindFilter !== "all" || mineOnly
                  ? "No holidays match those filters."
                  : activeYear
                    ? `Nothing left in ${activeYear}.`
                    : "Nothing upcoming."}
                {pastInfos.length > 0 ? " Show what's already been below." : ""}
              </p>
            ) : (
              months.map(({ ym, items }) => (
                <section key={ym} data-print-keep>
                  <h2 className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {monthTitle(ym)}
                    <span className="font-medium normal-case tracking-normal text-muted-foreground/70">· {plural(items.length, "holiday")}</span>
                  </h2>
                  <ul className="divide-y">
                    {items.map((info) => (
                      <HolidayCard
                        key={info.h.path}
                        info={info}
                        isNext={info.h.path === nextHoliday?.path}
                        past={info.h.date < today}
                        onOpenDay={() => navigate(`leave-calendar?d=${info.h.date.slice(0, 10)}`)}
                        select={selectButton(info.h)}
                        bridge={info.bridge && isEmployee ? <BridgeAction bridge={info.bridge} me={me} onPick={setDraft} /> : null}
                        actions={<SoftDeleteRowActions row={info.h} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
            {pastInfos.length > 0 && (
              <button
                type="button"
                onClick={() => setShowPast((s) => !s)}
                className="w-full border-t px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                data-print-hide
              >
                {showPast ? "Hide past holidays" : `Show ${plural(pastInfos.length, "past holiday")}`}
              </button>
            )}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guardClose(dirty, closeDialog)}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim() && form.date) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit holiday" : "Add holiday"}</DialogTitle>
            <DialogDescription>A fixed holiday is a day off for everyone it applies to; an optional one is a day employees can choose from their allowance.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. New Year's Day" autoFocus />
          </Field>
          <FieldRow>
            <Field
              label="Date"
              hint={form.date ? `${weekdayLongOf(form.date)}${formOnOffDay ? " - not a working day" : ""}` : undefined}
              error={clash ? `${clash.display_name} is already on this date` : undefined}
            >
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label="Type" hint="Fixed applies to all; optional is pickable.">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="optional">Optional</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Applies to" hint="Blank = everyone. A location limits it to employees working there.">
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="Everyone"
                list="holiday-locations"
              />
              <datalist id="holiday-locations">
                {locations.map((l) => <option key={l} value={l} />)}
              </datalist>
            </Field>
            <Field label="Length" hint="A half day charges 0.5 leave days, not a full one.">
              <label className="flex h-9 items-center gap-2 text-sm">
                <Checkbox checked={form.half_day} onCheckedChange={(v) => setForm({ ...form, half_day: v === true })} />
                <Clock3 className="h-4 w-4 text-muted-foreground" /> Half day
              </label>
            </Field>
          </FieldRow>
          {formBreak && (
            <p className={cn("rounded-lg border p-3 text-sm", formBreak.days >= 3 ? "border-success/40 bg-success/10" : "bg-muted/40")}>
              {formOnOffDay ? (
                <>Already a non-working day, so this holiday adds no time off.</>
              ) : formBreak.days >= 3 ? (
                <><Sparkles className="mr-1 inline h-4 w-4" /> Makes a {breakLabel(formBreak.days)}, {longDate(formBreak.from)} to {longDate(formBreak.to)}.</>
              ) : (
                <>A single day off. {weekdayLongOf(form.date)} sits between working days.</>
              )}
            </p>
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <FormError error={formErr} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guardClose(dirty, closeDialog)(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !form.date}>{editing ? "Save changes" : "Add holiday"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {bulkOpen && (
        <BulkAddDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          existingDates={new Set(rows.filter((h) => !h.delete_time).map((h) => h.date.slice(0, 10)))}
          onDone={reload}
        />
      )}
      {copyOpen && (
        <CopyYearDialog
          open={copyOpen}
          onOpenChange={setCopyOpen}
          holidays={rows}
          years={years}
          workDays={workDays}
          defaultFrom={activeYear || years[0] || String(new Date().getFullYear())}
          onDone={reload}
        />
      )}

      {draft && (
        <RequestLeaveDialog
          open
          onOpenChange={(o) => { if (!o) setDraft(null); }}
          me={me}
          initial={draft}
          onSubmitted={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/**
 * "Take this day off and it's a 4-day break". Owns the balance read rather than the page doing it, so the extra
 * collection is fetched only when there is actually a bridge on screen - and once, however many buttons there
 * are (the client cache dedupes). Proposing leave someone hasn't got is worse than not proposing it.
 */
function BridgeAction({ bridge, me, onPick }: { bridge: Bridge; me: Me; onPick: (d: LeaveDraft) => void }) {
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const available = useMemo(
    () => balances.filter((b) => (me.employee_id ? idOf(b.employee ?? "") === me.employee_id : false)).reduce((n, b) => n + (b.balance_days ?? 0), 0),
    [balances, me.employee_id],
  );
  const first = bridge.take[0]!;
  const last = bridge.take[bridge.take.length - 1]!;
  const label = bridge.take.length === 1 ? `${weekdayOf(first)} ${dayNumOf(first)}` : `${weekdayOf(first)}-${weekdayOf(last)}`;
  const short = bridge.take.length > available;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={short}
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title={
        short
          ? `You'd need ${plural(bridge.take.length, "day")} of leave and have ${available}`
          : `Take ${bridge.take.map(dmy).join(", ")} as leave for ${bridge.days} days off in a row (${dmy(bridge.from)} - ${dmy(bridge.to)}) · ${available} days balance`
      }
      onClick={() => onPick({ from: first, to: last })}
    >
      <Plane className="h-4 w-4" /> Take {label} off <span className="hidden sm:inline">→ {bridge.days} days</span>
    </Button>
  );
}

/** One holiday as a row of the year: date tile, what it is, the break it buys, and what you can do about it. */
function HolidayCard({ info, isNext, past, select, bridge, actions, onOpenDay }: {
  info: Info;
  isNext: boolean;
  past: boolean;
  select: ReactNode;
  bridge: ReactNode;
  actions: ReactNode;
  onOpenDay: () => void;
}) {
  const { h, off, brk, onWeekend } = info;
  const ymd = h.date.slice(0, 10);
  const long = brk && brk.days >= 3 ? brk : null;
  return (
    <li className={cn("flex items-center gap-3 px-3 py-2.5", past && "opacity-60")}>
      <button
        type="button"
        onClick={onOpenDay}
        title="See who's away that day on the leave calendar"
        className={cn(
          "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border leading-none transition-colors hover:bg-accent",
          isNext ? "border-primary bg-primary/10" : "bg-muted/50",
        )}
      >
        <span className="text-[15px] font-semibold tabular-nums">{dayNumOf(ymd)}</span>
        <span className="mt-0.5 text-[10px] font-medium uppercase text-muted-foreground">{weekdayOf(ymd)}</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{h.display_name}</span>
          {isNext && <Badge variant="default">Next</Badge>}
          {h.kind === "optional" && (
            <Badge variant={h.selected ? "info" : "warning"}>{h.selected ? "Optional · picked" : "Optional"}</Badge>
          )}
          {h.half_day && <Badge variant="info"><Clock3 className="h-3 w-3" /> Half day</Badge>}
          {h.location && <Badge variant="secondary"><MapPin className="h-3 w-3" /> {h.location}</Badge>}
          {long && <Badge variant="success"><Sparkles className="h-3 w-3" /> {breakLabel(long.days)}</Badge>}
          {onWeekend && <Badge variant="warning"><Sun className="h-3 w-3" /> Falls on {weekdayLongOf(ymd)}</Badge>}
          {h.disabled && <Badge variant="muted">Disabled</Badge>}
          {h.delete_time && <Badge variant="destructive">Deleted</Badge>}
        </div>
        {/* longDate is parsed as UTC, so this line can never disagree with the weekday on the tile. */}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {longDate(ymd)}
          {!past && ` · ${inDaysLabel(daysBetween(todayYmd(), ymd))}`}
          {long && long.days > 1 && ` · off ${dmy(long.from)} - ${dmy(long.to)}`}
          {onWeekend && " · nobody gains a day"}
          {h.applies === false && " · another location's holiday"}
          {!off && h.applies !== false && h.kind === "optional" && !h.disabled && " · not one of your picks"}
        </p>
      </div>
      {bridge}
      {select}
      {actions}
    </li>
  );
}

/**
 * The year planner. Mounted only while its view is open, because it is the one view that wants the viewer's
 * approved leave too - a read the calendar and list views don't need (D1 reads are the budget here).
 */
function YearView({ year, infos, isOff, workDays, weekStart, me, onSelectDay }: {
  year: string;
  infos: Info[];
  isOff: (d: string) => boolean;
  workDays: number[];
  weekStart: number;
  me: Me;
  onSelectDay: (ymd: string) => void;
}) {
  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests");
  const myLeave = useMemo(() => {
    const days = new Set<string>();
    for (const l of leaves) {
      if (!me.employee_id || idOf(l.employee ?? "") !== me.employee_id) continue;
      if ((l.state ?? "").toUpperCase() !== "APPROVED") continue;
      for (let d = Date.parse(l.start_date + "T00:00:00Z"); d <= Date.parse(l.end_date + "T00:00:00Z"); d += 86400000) {
        days.add(new Date(d).toISOString().slice(0, 10));
      }
    }
    return days;
  }, [leaves, me.employee_id]);

  const byDate = useMemo(() => new Map(infos.map((i) => [i.h.date.slice(0, 10), i])), [infos]);
  const dayOf = useCallback(
    (ymd: string): YearDay => {
      const info = byDate.get(ymd);
      const weekend = isWeekendDay(ymd, workDays);
      const off = isOff(ymd);
      const brk = off ? breakAround(ymd, isOff) : undefined;
      return {
        ymd,
        holiday: info?.h,
        off,
        weekend,
        brk: brk && brk.days >= 3 ? brk : undefined,
        leave: myLeave.has(ymd),
      };
    },
    [byDate, isOff, workDays, myLeave],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        <YearGrid year={year} dayOf={dayOf} today={todayYmd()} weekStart={weekStart} onSelect={onSelectDay} />
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-print-hide>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-primary/20" /> Holiday</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-emerald-200 dark:bg-emerald-900" /> Your approved leave</span>
          <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 rounded-full bg-success" /> 3+ days off in a row</span>
        </p>
      </div>
    </TooltipProvider>
  );
}
