import { useMemo, useState } from "react";
import { CalendarRange, Plus, Users, UserPlus, X, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { create, patch, get, invoke } from "@/api";
import { isConflict } from "@/lib/formError";
import { upcomingOccurrences, type EventRepeat } from "@/lib/eventRepeat";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import type { Employee, Department, Event, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
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
import { WriteDialog } from "@/components/common/WriteDialog";
import { Segmented } from "@/components/common/Segmented";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
// The three answers, in the order a person weighs them.
const RSVP_OPTIONS: { value: "going" | "maybe" | "declined"; label: string }[] = [
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "declined", label: "No" },
];

const EMPTY = {
  title: "", all_day: true, count_as_work: false, requires_clock_in: false, color: EVENT_COLORS[0], description: "",
  start_date: todayStr(), end_date: todayStr(), // used when all_day
  repeat: "", // "" = doesn't repeat
  ...defaultTimed(), // used when timed
};
const DAY_MS = 86400000;
// Millisecond bounds of an event; an all-day event runs to the end of its end date.
const startMs = (e: Event) => (e.all_day ? Date.parse(e.start_time.slice(0, 10)) : +new Date(e.start_time));
const endMs = (e: Event) => (e.all_day ? Date.parse(e.end_time.slice(0, 10)) + DAY_MS - 1 : +new Date(e.end_time));

export default function Events({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Event>("events", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const sd = useSoftDelete("events", "event", reload);
  // List or calendar. Remembered, because which one somebody wants is about their job, not about this visit.
  const [view, setViewState] = useState<"table" | "month">(() => (localStorage.getItem("events:view") === "month" ? "month" : "table"));
  const setView = (v: "table" | "month") => { setViewState(v); try { localStorage.setItem("events:view", v); } catch { /* private mode */ } };
  // Which row's RSVP is in flight, so a double-tap can't send two answers.
  const [rsvping, setRsvping] = useState<string | null>(null);
  async function rsvp(ev: Event, response: "going" | "maybe" | "declined") {
    setRsvping(ev.path);
    try {
      await invoke(`events/${idOf(ev.path)}`, "respond", undefined, { response });
      toast({ title: response === "going" ? "You're going" : response === "maybe" ? "Marked as maybe" : "You've declined", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't send your answer", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRsvping(null);
    }
  }
  const writable = usePermission("events.write");
  const canPurge = usePermission("events.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [attendees, setAttendees] = useState<string[]>([]); // employees/{id}
  const [dept, setDept] = useState(""); // department quick-add selection
  const [pickerOpen, setPickerOpen] = useState(false);
  // The version an edit writes against; refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState<string | undefined>(undefined);

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
  // An invitation you have not answered is the only thing on this page that is waiting on the reader.
  const needsMyRsvp = (e: Event) =>
    !e.delete_time && endMs(e) >= Date.now() && !!me.employee_id && (e.attendees ?? []).some((a) => idOf(a) === me.employee_id) && !e.my_response;
  const awaitingRsvp = useMemo(() => rows.filter(needsMyRsvp).length, [rows, me.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const myGoing = useMemo(() => rows.filter((e) => e.my_response === "going" && !e.delete_time && endMs(e) >= Date.now()).length, [rows]);
  const kf = useKpiFocus<Event, "all" | "upcoming" | "now" | "rsvp" | "going">({
    all: { label: "events", match: () => true },
    upcoming: { label: "upcoming events", match: (e) => !e.delete_time && endMs(e) >= Date.now() },
    now: { label: "events happening now", match: (e) => !e.delete_time && startMs(e) <= Date.now() && endMs(e) >= Date.now() },
    rsvp: { label: "invitations awaiting your answer", match: needsMyRsvp },
    going: { label: "events you said yes to", match: (e) => e.my_response === "going" && endMs(e) >= Date.now() },
  });

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
    setEtag(undefined);
    setForm({ ...EMPTY, ...defaultTimed(), color: EVENT_COLORS[rows.length % EVENT_COLORS.length] });
    setAttendees([]);
    setDept("");
    setOpen(true);
  }
  function openEdit(ev: Event) {
    setEditing(ev);
    setEtag(ev.etag);
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
      repeat: ev.repeat ?? "",
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

  // The dates a repeat will produce, shown before it is saved. Same stepping the cron uses (lib/eventRepeat.ts,
  // pinned by test/eventRepeatDrift.test.ts), so what the form promises is what appears.
  const repeatPreview = useMemo(() => {
    if (!form.repeat || !validRange) return [];
    const s = form.all_day ? Date.parse(`${form.start_date}T00:00:00.000Z`) : +new Date(form.start_dt);
    const e = form.all_day ? Date.parse(`${form.end_date}T00:00:00.000Z`) : +new Date(form.end_dt);
    return upcomingOccurrences(s, e, form.repeat as EventRepeat, 3);
  }, [form, validRange]);

  // The whole state a save writes, in one value: the discard guard and the draft both watch this, so editing the
  // attendee list counts as an edit (with `form` alone, adding twenty people read as an untouched form).
  const guarded = useMemo(() => ({ ...form, attendees }), [form, attendees]);

  // What this event does, read back before it is created: how long it runs, who it covers, what attendance
  // makes of it.
  const consequence = useMemo(() => {
    if (!validRange) return null;
    const startIso = form.all_day ? form.start_date : new Date(form.start_dt).toISOString();
    const endIso = form.all_day ? form.end_date : new Date(form.end_dt).toISOString();
    const parts = [durationLabel(startIso, endIso, form.all_day)];
    parts.push(attendees.length === 0 ? "nobody added yet" : `${attendees.length} ${attendees.length === 1 ? "attendee" : "attendees"}`);
    parts.push(form.count_as_work
      ? form.requires_clock_in ? "worked time for whoever clocks in" : "worked time for everyone on the list"
      : "not counted as work");
    return parts.join(" · ");
  }, [validRange, form, attendees.length]);

  // Someone on this list is already booked into another event over the same hours. Warned, not blocked: a
  // conference and an off-site can legitimately overlap for the same person.
  const clash = useMemo(() => {
    if (!validRange || attendees.length === 0) return null;
    const s = form.all_day ? Date.parse(form.start_date) : +new Date(form.start_dt);
    const e = form.all_day ? Date.parse(form.end_date) + DAY_MS - 1 : +new Date(form.end_dt);
    const set = new Set(attendees.map((a) => idOf(a)));
    for (const ev of rows) {
      if (ev.delete_time || ev.path === editing?.path) continue;
      if (startMs(ev) > e || endMs(ev) < s) continue;
      const shared = (ev.attendees ?? []).filter((a) => set.has(idOf(a)));
      if (shared.length) return { event: ev, shared: shared.length };
    }
    return null;
  }, [rows, validRange, form, attendees, editing?.path]);

  async function submit() {
    const times = form.all_day
      ? { start_time: form.start_date, end_time: form.end_date }
      : { start_time: new Date(form.start_dt).toISOString(), end_time: new Date(form.end_dt).toISOString() };
    const body = { title: form.title, all_day: form.all_day, count_as_work: form.count_as_work, requires_clock_in: form.count_as_work && form.requires_clock_in, ...times, color: form.color, description: form.description || null, attendees, repeat: (form.repeat || null) as EventRepeat | null };
    if (editing) {
      try {
        await patch(`events/${idOf(editing.path)}`, body, etag ?? editing.etag);
      } catch (e) {
        // Lost race: somebody else moved this event or changed its attendees. Take their version's etag so the
        // next press goes through deliberately, instead of reporting "etag mismatch" at the reader.
        if (isConflict(e)) {
          const fresh = await get<Event>(`events/${idOf(editing.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this event while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
    } else {
      await create<Event>("events", body);
    }
    toast({ title: editing ? "Event updated" : "Event created", variant: "success" });
    reload();
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
    // Who is actually coming, and the caller's own answer where they can give one. Being on the list was never
    // the same as turning up, and an organiser counting heads for an off-site was counting the invitation.
    { id: "rsvp", header: "Coming", sortable: false, filter: "none", accessor: (e) => e.going_count ?? 0, cell: (e) => {
      const invited = (e.attendees ?? []).length === 0 || (e.attendees ?? []).some((a) => idOf(a) === me.employee_id);
      const mayAnswer = invited && (e.access?.can ?? []).includes("respond") && endMs(e) >= Date.now() && !e.delete_time;
      return (
        <div className="flex flex-col gap-1">
          <span className="text-sm tabular-nums">
            {e.going_count ?? 0} going{e.maybe_count ? ` · ${e.maybe_count} maybe` : ""}{e.declined_count ? ` · ${e.declined_count} no` : ""}
          </span>
          {mayAnswer && (
            <AccessAction verb="respond" objectPath={e.path} can={e.access?.can} label="RSVP to event">
              <div className="flex gap-1">
                {RSVP_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={rsvping === e.path}
                    onClick={() => void rsvp(e, o.value)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50",
                      e.my_response === o.value ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </AccessAction>
          )}
        </div>
      );
    } },
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
        actions={
          <>
            <Segmented
              label="View"
              className="w-auto"
              value={view}
              onChange={(v) => setView(v as "table" | "month")}
              options={[{ value: "table", label: "List" }, { value: "month", label: "Month" }]}
            />
            {createBtn}
          </>
        }
      />

      <DataState state={state} error={error} onRetry={reload}>
        {view === "month" && (
          <EventMonth
            events={sorted}
            me={me}
            onOpen={openEdit}
            onAdd={(ymd) => {
              // A day on the calendar is a date somebody meant: the new event opens dated to it, all-day, rather
              // than to today with the calendar closed behind it.
              setEditing(null);
              setEtag(undefined);
              setForm({ ...EMPTY, all_day: true, start_date: ymd, end_date: ymd, color: EVENT_COLORS[rows.length % EVENT_COLORS.length] });
              setAttendees([]);
              setDept("");
              setOpen(true);
            }}
            onRsvp={rsvp}
            rsvping={rsvping}
          />
        )}
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Upcoming", value: upcoming.length, icon: CalendarRange, tone: upcoming.length ? "primary" : "muted", hint: "still to come", ...kf.kpi("upcoming") },
              ...(awaitingRsvp
                ? [{ label: "Awaiting your answer", value: awaitingRsvp, icon: CalendarRange, tone: "warning" as const, hint: "RSVP to these", ...kf.kpi("rsvp") }]
                : []),
              ...(myGoing ? [{ label: "You're going", value: myGoing, tone: "success" as const, hint: "you answered yes", ...kf.kpi("going") }] : []),
              { label: "Happening now", value: happeningNow, tone: happeningNow ? "success" : "muted", hint: happeningNow ? "under way" : "nothing running", ...(happeningNow ? kf.kpi("now") : {}) },
              {
                label: "Next event", value: <span className="text-base font-semibold">{next ? next.title : "None scheduled"}</span>,
                hint: next ? formatDate(next.start_time) : "nothing booked",
                ...(next ? { onClick: () => openEdit(next) } : {}),
              },
            ]}
          />
        )}
        {view === "table" && (
          <DataTable
            tableId="events"
            columns={cols}
            rows={kf.apply(sorted)}
            getRowId={(e) => e.path}
            rowClassName={(e) => (e.delete_time || endMs(e) < Date.now() ? "opacity-60" : undefined)}
            emptyTitle={kf.activeLabel ? `No ${kf.activeLabel}` : "No events"}
            emptyDescription={kf.activeLabel ? "Clear the metric filter to see every event." : "Create an event to mark a group of people unavailable on the timeline."}
            emptyAction={createBtn}
            accessCollection="events"
            accessTargetOf={(e) => ({ objectPath: e.path, label: e.title, can: e.access?.can })}
          />
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={<span className="flex items-center gap-2"><CalendarRange className="h-4 w-4 text-primary" /> {editing ? "Edit event" : "New event"}</span>}
        description="Shows on the company calendar for everyone it involves. An event that counts as work also feeds attendance."
        collection="events"
        objectPath={editing?.path}
        guardLabel="event"
        form={guarded}
        draftKey={editing ? undefined : "event:new"}
        applyDraft={(d) => { const { attendees: saved, ...rest } = d; setForm(rest); setAttendees(saved ?? []); }}
        onStartOver={editing ? undefined : () => { setForm({ ...EMPTY, ...defaultTimed() }); setAttendees([]); setDept(""); }}
        submitLabel={editing ? "Save changes" : "Create event"}
        canSubmit={canSave}
        whyNot={!form.title.trim() ? "Give the event a title." : "The event ends before it starts."}
        onSubmit={submit}
        footerStart={consequence ? <span className="truncate text-xs text-muted-foreground">{consequence}</span> : undefined}
      >
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
          <Field
            label="Repeats"
            field="repeat"
            hint="The next one is created after this one finishes, so nothing fills the calendar years ahead."
          >
            <Select value={form.repeat || "none"} onValueChange={(v) => setForm({ ...form, repeat: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Doesn't repeat</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
            {repeatPreview.length > 0 && (
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                Then {repeatPreview.map((ms) => formatDate(new Date(ms).toISOString())).join(" · ")}
              </p>
            )}
          </Field>
          {clash && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {clash.shared === 1 ? "One attendee is" : `${clash.shared} attendees are`} also on “{clash.event.title}”
              {" "}({formatDate(clash.event.start_time)}), which overlaps these dates.
            </p>
          )}
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>

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

// Events on a calendar, which is where events live in everybody's head.
//
// A table answers "what is on the books"; a month answers "what is happening the week I'm back", which is the
// question people actually arrive with. Clicking an empty day starts an event dated to it, and a band spans
// every day it covers, so a three-day off-site looks like three days rather than one row saying so.
//
// Deliberately NOT draggable, unlike the compliance calendar: a compliance item is one date and moving it moves
// a deadline, while an event has a start, an end and attendees whose answers were given for the old dates.
// Moving one is an edit worth opening the form for.
function EventMonth({ events, me, onOpen, onAdd, onRsvp, rsvping }: {
  events: Event[];
  me: Me;
  onOpen: (e: Event) => void;
  onAdd: (ymd: string) => void;
  onRsvp: (e: Event, r: "going" | "maybe" | "declined") => void;
  rsvping: string | null;
}) {
  const [cursor, setCursor] = useState(() => { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), 1)); });
  const live = useMemo(() => events.filter((e) => !e.delete_time), [events]);
  // An event occupies every day between its bounds, so a multi-day one appears on each of them.
  const byDay = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const e of live) {
      const from = new Date(startMs(e));
      const to = new Date(endMs(e));
      for (let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); d <= +to; d += DAY_MS) {
        const k = new Date(d).toISOString().slice(0, 10);
        const arr = m.get(k);
        if (arr) arr.push(e); else m.set(k, [e]);
        if (m.size > 400) break; // a pathological range must not build a map of the decade
      }
    }
    return m;
  }, [live]);
  const gridStart = useMemo(() => new Date(+cursor - cursor.getUTCDay() * DAY_MS), [cursor]);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => new Date(+gridStart + i * DAY_MS)), [gridStart]);
  const month = cursor.getUTCMonth();
  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  // Local date for the "today" ring - toISOString() would mark yesterday until UTC rolls over.
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const dayEvents = dayOpen ? byDay.get(dayOpen) ?? [] : [];

  return (
    <>
      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() - 1, 1)))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => { const n = new Date(); setCursor(new Date(Date.UTC(n.getFullYear(), n.getMonth(), 1))); }}>Today</Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1)))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-1 flex items-center gap-2 text-base font-semibold"><CalendarRange className="h-4 w-4 text-primary" />{monthLabel}</span>
        </div>
        <div className="grid grid-cols-7 border-b bg-muted/30 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const ymd = d.toISOString().slice(0, 10);
            const inMonth = d.getUTCMonth() === month;
            const items = byDay.get(ymd) ?? [];
            return (
              <div
                key={ymd}
                className={cn(
                  "group relative min-h-[92px] border-b border-r p-1.5 align-top",
                  i % 7 === 6 && "border-r-0",
                  !inMonth && "bg-muted/20",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-sm tabular-nums", ymd === today && "bg-primary font-semibold text-primary-foreground", !inMonth && "text-muted-foreground/50")}>{d.getUTCDate()}</span>
                  <AccessAction collection="events" create label="New event">
                    <button
                      type="button"
                      onClick={() => onAdd(ymd)}
                      title={`New event on ${ymd}`}
                      aria-label={`New event on ${ymd}`}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:flex coarse:h-8 coarse:w-8 coarse:items-center coarse:justify-center coarse:p-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </AccessAction>
                </div>
                <div className="mt-1 space-y-1">
                  {items.slice(0, 3).map((e) => (
                    <button
                      key={e.path}
                      type="button"
                      onClick={() => onOpen(e)}
                      title={`${e.title}${e.count_as_work ? " · counts as work" : ""} · ${e.going_count ?? 0} going`}
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: e.color || "var(--primary)" }} />
                      <span className="truncate">{e.title}</span>
                      {e.my_response === "going" && <Check className="ml-auto h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    </button>
                  ))}
                  {items.length > 3 && (
                    <button type="button" onClick={() => setDayOpen(ymd)} className="px-1 text-[11px] text-primary hover:underline">
                      +{items.length - 3} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* A busy day, in full, with the answer each event is waiting for. */}
      <Dialog open={!!dayOpen} onOpenChange={(o) => { if (!o) setDayOpen(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{dayOpen ? formatDate(dayOpen) : ""}</DialogTitle></DialogHeader>
          <ul className="space-y-2">
            {dayEvents.map((e) => {
              const invited = (e.attendees ?? []).length === 0 || (e.attendees ?? []).some((a) => idOf(a) === me.employee_id);
              const mayAnswer = invited && (e.access?.can ?? []).includes("respond") && endMs(e) >= Date.now();
              return (
                <li key={e.path} className="rounded-lg border p-2">
                  <button type="button" className="flex w-full items-center gap-2 text-left text-sm font-medium hover:underline" onClick={() => { setDayOpen(null); onOpen(e); }}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: e.color || "var(--primary)" }} />
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  </button>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.all_day ? "All day" : `${new Date(e.start_time).toLocaleTimeString(undefined, { timeStyle: "short" })} - ${new Date(e.end_time).toLocaleTimeString(undefined, { timeStyle: "short" })}`}
                    {" · "}{e.going_count ?? 0} going
                  </p>
                  {mayAnswer && (
                    <div className="mt-1.5 flex gap-1">
                      {RSVP_OPTIONS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          disabled={rsvping === e.path}
                          onClick={() => onRsvp(e, o.value)}
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50",
                            e.my_response === o.value ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
