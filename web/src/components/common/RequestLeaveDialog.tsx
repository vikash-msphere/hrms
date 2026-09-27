import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Users, X } from "lucide-react";
import { create, get, getAllPages, upload } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { addDaysYmd, orgDayFromToday, todayStr } from "@/lib/orgDay";
import { chargeableDays } from "@/lib/leaveDays";
import { DEFAULT_SCHEDULE } from "@/lib/attendance";
import { scheduleView } from "@/lib/workSchedule";
import { orgScheduleOf } from "../../../../src/domain/workSchedule";
import { bestBridge, breakAround } from "@/lib/holidayBreaks";
import {
  checkLeaveRestrictions,
  dayBar,
  dayBarReason,
  describeRestrictionsByGroup,
  hasAnyRestriction,
  LEAF_CODES,
  mergeRestrictions,
  parseRestrictions,
  requiredNotice,
  sandwichOf,
  type LeaveNeighbour,
  type LeaveRestrictions,
} from "../../../../src/domain/leaveRestrictions";
import type { ApprovalDelegation, Employee, Holiday, LeaveBalance, LeaveRequest, LeaveType, NoticePeriod, Me, Shift, ShiftAssignment, WorkPattern, WorkPatternAssignment } from "@/types";
import type { LeaveDraft } from "@/lib/leaveDraft";
import { DateRangeCalendar, type DayInfo } from "@/components/common/DateRangeCalendar";
import { AccessAction } from "@/components/access/AccessAction";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { Segmented } from "@/components/common/Segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";
import { draftKey } from "@/components/common/dialogGuard";

const upper = (s?: string) => (s ?? "").toUpperCase();
// Weekday of a ymd date, parsed as UTC so the label never shifts with the viewer's offset.
// Named `…LongOf` so it cannot be mistaken for orgDay's `weekdayOf`, which answers a NUMBER.
const weekdayLongOf = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
const fmtDays = (n: number) => String(Math.round(n * 2) / 2);
// The ORG's day for the quick picks, not the browser's - the same clock `minDate` below uses. This was
// `new Date()` stepped locally and formatted `en-CA`, which is the VIEWER's calendar: for London staff in an
// IST org the org has already rolled over from about 18:30 local, so `min` was D+1 while "Today" wrote D.
// `<input type="date">` does not clear an out-of-range value set programmatically and the form validates on
// `form.start_date` rather than on `validity`, so Submit stayed enabled and the server refused the request as
// back-dated - the exact shape lib/orgDay.ts's header describes.
const ymdIn = (days: number) => orgDayFromToday(days);
// Namespaced to the caller (draftKey), so a half-written request on a shared machine - dates, and a reason
// that is often personal - is never handed to whoever opens this dialog next. Session-scoped, which is the
// useful lifetime of a draft.
const DRAFT_KEY = () => draftKey("leave-request");
const dowOf = (ymd: string) => new Date(ymd + "T00:00:00Z").getUTCDay();
// "Fri 26 Dec" - the month matters, because the calendar below shows two of them and a bridge can sit in
// either. `weekdayDay` drops it for the near end of a same-month range, so it isn't printed twice.
const dayLabel = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const weekdayDay = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
// Last day of the month after the one `ymd` is in: the horizon for bridge suggestions.
const endOfNextMonth = (ymd: string) =>
  new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) + 1, 0)).toISOString().slice(0, 10);

