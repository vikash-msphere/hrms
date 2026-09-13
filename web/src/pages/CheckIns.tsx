import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Plus, Trash2, Check, X, CalendarDays, CalendarPlus, CalendarClock, ChevronRight, ArrowDownToLine, ListPlus, ListTodo, History, Repeat, Search, SquareKanban, Lock, Sparkles } from "lucide-react";
import { create, patch, remove, list } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd } from "@/lib/orgDay";
import type { Board, CheckIn, CheckInActionItem, Employee, Goal, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { PersonAvatar } from "@/components/common/PersonAvatar";
import { MakeTaskDialog } from "@/components/common/MakeTaskDialog";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { addMonthsFromAnchor } from "../../../src/domain/calendar";

const plusDays = addDaysYmd;
// One step along a cadence, mirroring the cron that creates the next 1:1: weeks in days, monthly by calendar
// month. `anchorDay` is the series' own day of the month - the cron carries it on the row, and the preview
// carries it down the chain below, so a monthly 1:1 on the 31st reads "28 Feb · 31 Mar · 30 Apr" rather than
// dropping to the 28th for good after one short month (domain/calendar.ts#addMonthsFromAnchor).
const stepCadence = (iso: string, cadence: string, anchorDay: number) => {
  if (cadence !== "monthly") return plusDays(iso, cadence === "weekly" ? 7 : 14);
  return addMonthsFromAnchor(new Date(`${iso}T00:00:00Z`), 1, anchorDay).toISOString().slice(0, 10);
};
// "Today" / "Tomorrow" / "In n days" for the near future, where a calendar date makes you do the math yourself.
const relativeDay = (iso: string): string | null => {
  const days = Math.round((new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${todayStr()}T00:00:00Z`).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return `In ${days} days`;
  return null;
};

const PAST_PREVIEW = 8;

export default function CheckIns({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<CheckIn>("check-ins");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  // Prefill for the dialog. "Schedule next" from a past 1:1 carries the person AND its open action
  // items over; `source` is that past 1:1, whose carried items get marked done once the new one exists.
  const [creating, setCreating] = useState<{ counterpart?: string; counterpartName?: string; date?: string; action_items?: CheckInActionItem[]; source?: CheckIn } | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAllPast, setShowAllPast] = useState(false);
  // "Make task": promote an action item to a board card (one-way; the item stays on the 1:1).
  const [makeTask, setMakeTask] = useState<{ text: string; from: CheckIn } | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  // The other person in the 1:1, from the caller's side of it.
  const otherRef = (c: CheckIn) => (idOf(c.employee ?? "") === me.employee_id ? c.counterpart : c.employee);
  // The name comes off the ROW first. An employee can read only their own employee record, so resolving the
  // other attendee out of the employees collection works for a manager and leaves an employee looking at "-"
  // on their own 1:1 - which is why the server serves both names with the row.
  const otherParty = (c: CheckIn) =>
    (idOf(c.employee ?? "") === me.employee_id ? c.counterpart_name : c.employee_name) || empName(otherRef(c));

  // Everyone the caller has 1:1s with, plus cadence health: days since the last logged 1:1, and
  // whether a next one is already on the calendar (scheduled pairs don't need the overdue nudge).
  const people = useMemo(() => {
    const today = todayStr();
    const last = new Map<string, string>();
    const scheduled = new Set<string>();
    const names = new Map<string, string>();
    for (const c of rows) {
      const ref = otherRef(c);
      if (!ref) continue;
      const id = idOf(ref);
      if (!names.has(id)) names.set(id, empName(ref));
      const d = c.meeting_date ?? "";
      if (d >= today) scheduled.add(id);
      else if (d > (last.get(id) ?? "")) last.set(id, d);
    }
    return [...names.entries()]
      .map(([id, name]) => {
        const lastDate = last.get(id);
        const days = lastDate ? Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${lastDate}T00:00:00Z`).getTime()) / 86400000) : null;
        return { id, name, days, overdue: days != null && days > 30 && !scheduled.has(id) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, empName]);

  // Clicking a metric narrows the 1:1s below to the ones it counted: the meetings carrying unfinished items,
  // what is still ahead, or the people who have gone too long without one.
  const overdueIds = useMemo(() => new Set(people.filter((p) => p.overdue).map((p) => p.id)), [people]);
  const kf = useKpiFocus<CheckIn, "open" | "upcoming" | "overdue">({
    open: { label: "1:1s with open action items", match: (c) => (c.action_items ?? []).some((i) => !i.done) },
    upcoming: { label: "scheduled 1:1s", match: (c) => (c.meeting_date ?? "") >= todayStr() },
    overdue: { label: "1:1s with people you are overdue with", match: (c) => overdueIds.has(idOf(otherRef(c) ?? "")) },
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kf.apply(rows.filter(
      (c) =>
        (!personFilter || idOf(otherRef(c) ?? "") === personFilter) &&
        (!q ||
          (c.notes ?? "").toLowerCase().includes(q) ||
          (c.action_items ?? []).some((i) => i.text.toLowerCase().includes(q)) ||
          otherParty(c).toLowerCase().includes(q))
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, personFilter, query, kf.focus]);

  // Meeting-date framing: scheduled 1:1s (today onward, soonest first) ahead of past ones (newest first).
  const { upcoming, past } = useMemo(() => {
    const today = todayStr();
    const key = (c: CheckIn) => c.meeting_date ?? c.create_time ?? "";
    const up = visible.filter((c) => (c.meeting_date ?? "") >= today).sort((a, b) => key(a).localeCompare(key(b)));
    const done = visible.filter((c) => (c.meeting_date ?? "") < today).sort((a, b) => key(b).localeCompare(key(a)));
    return { upcoming: up, past: done };
  }, [visible]);
  // While searching, a hidden match reads as "no result" - so search disables the past cutoff.
  const pastShown = showAllPast || query.trim() ? past : past.slice(0, PAST_PREVIEW);

  // Strip figures count every 1:1 the caller can see, so they hold still while a metric narrows the list.
  const totalOpenItems = useMemo(() => rows.reduce((s, c) => s + (c.action_items ?? []).filter((i) => !i.done).length, 0), [rows]);
  const scheduled = useMemo(() => {
    const today = todayStr();
    return rows.filter((c) => (c.meeting_date ?? "") >= today).sort((a, b) => (a.meeting_date ?? "").localeCompare(b.meeting_date ?? ""));
  }, [rows]);
  const nextMeeting = scheduled[0];
  const scheduledCount = scheduled.length;

  // Open action items stranded in past 1:1s, per person - what an upcoming 1:1 can pull forward.
  const openByPerson = useMemo(() => {
    const today = todayStr();
    const m = new Map<string, { c: CheckIn; items: CheckInActionItem[] }[]>();
    for (const c of rows) {
      if ((c.meeting_date ?? "") >= today) continue;
      const open = (c.action_items ?? []).filter((i) => !i.done);
      const ref = otherRef(c);
      if (!open.length || !ref) continue;
      m.set(idOf(ref), [...(m.get(idOf(ref)) ?? []), { c, items: open }]);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Marks a 1:1's open items done, used when they have been carried into a newer 1:1 - "moved
  // forward", not completed, but done is what keeps them from being offered (and counted) twice.
  const retireOpenItems = (c: CheckIn) =>
    patch(`check-ins/${idOf(c.path)}`, { action_items: (c.action_items ?? []).map((i) => (i.done ? i : { ...i, done: true })) });

  async function bringForward(target: CheckIn) {
    const sources = openByPerson.get(idOf(otherRef(target) ?? "")) ?? [];
    const moved = sources.flatMap((s) => s.items);
    if (!moved.length) return;
    try {
      await patch(`check-ins/${idOf(target.path)}`, {
        action_items: [...(target.action_items ?? []), ...moved.map((i) => ({ text: i.text, done: false }))],
      });
      for (const s of sources) await retireOpenItems(s.c);
      reload();
      toast({ title: `Brought ${moved.length} item${moved.length === 1 ? "" : "s"} forward`, variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't bring items forward", description: (e as Error).message, variant: "destructive" });
      reload();
    }
  }

  async function reschedule(c: CheckIn, date: string) {
    try { await patch(`check-ins/${idOf(c.path)}`, { meeting_date: date }); reload(); toast({ title: `Moved to ${formatDate(date)}`, variant: "success" }); }
    catch (e) { toast({ title: "Couldn't reschedule", description: (e as Error).message, variant: "destructive" }); }
  }

  async function setCadence(c: CheckIn, cadence: CheckIn["cadence"] | null) {
    try { await patch(`check-ins/${idOf(c.path)}`, { cadence }); reload(); toast({ title: cadence ? `Repeats ${CADENCE_LABEL[cadence].toLowerCase()}` : "No longer repeats", variant: "success" }); }
    catch (e) { toast({ title: "Couldn't update the cadence", description: (e as Error).message, variant: "destructive" }); }
  }

  async function saveNotes(c: CheckIn, notes: string) {
    try { await patch(`check-ins/${idOf(c.path)}`, { notes }, c.etag); reload(); toast({ title: "Notes saved", variant: "success" }); }
    catch (e) { toast({ title: "Couldn't save notes", description: (e as Error).message, variant: "destructive" }); }
  }
  // The server decides which side's column a private note lands in, from who is asking - there is no "side"
  // to send, which is what stops a third party writing over somebody's note.
  async function savePrivate(c: CheckIn, note: string) {
    try { await patch(`check-ins/${idOf(c.path)}`, { private_note: note }, c.etag); reload(); toast({ title: "Private note saved", description: "Only you can read it.", variant: "success" }); }
    catch (e) { toast({ title: "Couldn't save your note", description: (e as Error).message, variant: "destructive" }); }
  }
  // No etag: the pulse is one tap on a five-button row, and a stale If-Match would fail a harmless correction.
  async function setPulse(c: CheckIn, pulse: number | null) {
    try { await patch(`check-ins/${idOf(c.path)}`, { pulse }); reload(); }
    catch (e) { toast({ title: "Couldn't record that", description: (e as Error).message, variant: "destructive" }); reload(); }
  }
  // Action items save the moment they change (no etag: quick successive toggles would race the
  // store's async refresh and trip the If-Match check for no user benefit on this tiny list).
  async function saveItems(c: CheckIn, items: CheckInActionItem[]) {
    try { await patch(`check-ins/${idOf(c.path)}`, { action_items: items }); reload(); }
    catch (e) { toast({ title: "Couldn't update action items", description: (e as Error).message, variant: "destructive" }); reload(); }
  }
  async function del(c: CheckIn) {
    if (!(await confirm({ title: "Delete this 1:1?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`check-ins/${idOf(c.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  useIntent("new-checkin", () => setCreating({}));

  const newBtn = (
    <AccessAction collection="check-ins" create label="New 1:1">
      <Button onClick={() => setCreating({})}><Plus className="h-4 w-4" /> New 1:1</Button>
    </AccessAction>
  );

  const cardFor = (c: CheckIn, opts?: { collapsed?: boolean }) => (
    <CheckInCard
      key={c.path}
      checkIn={c}
      withName={otherParty(c) || "-"}
      startCollapsed={opts?.collapsed}
      carryCount={opts?.collapsed ? 0 : (openByPerson.get(idOf(otherRef(c) ?? "")) ?? []).reduce((s, x) => s + x.items.length, 0)}
      onBringForward={() => bringForward(c)}
      onReschedule={(date) => reschedule(c, date)}
      onSetCadence={(cadence) => setCadence(c, cadence)}
      mine={idOf(c.employee ?? "") === me.employee_id || idOf(c.counterpart ?? "") === me.employee_id}
      isSubject={idOf(c.employee ?? "") === me.employee_id}
      onSaveNotes={(notes) => saveNotes(c, notes)}
      onSavePrivate={(note) => savePrivate(c, note)}
      onSetPulse={(pulse) => setPulse(c, pulse)}
      onSaveItems={(items) => saveItems(c, items)}
      onMakeTask={(text) => setMakeTask({ text, from: c })}
      onDelete={() => del(c)}
      onScheduleNext={() =>
        setCreating({
          counterpart: otherRef(c),
          // Carried as a NAME as well as a ref: an employee can read only their own employee record, so the
          // composer's picker holds no option for their manager and the carried person would be drawn as an
          // empty box - the row is where their name comes from (see `otherParty`).
          counterpartName: otherParty(c),
          date: plusDays(todayStr(), 7),
          action_items: (c.action_items ?? []).filter((i) => !i.done).map((i) => ({ text: i.text, done: false })),
          source: c,
        })
      }
    />
  );

  return (
    <div>
      <PageHeader title="1:1s" description="Your 1:1s. Keep shared notes and action items between you and your manager." actions={newBtn} />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No 1:1s yet" description="Log a 1:1 to keep shared notes and action items. Leave the person blank and it defaults to your manager." action={newBtn} />
        ) : (
          <div className="space-y-6">
            <SummaryStrip
              className="mb-0"
              items={[
                { label: "Open action items", value: totalOpenItems, icon: ListTodo, tone: totalOpenItems > 0 ? "warning" : "muted", hint: totalOpenItems ? "show those 1:1s" : "nothing outstanding", ...kf.kpi("open") },
                {
                  label: "Next 1:1",
                  value: nextMeeting?.meeting_date ? formatDate(nextMeeting.meeting_date) : "-",
                  icon: CalendarDays,
                  hint: nextMeeting ? `with ${otherParty(nextMeeting) || "your manager"}` : "Nothing scheduled",
                  ...(scheduledCount ? kf.kpi("upcoming") : {}),
                },
                ...(overdueIds.size
                  ? [{ label: "Overdue people", value: overdueIds.size, icon: History, tone: "warning" as const, hint: "none in a month", ...kf.kpi("overdue") }]
                  : []),
                { label: "Logged 1:1s", value: rows.length, icon: History, hint: kf.focus ? "show all" : "1:1s on record", onClick: () => kf.setFocus(null), active: kf.focus === null },
              ]}
            />

            <div className="flex flex-wrap items-center gap-1.5">
              {people.length > 1 && <FilterChip active={!personFilter} onClick={() => setPersonFilter(null)}>Everyone</FilterChip>}
              {people.length > 1 &&
                people.map((p) => (
                  <FilterChip key={p.id} active={personFilter === p.id} onClick={() => setPersonFilter(personFilter === p.id ? null : p.id)}>
                    {p.name}
                    {p.days != null && (
                      <span className={cn("ml-1 text-[11px] font-normal tabular-nums", p.overdue ? "font-medium text-amber-600 dark:text-amber-400" : "opacity-60")}>
                        {p.days}d{p.overdue ? " ago" : ""}
                      </span>
                    )}
                  </FilterChip>
                ))}
              <div className="relative ml-auto w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes and action items…" className="h-8 pl-8" />
              </div>
            </div>

            {visible.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {kf.activeLabel ? <>No {kf.activeLabel}. <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all 1:1s</button></> : "No 1:1s match."}
              </p>
            )}
            {upcoming.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" /> Upcoming</h2>
                <div className="space-y-4">{upcoming.map((c) => cardFor(c))}</div>
              </section>
            )}
            {past.length > 0 && (
              <section className="space-y-3">
                {upcoming.length > 0 && (
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><History className="h-3.5 w-3.5" /> Past</h2>
                )}
                <div className="space-y-2">{pastShown.map((c) => cardFor(c, { collapsed: true }))}</div>
                {past.length > PAST_PREVIEW && !showAllPast && (
                  <Button variant="outline" size="sm" onClick={() => setShowAllPast(true)}>
                    Show all {past.length}
                  </Button>
                )}
              </section>
            )}
          </div>
        )}
      </DataState>

      {makeTask && (
        <MakeTaskDialog
          text={makeTask.text}
          source={`From a 1:1 with ${otherParty(makeTask.from) || "your counterpart"}${makeTask.from.meeting_date ? ` on ${formatDate(makeTask.from.meeting_date)}` : ""}.`}
          onClose={() => setMakeTask(null)}
          onCreated={() => toast({ title: "Task created on the board", variant: "success" })}
        />
      )}
      {creating && (
        <NewDialog
          me={me}
          employees={employees}
          initial={creating}
          existing={rows}
          nameOf={empName}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            const src = creating.source;
            const carried = creating.action_items?.length ?? 0;
            setCreating(null);
            // The new 1:1 now owns the carried items; retire them on the old one so they aren't open twice.
            if (src && carried > 0) await retireOpenItems(src).catch(() => undefined);
            reload();
            toast({ title: carried > 0 ? `1:1 logged · ${carried} item${carried === 1 ? "" : "s"} carried forward` : "1:1 logged", variant: "success" });
          }}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active ? "border-transparent bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

const NOTES_TEMPLATE = "Wins:\n\nBlockers:\n\nGrowth:\n\nFeedback:\n";
const CADENCE_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
// What each pulse number means, so "3" isn't left to interpretation on either side of the table.
const PULSE_LABEL: Record<number, string> = { 1: "Rough", 2: "Off", 3: "Fine", 4: "Good", 5: "Great" };

function CheckInCard({ checkIn: c, withName, startCollapsed, carryCount, mine, isSubject, onBringForward, onReschedule, onSetCadence, onSaveNotes, onSavePrivate, onSetPulse, onSaveItems, onMakeTask, onDelete, onScheduleNext }: {
  checkIn: CheckIn;
  withName: string;
  startCollapsed?: boolean;
  carryCount: number;
  /** The caller is one of the two people in this 1:1 - the only ones with a private note of their own. */
  mine: boolean;
  /** The caller is the employee this 1:1 is about: the pulse is theirs to set. */
  isSubject: boolean;
  onBringForward: () => void;
  onReschedule: (date: string) => void;
  onSetCadence: (cadence: CheckIn["cadence"] | null) => void;
  onSaveNotes: (notes: string) => Promise<void>;
  onSavePrivate: (note: string) => Promise<void>;
  onSetPulse: (pulse: number | null) => Promise<void>;
  onSaveItems: (items: CheckInActionItem[]) => Promise<void>;
  onMakeTask: (text: string) => void;
  onDelete: () => void;
  onScheduleNext: () => void;
}) {
  const can = c.access?.can ?? [];
  const canEdit = can.includes("update");
  const [open, setOpen] = useState(!startCollapsed);
  const [notes, setNotes] = useState(c.notes ?? "");
  const [items, setItems] = useState<CheckInActionItem[]>(c.action_items ?? []);
  const [newItem, setNewItem] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [itemsBusy, setItemsBusy] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedDate, setReschedDate] = useState(c.meeting_date ?? "");

  // The private note starts folded: it is not part of what the meeting was, and an open box invites the wrong
  // half of the conversation into the shared one.
  const [privateOpen, setPrivateOpen] = useState(false);
  const [priv, setPriv] = useState(c.private_note ?? "");
  const [privBusy, setPrivBusy] = useState(false);
  const [pulseBusy, setPulseBusy] = useState(false);

  useEffect(() => { setNotes(c.notes ?? ""); }, [c.notes]);
  useEffect(() => { setPriv(c.private_note ?? ""); }, [c.private_note]);
  useEffect(() => { setItems(c.action_items ?? []); }, [c.action_items]);
  const notesDirty = notes !== (c.notes ?? "");
  const privDirty = priv !== (c.private_note ?? "");
  async function savePrivate() {
    if (!privDirty || privBusy) return;
    setPrivBusy(true);
    try { await onSavePrivate(priv); } finally { setPrivBusy(false); }
  }
  const openCount = items.filter((it) => !it.done).length;
  const rel = c.meeting_date ? relativeDay(c.meeting_date) : null;

  // Action items commit immediately (optimistic; a failed save resyncs from the server via reload).
  // Notes stay a draft until "Save notes" so half-typed thoughts never persist behind your back.
  const commitItems = async (next: CheckInActionItem[]) => {
    setItems(next);
    setItemsBusy(true);
    try { await onSaveItems(next); } finally { setItemsBusy(false); }
  };
  const toggle = (i: number) => commitItems(items.map((it, j) => (j === i ? { ...it, done: !it.done } : it)));
  const removeItem = (i: number) => commitItems(items.filter((_, j) => j !== i));
  const addItem = () => { if (newItem.trim()) { void commitItems([...items, { text: newItem.trim(), done: false }]); setNewItem(""); } };
  const saveNotes = async () => {
    setNotesBusy(true);
    try { await onSaveNotes(notes.trim()); } finally { setNotesBusy(false); }
  };

  // Folded: one scannable line - who, when, what was said, what is still open. Everything else waits.
  if (!open) {
    return (
      <Card className="p-0 transition-colors hover:border-primary/40">
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} className="flex w-full items-center gap-3 p-3 text-left">
          <PersonAvatar name={withName} className="h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{withName}</span>
              {c.meeting_date && <span className="text-xs tabular-nums text-muted-foreground">{formatDate(c.meeting_date)}</span>}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {(c.notes ?? "").split("\n")[0] || (items.length > 0 ? `${items.length} action item${items.length === 1 ? "" : "s"}` : "Nothing captured.")}
            </p>
          </div>
          {!(c.notes ?? "").trim() && <Badge variant="muted" className="shrink-0">no notes</Badge>}
          {openCount > 0 && <Badge variant="warning" className="shrink-0">{openCount} open</Badge>}
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {startCollapsed ? (
            <button type="button" onClick={() => setOpen(false)} aria-expanded className="flex min-w-0 items-center gap-2 text-left">
              <ChevronRight className="h-4 w-4 shrink-0 rotate-90 text-muted-foreground transition-transform" />
              <PersonAvatar name={withName} className="h-8 w-8 shrink-0" />
              <span className="font-semibold">1:1 with {withName}</span>
            </button>
          ) : (
            <>
              <PersonAvatar name={withName} className="h-8 w-8 shrink-0" />
              <span className="font-semibold">1:1 with {withName}</span>
            </>
          )}
          {c.meeting_date && <span className="text-sm tabular-nums text-muted-foreground">· {formatDate(c.meeting_date)}</span>}
          {rel && <Badge variant={rel === "Today" ? "default" : "secondary"}>{rel}</Badge>}
          {c.cadence && <Badge variant="info"><Repeat className="h-3 w-3" /> {CADENCE_LABEL[c.cadence]}</Badge>}
          {openCount > 0 && <Badge variant="warning">{openCount} open item{openCount === 1 ? "" : "s"}</Badge>}
        </div>
        <div className="flex items-center gap-1">
          {startCollapsed && (
            <AccessAction collection="check-ins" create label="Schedule next 1:1">
              <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={onScheduleNext}>
                <CalendarPlus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Schedule next</span>
              </Button>
            </AccessAction>
          )}
          {!startCollapsed && canEdit && c.meeting_date && (
            <Popover open={reschedOpen} onOpenChange={(o) => { setReschedOpen(o); if (o) setReschedDate(c.meeting_date ?? ""); }}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Reschedule</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-2 p-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => { setReschedOpen(false); onReschedule(plusDays(c.meeting_date!, 7)); }}
                >
                  +1 week ({formatDate(plusDays(c.meeting_date, 7))})
                </Button>
                <div className="flex items-center gap-2">
                  <Input type="date" value={reschedDate} onChange={(e) => setReschedDate(e.target.value)} className="h-8" />
                  <Button size="sm" disabled={!reschedDate || reschedDate === c.meeting_date} onClick={() => { setReschedOpen(false); onReschedule(reschedDate); }}>
                    Set
                  </Button>
                </div>
                <div className="flex items-center gap-2 border-t pt-2">
                  <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <Select value={c.cadence ?? "none"} onValueChange={(v) => { setReschedOpen(false); onSetCadence(v === "none" ? null : (v as CheckIn["cadence"])); }}>
                    <SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Doesn't repeat</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <RowActivityButton resource={c.path} />
          {can.includes("delete") && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
          {canEdit ? (
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did you discuss?"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && notesDirty && !notesBusy) { e.preventDefault(); void saveNotes(); } }}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{notes || <span className="text-muted-foreground">No notes.</span>}</p>
          )}
          {canEdit && !notes && (
            <Button variant="ghost" size="sm" className="mt-1 h-7 text-muted-foreground" onClick={() => setNotes(NOTES_TEMPLATE)}>
              <ListPlus className="h-3.5 w-3.5" /> Add talking points
            </Button>
          )}
          {canEdit && notesDirty && (
            <div className="mt-2 flex items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">⌘↵ to save</span>
              <Button size="sm" loading={notesBusy} onClick={saveNotes}><Check className="h-3.5 w-3.5" /> Save notes</Button>
            </div>
          )}
        </div>

        {/* The half that isn't shared. A 1:1 where every word is read by both people is a 1:1 where the honest
            half goes in a private notebook - so it lives here instead, served only to whoever wrote it. */}
        {mine && (
          <div>
            <button
              type="button"
              onClick={() => setPrivateOpen((o) => !o)}
              className="mb-1 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              <Lock className="h-3 w-3" /> Private note
              {!privateOpen && c.private_note ? <span className="font-normal normal-case">· written</span> : null}
              {c.other_has_private_note && <span className="ml-auto font-normal normal-case">{withName} has one too</span>}
            </button>
            {privateOpen && (
              <>
                <Textarea
                  rows={2}
                  value={priv}
                  onChange={(e) => setPriv(e.target.value)}
                  placeholder="Only you can read this."
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && privDirty && !privBusy) { e.preventDefault(); void savePrivate(); } }}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Yours alone: {withName}, HR and anyone reading down the chain get nothing. They can see that a note exists.
                </p>
                {privDirty && (
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">⌘↵ to save</span>
                    <Button size="sm" loading={privBusy} onClick={savePrivate}><Check className="h-3.5 w-3.5" /> Save note</Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* The pulse: one number, the employee's own. A manager rating their report's mood would be a much
            worse feature, so only the employee sees the buttons - everyone else sees the answer. */}
        {(isSubject || c.pulse != null) && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {isSubject ? "How did it go?" : "How they rated it"}
            </p>
            {isSubject ? (
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={pulseBusy}
                    onClick={() => void onSetPulse(c.pulse === n ? null : n)}
                    aria-label={`${n} out of 5`}
                    title={PULSE_LABEL[n]}
                    className={cn(
                      "h-8 w-8 rounded-full border text-sm tabular-nums transition-colors disabled:opacity-50",
                      c.pulse === n ? "border-primary bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {n}
                  </button>
                ))}
                <span className="ml-1 text-xs text-muted-foreground">{c.pulse ? PULSE_LABEL[c.pulse] : "Only you can set this."}</span>
              </div>
            ) : (
              <p className="text-sm">
                <span className="font-medium tabular-nums">{c.pulse}/5</span> <span className="text-muted-foreground">· {PULSE_LABEL[c.pulse!]}</span>
              </p>
            )}
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action items</p>
          {canEdit && carryCount > 0 && (
            <button
              type="button"
              onClick={onBringForward}
              className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
              {carryCount} open item{carryCount === 1 ? "" : "s"} from last time · Bring forward
            </button>
          )}
          <div className="space-y-1">
            {items.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Checkbox checked={!!it.done} disabled={!canEdit || itemsBusy} onCheckedChange={() => toggle(i)} />
                <span className={cn("flex-1", it.done && "text-muted-foreground line-through")}>{it.text}</span>
                {!it.done && (
                  <AccessAction collection="cards" create label="Make a board task">
                    <button type="button" onClick={() => onMakeTask(it.text)} className="text-muted-foreground hover:text-primary" aria-label="Make a board task" title="Make a board task">
                      <SquareKanban className="h-3.5 w-3.5" />
                    </button>
                  </AccessAction>
                )}
                {canEdit && <button type="button" disabled={itemsBusy} onClick={() => removeItem(i)} className="text-muted-foreground hover:text-destructive disabled:opacity-50" aria-label="Remove"><X className="h-3.5 w-3.5" /></button>}
              </div>
            ))}
          </div>
          {canEdit && (
            <div className="mt-2 flex items-center gap-2">
              <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an action item…" className="h-8" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} />
              <Button size="sm" variant="outline" onClick={addItem} loading={itemsBusy} disabled={!newItem.trim()}><Plus className="h-3.5 w-3.5" /> Add</Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}


function NewDialog({ me, employees, initial, existing, nameOf, onClose, onCreated }: {
  me: Me;
  employees: Employee[];
  initial: { counterpart?: string; counterpartName?: string; date?: string; action_items?: CheckInActionItem[] };
  /** Every 1:1 the caller can see - what the duplicate warning and the cadence echo read from. */
  existing: CheckIn[];
  nameOf: (ref?: string) => string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    counterpart: initial.counterpart ?? "",
    date: initial.date ?? todayStr(),
    cadence: "none",
    notes: "",
  });
  const carried = initial.action_items?.length ?? 0;
  const [building, setBuilding] = useState(false);

  // Who this may be with. The list is the people the caller can READ, which for an employee is only
  // themselves - so a 1:1 carried over from a past meeting would arrive with its person set to a value the
  // picker has no option for, and draw as an empty box. The carried person is added back by name (the row
  // carries it, which is the only place an employee can learn it).
  const counterpartOptions = useMemo(() => {
    const opts = employees
      .filter((e) => idOf(e.path) !== me.employee_id)
      .map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }));
    const carriedRef = initial.counterpart;
    if (carriedRef && initial.counterpartName && !opts.some((o) => o.value === carriedRef)) {
      opts.unshift({ value: carriedRef, label: initial.counterpartName });
    }
    return opts;
  }, [employees, me.employee_id, initial.counterpart, initial.counterpartName]);

  /**
   * An agenda made of what is actually happening, rather than four headings and a blank page.
   *
   * Three sources, all of them things the pair would have had to look up anyway: the other person's open goals
   * (with where each one stands), the items left unfinished from their last 1:1, and how long it has been. The
   * goals are read on demand - opening this form must not cost a goals request, and most 1:1s are logged with
   * notes typed afterwards rather than an agenda prepared before.
   */
  async function buildAgenda() {
    if (building) return;
    setBuilding(true);
    try {
      const other = form.counterpart ? idOf(form.counterpart) : undefined;
      const lines: string[] = [];
      if (other) {
        // Only the subject's own goals, and only the live ones. A closed goal is not this week's business.
        const goals = (await list<Goal>("goals", { max: 100, params: { employee: `employees/${other}` } }).catch(() => null))?.results ?? [];
        const open = goals
          .filter((g) => !g.delete_time && (g.status === "in_progress" || g.status === "not_started"))
          .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
        if (open.length) {
          lines.push("Goals:");
          for (const g of open.slice(0, 6)) {
            const where = g.target_value != null ? `${g.current_value ?? 0} of ${g.target_value}${g.unit ? ` ${g.unit}` : ""}` : `${g.progress ?? 0}%`;
            lines.push(`- ${g.title} (${where}${g.due_date ? `, due ${formatDate(g.due_date)}` : ""})`);
          }
          lines.push("");
        }
      }
      // What was left open last time, from the pair's most recent meeting with anything unfinished.
      const last = existing
        .filter((c) => {
          const o = idOf(c.employee ?? "") === me.employee_id ? c.counterpart : c.employee;
          return !!other && !!o && idOf(o) === other && (c.action_items ?? []).some((i) => !i.done);
        })
        .sort((a, b) => (b.meeting_date ?? "").localeCompare(a.meeting_date ?? ""))[0];
      const stillOpen = (last?.action_items ?? []).filter((i) => !i.done);
      if (stillOpen.length) {
        lines.push(`Still open from ${last?.meeting_date ? formatDate(last.meeting_date) : "last time"}:`);
        for (const i of stillOpen.slice(0, 8)) lines.push(`- ${i.text}`);
        lines.push("");
      }
      lines.push("Wins:", "", "Blockers:", "", "Anything else:", "");
      setForm((f) => ({ ...f, notes: lines.join("\n") }));
    } finally {
      setBuilding(false);
    }
  }

  async function start() {
    await create("check-ins", {
      counterpart: form.counterpart || undefined,
      meeting_date: form.date || undefined,
      notes: form.notes.trim() || undefined,
      action_items: initial.action_items?.length ? initial.action_items : undefined,
      cadence: form.cadence === "none" ? undefined : (form.cadence as CheckIn["cadence"]),
    });
    onCreated();
  }

  // Already on the calendar with this person on this date. Warned, never blocked: two 1:1s in a day is odd but
  // not wrong, and a double-booking is usually a forgotten one rather than a mistake.
  const clash = form.date && form.counterpart
    ? existing.find((c) => {
        // The other party seen from the caller's side, the same way the page reads it.
        const other = idOf(c.employee ?? "") === me.employee_id ? c.counterpart : c.employee;
        return c.meeting_date === form.date && !!other && idOf(other) === idOf(form.counterpart);
      })
    : undefined;
  // The next few dates a cadence will produce, before it is saved - a repeat you can't see is a repeat nobody
  // trusts. Steps the way the cron does (weeks by days, monthly by calendar month, from the previous date), so
  // the dates shown here are the dates that will exist.
  const anchorDay = form.date ? Number(form.date.slice(8, 10)) : 1;
  const nextDates = form.cadence === "none" || !form.date
    ? []
    : [1, 2, 3].reduce<string[]>((acc) => [...acc, stepCadence(acc[acc.length - 1] ?? form.date, form.cadence, anchorDay)], []);
  const rel = form.date ? relativeDay(form.date) : null;
  const withName = form.counterpart ? nameOf(form.counterpart) : "your manager";

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="New 1:1"
      description={`Shared with ${withName}: you can both read and edit the notes and action items.`}
      collection="check-ins"
      guardLabel="1:1"
      form={form}
      // Only the blank composer keeps a draft: "schedule next" seeds the person, the date and the items it is
      // carrying, and a restored draft would silently overwrite all three.
      draftKey={initial.counterpart || initial.date || carried ? undefined : "checkin:new"}
      applyDraft={(d) => setForm(d)}
      onStartOver={() => setForm({ counterpart: "", date: todayStr(), cadence: "none", notes: "" })}
      submitLabel={form.date > todayStr() ? "Schedule 1:1" : "Log 1:1"}
      canSubmit={!!form.date}
      whyNot="Pick the meeting date."
      onSubmit={start}
      submitAccess={(b) => <AccessAction collection="check-ins" create label="New 1:1">{b}</AccessAction>}
    >
        <Field label="With" hint="Defaults to your manager if left blank.">
          <Combobox
            value={form.counterpart}
            onValueChange={(v) => setForm({ ...form, counterpart: v })}
            placeholder="Your manager"
            searchPlaceholder="Search people…"
            options={counterpartOptions}
          />
        </Field>
        <FieldRow>
          <Field label="Meeting date" hint={rel ?? undefined}>
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            {/* The three dates anyone actually picks, without opening the calendar. */}
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[{ label: "Today", value: todayStr() }, { label: "Tomorrow", value: plusDays(todayStr(), 1) }, { label: "Next week", value: plusDays(todayStr(), 7) }].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setForm({ ...form, date: o.value })}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    form.date === o.value ? "border-primary text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Repeats" hint="The next one is scheduled automatically after each meeting.">
            <Select value={form.cadence} onValueChange={(v) => setForm({ ...form, cadence: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Doesn't repeat</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
            {nextDates.length > 0 && (
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                Then {nextDates.map((d) => formatDate(d)).join(" · ")}
              </p>
            )}
          </Field>
        </FieldRow>
        {clash && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            You already have a 1:1 with {withName} on {formatDate(form.date)}
            {(clash.action_items ?? []).some((i) => !i.done) ? ", with open action items on it" : ""}.
          </p>
        )}
        <Field
          label="Notes (optional)"
          field="notes"
          action={!form.notes && (
            <span className="flex items-center gap-1">
              {/* An agenda built from what is actually going on beats a blank box and beats four fixed
                  headings: their open goals, what was left unfinished last time, when you last met. The goals
                  are fetched only when this is pressed - a 1:1 form must not cost a goals read to open. */}
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" loading={building} onClick={() => void buildAgenda()}>
                <Sparkles className="h-3.5 w-3.5" /> Build agenda
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => setForm({ ...form, notes: NOTES_TEMPLATE })}>
                <ListPlus className="h-3.5 w-3.5" /> Talking points
              </Button>
            </span>
          )}
        >
          <Textarea rows={form.notes ? 8 : 3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Agenda or talking points." />
        </Field>
        {carried > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
            Carries {carried} open action item{carried === 1 ? "" : "s"} forward from the last 1:1, and closes {carried === 1 ? "it" : "them"} there.
          </p>
        )}
    </WriteDialog>
  );
}
