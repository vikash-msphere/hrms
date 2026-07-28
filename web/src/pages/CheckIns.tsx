import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Plus, Trash2, Check, X, CalendarDays, ListTodo, History } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { CheckIn, CheckInActionItem, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Field } from "@/components/common/Field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function CheckIns({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<CheckIn>("check-ins");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  // The other person in the 1:1, from the caller's side of it.
  const otherParty = (c: CheckIn) => empName(idOf(c.employee ?? "") === me.employee_id ? c.counterpart : c.employee);

  // Meeting-date framing: scheduled 1:1s (today onward, soonest first) ahead of past ones (newest first).
  const { upcoming, past } = useMemo(() => {
    const today = todayStr();
    const key = (c: CheckIn) => c.meeting_date ?? c.create_time ?? "";
    const up = rows.filter((c) => (c.meeting_date ?? "") >= today).sort((a, b) => key(a).localeCompare(key(b)));
    const done = rows.filter((c) => (c.meeting_date ?? "") < today).sort((a, b) => key(b).localeCompare(key(a)));
    return { upcoming: up, past: done };
  }, [rows]);

  const openItems = useMemo(() => rows.reduce((s, c) => s + (c.action_items ?? []).filter((i) => !i.done).length, 0), [rows]);

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

  useIntent("new-checkin", () => setCreating(true));

  const newBtn = (
    <AccessAction collection="check-ins" create label="New 1:1">
      <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New 1:1</Button>
    </AccessAction>
  );

  const cardFor = (c: CheckIn) => (
    <CheckInCard
      key={c.path}
      checkIn={c}
      withName={otherParty(c) || "-"}
      onSaveNotes={(notes) => saveNotes(c, notes)}
      onSaveItems={(items) => saveItems(c, items)}
      onDelete={() => del(c)}
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
                { label: "Logged 1:1s", value: rows.length, icon: History },
              ]}
            />
            {upcoming.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" /> Upcoming</h2>
                <div className="space-y-4">{upcoming.map(cardFor)}</div>
              </section>
            )}
            {past.length > 0 && (
              <section className="space-y-3">
                {upcoming.length > 0 && (
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><History className="h-3.5 w-3.5" /> Past</h2>
                )}
                <div className="space-y-4">{past.map(cardFor)}</div>
              </section>
            )}
          </div>
        )}
      </DataState>

      {creating && (
        <NewDialog
          me={me}
          employees={employees}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); toast({ title: "1:1 logged", variant: "success" }); }}
          toastErr={(m) => toast({ title: "Couldn't log the 1:1", description: m, variant: "destructive" })}
        />
      )}
    </div>
  );
}

function CheckInCard({ checkIn: c, withName, onSaveNotes, onSaveItems, onDelete }: {
  checkIn: CheckIn;
  withName: string;
  onSaveNotes: (notes: string) => Promise<void>;
  onSaveItems: (items: CheckInActionItem[]) => Promise<void>;
  onDelete: () => void;
}) {
  const can = c.access?.can ?? [];
  const canEdit = can.includes("update");
  const [notes, setNotes] = useState(c.notes ?? "");
  const [items, setItems] = useState<CheckInActionItem[]>(c.action_items ?? []);
  const [newItem, setNewItem] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [itemsBusy, setItemsBusy] = useState(false);

  useEffect(() => { setNotes(c.notes ?? ""); }, [c.notes]);
  useEffect(() => { setItems(c.action_items ?? []); }, [c.action_items]);
  const notesDirty = notes !== (c.notes ?? "");
  const isToday = c.meeting_date === todayStr();

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

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-primary" />
          <span className="font-semibold">1:1 with {withName}</span>
          {c.meeting_date && <span className="text-sm tabular-nums text-muted-foreground">· {formatDate(c.meeting_date)}</span>}
          {isToday && <Badge>Today</Badge>}
          {items.some((it) => !it.done) && (
            <Badge variant="warning">{items.filter((it) => !it.done).length} open item{items.filter((it) => !it.done).length === 1 ? "" : "s"}</Badge>
          )}
        </div>
        <RowActivityButton resource={c.path} />
        {can.includes("delete") && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
          {canEdit ? (
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you discuss?" />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{notes || <span className="text-muted-foreground">No notes.</span>}</p>
          )}
          {canEdit && notesDirty && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" loading={notesBusy} onClick={saveNotes}><Check className="h-3.5 w-3.5" /> Save notes</Button>
            </div>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action items</p>
          <div className="space-y-1">
            {items.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Checkbox checked={!!it.done} disabled={!canEdit || itemsBusy} onCheckedChange={() => toggle(i)} />
                <span className={cn("flex-1", it.done && "text-muted-foreground line-through")}>{it.text}</span>
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

function NewDialog({ me, employees, onClose, onCreated, toastErr }: {
  me: Me;
  employees: Employee[];
  onClose: () => void;
  onCreated: () => void;
  toastErr: (msg: string) => void;
}) {
  const [counterpart, setCounterpart] = useState("");
  const [date, setDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      await create("check-ins", { counterpart: counterpart || undefined, meeting_date: date || undefined, notes: notes.trim() || undefined });
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
        <Field label="Meeting date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Notes (optional)"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Agenda or talking points." /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={start} loading={busy}>Log 1:1</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
