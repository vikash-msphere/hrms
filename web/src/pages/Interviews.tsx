import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, Link2, Mail, Plus, Pencil, Check, X, ClipboardList, Trash2, Clock, CheckCircle2, Users } from "lucide-react";
import { create, patch, remove, invoke, get, getAllPages } from "@/api";
import type { ListResponse } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDateTime, formatDayTime, formatTime, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd, orgDayOf } from "@/lib/orgDay";
import { isConflict } from "@/lib/formError";
import { navigate, recordUrl, setRouteRecord } from "@/router";
import type { Me, Interview, InterviewFeedback, Application, Candidate, JobRequisition, Employee, LeaveRequest, Event as EventRow } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useNow } from "@/lib/clock";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { TimeRangeField } from "@/components/common/TimeRangeField";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { REC_LABEL, REC_VARIANT, NEGATIVE_REC, findFreeSlots, type BusyWindow } from "@/lib/ats";
import { buildTimedIcs, downloadIcs } from "@/lib/ics";
import { useAtsConfig } from "./Candidates";

// How far ahead the free-slot search looks, and the ceiling on the rows it reads to answer. ONE number for the
// window: the leave query below is narrowed to exactly the days `findFreeSlots` will consider, so widening one
// without the other would either read rows it cannot use or miss days it does.
const SLOT_SEARCH_DAYS = 10;
const SLOT_ROW_CAP = 1000;

const MODES = [
  { key: "video", label: "Video" },
  { key: "onsite", label: "Onsite" },
  { key: "phone", label: "Phone" },
] as const;
const modeLabel = (k?: string) => MODES.find((m) => m.key === k)?.label ?? k ?? "";
type Variant = "secondary" | "success" | "destructive" | "outline";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  scheduled: { label: "Scheduled", variant: "secondary" },
  done: { label: "Done", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};
const fmtWhen = (iso?: string) => (iso ? formatDateTime(iso) : "Not scheduled");

