import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Plus, Trash2, Check, X, CalendarDays, CalendarPlus, CalendarClock, ChevronRight, ArrowDownToLine, ListPlus, ListTodo, History, Repeat, Search, SquareKanban } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { Board, CheckIn, CheckInActionItem, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { PersonAvatar } from "@/components/common/PersonAvatar";
import { Field } from "@/components/common/Field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const todayStr = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  // Prefill for the dialog. "Schedule next" from a past 1:1 carries the person AND its open action
  // items over; `source` is that past 1:1, whose carried items get marked done once the new one exists.
  const [creating, setCreating] = useState<{ counterpart?: string; date?: string; action_items?: CheckInActionItem[]; source?: CheckIn } | null>(null);
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
  const otherParty = (c: CheckIn) => empName(otherRef(c));

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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (c) =>
        (!personFilter || idOf(otherRef(c) ?? "") === personFilter) &&
        (!q ||
          (c.notes ?? "").toLowerCase().includes(q) ||
          (c.action_items ?? []).some((i) => i.text.toLowerCase().includes(q)) ||
          otherParty(c).toLowerCase().includes(q))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, personFilter, query]);

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

  const openItems = useMemo(() => visible.reduce((s, c) => s + (c.action_items ?? []).filter((i) => !i.done).length, 0), [visible]);

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
      onSaveNotes={(notes) => saveNotes(c, notes)}
      onSaveItems={(items) => saveItems(c, items)}
      onMakeTask={(text) => setMakeTask({ text, from: c })}
      onDelete={() => del(c)}
      onScheduleNext={() =>
        setCreating({
          counterpart: otherRef(c),
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
                { label: "Open action items", value: openItems, icon: ListTodo, tone: openItems > 0 ? "warning" : "muted" },
                {
                  label: "Next 1:1",
                  value: upcoming[0]?.meeting_date ? formatDate(upcoming[0].meeting_date) : "-",
                  icon: CalendarDays,
                  hint: upcoming[0] ? `with ${otherParty(upcoming[0]) || "your manager"}` : "Nothing scheduled",
                },
                { label: "Logged 1:1s", value: visible.length, icon: History },
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
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes and action items…" className="h-8 pl-8" />
              </div>
            </div>

            {visible.length === 0 && <p className="text-sm text-muted-foreground">No 1:1s match.</p>}
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
          withName={otherParty(makeTask.from) || "your counterpart"}
          meetingDate={makeTask.from.meeting_date}
          onClose={() => setMakeTask(null)}
          onCreated={() => { setMakeTask(null); toast({ title: "Task created on the board", variant: "success" }); }}
          toastErr={(m) => toast({ title: "Couldn't create the task", description: m, variant: "destructive" })}
        />
      )}
      {creating && (
        <NewDialog
          me={me}
          employees={employees}
          initial={creating}
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
          toastErr={(m) => toast({ title: "Couldn't log the 1:1", description: m, variant: "destructive" })}
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

function CheckInCard({ checkIn: c, withName, startCollapsed, carryCount, onBringForward, onReschedule, onSetCadence, onSaveNotes, onSaveItems, onMakeTask, onDelete, onScheduleNext }: {
  checkIn: CheckIn;
  withName: string;
  startCollapsed?: boolean;
  carryCount: number;
  onBringForward: () => void;
  onReschedule: (date: string) => void;
  onSetCadence: (cadence: CheckIn["cadence"] | null) => void;
  onSaveNotes: (notes: string) => Promise<void>;
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

  useEffect(() => { setNotes(c.notes ?? ""); }, [c.notes]);
  useEffect(() => { setItems(c.action_items ?? []); }, [c.action_items]);
  const notesDirty = notes !== (c.notes ?? "");
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

// Promote a 1:1 action item to a board card. Boards load only when this dialog opens (lazy, like every
// secondary read). One-way: the card links back to the 1:1 in its description; the item stays on the 1:1.
function MakeTaskDialog({ text, withName, meetingDate, onClose, onCreated, toastErr }: {
  text: string;
  withName: string;
  meetingDate?: string;
  onClose: () => void;
  onCreated: () => void;
  toastErr: (msg: string) => void;
}) {
  const { rows: boards, state } = useCollection<Board>("boards");
  const [board, setBoard] = useState("");
  const [title, setTitle] = useState(text);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!board && boards[0]) setBoard(boards[0].path); }, [boards, board]);

  async function make() {
    if (!board || !title.trim()) return;
    setBusy(true);
    try {
      await create("cards", {
        board,
        title: title.trim(),
        description: `From a 1:1 with ${withName}${meetingDate ? ` on ${formatDate(meetingDate)}` : ""}.`,
      });
      onCreated();
    } catch (e) {
      toastErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy) make(); }}>
        <DialogHeader><DialogTitle>Make a board task</DialogTitle></DialogHeader>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Board">
          <Combobox
            value={board}
            onValueChange={setBoard}
            placeholder={state === "loading" ? "Loading boards…" : "Pick a board"}
            searchPlaceholder="Search boards…"
            options={boards.map((b) => ({ value: b.path, label: b.name }))}
          />
        </Field>
        {boards.length === 0 && state === "ready" && <p className="text-xs text-muted-foreground">No boards you can add to yet.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={make} loading={busy} disabled={!board || !title.trim()}>Create task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewDialog({ me, employees, initial, onClose, onCreated, toastErr }: {
  me: Me;
  employees: Employee[];
  initial: { counterpart?: string; date?: string; action_items?: CheckInActionItem[] };
  onClose: () => void;
  onCreated: () => void;
  toastErr: (msg: string) => void;
}) {
  const [counterpart, setCounterpart] = useState(initial.counterpart ?? "");
  const [date, setDate] = useState(initial.date ?? todayStr());
  const [cadence, setCadence] = useState<string>("none");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      await create("check-ins", {
        counterpart: counterpart || undefined,
        meeting_date: date || undefined,
        notes: notes.trim() || undefined,
        action_items: initial.action_items?.length ? initial.action_items : undefined,
        cadence: cadence === "none" ? undefined : (cadence as CheckIn["cadence"]),
      });
      onCreated();
    } catch (e) {
      toastErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy) start(); }}>
        <DialogHeader><DialogTitle>New 1:1</DialogTitle></DialogHeader>
        <Field label="With" hint="Defaults to your manager if left blank.">
          <Combobox
            value={counterpart}
            onValueChange={setCounterpart}
            placeholder="Your manager"
            searchPlaceholder="Search people…"
            options={employees.filter((e) => idOf(e.path) !== me.employee_id).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Meeting date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Repeats" hint="The next one is scheduled automatically after each meeting.">
            <Select value={cadence} onValueChange={setCadence}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Doesn't repeat</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Notes (optional)"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Agenda or talking points." /></Field>
        {(initial.action_items?.length ?? 0) > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
            Carries {initial.action_items!.length} open action item{initial.action_items!.length === 1 ? "" : "s"} forward from the last 1:1.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={start} loading={busy}>Log 1:1</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
