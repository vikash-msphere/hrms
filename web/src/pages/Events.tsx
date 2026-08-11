import { useMemo, useState } from "react";
import { CalendarRange, Plus, Users, UserPlus, X } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import type { Employee, Department, Event, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { TimeRangeField } from "@/components/common/TimeRangeField";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Palette for event bands - a spectrum of distinct hues so events read apart at a glance on the timeline.
const EVENT_COLORS = [
  "#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#84cc16",
  "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b",
];
const empRef = (e: Employee) => `employees/${idOf(e.path)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
// ISO instant -> "YYYY-MM-DDTHH:mm" in the viewer's local time, for <input type="datetime-local">.
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const nowLocalInput = () => toLocalInput(new Date().toISOString());
// Human duration between two instants (minutes/hours/days), for the list + dialog.
function durationLabel(startIso: string, endIso: string, allDay: boolean): string {
  if (allDay) {
    const days = Math.round((Date.parse(endIso.slice(0, 10)) - Date.parse(startIso.slice(0, 10))) / 86400000) + 1;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const mins = Math.max(0, Math.round((+new Date(endIso) - +new Date(startIso)) / 60000));
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) { const h = Math.floor(mins / 60), m = mins % 60; return m ? `${h}h ${m}m` : `${h}h`; }
  const d = Math.floor(mins / 1440), h = Math.round((mins % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}
// Timed default: the next full hour, one hour long - a valid range the picker can seed from
// (equal start/end would render as an overnight roll before the user touches anything).
const defaultTimed = () => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const start_dt = toLocalInput(d.toISOString());
  d.setHours(d.getHours() + 1);
  return { start_dt, end_dt: toLocalInput(d.toISOString()) };
};
const EMPTY = {
  title: "", all_day: true, count_as_work: false, requires_clock_in: false, color: EVENT_COLORS[0], description: "",
  start_date: todayStr(), end_date: todayStr(), // used when all_day
  ...defaultTimed(), // used when timed
};
const DAY_MS = 86400000;
// Millisecond bounds of an event; an all-day event runs to the end of its end date.
const startMs = (e: Event) => (e.all_day ? Date.parse(e.start_time.slice(0, 10)) : +new Date(e.start_time));
const endMs = (e: Event) => (e.all_day ? Date.parse(e.end_time.slice(0, 10)) + DAY_MS - 1 : +new Date(e.end_time));

export default function Events({ me: _me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Event>("events", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const sd = useSoftDelete("events", "event", reload);
  const writable = usePermission("events.write");
  const canPurge = usePermission("events.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [attendees, setAttendees] = useState<string[]>([]); // employees/{id}
  const [dept, setDept] = useState(""); // department quick-add selection
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Upcoming first (soonest at the top), then past events newest-first.
  const { sorted, upcoming } = useMemo(() => {
    const now = Date.now();
    const live = rows.filter((e) => !e.delete_time);
    const upcoming = live.filter((e) => endMs(e) >= now).sort((a, b) => startMs(a) - startMs(b));
    const past = live.filter((e) => endMs(e) < now).sort((a, b) => startMs(b) - startMs(a));
    const deleted = rows.filter((e) => e.delete_time);
    return { sorted: [...upcoming, ...past, ...deleted], upcoming };
  }, [rows]);
  const next = upcoming[0];
  const happeningNow = useMemo(() => {
    const now = Date.now();
    return upcoming.filter((e) => startMs(e) <= now).length;
  }, [upcoming]);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  const toggle = (ref: string) => setAttendees((a) => (a.includes(ref) ? a.filter((x) => x !== ref) : [...a, ref]));
  // "Everyone" = select all current employees (the event stores an explicit list, so this is a snapshot).
  const allSelected = employees.length > 0 && employees.every((e) => attendees.includes(empRef(e)));
  // Add every employee of the chosen department to the attendees (union, no removal of existing picks).
  function addDept(deptPath: string) {
    setDept(deptPath);
    if (!deptPath) return;
    const members = employees.filter((e) => e.department && idOf(e.department) === idOf(deptPath)).map(empRef);
    setAttendees((a) => Array.from(new Set([...a, ...members])));
  }

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, ...defaultTimed(), color: EVENT_COLORS[rows.length % EVENT_COLORS.length] });
    setAttendees([]);
    setDept("");
    setOpen(true);
  }
  function openEdit(ev: Event) {
    setEditing(ev);
    setForm({
      title: ev.title,
      all_day: ev.all_day,
      count_as_work: ev.count_as_work,
      requires_clock_in: !!ev.requires_clock_in,
      color: ev.color ?? EVENT_COLORS[0],
      description: ev.description ?? "",
      start_date: ev.start_time.slice(0, 10),
      end_date: ev.end_time.slice(0, 10),
      start_dt: toLocalInput(ev.start_time),
      end_dt: toLocalInput(ev.end_time),
    });
    setAttendees(ev.attendees ?? []);
    setDept("");
    setOpen(true);
  }

  // Mirrors the inline field errors: a form with end-before-start must not be submittable.
  const validRange = form.all_day
    ? !!form.start_date && !!form.end_date && form.end_date >= form.start_date
    : !!form.start_dt && !!form.end_dt && form.end_dt >= form.start_dt;
  const canSave = !!form.title.trim() && validRange;

  async function submit() {
    setBusy(true);
    const times = form.all_day
      ? { start_time: form.start_date, end_time: form.end_date }
      : { start_time: new Date(form.start_dt).toISOString(), end_time: new Date(form.end_dt).toISOString() };
    const body = { title: form.title, all_day: form.all_day, count_as_work: form.count_as_work, requires_clock_in: form.count_as_work && form.requires_clock_in, ...times, color: form.color, description: form.description || null, attendees };
    try {
      if (editing) await patch(`events/${idOf(editing.path)}`, body, editing.etag);
      else await create<Event>("events", body);
      toast({ title: editing ? "Event updated" : "Event created", variant: "success" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const cols: Column<Event>[] = [
    { id: "title", header: "Event", accessor: (e) => e.title, cell: (e) => (
      <span className="flex items-center gap-2 font-medium">
        <span className="inline-block h-3 w-5 rounded-full" style={{ backgroundColor: e.color || leaveColor(undefined, idOf(e.path)) }} /> {e.title}
      </span>
    ) },
    { id: "when", header: "When", accessor: (e) => e.start_time, cell: (e) => {
      // Same-day events show the date once; all-day events say so instead of repeating times.
      const sameDay = e.all_day
        ? e.start_time.slice(0, 10) === e.end_time.slice(0, 10)
        : new Date(e.start_time).toDateString() === new Date(e.end_time).toDateString();
      const fmt = (iso: string) => (e.all_day ? formatDate(iso) : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
      const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
      const main = sameDay
        ? e.all_day ? formatDate(e.start_time) : `${new Date(e.start_time).toLocaleDateString(undefined, { dateStyle: "medium" })}, ${time(e.start_time)} - ${time(e.end_time)}`
        : `${fmt(e.start_time)} - ${fmt(e.end_time)}`;
      const sub = e.all_day
        ? sameDay ? "All day" : `All day · ${durationLabel(e.start_time, e.end_time, true)}`
        : durationLabel(e.start_time, e.end_time, false);
      return (
        <div className="text-sm">
          <div>{main}</div>
          <div className="text-xs text-muted-foreground">{sub}</div>
        </div>
      );
    } },
    { id: "counts", header: "Counts as work", filter: "select", accessor: (e) => (e.count_as_work ? "Yes" : "No"), cell: (e) => (e.count_as_work ? <Badge variant="secondary">Worked time</Badge> : <span className="text-muted-foreground">-</span>) },
    { id: "attendees", header: "Attendees", sortable: false, filter: "none", accessor: (e) => e.attendees?.length ?? 0, cell: (e) => (
      <span className="flex items-center gap-1.5 text-sm"><Users className="h-3.5 w-3.5 text-muted-foreground" /> {e.attendees?.length ?? 0}</span>
    ) },
    { id: "description", header: "Description", defaultHidden: true, accessor: (e) => e.description ?? "", cell: (e) => e.description || "-" },
    stateColumn<Event>(),
    ...metaColumns<Event>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (e) => <SoftDeleteRowActions row={e} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} />,
    },
  ];

  const createBtn = (
    <AccessAction collection="events" create label="New event">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New event</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader
        title="Events"
        description="Company events like conferences and off-sites."
        actions={createBtn}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Upcoming", value: upcoming.length, icon: CalendarRange, tone: upcoming.length ? "primary" : "muted" },
              { label: "Happening now", value: happeningNow, tone: happeningNow ? "success" : "muted" },
              { label: "Next event", value: <span className="text-base font-semibold">{next ? next.title : "None scheduled"}</span>, hint: next ? `${formatDate(next.start_time)} · ${(next.attendees ?? []).length} attending` : undefined },
            ]}
          />
        )}
        <DataTable
          tableId="events"
          columns={cols}
          rows={sorted}
          getRowId={(e) => e.path}
          rowClassName={(e) => (e.delete_time || endMs(e) < Date.now() ? "opacity-60" : undefined)}
          emptyTitle="No events"
          emptyDescription="Create an event to mark a group of people unavailable on the timeline."
          accessCollection="events"
          accessTargetOf={(e) => ({ objectPath: e.path, label: e.title, can: e.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" onEnterSubmit={() => { if (!busy && canSave) submit(); }}>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><CalendarRange className="h-4 w-4 text-primary" /> {editing ? "Edit event" : "New event"}</DialogTitle></DialogHeader>
          <Field label="Title"><Input value={form.title} placeholder="e.g. annual offsite" onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={form.all_day} onCheckedChange={(v) => setForm({ ...form, all_day: !!v })} />
            All day
          </label>
          {form.all_day ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date"><Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></Field>
              <Field label="End date" error={form.end_date && form.end_date < form.start_date ? "End date is before the start date." : undefined}><Input type="date" value={form.end_date} min={form.start_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></Field>
            </div>
          ) : (
            /* One composite: date + start/end times, quick durations, overnight roll, and a pickable
               end date for multi-day events. Invalid ranges are unrepresentable - no error branch. */
            <Field label="When">
              <TimeRangeField
                key={editing?.path ?? "new"}
                initialStart={form.start_dt}
                initialEnd={form.end_dt}
                allowEndDate
                onChange={(s, e) => setForm({ ...form, start_dt: s, end_dt: e })}
              />
            </Field>
          )}
          <div className="rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={form.count_as_work} onCheckedChange={(v) => setForm({ ...form, count_as_work: !!v })} />
              Count this time as worked hours
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              {form.count_as_work
                ? "The event's duration is credited to attendees' worked minutes, so it can make their day count as present."
                : "The time is not counted as work, and the event does not excuse the day: an attendee who never clocks in is absent, and loses pay for it."}
            </p>
            {form.count_as_work && (
              <label className="mt-3 flex items-center gap-2 border-t pt-3 text-sm font-medium">
                <Checkbox checked={form.requires_clock_in} onCheckedChange={(v) => setForm({ ...form, requires_clock_in: !!v })} />
                Only credit attendees who clocked in
              </label>
            )}
            {form.count_as_work && (
              <p className="mt-1 text-xs text-muted-foreground">
                {form.requires_clock_in
                  ? "For events during the workday (a team lunch, an on-site workshop): attendees who never punched that day get no credit and stay absent."
                  : "For events away from the office (an off-site, a conference): every attendee is credited whether or not they punched."}
              </p>
            )}
          </div>
          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {EVENT_COLORS.map((c) => (
                <button key={c} type="button" aria-label={c} onClick={() => setForm({ ...form, color: c })}
                  className={`h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-background ${form.color === c ? "ring-foreground" : "ring-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </Field>
          <Field label="Attendees" hint="People marked unavailable for these dates.">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setPickerOpen(true)}>
                  <UserPlus className="h-3.5 w-3.5" /> Add people
                </Button>
                <Select value={dept} onValueChange={addDept}>
                  <SelectTrigger className="h-8 w-52"><SelectValue placeholder="Add a whole department…" /></SelectTrigger>
                  <SelectContent>
                    {departments.filter((d) => !d.delete_time).map((d) => (
                      <SelectItem key={d.path} value={d.path}>{d.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {employees.length > 0 && (
                  <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setAttendees(allSelected ? [] : employees.map(empRef))}>
                    {allSelected ? "Clear all" : "Everyone"}
                  </Button>
                )}
              </div>
              {attendees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No attendees yet.</p>
              ) : (
                <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-2">
                  {attendees.map((ref) => (
                    <span key={ref} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                      {empName(ref)}
                      <button type="button" onClick={() => toggle(ref)} className="rounded text-muted-foreground transition-colors hover:text-foreground" aria-label={`Remove ${empName(ref)}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!canSave}>
              {editing ? "Save changes" : "Create event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pickerOpen && (
        <EmployeePicker
          title="Add attendees"
          confirmLabel="Add"
          employees={employees}
          departments={departments}
          exclude={attendees}
          onClose={() => setPickerOpen(false)}
          onConfirm={(refs) => { setAttendees((a) => Array.from(new Set([...a, ...refs]))); setPickerOpen(false); }}
        />
      )}
    </div>
  );
}