export default function Interviews({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Interview>("interviews");
  const cfg = useAtsConfig();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Interview | "new" | null>(null);
  // The three lists behind an interview's LABELS (which candidate, for which role) and the interviewer picker.
  // An empty schedule has nothing to label, so it reads none of them; the dialog needs all of them to offer a
  // choice, so opening it pulls them in. Nothing here is on screen before either is true.
  const labelled = rows.length > 0 || dialog !== null;
  // Complete, not the first page - the label chains through two of these maps, so an interview whose
  // application is past a window resolves to no candidate AND no role: a slot scheduled with nobody.
  const { rows: apps } = useCollection<Application>("applications", { enabled: labelled, all: true });
  const { rows: candidates } = useCollection<Candidate>("candidates", { enabled: labelled, all: true });
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions", { enabled: labelled, all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: labelled });
  useDeepOpen(openId, rows, setDialog);
  // A slot being argued about over chat is pasteable; `useDeepOpen` above reads the id back in.
  function openDialog(d: Interview | "new") { setDialog(d); setRouteRecord(d === "new" ? null : idOf(d.path)); }
  function closeDialog() { setDialog(null); setRouteRecord(null); }
  const [scorecardFor, setScorecardFor] = useState<Interview | null>(null);

  const candForApp = useMemo(() => {
    const cName = new Map(candidates.map((c) => [idOf(c.path), c.name]));
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => { const a = appRef ? m.get(idOf(appRef)) : undefined; return a?.candidate ? cName.get(idOf(a.candidate)) ?? "Candidate" : ""; };
  }, [apps, candidates]);
  // Candidate id behind an application, for deep-linking to the candidate profile.
  const candIdForApp = useMemo(() => {
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => { const a = appRef ? m.get(idOf(appRef)) : undefined; return a?.candidate ? idOf(a.candidate) : null; };
    // Only `apps`: this one returns the id off the application and never looks a candidate up, unlike the
    // name lookup above it. Carrying `candidates` here rebuilt the map on every candidate list refresh.
  }, [apps]);
  const reqForApp = useMemo(() => {
    const rTitle = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => { const a = appRef ? m.get(idOf(appRef)) : undefined; return a?.requisition ? rTitle.get(idOf(a.requisition)) ?? "" : ""; };
  }, [apps, reqs]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref: string) => m.get(idOf(ref)) ?? "Employee";
  }, [employees]);
  // Who owns the hiring for the job behind an application: the first panelist anyone would add.
  const hiringManagerFor = useMemo(() => {
    const mgr = new Map(reqs.map((r) => [idOf(r.path), r.hiring_manager ? idOf(r.hiring_manager) : null]));
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => {
      const a = appRef ? m.get(idOf(appRef)) : undefined;
      return a?.requisition ? mgr.get(idOf(a.requisition)) ?? null : null;
    };
  }, [apps, reqs]);

  // "On my panel" is the only question an interviewer has here, and a slot whose time has passed while still
  // scheduled is the one blocking a scorecard. Both are clickable metrics rather than a scan of the list.
  const onMyPanel = (i: Interview) => !!me.employee_id && (i.interviewers ?? []).some((ref) => idOf(ref) === me.employee_id);
  // Bucketed on the ORG's clock (lib/orgDay), not the viewer's: `toDateString()` renders an instant in the
  // browser's timezone, and interviewing is the one workflow that routinely crosses zones. A panelist in
  // London reading an IST org's 01:00 slot saw it as "Today" the evening before, and a panelist west of the
  // org read today's slots as tomorrow and found the day's queue empty.
  const isToday = (i: Interview) =>
    i.status === "scheduled" && !!i.scheduled_start_time && orgDayOf(i.scheduled_start_time) === todayStr();
  const isPastDue = (i: Interview) =>
    i.status === "scheduled" && !!i.scheduled_start_time && i.scheduled_start_time < new Date().toISOString() && !isToday(i);
  const kf = useKpiFocus<Interview, "today" | "scheduled" | "done" | "mine" | "pastDue">({
    today: { label: "interviews today", match: isToday },
    scheduled: { label: "scheduled interviews", match: (i) => i.status === "scheduled" },
    done: { label: "completed interviews", match: (i) => i.status === "done" },
    mine: { label: "interviews on your panel", match: onMyPanel },
    pastDue: { label: "interviews still open past their slot", match: isPastDue },
  });

  // Upcoming interviews first (soonest at the top), then past/finished ones newest-first.
  //
  // The boundary is read from a TICKING clock, not from `new Date()` inside the memo: keyed on the rows, that
  // captured the instant of the last data change, so a round that started an hour ago stayed in "upcoming" for
  // as long as the schedule sat open - which on an interview day is exactly when it is open.
  const nowMs = useNow();
  const items = useMemo(() => {
    const now = new Date(nowMs).toISOString();
    const scoped = kf.apply(rows);
    const upcoming = scoped
      .filter((i) => i.status === "scheduled" && (i.scheduled_start_time ?? "") >= now)
      .sort((a, b) => (a.scheduled_start_time ?? "").localeCompare(b.scheduled_start_time ?? ""));
    const rest = scoped
      .filter((i) => !upcoming.includes(i))
      .sort((a, b) => (b.scheduled_start_time ?? "").localeCompare(a.scheduled_start_time ?? ""));
    return [...upcoming, ...rest];
  }, [rows, kf.focus, nowMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const todayCount = useMemo(() => rows.filter(isToday).length, [rows]);

  // What the scorecard dialog walks: the rounds on screen this reader could score - their own panel first,
  // held rounds before booked ones, because an unscored finished interview is what blocks a decision.
  const scorecardQueue = useMemo(() => {
    const mine = items.filter(onMyPanel);
    const pool = mine.length ? mine : items;
    return [...pool].sort((a, b) => Number(b.status === "done") - Number(a.status === "done"));
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  async function complete(i: Interview) {
    if (!(await confirm({ title: "Mark this interview as done?", description: "It leaves the schedule and the panel is asked for their scorecards.", confirmLabel: "Mark done" }))) return;
    try { await invoke(`interviews/${idOf(i.path)}`, "complete"); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }
  async function cancel(i: Interview) {
    if (!(await confirm({ title: "Cancel this interview?", destructive: true, confirmLabel: "Cancel interview" }))) return;
    try { await invoke(`interviews/${idOf(i.path)}`, "cancel"); reload(); }
    catch (e) { toast({ title: "Couldn't cancel", description: (e as Error).message, variant: "destructive" }); }
  }
  // A calendar invite for the slot, built here rather than mailed by the server: the panel already gets a
  // notification, and what they are missing is the hour in their own calendar.
  function addToCalendar(i: Interview) {
    if (!i.scheduled_start_time) return;
    const end = i.scheduled_end_time ?? new Date(Date.parse(i.scheduled_start_time) + 3_600_000).toISOString();
    const who = candForApp(i.application);
    const panel = (i.interviewers ?? []).map(empName).join(", ");
    downloadIcs(
      `interview-${who || "candidate"}.ics`.replace(/\s+/g, "-").toLowerCase(),
      buildTimedIcs(
        [{
          uid: `interview-${idOf(i.path)}@hrms`,
          start: i.scheduled_start_time,
          end,
          summary: `${i.title}${who ? ` · ${who}` : ""}`,
          description: [reqForApp(i.application), panel ? `Panel: ${panel}` : "", modeLabel(i.mode)].filter(Boolean).join("\n"),
          location: i.location ?? undefined,
        }],
        "Interviews",
      ),
    );
  }

  // Tell the CANDIDATE. Scheduling has always notified the panel and left the candidate to be mailed by hand,
  // which is where a wrong time or a missing link comes from. The server sends the round, the slot and the
  // link straight off the record, with a calendar attachment.
  const [inviting, setInviting] = useState<string | null>(null);
  async function invite(i: Interview) {
    const who = candForApp(i.application) || "the candidate";
    if (!(await confirm({
      title: `Email ${who} their interview?`,
      description: "They get the round, the time, the mode and the link, with a calendar file attached. Nothing about the panel's notes is shared.",
      confirmLabel: "Send invitation",
    }))) return;
    setInviting(i.path);
    try { await invoke(`interviews/${idOf(i.path)}`, "invite"); toast({ title: `Invitation sent to ${who}`, variant: "success" }); }
    catch (e) { toast({ title: "Couldn't send the invitation", description: (e as Error).message, variant: "destructive" }); }
    finally { setInviting(null); }
  }

  async function del(i: Interview) {
    if (!(await confirm({ title: "Delete this interview?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`interviews/${idOf(i.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  const openApps = apps.filter((a) => a.status === "active");
  // "Schedule" on the pipeline drawer lands here with the form open and the candidate already picked, rather
  // than making the reader find them in a combobox a second time.
  const [prefillApp, setPrefillApp] = useState("");
  useIntent("new-interview", (arg) => { setPrefillApp(typeof arg === "string" ? arg : ""); setDialog("new"); });
  const newBtn = (
    <AccessAction collection="interviews" create label="Schedule an interview">
      <Button onClick={() => openDialog("new")}><Plus className="h-4 w-4" /> Schedule interview</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Interviews" description="Scheduled interviews across your pipeline. Complete them and capture scorecards." actions={newBtn} />

      {/* A card's label chains through applications and candidates, so a short read on either shows an
          interview with nobody on it. */}
      <TruncationNotice collection={["interviews", "applications", "candidates", "job-requisitions"]} what="interviews" className="mb-3" />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Today", value: todayCount, icon: Clock, tone: todayCount ? "warning" : "muted", hint: todayCount ? "slots today" : "none today", ...kf.kpi("today") },
              ...(rows.some(onMyPanel)
                ? [{ label: "On your panel", value: rows.filter(onMyPanel).length, icon: Users, tone: "primary" as const, hint: "you are interviewing", ...kf.kpi("mine") }]
                : []),
              ...(rows.some(isPastDue)
                ? [{ label: "Past their slot", value: rows.filter(isPastDue).length, icon: Clock, tone: "destructive" as const, hint: "mark done or cancel", ...kf.kpi("pastDue") }]
                : []),
              { label: "Scheduled", value: rows.filter((i) => i.status === "scheduled").length, icon: CalendarClock, tone: "primary", hint: "booked, not held", ...kf.kpi("scheduled") },
              { label: "Completed", value: rows.filter((i) => i.status === "done").length, icon: CheckCircle2, tone: "success", hint: "held and scored", ...kf.kpi("done") },
            ]}
          />
        )}
        {items.length === 0 ? (
          kf.activeLabel ? (
            <EmptyState icon={CalendarClock} title={`No ${kf.activeLabel}`} description="Nothing matches that metric right now." action={<Button variant="outline" onClick={kf.clear}>Show all interviews</Button>} />
          ) : (
          <EmptyState icon={CalendarClock} title="No interviews scheduled" description="Schedule an interview on an active application to get started." action={newBtn} />
          )
        ) : (
          <div className="space-y-2">
            {items.map((i) => {
              const can = i.access?.can ?? [];
              const sm = STATUS_META[i.status] ?? { label: i.status, variant: "secondary" as Variant };
              const panel = (i.interviewers ?? []).map(empName);
              return (
                <div key={i.path} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-3">
                  <div className="min-w-48 flex-1">
                    <div className="font-medium">
                      {candIdForApp(i.application)
                        ? <button type="button" className="hover:underline" onClick={() => navigate(`candidates/${candIdForApp(i.application)}`)}>{candForApp(i.application)}</button>
                        : candForApp(i.application)}
                      <span className="font-normal text-muted-foreground"> · {i.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{[reqForApp(i.application), modeLabel(i.mode), i.location].filter(Boolean).join(" · ")}</div>
                    {panel.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">Panel: {panel.join(", ")}</div>}
                  </div>
                  <div className="text-sm text-muted-foreground">{fmtWhen(i.scheduled_start_time)}</div>
                  {isToday(i) && <Badge variant="warning">Today</Badge>}
                  <Badge variant={sm.variant}>{sm.label}</Badge>
                  <div className="flex flex-wrap items-center gap-1">
                    {/* After the interview the scorecard is the pending action - promote it. */}
                    <Button size="sm" variant={i.status === "done" ? "default" : "outline"} className="h-7" onClick={() => setScorecardFor(i)}><ClipboardList className="h-3.5 w-3.5" /> Scorecard</Button>
                    {/* An interview nobody's calendar knows about is an interview somebody misses. */}
                    {i.scheduled_start_time && i.status !== "cancelled" && (
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => addToCalendar(i)} aria-label="Add to calendar" title="Download a calendar invite">
                        <CalendarPlus className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {can.includes("invite") && i.status === "scheduled" && !!i.scheduled_start_time && (
                      <AccessAction verb="invite" objectPath={i.path} can={can} label="Email the candidate">
                        <Button size="sm" variant="ghost" className="h-7" loading={inviting === i.path} onClick={() => invite(i)} aria-label="Email the candidate" title="Email the candidate their slot"><Mail className="h-3.5 w-3.5" /></Button>
                      </AccessAction>
                    )}
                    {can.includes("complete") && i.status === "scheduled" && <AccessAction verb="complete" objectPath={i.path} can={can} label="Complete interview"><Button size="sm" variant="ghost" className="h-7" onClick={() => complete(i)}><Check className="h-3.5 w-3.5" /> Done</Button></AccessAction>}
                    {can.includes("cancel") && i.status === "scheduled" && <AccessAction verb="cancel" objectPath={i.path} can={can} label="Cancel interview"><Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => cancel(i)} aria-label="Cancel interview"><X className="h-3.5 w-3.5" /> Cancel</Button></AccessAction>}
                    {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openDialog(i)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                    {can.includes("delete") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(i)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DataState>

      {dialog && (
        <InterviewDialog
          interview={dialog === "new" ? null : dialog}
          defaultApplication={prefillApp}
          apps={openApps}
          interviews={rows}
          candName={(ref) => candForApp(ref)}
          reqName={(ref) => reqForApp(ref)}
          hiringManagerFor={hiringManagerFor}
          employees={employees}
          me={me}
          onClose={() => { closeDialog(); setPrefillApp(""); }}
          onSaved={() => { closeDialog(); setPrefillApp(""); reload(); }}
        />
      )}
      {scorecardFor && (
        <ScorecardDialog
          interview={scorecardFor}
          me={me}
          criteria={cfg.scorecard_criteria}
          blind={!!cfg.blind_scorecards}
          empName={empName}
          candName={candForApp(scorecardFor.application)}
          jobTitle={reqForApp(scorecardFor.application)}
          queue={scorecardQueue}
          onOpen={setScorecardFor}
          onClose={() => setScorecardFor(null)}
        />
      )}
    </div>
  );
}

// The rounds every pipeline actually books. Typing "Technical round" for the fortieth time is not data entry.
const ROUND_PRESETS = ["Screening call", "Technical round", "System design", "Hiring manager", "Culture fit", "Final round"];
// What the location field IS depends on how the interview is held; one label for all three modes was wrong twice.
const LOCATION_FIELD: Record<string, { label: string; placeholder: string; hint: string }> = {
  video: { label: "Meeting link", placeholder: "https://…", hint: "Goes out in the panel's notification, so paste the real link." },
  onsite: { label: "Room / address", placeholder: "e.g. Level 3, Room 2", hint: "Where the candidate should turn up." },
  phone: { label: "Phone number", placeholder: "e.g. +91 98xxxxxxxx", hint: "Which number to call, and whose." },
};
// The next whole hour, which is what "schedule an interview" means nine times out of ten.
function nextHourSlot() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return { start: d.toISOString(), end: new Date(d.getTime() + 3_600_000).toISOString() };
}
const fmtSlot = formatDayTime;
const fmtTime = formatTime;

function InterviewDialog({ interview, defaultApplication, apps, interviews, candName, reqName, hiringManagerFor, employees, me, onClose, onSaved }: {
  interview: Interview | null;
  /** Pre-picked application, when the dialog was opened from a pipeline card. */
  defaultApplication?: string;
  apps: Application[];
  /** Every interview, for the "this panelist is already booked then" guard. */
  interviews: Interview[];
  candName: (ref?: string) => string;
  reqName: (ref?: string) => string;
  hiringManagerFor: (appRef?: string) => string | null;
  employees: Employee[];
  me: Me;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!interview;
  const seed = useMemo(nextHourSlot, []);
  const [form, setForm] = useState({
    application: interview?.application ? idOf(interview.application) : defaultApplication ?? "",
    title: interview?.title ?? "",
    mode: interview?.mode ?? "video",
    start: interview?.scheduled_start_time ?? seed.start,
    end: interview?.scheduled_end_time ?? seed.end,
    location: interview?.location ?? "",
    panel: (interview?.interviewers ?? []).map(idOf),
  });
  // The version an edit writes against, refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState(interview?.etag);
  // The slot control seeds itself once, on mount, so anything that replaces the whole form from outside (a
  // restored draft, start over) has to remount it - otherwise it would go on showing the old times while the
  // form held the new ones.
  const [slotSeed, setSlotSeed] = useState(0);
  const canSubmit = !!form.title.trim() && (editing || !!form.application);

  const empLabelOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (id: string) => m.get(id) ?? "Employee";
  }, [employees]);
  const appRef = form.application ? `applications/${form.application}` : interview?.application;

  const addPanelist = (id: string) => setForm((f) => (f.panel.includes(id) ? f : { ...f, panel: [...f.panel, id] }));
  const dropPanelist = (id: string) => setForm((f) => ({ ...f, panel: f.panel.filter((x) => x !== id) }));

  // Who you'd add without being asked: the job's hiring manager, then whoever already interviewed this
  // candidate on earlier rounds - a fresh panel every round is how context gets lost between them.
  const suggested = useMemo(() => {
    const out: string[] = [];
    const mgr = hiringManagerFor(appRef);
    if (mgr) out.push(mgr);
    if (appRef) {
      for (const i of interviews) {
        if (i.path === interview?.path || !i.application || idOf(i.application) !== idOf(appRef)) continue;
        for (const ref of i.interviewers ?? []) out.push(idOf(ref));
      }
    }
    return [...new Set(out)].filter((id) => !form.panel.includes(id)).slice(0, 5);
  }, [appRef, interviews, interview?.path, form.panel, hiringManagerFor]);

  // A panelist (or the candidate) already booked over these hours. Warned, never blocked: a double-book is
  // sometimes deliberate, and only the person scheduling knows.
  const clashes = useMemo(() => {
    const s = Date.parse(form.start);
    const e = Date.parse(form.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return [];
    const out: string[] = [];
    for (const i of interviews) {
      if (i.path === interview?.path || i.status !== "scheduled" || !i.scheduled_start_time) continue;
      const os = Date.parse(i.scheduled_start_time);
      const oe = i.scheduled_end_time ? Date.parse(i.scheduled_end_time) : os + 3_600_000;
      if (!(os < e && oe > s)) continue;
      const shared = (i.interviewers ?? []).map(idOf).filter((id) => form.panel.includes(id));
      for (const id of shared) out.push(`${empLabelOf(id)} is on “${i.title}” at ${fmtTime(i.scheduled_start_time)}`);
      if (appRef && i.application && idOf(i.application) === idOf(appRef)) {
        out.push(`${candName(appRef)} already has “${i.title}” at ${fmtTime(i.scheduled_start_time)}`);
      }
    }
    return [...new Set(out)].slice(0, 3);
  }, [interviews, interview?.path, form.start, form.end, form.panel, appRef, candName, empLabelOf]);

  const loc = LOCATION_FIELD[form.mode] ?? LOCATION_FIELD.video!;
  const minutes = Math.max(0, Math.round((Date.parse(form.end) - Date.parse(form.start)) / 60000));

  // Free-slot search. Approved leave and events are read ONLY when the button is pressed: two collections
  // nothing else on this page needs, and most interviews are booked to a time somebody already agreed.
  const [slots, setSlots] = useState<{ loading: boolean; offered: { start: number; end: number }[] | null }>({ loading: false, offered: null });
  async function findSlots() {
    if (!form.panel.length) return;
    setSlots({ loading: true, offered: null });
    try {
      // NARROWED TO THE SEARCH WINDOW, not to the newest rows. This asked for `max_page_size=200`, got the
      // server's 100 (http/pagination.ts caps there), and those hundred are the most recently CREATED leave
      // requests - which has nothing to do with the days being searched. Leave approved a month ago for next
      // week sat past the cursor, so the slot finder offered times the panel is away for: a wrong answer
      // wearing the confidence of a computed one. `state`/`from`/`to` are server-side filters on this
      // collection, so the rows that come back are exactly the ones that can make a day busy.
      const fromYmd = todayStr();
      const toYmd = addDaysYmd(fromYmd, SLOT_SEARCH_DAYS);
      const [leave, events] = await Promise.all([
        getAllPages<LeaveRequest>(`leave-requests?state=approved&from=${fromYmd}&to=${toYmd}`, SLOT_ROW_CAP).catch(() => ({ results: [] as LeaveRequest[] })),
        // `events` has no date filter on the server, so this follows the cursor within a ceiling instead.
        getAllPages<EventRow>("events", SLOT_ROW_CAP).catch(() => ({ results: [] as EventRow[] })),
      ]);
      const busy: BusyWindow[] = [];
      // Other interviews the panel is already sitting on.
      for (const i of interviews) {
        if (i.path === interview?.path || i.status !== "scheduled" || !i.scheduled_start_time) continue;
        const s = Date.parse(i.scheduled_start_time);
        const e = i.scheduled_end_time ? Date.parse(i.scheduled_end_time) : s + 3_600_000;
        for (const ref of i.interviewers ?? []) busy.push({ who: idOf(ref), start: s, end: e, label: i.title });
      }
      // Approved leave blocks the whole day - a half-day panelist is still a panelist who might be away.
      for (const l of leave.results ?? []) {
        if (l.state !== "approved" || !l.employee || !l.start_date) continue;
        const s = Date.parse(`${l.start_date}T00:00:00`);
        const e = Date.parse(`${l.end_date ?? l.start_date}T00:00:00`) + 86_400_000;
        busy.push({ who: idOf(l.employee), start: s, end: e, label: "leave" });
      }
      // Events they are on the attendee list for.
      for (const ev of events.results ?? []) {
        if (ev.delete_time || !ev.start_time) continue;
        const s = Date.parse(ev.start_time);
        const e = ev.end_time ? Date.parse(ev.end_time) : s + 3_600_000;
        for (const ref of ev.attendees ?? []) busy.push({ who: idOf(ref), start: s, end: e, label: ev.title });
      }
      setSlots({
        loading: false,
        offered: findFreeSlots({ panel: form.panel, busy, durationMin: minutes || 60, fromMs: Date.now(), days: SLOT_SEARCH_DAYS, limit: 6 }),
      });
    } catch {
      setSlots({ loading: false, offered: [] });
    }
  }
  const consequence = [
    Number.isFinite(Date.parse(form.start)) ? fmtSlot(form.start) : "",
    minutes ? `${minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`}` : "",
    form.panel.length ? `${form.panel.length} ${form.panel.length === 1 ? "panelist" : "panelists"} notified` : "nobody on the panel",
  ].filter(Boolean).join(" · ");

  function copyLink() {
    navigator.clipboard.writeText(recordUrl("interviews", idOf(interview!.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this interview can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  async function submit() {
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      mode: form.mode,
      // `format: date-time` fields, and "" is not one - an unscheduled slot leaves them out.
      ...(form.start ? { scheduled_start_time: form.start } : {}),
      ...(form.end ? { scheduled_end_time: form.end } : {}),
      location: form.location.trim(),
      interviewers: form.panel.map((id) => `employees/${id}`),
    };
    if (editing) {
      try {
        const saved = await patch<Interview>(`interviews/${idOf(interview!.path)}`, body, etag ?? interview!.etag);
        setEtag(saved.etag); // a second Save from a dialog left open must not send the first one's etag
      } catch (e) {
        // Lost race: somebody else moved the slot or changed the panel. Take their etag so the next press is a
        // deliberate overwrite.
        if (isConflict(e)) {
          const fresh = await get<Interview>(`interviews/${idOf(interview!.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this interview while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
    } else {
      body.application = `applications/${form.application}`;
      await create<Interview>("interviews", body);
    }
    toast({ title: editing ? "Interview updated" : "Interview scheduled", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={editing ? "Edit interview" : "Schedule an interview"}
      description="Every panelist gets a notification with the candidate, the round and the time. Moving the slot or adding someone notifies them again."
      collection="interviews"
      objectPath={interview?.path}
      guardLabel="interview"
      form={form}
      draftKey={editing ? undefined : "interview:new"}
      applyDraft={editing ? undefined : (d) => { setForm(d); setSlotSeed((n) => n + 1); }}
      onStartOver={editing ? undefined : () => { setForm({ application: "", title: "", mode: "video", start: seed.start, end: seed.end, location: "", panel: [] }); setSlotSeed((n) => n + 1); }}
      submitLabel={editing ? "Save changes" : "Schedule"}
      canSubmit={canSubmit}
      whyNot={[!form.title.trim() && "Name the round (screening, technical, …).", !editing && !form.application && "Pick who is being interviewed."]}
      onSubmit={submit}
      footerStart={
        <div className="flex min-w-0 items-center gap-2">
          {editing && <Button type="button" variant="ghost" size="sm" onClick={copyLink}><Link2 className="h-4 w-4" /> Copy link</Button>}
          <span className="truncate text-xs text-muted-foreground">{consequence}</span>
        </div>
      }
    >
      {!editing ? (
        <Field label="Application" field="application">
          <Combobox
            value={form.application}
            onValueChange={(v) => setForm({ ...form, application: v })}
            options={apps.map((a) => ({ value: idOf(a.path), label: `${candName(a.path)} · ${reqName(a.path)}` }))}
            placeholder="Pick an active application"
            searchPlaceholder="Search candidates…"
            emptyText="No active applications to interview."
            autoFocus
          />
        </Field>
      ) : (
        <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {[candName(interview.application), reqName(interview.application)].filter(Boolean).join(" · ")}
        </p>
      )}
      <FieldRow>
        <Field label="Round" field="title">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus={editing} placeholder="e.g. Technical round" />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ROUND_PRESETS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setForm({ ...form, title: r })}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  form.title === r ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Mode" field="mode">
          <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{MODES.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </FieldRow>
      {/* One control for the slot: shared date, start and end times, live duration and quick lengths. Two
          datetime-locals made the reader type the date twice and left "ends before it starts" possible. */}
      <Field
        label="When"
        field="scheduled_start_time"
        action={form.panel.length > 0
          ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" loading={slots.loading} onClick={findSlots}>Find a free slot</Button>
          : undefined}
        hint={form.panel.length === 0 ? "Add the panel first and this can offer the hours they're all free." : undefined}
      >
        <TimeRangeField
          key={`${interview?.path ?? "new"}:${slotSeed}`}
          initialStart={form.start}
          initialEnd={form.end}
          onChange={(s, e) => setForm((f) => ({ ...f, start: s, end: e }))}
        />
        {/* Offered, never imposed: picking one fills the slot control, which stays editable. */}
        {slots.offered !== null && (
          <div className="mt-2">
            {slots.offered.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No hour in the next two working weeks is free for all {form.panel.length} of them. Drop someone from the panel, or book over a clash deliberately.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">All free:</span>
                {slots.offered.map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    onClick={() => { setForm((f) => ({ ...f, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })); setSlotSeed((n) => n + 1); }}
                    className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {fmtSlot(new Date(s.start).toISOString())}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>
      <Field label={`${loc.label} (optional)`} field="location" hint={loc.hint}>
        <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={loc.placeholder} />
      </Field>
      <Field
        label="Interview panel"
        field="interviewers"
        hint={form.panel.length ? "Each of them is notified, and each can file a scorecard." : "Nobody is notified and nobody can score this round until someone is on it."}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Combobox
              value=""
              onValueChange={addPanelist}
              options={employees.filter((e) => !form.panel.includes(idOf(e.path))).map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}`.trim() }))}
              placeholder="Add a panelist…"
              searchPlaceholder="Search people…"
              emptyText="Everyone is already on the panel."
              className="w-56"
            />
            {me.employee_id && !form.panel.includes(me.employee_id) && (
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => addPanelist(me.employee_id!)}>Add me</Button>
            )}
          </div>
          {suggested.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Suggested:</span>
              {suggested.map((id) => (
                <button key={id} type="button" onClick={() => addPanelist(id)} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  + {empLabelOf(id)}
                </button>
              ))}
            </div>
          )}
          {form.panel.length > 0 && (
            <div className="flex flex-wrap gap-1.5 rounded-lg border p-2">
              {form.panel.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                  {empLabelOf(id)}
                  <button type="button" onClick={() => dropPanelist(id)} aria-label={`Remove ${empLabelOf(id)}`} className="rounded text-muted-foreground transition-colors hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </Field>
      {clashes.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          Already booked over this slot: {clashes.join("; ")}.
        </div>
      )}
      {interview && <ActivitySection resource={interview.path} className="border-t pt-3" />}
    </WriteDialog>
  );
}

// What a number on a criterion MEANS, so five panelists mean roughly the same thing by a 4.
const RATING_ANCHOR: Record<number, string> = { 1: "Well below", 2: "Below", 3: "Meets", 4: "Above", 5: "Outstanding" };

/** 1-5 as five buttons: one tap, the whole scale visible, and the anchor said out loud. */
function RatingRow({ label, value, onChange }: { label: string; value?: number; onChange: (n: number) => void }) {
  const labelId = useId();
  // A real radio group, not five toggle buttons: one tab stop for the row, arrows to move between the numbers,
  // and a screen reader that says "3 of 5, Meets" instead of reading out five pressed/unpressed buttons.
  const onKey = (e: React.KeyboardEvent) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    onChange(Math.min(5, Math.max(1, (value ?? (delta > 0 ? 0 : 6)) + delta)));
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" id={labelId}>{label}</span>
      <div className="flex items-center gap-1" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKey}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            // Roving tab stop: the chosen number owns the group's place in the tab order (the first, when
            // nothing is chosen yet), and the arrows do the rest.
            tabIndex={value === n || (!value && n === 1) ? 0 : -1}
            onClick={() => onChange(n)}
            title={RATING_ANCHOR[n]}
            aria-label={`${n} - ${RATING_ANCHOR[n]}`}
            className={cn(
              // Five 32px targets in a row is a coin flip with a thumb, and this is filled on a phone during
              // the interview. The role's own floor (index.css) only grows the height; the width has to be
              // stated here or the buttons come out tall and thin.
              "h-8 w-8 rounded-md border text-sm tabular-nums transition-colors coarse:h-11 coarse:w-11",
              value === n ? "border-primary bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {n}
          </button>
        ))}
        <span className="ml-1 w-20 text-xs text-muted-foreground">{value ? RATING_ANCHOR[value] : ""}</span>
      </div>
    </div>
  );
}

function ScorecardDialog({ interview, me, criteria, blind, empName, candName, jobTitle, queue, onOpen, onClose }: {
  interview: Interview;
  me: Me;
  criteria: { key: string; label: string }[];
  /** Hide the panel's other verdicts until this one is filed (settings/ats). */
  blind: boolean;
  empName: (ref: string) => string;
  candName: string;
  jobTitle: string;
  /** The rounds this reader can score, for walking them without closing the dialog. */
  queue: Interview[];
  onOpen: (i: Interview) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [all, setAll] = useState<InterviewFeedback[]>([]);
  const [mine, setMine] = useState<InterviewFeedback | null>(null);
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<{ ratings: Record<string, number>; overall: string; rec: string; comment: string }>({
    ratings: {}, overall: "", rec: "", comment: "",
  });
  const overallError = form.overall !== "" && (Number(form.overall) < 1 || Number(form.overall) > 5) ? "Rate between 1 and 5." : undefined;

  // A `live` latch, because this dialog is QUEUE-NAVIGABLE in place (`onOpen={setScorecardFor}`, no `key`), so
  // walking from one interview's scorecard to the next leaves two fetches racing. When the stale one lands last
  // it sets four things at once, and every one of them is wrong: `setAll` puts the OTHER PANELISTS' scorecards
  // for a different interview on screen (which is what the blind-scoring toggle exists to control), `setForm`
  // pre-fills this candidate's card with the reader's ratings and written comment from the previous one, and
  // `setMine`/`setEtag` are what `submit()` writes to - so Save patched the previous interview's feedback
  // record with a body naming the current interview. `Pipeline`'s ApplicationDrawer is the shape to copy.
  useEffect(() => {
    let live = true;
    // Cleared up front, so nothing from the previous interview is on screen while this one loads.
    setAll([]);
    setMine(null);
    setEtag(undefined);
    setForm({ ratings: {}, overall: "", rec: "", comment: "" });
    get<ListResponse<InterviewFeedback>>(`interview-feedback?interview=interviews/${idOf(interview.path)}&max_page_size=200`)
      .then((r) => {
        if (!live) return;
        const list = r.results ?? [];
        setAll(list);
        const own = list.find((f) => f.author && idOf(f.author) === me.employee_id) ?? null;
        setMine(own);
        setEtag(own?.etag);
        if (own) {
          setForm({
            ratings: own.ratings ?? {},
            overall: own.overall_rating != null ? String(own.overall_rating) : "",
            rec: own.recommendation ?? "",
            comment: own.comment ?? "",
          });
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [interview, me.employee_id]);

  // Four owed scorecards used to mean four trips through the list. `‹ 2/4 ›` and j/k walk the rounds this
  // reader can score; filing one advances to the next.
  const qIndex = queue.findIndex((i) => i.path === interview.path);
  const canStep = (delta: number) => qIndex >= 0 && !!queue[qIndex + delta];
  const step = (delta: number) => { const next = queue[qIndex + delta]; if (next) onOpen(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-bound each render on purpose: the handler closes over the queue position.
  });

  const others = all.filter((f) => f.path !== mine?.path);
  // Blind mode is an anchoring guard, not a secrecy boundary: the rows are readable to anyone who can read the
  // collection, and this simply doesn't put them in front of an interviewer who is still forming a view.
  const hidden = blind && !mine;
  // The panel's verdict as it stands, so a scorecard is filed into a conversation rather than a void.
  const tally = useMemo(() => {
    const yes = others.filter((f) => f.recommendation === "yes" || f.recommendation === "strong_yes").length;
    const no = others.filter((f) => NEGATIVE_REC.includes(f.recommendation ?? "")).length;
    const rated = others.filter((f) => f.overall_rating != null);
    const avg = rated.length ? rated.reduce((s, f) => s + (f.overall_rating ?? 0), 0) / rated.length : null;
    return { yes, no, avg };
  }, [others]);

  // The criteria average: the number the overall rating is almost always meant to be, offered rather than
  // computed behind the reader's back (a panelist may deliberately weigh one criterion above the rest).
  const scored = criteria.map((c) => form.ratings[c.key]).filter((n): n is number => typeof n === "number");
  const criteriaAvg = scored.length ? scored.reduce((s, n) => s + n, 0) / scored.length : null;
  const negative = NEGATIVE_REC.includes(form.rec);
  const canSubmit = !!form.rec && !overallError && (!negative || !!form.comment.trim());

  async function submit() {
    const body = {
      interview: `interviews/${idOf(interview.path)}`,
      ratings: form.ratings,
      // Omitted when blank rather than sent as `null`: `overall_rating` is `{ type: number }` in openapi.yaml,
      // not nullable, and an overall score is optional on this form - so submitting feedback with only a
      // recommendation sent a null the Prism proxy rejects with a 422 (see the rule in api.ts).
      ...(form.overall ? { overall_rating: Number(form.overall) } : {}),
      recommendation: form.rec,
      comment: form.comment.trim(),
    };
    if (mine) {
      try {
        const saved = await patch<InterviewFeedback>(`interview-feedback/${idOf(mine.path)}`, body, etag ?? mine.etag);
        setEtag(saved.etag);
      } catch (e) {
        if (isConflict(e)) {
          const fresh = await get<InterviewFeedback>(`interview-feedback/${idOf(mine.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Your scorecard changed elsewhere while this was open. Press Save again to keep this version.");
        }
        throw e;
      }
    } else {
      await create<InterviewFeedback>("interview-feedback", body);
    }
    toast({ title: mine ? "Scorecard updated" : "Scorecard filed", variant: "success" });
    onClose();
  }

  return (
    <WriteDialog
      open
      // A scorecard is a panelist's private read on a candidate, held back from the rest of the panel until
      // theirs is in - so it is masked in session replay (`sentry-mask`, see web/src/instrument.ts). A dialog
      // renders through a portal, outside `<main data-page>`, so no route-level mask can reach it; this is the
      // same per-dialog tag the profile's pay and identity forms carry, and test/replayMaskCoverage.test.ts
      // holds this one to it too.
      className="sentry-mask"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2 pr-8">
          <span className="truncate">Scorecard · {interview.title}</span>
          {queue.length > 1 && qIndex >= 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground">
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous round" title="Previous round (k)"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{qIndex + 1}/{queue.length}</span>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next round" title="Next round (j)"><ChevronRight className="h-4 w-4" /></Button>
            </span>
          )}
        </span>
      }
      description={`${[candName, jobTitle].filter(Boolean).join(" · ") || "This round"} - your verdict is visible to the rest of the panel and to whoever decides on the offer.`}
      collection="interview-feedback"
      objectPath={mine?.path}
      guardLabel="scorecard"
      form={form}
      submitLabel={mine ? "Save scorecard" : "File scorecard"}
      canSubmit={canSubmit}
      whyNot={[
        !form.rec && "Say yes or no - the ratings alone aren't a decision.",
        negative && !form.comment.trim() && "A no needs a reason: it's all the rest of the panel gets.",
        !!overallError && "Overall has to be between 1 and 5.",
      ]}
      onSubmit={submit}
      cancelLabel="Close"
    >
      {hidden && others.length > 0 && (
        <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {others.length === 1 ? "One panelist has" : `${others.length} panelists have`} already filed. Their verdicts stay hidden until yours is in, so this is your read and not theirs.
        </p>
      )}
      {!hidden && others.length > 0 && (
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Panel so far
            <span className="font-normal normal-case tracking-normal">
              {tally.yes} yes · {tally.no} no{tally.avg != null ? ` · avg ${tally.avg.toFixed(1)}/5` : ""}
            </span>
          </p>
          {others.map((f) => (
            <div key={f.path} className="text-sm">
              <span className="font-medium">{f.author ? empName(f.author) : "Panelist"}</span>
              {f.recommendation && <Badge variant={REC_VARIANT[f.recommendation] ?? "secondary"} className="ml-2">{REC_LABEL[f.recommendation] ?? f.recommendation}</Badge>}
              {f.overall_rating != null && <span className="ml-2 text-muted-foreground">{f.overall_rating}/5</span>}
              {f.comment && <div className="text-xs text-muted-foreground">{f.comment}</div>}
            </div>
          ))}
        </div>
      )}
      {!hidden && others.length === 0 && <p className="text-xs text-muted-foreground">Nobody else has filed on this round yet - yours is the first read of this candidate.</p>}

      <Field label="Your ratings" hint={`1 ${RATING_ANCHOR[1]!.toLowerCase()} … 5 ${RATING_ANCHOR[5]!.toLowerCase()}. Skip a criterion you couldn't judge.`}>
        <div className="space-y-2 rounded-lg border p-3">
          {criteria.map((c) => (
            <RatingRow key={c.key} label={c.label} value={form.ratings[c.key]} onChange={(n) => setForm({ ...form, ratings: { ...form.ratings, [c.key]: n } })} />
          ))}
        </div>
      </Field>
      <FieldRow>
        <Field
          label="Overall (1-5)"
          field="overall_rating"
          error={overallError}
          action={criteriaAvg != null && form.overall !== criteriaAvg.toFixed(1)
            ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setForm({ ...form, overall: criteriaAvg.toFixed(1) })}>Use average ({criteriaAvg.toFixed(1)})</Button>
            : undefined}
        >
          <Input type="number" min={1} max={5} step="0.5" value={form.overall} onChange={(e) => setForm({ ...form, overall: e.target.value })} />
        </Field>
        <Field label="Recommendation" field="recommendation" hint="This is the part the hiring decision reads.">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(REC_LABEL).map(([k, v]) => (
              <button
                key={k}
                type="button"
                onClick={() => setForm({ ...form, rec: k })}
                aria-pressed={form.rec === k}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                  form.rec === k
                    ? NEGATIVE_REC.includes(k) ? "border-destructive bg-destructive font-medium text-destructive-foreground" : "border-success bg-success font-medium text-success-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </Field>
      </FieldRow>
      <Field
        label={negative ? "Why not" : "Comments"}
        field="comment"
        hint={negative ? "Required for a no - the rest of the panel decides on this, not on the number." : "What you saw, in enough detail for someone who wasn't in the room."}
      >
        <Textarea rows={3} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
      </Field>
    </WriteDialog>
  );
}