// The "request leave" form, extracted so the Leaves page and the dashboard timeline share one implementation.
// Self-contained: it fetches the data it needs (types, balances, holidays, peers' requests, working week), so
// callers only supply the viewer, an initial date/session draft, and an onSubmitted callback. Mount it only
// while open (e.g. `{open && <RequestLeaveDialog .../>}`) so it fetches nothing until used.
export function RequestLeaveDialog({
  open,
  onOpenChange,
  me,
  initial,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  me: Me;
  initial?: LeaveDraft | null;
  onSubmitted?: () => void;
}) {
  const { rows: types } = useCollection<LeaveType>("leave-types");
  // THE CALLER'S OWN ROWS, asked for as such. `leave-balances` and `leave-requests` are scoped by AUTHZ, not
  // by person: for an employee that is themselves and filtering here is a no-op, but for a manager or HR it is
  // the department's or the org's newest hundred - one row per employee per leave type, so a 60-person org with
  // five types has 300 of them. Their own row simply may not be in the window, and `?? 0` below then reads
  // "not loaded" as "none left": a manager with eighteen days is shown a red panel saying they have none and
  // `canSubmit` refuses to let them file at all. A dialog has no "load more" and nothing admits a window.
  const mineParams = me.employee_id ? { employee: `employees/${me.employee_id}` } : undefined;
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { params: mineParams, enabled: !!mineParams });
  const { rows: myRequests } = useCollection<LeaveRequest>("leave-requests", { params: mineParams, enabled: !!mineParams });
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  // The department "who else is away then" panel is advisory and deliberately stays a window: it is about
  // other people, and being short there costs a hint rather than blocking a request.
  const { rows: requests } = useCollection<LeaveRequest>("leave-requests");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  // Private by default: without read access the hook returns [] and fires no request, so this only ever
  // sharpens the "who decides this" line for callers who can already see the cover arrangement.
  const { rows: delegations } = useCollection<ApprovalDelegation>("approval-delegations");
  const { toast } = useToast();
  // A failed submit is shown in the form, not only as a toast: the server's reason (an overlap, a policy cap)
  // is what the next edit has to answer, so it stays on screen until the next attempt.
  const [err, setErr] = useState<string | null>(null);

  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [weekStart, setWeekStart] = useState(0);
  // Whether a day is resolved through the roster and the schedule the person is on, or from the org blob
  // alone (src/domain/workSchedule.ts). Read here because it decides whether the two lookups below are worth
  // making at all: on "org" nobody's days differ, so there is nothing to look up.
  const [scheduleSource, setScheduleSource] = useState<"org" | "resolved">("org");
  useEffect(() => {
    getSetting<{ work_days?: number[]; week_start?: number; schedule_source?: string }>("attendance")
      .then((s) => {
        if (Array.isArray(s.value?.work_days) && s.value.work_days.length) setWorkDays(s.value.work_days);
        if (typeof s.value?.week_start === "number") setWeekStart(s.value.week_start);
        if (s.value?.schedule_source === "resolved") setScheduleSource("resolved");
      })
      .catch(() => {});
  }, []);

  // THE REQUESTER'S OWN WORKING DAYS, because that is what the server charges against
  // (services/leaveRequests.ts). Quoting the org's week here instead is the drift lib/leaveDays.ts exists to
  // prevent, now with a part-timer on the wrong side of it: a Mon-Fri week of leave costs somebody on a
  // Mon/Wed/Fri schedule three days, and a form that said five would have them spend a balance they cannot
  // get back.
  //
  // Two narrowed reads, and only while the org resolves days per person. The catalogs they resolve against
  // are shared collection reads the store already caches.
  const resolvesPerPerson = scheduleSource === "resolved";
  const { rows: shiftCatalog } = useCollection<Shift>("shifts", { all: true, enabled: resolvesPerPerson });
  const { rows: patterns } = useCollection<WorkPattern>("work-patterns", { all: true, enabled: resolvesPerPerson });
  const [myRoster, setMyRoster] = useState<{ shifts: ShiftAssignment[]; patterns: WorkPatternAssignment[] }>({ shifts: [], patterns: [] });
  useEffect(() => {
    if (!resolvesPerPerson || !me.employee_id) return;
    // The whole window the form can quote, not just the dates picked so far: the range moves as the person
    // edits it, and refetching per keystroke would be a read per character typed into a date field. Read off
    // the clock rather than the `todayYmd` below, which is declared after this and is the same value.
    const today = todayStr();
    const from = addDaysYmd(today, -370);
    const to = addDaysYmd(today, 400);
    const emp = `employees/${me.employee_id}`;
    let live = true;
    void Promise.all([
      getAllPages<ShiftAssignment>(`shift-assignments?employee=${encodeURIComponent(emp)}&from=${from}&to=${to}`, 2000),
      getAllPages<WorkPatternAssignment>(`work-pattern-assignments?employee=${encodeURIComponent(emp)}&from=${from}&to=${to}`, 500),
    ])
      // A failed lookup leaves the org's own week in place rather than blocking the form: the server is what
      // charges the balance, and it resolves the same day whether or not this read landed.
      .then(([s, p]) => { if (live) setMyRoster({ shifts: s.results, patterns: p.results }); })
      .catch(() => {});
    return () => { live = false; };
  }, [resolvesPerPerson, me.employee_id]);

  // The day-by-day resolver every charging rule below takes (src/domain/workSchedule.ts).
  const schedOf = useMemo(() => {
    const org = { ...DEFAULT_SCHEDULE, work_days: workDays };
    if (!resolvesPerPerson) return orgScheduleOf(org);
    return scheduleView({ sched: org, shifts: shiftCatalog, patterns, assignments: myRoster.shifts, patternAssignments: myRoster.patterns })
      .of(me.employee_id ?? "");
  }, [resolvesPerPerson, workDays, shiftCatalog, patterns, myRoster, me.employee_id]);
  // The holidays that don't charge leave, as the server counts them: `applies === false` is a regional holiday
  // for another location, and a half-day one costs 0.5 rather than nothing.
  const mine = useMemo(() => holidays.filter((h) => !h.disabled && h.applies !== false), [holidays]);
  const holidaySet = useMemo(() => new Set(mine.filter((h) => !h.half_day).map((h) => h.date.slice(0, 10))), [mine]);
  const halfHolidaySet = useMemo(() => new Set(mine.filter((h) => h.half_day).map((h) => h.date.slice(0, 10))), [mine]);

  // Org policy: when back-dating is disallowed, the date pickers can't go before today (server enforces it too).
  const [allowBackdated, setAllowBackdated] = useState(true);
  useEffect(() => {
    getSetting<{ allow_backdated?: boolean }>("leave-requests")
      .then((s) => { if (typeof s.value?.allow_backdated === "boolean") setAllowBackdated(s.value.allow_backdated); })
      .catch(() => {});
  }, []);
  // The org's restrictions baseline. The effective policy for the SELECTED type is this merged with that
  // type's own overrides, exactly as the server merges them - so what this dialog refuses and what the server
  // refuses are one rule set rather than two that agree today.
  const [orgRestrictions, setOrgRestrictions] = useState<Record<string, unknown>>({});
  useEffect(() => {
    getSetting<Record<string, unknown>>("leave_restrictions")
      .then((s) => setOrgRestrictions(s.value ?? {}))
      .catch(() => {});
  }, []);
  // Whether this person is serving notice, for the exit-process rules - fetched ONLY when some leave type
  // actually has such a rule, which almost no org will. An unconditional read here would be one extra query
  // per opening of this dialog, for a preview of a rule nobody had configured. Private by default too: with
  // no read access the hook returns [] and fires nothing, and the rule simply isn't previewed - the server
  // still enforces it either way.
  const anyExitRule = useMemo(
    () => types.some((t) => { const d = mergeRestrictions(orgRestrictions, t.restrictions).exit.during_notice; return !!d && d !== "allowed"; }),
    [types, orgRestrictions],
  );
  const { rows: noticePeriods } = useCollection<NoticePeriod>("notice-periods", { params: mineParams, enabled: !!mineParams && anyExitRule });
  // The ORG's day. The server refuses a back-dated start against `services/orgDay.ts`, so a `min` computed
  // from the browser's day is a floor the server does not share: west of UTC it offered a date that came
  // back rejected, east of it the picker blocked a start the server would have taken.
  const minDate = allowBackdated ? undefined : todayStr();

  // Sessions: 1 = first half (morning), 2 = second half (afternoon). Defaults 1/2 = full days.
  const [form, setForm] = useState({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
  // Seed the dates/sessions whenever the dialog (re)opens with a draft.
  useEffect(() => {
    if (open) setForm((f) => ({ ...f, leave_type: initial?.leaveType ?? f.leave_type, start_date: initial?.from ?? f.start_date, end_date: initial?.to ?? f.end_date, startSession: initial?.startSession ?? 1, endSession: initial?.endSession ?? 2, reason: initial?.reason ?? f.reason }));
  }, [open, initial?.from, initial?.to, initial?.startSession, initial?.endSession, initial?.leaveType, initial?.reason]);

  // A half-written request survives a reload, a tab switch, or an accidental close: the dialog is the only
  // place this data exists until it is filed, and re-deriving "which Thursday was that" is real work. Session
  // storage (not local) keeps it to this browsing session, which is the useful lifetime of a draft.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!open || initial) return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY());
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<typeof form>;
      if (!saved.leave_type && !saved.start_date && !saved.reason) return;
      setForm((f) => ({ ...f, ...saved }));
      setRestored(true);
    } catch {
      // A corrupt draft is not worth a crash - it just doesn't restore.
    }
  }, [open, initial]);
  useEffect(() => {
    if (!open) return;
    const blank = !form.leave_type && !form.start_date && !form.end_date && !form.reason.trim();
    try {
      if (blank) sessionStorage.removeItem(DRAFT_KEY());
      else sessionStorage.setItem(DRAFT_KEY(), JSON.stringify(form));
    } catch {
      // Private-mode storage refusals are not worth surfacing; the form still works.
    }
  }, [open, form]);
  function startOver() {
    try { sessionStorage.removeItem(DRAFT_KEY()); } catch { /* nothing to clean up */ }
    setForm({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
    setDoc(null);
    setRestored(false);
  }

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "Someone");
  }, [employees]);

  const [busy, setBusy] = useState(false);
  // A sick note belongs WITH the request that needs it. The row has to exist before bytes can hang off it, so
  // the file is held here and uploaded the moment the request is filed.
  const [doc, setDoc] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const meEmployee = useMemo(() => (me.employee_id ? employees.find((e) => idOf(e.path) === me.employee_id) : undefined), [employees, me.employee_id]);
  const todayYmd = todayStr();
  const onProbation = !!meEmployee?.probation_end_date && meEmployee.probation_end_date.slice(0, 10) >= todayYmd;
  // Whose desk this lands on: the requester's manager, or whoever is standing in for them today. "Goes to
  // Priya" beats a request that vanishes into an unnamed queue.
  const decider = useMemo(() => {
    const managerRef = meEmployee?.manager;
    if (!managerRef) return null;
    const active = delegations.find((d) => d.delegator && idOf(d.delegator) === idOf(managerRef) && (d.from_date ?? "") <= todayYmd && (d.to_date ?? "") >= todayYmd);
    const name = (ref?: string) => (ref ? employees.find((e) => idOf(e.path) === idOf(ref)) : undefined);
    const mgr = name(managerRef);
    const del = active?.delegate ? name(active.delegate) : undefined;
    if (!mgr) return null;
    return {
      name: del ? `${del.first_name} ${del.last_name}` : `${mgr.first_name} ${mgr.last_name}`,
      coveringFor: del ? `${mgr.first_name} ${mgr.last_name}` : undefined,
      until: active?.to_date,
    };
  }, [meEmployee, delegations, employees, todayYmd]);

  // The policy in force for one type, and for the one currently selected. Computed before the day count
  // because the sandwich rule is part of what a day COSTS: a type that charges the weekend inside a block
  // makes Friday-to-Monday four days, and the number on screen has to be the number the balance is charged.
  const rulesFor = useMemo(() => {
    const cache = new Map<string, LeaveRestrictions>();
    return (t?: LeaveType) => {
      if (!t) return parseRestrictions({});
      // Keyed by the row's OWN restrictions as well as its path. The merge reads `t.restrictions`, so a cache
      // keyed by the path alone went on answering with the policy a type USED to have the moment an edit
      // reached the row - this admin's, or another's arriving through the store - and the dialog then
      // previewed, and let through, a rule the server no longer enforces.
      const key = `${t.path}\u0000${JSON.stringify(t.restrictions ?? null)}`;
      if (!cache.has(key)) cache.set(key, mergeRestrictions(orgRestrictions, t.restrictions));
      return cache.get(key)!;
    };
  }, [orgRestrictions]);
  const selectedType = types.find((t) => form.leave_type && idOf(t.path) === idOf(form.leave_type));
  const selectedRules = rulesFor(selectedType);

  const formDays = chargeableDays(form.start_date, form.end_date, form.startSession, form.endSession, schedOf, holidaySet, halfHolidaySet, sandwichOf(selectedRules));
  const rangeInverted = !!form.start_date && !!form.end_date && form.end_date < form.start_date;
  // How many calendar days in the range are weekends/holidays (not charged) - shown so the total isn't a
  // surprise. Counted UNDER THE SELECTED TYPE'S SANDWICH RULE, not against a plain working week: a type that
  // charges the weekend inside a block skips nothing, and saying "2 weekend days in between don't count"
  // beside a total that had just counted them is the one sentence on this form that could make somebody file
  // a request they would not have filed.
  const skippedDays = useMemo(() => {
    if (!form.start_date || !form.end_date || rangeInverted) return 0;
    const span = Math.round((Date.parse(form.end_date + "T00:00:00Z") - Date.parse(form.start_date + "T00:00:00Z")) / 86400000) + 1;
    const charged = chargeableDays(form.start_date, form.end_date, 1, 2, schedOf, holidaySet, halfHolidaySet, sandwichOf(selectedRules)) ?? span;
    return Math.max(0, span - charged);
  }, [form.start_date, form.end_date, rangeInverted, schedOf, holidaySet, halfHolidaySet, selectedRules]);

  // Is a single day already free (weekend or full holiday)? Used to label the date pickers, so "why did my
  // Saturday cost nothing" is answered before the request is filed rather than after.
  const dayNote = (ymd: string): string | undefined => {
    if (!ymd) return undefined;
    const d = new Date(ymd + "T00:00:00Z");
    if (Number.isNaN(+d)) return undefined;
    const off = !workDays.includes(d.getUTCDay()) || holidaySet.has(ymd);
    return `${weekdayLongOf(ymd)}${off ? " · already a day off" : halfHolidaySet.has(ymd) ? " · half-day holiday" : ""}`;
  };

  const balanceByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of balances) if (me.employee_id && b.employee && idOf(b.employee) === me.employee_id && b.leave_type) m.set(idOf(b.leave_type), b.balance_days);
    return m;
  }, [balances, me.employee_id]);
  // `undefined` = no balance row for this type (untracked, or not visible to this caller), which is NOT the
  // same answer as zero and must not block a request - the sibling helper for the same data says so in as many
  // words (lib/leaveApproval.tsx: "undefined = not visible / untracked"), and degrades to showing no balance
  // line rather than to "you have none". `null` stays "this type has no balance to track" (unpaid leave).
  const availableFor = (t: LeaveType): number | null | undefined => (t.paid ? balanceByType.get(idOf(t.path)) : null);
  const selectedAvail = selectedType ? availableFor(selectedType) : null;
  const insufficient = selectedAvail != null && formDays != null && formDays > selectedAvail + 1e-9;

  const deptOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e.department]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [employees]);
  const myDept = me.employee_id ? deptOf(`employees/${me.employee_id}`) : undefined;
  const overlaps = useMemo(() => {
    if (!form.start_date || !form.end_date || !myDept) return [];
    return requests
      .filter(
        (lr) =>
          lr.employee &&
          idOf(lr.employee) !== me.employee_id &&
          (upper(lr.state) === "APPROVED" || upper(lr.state) === "PENDING") &&
          deptOf(lr.employee) === myDept &&
          lr.start_date <= form.end_date &&
          lr.end_date >= form.start_date,
      )
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [requests, deptOf, myDept, form.start_date, form.end_date, me.employee_id]);

  // The caller's OWN pending/approved leave that would double-book any day in the range. Session-aware:
  // a morning half and an afternoon half of the same day don't clash, so "take the other half" still works.
  const typeLabel = useMemo(() => {
    const m = new Map(types.map((t) => [idOf(t.path), t.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Leave" : "Leave");
  }, [types]);
  const myConflicts = useMemo(() => {
    if (!form.start_date || !form.end_date || !me.employee_id || form.end_date < form.start_date) return [];
    const nS = form.start_date, nE = form.end_date;
    // The caller's own requests, read as the caller's: this guard gates `canSubmit`, so leave that fell off a
    // department-wide window would let a double-booking through to the server to be caught there instead.
    return myRequests
      .filter((lr) => {
        if (!lr.employee || idOf(lr.employee) !== me.employee_id) return false;
        const st = upper(lr.state);
        if (st !== "APPROVED" && st !== "PENDING") return false;
        const eS = lr.start_date.slice(0, 10), eE = lr.end_date.slice(0, 10);
        const o1 = eS > nS ? eS : nS, o2 = eE < nE ? eE : nE;
        if (o1 > o2) return false; // no shared days
        if (o1 < o2) return true; // 2+ shared days always clash
        // Exactly one shared day: clash only if the session ranges on that day intersect.
        const a1 = eS === o1 ? (lr.start_session ?? 1) : 1, a2 = eE === o1 ? (lr.end_session ?? 2) : 2;
        const b1 = nS === o1 ? form.startSession : 1, b2 = nE === o1 ? form.endSession : 2;
        return a1 <= b2 && b1 <= a2;
      })
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [myRequests, me.employee_id, form.start_date, form.end_date, form.startSession, form.endSession]);

  // What each day on the calendar is: its holiday, and which of my department is already away then. Both come
  // from rows this dialog already holds, so the picker costs no extra reads.
  // Three shortcuts, for the three requests that don't need a calendar at all: half of today (the appointment
  // / went-home-unwell case, which otherwise costs a date pick plus a duration change), tomorrow, and the one
  // or two days that would turn an upcoming holiday into a proper break. A pick that lands entirely on days
  // off is dropped rather than offered as a dud.
  const quickPicks = useMemo(() => {
    const today = ymdIn(0);
    // Both halves of today, whatever the clock says: half days get filed after the fact as often as before it
    // (the morning you were at the clinic), so hiding one of them by time of day only gets in the way.
    // "First / second half" rather than "morning / afternoon" is the wording the request badges and the detail
    // sheet already use, and it doesn't invite an argument about when the morning ends.
    const picks: { label: string; hint?: string; from: string; to: string; startSession: number; endSession: number }[] = [
      { label: "First half today", from: today, to: today, startSession: 1, endSession: 1 },
      { label: "Second half today", from: today, to: today, startSession: 2, endSession: 2 },
      { label: "Tomorrow", from: ymdIn(1), to: ymdIn(1), startSession: 1, endSession: 2 },
    ];
    // The cheapest leave that buys a long break, over the holidays of this month and next - the same
    // arithmetic the Holidays page offers, brought to where leave is actually filed. Best value per day
    // spent wins; ties go to the nearest holiday because the scan runs in date order.
    const isOff = (d: string) => !workDays.includes(dowOf(d)) || holidaySet.has(d);
    const horizon = endOfNextMonth(today);
    let best: { take: string[]; days: number } | null = null;
    for (const h of [...holidaySet].filter((d) => d > today && d <= horizon).sort()) {
      const bridge = bestBridge(breakAround(h, isOff), isOff, { maxTake: 2, minDays: 4 });
      if (!bridge) continue;
      if (!best || bridge.days / bridge.take.length > best.days / best.take.length) best = bridge;
    }
    if (best) {
      const from = best.take[0]!;
      const to = best.take[best.take.length - 1]!;
      picks.push({
        label:
          from === to
            ? dayLabel(from)
            : `${from.slice(0, 7) === to.slice(0, 7) ? weekdayDay(from) : dayLabel(from)}-${dayLabel(to)}`,
        // The payoff belongs in the tooltip: on the chip itself it competes with the date for the same glance.
        hint: `Takes ${best.take.length === 1 ? "this day" : "these days"} off for a ${best.days}-day break`,
        from,
        to,
        startSession: 1,
        endSession: 2,
      });
    }
    return picks.filter((p) => {
      if (minDate && p.from < minDate) return false;
      return (chargeableDays(p.from, p.to, p.startSession, p.endSession, schedOf, holidaySet, halfHolidaySet) ?? 0) > 0;
    });
  }, [workDays, schedOf, minDate, holidaySet, halfHolidaySet]);

  const holidayNameByDay = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of mine) m.set(h.date.slice(0, 10), h.display_name || "Holiday");
    return m;
  }, [mine]);
  const awayByDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const lr of requests) {
      const st = upper(lr.state);
      if (st !== "APPROVED" && st !== "PENDING") continue;
      if (!lr.employee || idOf(lr.employee) === me.employee_id) continue;
      if (myDept && deptOf(lr.employee) !== myDept) continue;
      const end = Date.parse(lr.end_date.slice(0, 10) + "T00:00:00Z");
      for (let t = Date.parse(lr.start_date.slice(0, 10) + "T00:00:00Z"); t <= end; t += 86400000) {
        const ymd = new Date(t).toISOString().slice(0, 10);
        const at = m.get(ymd) ?? [];
        at.push(empName(lr.employee));
        m.set(ymd, at);
      }
    }
    return m;
  }, [requests, me.employee_id, myDept, deptOf, empName]);
  // Stable per set of facts, not per render: the calendar memoizes "does any visible day carry a policy bar"
  // on this function's identity, and a fresh closure every render would make that memo do nothing.
  const dayInfo = useCallback((ymd: string): DayInfo | undefined => {
    const holiday = holidayNameByDay.get(ymd);
    const away = awayByDay.get(ymd);
    // The policy's own view of this one date, through the SAME predicates the server refuses with
    // (domain/leaveRestrictions.ts#dayBar) - so a day the grid strikes out and a day the server would refuse
    // are the same set, not two readings of one rule. Only the rules that can be decided for a date on its
    // own: a notice requirement depends on how long the request is, so it belongs in the policy list instead.
    const bar = selectedType ? dayBar(selectedRules, ymd) : null;
    // The KIND travels with the reason: a closed period is drawn as the span it is, a recurring rule as a
    // mark on its own day. Both come from the same predicate, so neither drawing can disagree with the
    // refusal.
    const barred = bar
      ? { reason: dayBarReason(bar), kind: bar.kind === "window" ? ("window" as const) : ("day" as const) }
      : undefined;
    if (!holiday && !away && !barred) return undefined;
    return { holiday, halfHoliday: halfHolidaySet.has(ymd), away, barred };
  }, [holidayNameByDay, awayByDay, halfHolidaySet, selectedType, selectedRules]);

  /**
   * The leave policy, previewed before the round trip.
   *
   * The SERVER is the authority - it re-runs this same function over rows it can see and this one cannot (a
   * request of somebody else's that the window dropped, a notice period this caller can't read). What running
   * it here buys is that the common refusals - short notice, a quota, a blackout - are answered while the form
   * is still open and the dates can be changed, instead of coming back as a sentence under a closed dialog.
   */
  const violations = useMemo(() => {
    if (!selectedType || !form.start_date || !form.end_date || formDays == null || formDays <= 0) return [];
    const typeId = idOf(selectedType.path);
    // A COMBINATION RULE BINDS BOTH TYPES, so "does this type configure anything?" is the wrong question to
    // decide whether there is a policy to evaluate. A type with an empty blob of its own that another type
    // names in `no_combination_with` is still bound by it - the server says so in as many words
    // (services/leaveRequests.ts#inboundCombinationGap) and refuses the create. Without this half the dialog
    // showed a clean checklist and an enabled Submit for exactly that configuration, then the request came
    // back refused: the one case where the preview answered the opposite of the server. Pure in-memory over
    // rules the dialog has already merged for every type, so it costs no read.
    const inboundRule = types.some((t) => idOf(t.path) !== typeId
      && rulesFor(t).combinations.no_combination_with?.some((ref) => idOf(ref) === typeId));
    if (!hasAnyRestriction(selectedRules) && !inboundRule) return [];
    const startMs = Date.parse(form.start_date + "T00:00:00Z");
    const endMs = Date.parse(form.end_date + "T00:00:00Z");
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return [];
    const neighbours: LeaveNeighbour[] = myRequests
      .filter((lr) => lr.employee && idOf(lr.employee) === me.employee_id && (upper(lr.state) === "APPROVED" || upper(lr.state) === "PENDING"))
      .map((lr) => {
        const t = types.find((x) => lr.leave_type && idOf(x.path) === idOf(lr.leave_type));
        return {
          uuid: lr.path,
          leaveTypeId: lr.leave_type ? idOf(lr.leave_type) : "",
          leaveTypeName: t?.display_name,
          startMs: Date.parse(lr.start_date.slice(0, 10) + "T00:00:00Z"),
          endMs: Date.parse(lr.end_date.slice(0, 10) + "T00:00:00Z"),
          startSession: lr.start_session ?? 1,
          endSession: lr.end_session ?? 2,
          noCombinationWith: t ? rulesFor(t).combinations.no_combination_with : null,
        };
      });
    // "Ever" can't be answered from a page of requests, so the lifetime rules are left to the server rather
    // than previewed from a window that would under-count them and say yes to something it will refuse.
    const serving = noticePeriods.find((n) => (n.status ?? "").toLowerCase() === "serving" && !n.delete_time);
    const exitWindow = serving
      ? { fromMs: Date.parse(serving.notice_date.slice(0, 10) + "T00:00:00Z"), toMs: Date.parse(serving.last_working_day.slice(0, 10) + "T00:00:00Z") }
      : null;
    // Days of THIS type already booked inside the notice window, counted whole for a request that straddles
    // the notice date - the same reading the server takes (services/leaveRequests.ts). Computed rather than
    // passed as 0, which previewed an `exit.during_notice: "capped"` policy as `0 + days` against the cap and
    // so always looked satisfiable. Like `neighbours`, it is read off the page of own requests the dialog
    // already holds, so a request past that window's cursor is not counted and the preview can under-count;
    // the server re-runs the rule over an aggregate and is the authority. (`lifetime` is left null for the
    // same reason one step further: "ever" cannot be answered from a page at all.)
    const exitDaysUsed = exitWindow
      ? myRequests
        .filter((lr) => lr.employee && idOf(lr.employee) === me.employee_id
          && (upper(lr.state) === "APPROVED" || upper(lr.state) === "PENDING")
          && lr.leave_type && idOf(lr.leave_type) === typeId
          && Date.parse(lr.end_date.slice(0, 10) + "T00:00:00Z") >= exitWindow.fromMs
          && Date.parse(lr.start_date.slice(0, 10) + "T00:00:00Z") <= exitWindow.toMs)
        .reduce((sum, lr) => sum + (Number(lr.days) || 0), 0)
      : 0;
    return checkLeaveRestrictions({
      rules: selectedRules,
      leaveTypeId: typeId,
      leaveTypeName: selectedType.display_name,
      startMs,
      endMs,
      startSession: form.startSession,
      endSession: form.endSession,
      days: formDays,
      todayMs: Date.parse(todayYmd + "T00:00:00Z"),
      employeeStartMs: meEmployee?.start_date ? Date.parse(meEmployee.start_date.slice(0, 10) + "T00:00:00Z") : null,
      onBehalf: false,
      // Answered here, where the server cannot answer it at all: the create path passes null because the row
      // has to exist before a file can hang off it, so IT defers the document rule to approval. This form has
      // the file in hand, so it asks for it now - which is the moment it is easiest to produce, and stops a
      // request being filed today only to be refused by the approver on Friday.
      hasDocument: !!doc,
      reason: form.reason,
      schedOf,
      holidays: holidaySet,
      halfDayHolidays: halfHolidaySet,
      neighbours: neighbours.filter((n) => n.leaveTypeId),
      lifetime: null,
      exitWindow,
      exitDaysUsed,
    });
  }, [selectedType, selectedRules, rulesFor, form.start_date, form.end_date, form.startSession, form.endSession, form.reason, formDays, myRequests, types, me.employee_id, todayYmd, meEmployee, schedOf, holidaySet, halfHolidaySet, doc, noticePeriods]);
  /**
   * Why a type can't be taken by this person AT ALL, whatever dates they pick. Only reasons that are true of
   * the PERSON belong here - a type shut for the whole notice period is one; a service requirement is not,
   * because leave that starts after the waiting period ends is allowed and booking ahead for it is the point
   * (the violation panel names the eligible-from date once dates are chosen, which is the honest answer).
   */
  const eligibilityBlock = (t: LeaveType): string | null => {
    const r = rulesFor(t);
    if (r.exit.during_notice === "blocked" && noticePeriods.some((n) => (n.status ?? "").toLowerCase() === "serving" && !n.delete_time)) {
      return "not available during notice period";
    }
    return null;
  };

  const blocking = violations.filter((v) => v.severity === "error");
  const waived = violations.filter((v) => v.severity === "warning");
  // Until there are dates, no rule has been judged: the checklist lists what the policy asks for rather than
  // ticking things it has not actually checked.
  const datesChosen = !!form.start_date && !!form.end_date && formDays != null && formDays > 0;

  /**
   * THE POLICY AS ONE CHECKLIST, each rule in exactly one place whether it is met or broken.
   *
   * This replaces three surfaces that each stated part of the policy: a notice hint on the Start date
   * field, a panel of blocking violations, and a panel of waived ones. They overlapped, so the code carried
   * a flag to stop the hint printing a sentence the panel was already printing - an invariant living in a
   * boolean that the next surface to be added would have had to remember. Here a rule has one row, and the
   * row changes state; there is nothing to keep in sync.
   *
   * Built by joining what the policy SAYS (a clause per leaf) to what the evaluator ANSWERS (a violation per
   * code) through the domain's own `LEAF_CODES`, so the screen never forms its own opinion about which rule
   * a refusal belongs to.
   */
  const policyChecks = useMemo(() => {
    if (!selectedType || !hasAnyRestriction(selectedRules)) return [];
    const byCode = new Map(violations.map((v) => [v.code, v]));
    const seen = new Set<string>();
    const rows = describeRestrictionsByGroup(selectedRules)
      // A waiver is not a rule - it changes what breaking one costs, and each waived rule says so on its
      // own row below.
      .filter((c) => c.group !== "soft_rules")
      .map((c) => {
        const code = LEAF_CODES[`${c.group}.${c.leaf}`];
        const hit = code ? byCode.get(code) : undefined;
        if (code) seen.add(code);
        return {
          key: `${c.group}.${c.leaf}`,
          text: hit?.message ?? c.text,
          state: !datesChosen ? "pending" : hit ? (hit.severity === "error" ? "unmet" : "waived") : "met",
        } as const;
      });
    // Anything the evaluator refused that no clause described. Should be empty - but a rule the reader is
    // blocked by and cannot see is the one failure this panel must not have, so it is caught rather than
    // trusted away.
    const orphans = violations
      .filter((v) => !seen.has(v.code))
      .map((v) => ({ key: `violation-${v.code}`, text: v.message, state: v.severity === "error" ? "unmet" : "waived" } as const));
    return [...rows, ...orphans];
  }, [selectedType, selectedRules, violations, datesChosen]);
  // The notice rule used to be stated here as well, as a hint on the Start date field, with a flag to stop it
  // printing while the violation panel was printing the same sentence. Both are gone: the checklist above
  // states that rule in one row and changes the row's state, so there is no second surface to suppress. The
  // flag was an invariant kept by hand, and the next surface added would have had to remember it.

  const canSubmit = !!form.leave_type && !!form.start_date && !!form.end_date && !!formDays && !insufficient && myConflicts.length === 0 && blocking.length === 0;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const created = await create<LeaveRequest>("leave-requests", {
        leave_type: form.leave_type,
        start_date: form.start_date,
        end_date: form.end_date,
        start_session: form.startSession,
        end_session: form.endSession,
        reason: form.reason,
      });
      // The bytes can only hang off a filed request, so the attachment is a second call. A failure here leaves
      // a perfectly good request behind - say so rather than implying the whole thing failed.
      if (doc) {
        try {
          await upload(created.path, doc);
        } catch (e) {
          toast({ title: "Leave requested, but the document didn't attach", description: (e as Error).message, variant: "destructive" });
          try { sessionStorage.removeItem(DRAFT_KEY()); } catch { /* nothing to clean up */ }
          // Cleared alongside the rest, exactly as the success path below does. The draft this flag refers to
          // has just been deleted, so a mount site that keeps this component alive would otherwise reopen it
          // showing "Picked up where you left off" and a Start over link over an empty form.
          setRestored(false);
          setForm({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
          setDoc(null);
          onOpenChange(false);
          onSubmitted?.();
          return;
        }
      }
      toast({ title: "Leave requested", variant: "success" });
      try { sessionStorage.removeItem(DRAFT_KEY()); } catch { /* nothing to clean up */ }
      setRestored(false);
      setForm({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
      setDoc(null);
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onOpenChange(false); }}>
      {/* scrollBody: this is a dozen fields and a calendar, so on a phone the whole panel used to scroll and
          "Request leave" sat below the fold - the button you came to press was the one thing you could not
          see. The form scrolls inside; the title and the two actions stay put. */}
      <DialogContent scrollBody className="sm:max-w-2xl" onEnterSubmit={() => { if (!busy && canSubmit) void submit(); }}>
        <DialogHeader>
          <DialogTitle>Request leave</DialogTitle>
          <DialogDescription>
            {decider ? <>Goes to {decider.name} for approval{decider.coveringFor ? ` (covering for ${decider.coveringFor} until ${formatDate(decider.until!)})` : ""}.</> : <>Weekends and holidays in the range don't come off your balance.</>}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        {restored && (
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            Picked up where you left off.
            <button type="button" onClick={startOver} className="font-medium text-primary hover:underline">Start over</button>
          </p>
        )}
        {/* One column, in the order the request is actually thought through: what kind of leave, which days,
            how much of the first and last, what it costs, and only then who else it affects. */}
        <div className="grid gap-5">
          <div className="order-2 space-y-4">
            {myConflicts.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">You already have leave on these dates</p>
                <ul className="mt-1 space-y-1">
                  {myConflicts.map((lr) => (
                    <li key={lr.path} className="flex items-center justify-between gap-2">
                      <span>{typeLabel(lr.leave_type)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(lr.start_date)} - {formatDate(lr.end_date)}{upper(lr.state) === "PENDING" ? " · pending" : ""}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-muted-foreground">Change the dates, or cancel the existing request first.</p>
              </div>
            )}
            {policyChecks.length > 0 && (
              <div className={cn(
                "rounded-lg border p-3 text-sm",
                blocking.length > 0 ? "border-destructive/40 bg-destructive/10" : waived.length > 0 ? "border-warning/40 bg-warning/10" : "bg-muted/40",
              )}>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{selectedType?.display_name ?? "Leave"} policy</p>
                  <p className={cn(
                    "text-xs font-medium",
                    blocking.length > 0 ? "text-destructive" : waived.length > 0 ? "text-warning-foreground dark:text-warning" : "text-muted-foreground",
                  )}>
                    {!datesChosen
                      ? `${policyChecks.length} rule${policyChecks.length === 1 ? "" : "s"} apply`
                      : blocking.length > 0
                        ? `${blocking.length} rule${blocking.length === 1 ? "" : "s"} not met`
                        : waived.length > 0
                          ? "Your approver will be told"
                          : "All rules met"}
                  </p>
                </div>
                <ul className="space-y-1">
                  {policyChecks.map((c) => (
                    <li key={c.key} className="flex items-start gap-2">
                      {/* The mark carries the state in shape as well as colour - a row that reads only by
                          hue says nothing to a reader who cannot separate the two. */}
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none",
                          c.state === "met" && "bg-success text-success-foreground",
                          c.state === "unmet" && "bg-destructive text-destructive-foreground",
                          c.state === "waived" && "bg-warning text-warning-foreground",
                          c.state === "pending" && "border border-muted-foreground/40 text-muted-foreground",
                        )}
                      >
                        {c.state === "met" ? "✓" : c.state === "unmet" ? "✕" : c.state === "waived" ? "!" : "·"}
                      </span>
                      <span className={cn(c.state === "pending" && "text-muted-foreground")}>
                        {c.text}
                        {c.state === "waived" && (
                          <span className="text-warning-foreground dark:text-warning"> - waived, your approver decides.</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {waived.length > 0 && blocking.length === 0 && (
                  <p className="mt-1.5 text-xs text-muted-foreground">You can still file this; it goes for approval with a note of what it breaks.</p>
                )}
              </div>
            )}
            {overlaps.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warning-foreground dark:text-warning"><Users className="h-4 w-4" /> Also off in your department</p>
                <ul className="space-y-1">
                  {overlaps.map((lr) => (
                    <li key={lr.path} className="flex items-center justify-between gap-2">
                      <span>{empName(lr.employee)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(lr.start_date)}–{formatDate(lr.end_date)}{upper(lr.state) === "PENDING" ? " · pending" : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="order-1 space-y-4">
            <Field label="Leave type">
              <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
                <SelectTrigger><SelectValue placeholder="Select a type…" /></SelectTrigger>
                <SelectContent>
                  {types.filter((t) => !t.disabled).map((t) => {
                    const avail = availableFor(t);
                    const lacks = avail != null && formDays != null && formDays > avail + 1e-9;
                    // A type the policy bars on probation is a guaranteed server rejection; say so in the list
                    // rather than after the click.
                    const barred = onProbation && t.available_during_probation === false;
                    // The same for a type nobody at this tenure may take at all, or one shut for the whole
                    // notice period - both are properties of the PERSON rather than of the dates, so they can
                    // be answered in the list instead of after a date is picked.
                    const ineligible = eligibilityBlock(t);
                    return (
                      <SelectItem key={t.path} value={`leave-types/${idOf(t.path)}`} disabled={lacks || barred || !!ineligible}>
                        {t.display_name}{avail != null ? ` · ${avail} left` : ""}{barred ? " - not available during probation" : ineligible ? ` - ${ineligible}` : lacks ? " - not enough balance" : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </Field>
            <FieldRow>
              <Field label="Start date" hint={dayNote(form.start_date)}>
                <Input
                  type="date"
                  min={minDate}
                  value={form.start_date}
                  // Picking a start auto-fills the end (single-day is the common case) and drags a now-stale end along.
                  onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, start_date: v, end_date: !f.end_date || f.end_date < v ? v : f.end_date })); }}
                />
              </Field>
              <Field label="End date" hint={rangeInverted ? undefined : dayNote(form.end_date)} error={rangeInverted ? "End date is before the start date." : undefined}>
                <Input type="date" min={form.start_date || minDate} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
              </Field>
            </FieldRow>
            {/* Most leave is one day, soon, or a clean block of a week: chips beat two date pickers for those,
                and the pickers above still take anything else. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Quick pick</span>
              {quickPicks.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  title={p.hint}
                  onClick={() => setForm((f) => ({ ...f, start_date: p.from, end_date: p.to, startSession: p.startSession, endSession: p.endSession }))}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                    // Sessions count too: a full day today is not the same pick as half of today.
                    form.start_date === p.from && form.end_date === p.to && form.startSession === p.startSession && form.endSession === p.endSession &&
                      "border-primary bg-primary/10 text-primary",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {/* The picker that shows what those dates mean: which days are already off, where the holidays are,
                and who on the team is away then. Click a day, click again to close the range, or drag. */}
            <DateRangeCalendar
              start={form.start_date}
              end={form.end_date}
              minDate={minDate}
              workDays={workDays}
              weekStart={weekStart}
              dayInfo={dayInfo}
              onSelect={({ start, end }) =>
                // A multi-day range has no "morning only" meaning on both ends at once, so the boundaries reset
                // to whole days whenever the range stops being a single day.
                setForm((f) => ({ ...f, start_date: start, end_date: end, ...(start === end ? {} : { startSession: 1, endSession: 2 }) }))
              }
            />
            {form.start_date && form.start_date === form.end_date ? (
              <Field label="Duration">
                <Segmented
                  label="Duration"
                  value={form.startSession === 1 && form.endSession === 2 ? "full" : form.startSession === 1 ? "am" : "pm"}
                  onChange={(v) => setForm({ ...form, startSession: v === "pm" ? 2 : 1, endSession: v === "am" ? 1 : 2 })}
                  options={[
                    { value: "full", label: "Full day" },
                    { value: "am", label: "Morning", hint: "First half of the day" },
                    { value: "pm", label: "Afternoon", hint: "Second half of the day" },
                  ]}
                />
              </Field>
            ) : form.start_date && form.end_date && form.end_date > form.start_date ? (
              <FieldRow>
                <Field label="First day">
                  <Segmented
                    label="First day"
                    value={form.startSession}
                    onChange={(v) => setForm({ ...form, startSession: v })}
                    options={[{ value: 1, label: "Full day" }, { value: 2, label: "Afternoon only" }]}
                  />
                </Field>
                <Field label="Last day">
                  <Segmented
                    label="Last day"
                    value={form.endSession}
                    onChange={(v) => setForm({ ...form, endSession: v })}
                    options={[{ value: 2, label: "Full day" }, { value: 1, label: "Morning only" }]}
                  />
                </Field>
              </FieldRow>
            ) : null}
            {/* What the request costs, next to the dates that decide it: the days it uses, the days the range
                skipped, and the balance it leaves behind. Below the reason box this number was read too late to
                change anyone's mind. */}
            {formDays != null && (
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border p-3",
                  insufficient ? "border-destructive/40 bg-destructive/10" : formDays === 0 ? "border-warning/40 bg-warning/10" : "bg-muted/40",
                )}
              >
                <span className="text-sm">
                  <span className="text-2xl font-semibold tabular-nums">{fmtDays(formDays)}</span>{" "}
                  <span className="text-muted-foreground">day{formDays === 1 ? "" : "s"} of leave</span>
                  {skippedDays > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {skippedDays} weekend/holiday day{skippedDays === 1 ? "" : "s"} in between {skippedDays === 1 ? "doesn't" : "don't"} count
                    </span>
                  )}
                </span>
                {formDays === 0 ? (
                  <span className="text-sm text-warning-foreground dark:text-warning">No working days in this range. Pick a working day.</span>
                ) : insufficient ? (
                  <span className="text-sm font-medium text-destructive">Only {fmtDays(selectedAvail!)} day{selectedAvail === 1 ? "" : "s"} left in this balance.</span>
                ) : selectedAvail != null ? (
                  <span className="text-right text-sm text-muted-foreground">
                    <span className="block font-medium tabular-nums text-foreground">
                      {fmtDays(selectedAvail - formDays)} of {fmtDays(selectedAvail)} left
                    </span>
                    if this is approved
                  </span>
                ) : selectedType && !selectedType.paid ? (
                  <span className="text-sm text-muted-foreground">Unpaid, so nothing comes off a balance.</span>
                ) : null}
              </div>
            )}
          </div>
        </div>
        <FieldRow>
          <Field label="Reason (optional)">
            {/* Masked AND ignored in session replay (web/src/instrument.ts): masking hides the text, `ignore`
                stops the keystrokes being recorded as they are typed - which matters here more than anywhere,
                because what somebody types into this box is routinely a diagnosis or a bereavement, and they
                are typing it into a form, not choosing to publish it. The label stays readable. */}
            <Textarea rows={3} data-sentry-mask data-sentry-ignore value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <Field label="Supporting document (optional)" hint="A sick note or travel paperwork, attached to this request when it is filed.">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf"
              onChange={(e) => { setDoc(e.target.files?.[0] ?? null); e.target.value = ""; }}
            />
            {doc ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                <button type="button" aria-label="Remove the attachment" onClick={() => setDoc(null)} className="rounded p-0.5 hover:bg-accent">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              // No object exists yet, so this manages the collection-level grant for the upload verb - who may
              // attach a document to a leave request at all.
              <AccessAction collection="leave-requests" verb="upload" label="Attach a document">
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Paperclip className="h-4 w-4" /> Attach a file
                </Button>
              </AccessAction>
            )}
          </Field>
        </FieldRow>
        <FormError error={err} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>Request leave</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
