import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Plus, Pencil, Check, X, ClipboardList, Trash2, Clock, CheckCircle2 } from "lucide-react";
import { create, patch, remove, invoke, get } from "@/api";
import type { ListResponse } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { navigate } from "@/router";
import type { Me, Interview, InterviewFeedback, Application, Candidate, JobRequisition, Employee } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { useAtsConfig } from "./Candidates";

const MODES = [
  { key: "video", label: "Video" },
  { key: "onsite", label: "Onsite" },
  { key: "phone", label: "Phone" },
] as const;
const modeLabel = (k?: string) => MODES.find((m) => m.key === k)?.label ?? k ?? "";
const REC_LABEL: Record<string, string> = { strong_yes: "Strong yes", yes: "Yes", no: "No", strong_no: "Strong no" };
const REC_VARIANT: Record<string, "success" | "destructive"> = { strong_yes: "success", yes: "success", no: "destructive", strong_no: "destructive" };
type Variant = "secondary" | "success" | "destructive" | "outline";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  scheduled: { label: "Scheduled", variant: "secondary" },
  done: { label: "Done", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};
const fmtWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled");
// datetime-local <-> ISO helpers (local wall-clock in the input, UTC ISO on the wire).
const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export default function Interviews({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Interview>("interviews");
  const { rows: apps } = useCollection<Application>("applications");
  const { rows: candidates } = useCollection<Candidate>("candidates");
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const { rows: employees } = useCollection<Employee>("employees");
  const cfg = useAtsConfig();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Interview | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);
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
  }, [apps, candidates]);
  const reqForApp = useMemo(() => {
    const rTitle = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => { const a = appRef ? m.get(idOf(appRef)) : undefined; return a?.requisition ? rTitle.get(idOf(a.requisition)) ?? "" : ""; };
  }, [apps, reqs]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref: string) => m.get(idOf(ref)) ?? "Employee";
  }, [employees]);

  // Upcoming interviews first (soonest at the top), then past/finished ones newest-first.
  const items = useMemo(() => {
    const now = new Date().toISOString();
    const upcoming = rows
      .filter((i) => i.status === "scheduled" && (i.scheduled_start_time ?? "") >= now)
      .sort((a, b) => (a.scheduled_start_time ?? "").localeCompare(b.scheduled_start_time ?? ""));
    const rest = rows
      .filter((i) => !upcoming.includes(i))
      .sort((a, b) => (b.scheduled_start_time ?? "").localeCompare(a.scheduled_start_time ?? ""));
    return [...upcoming, ...rest];
  }, [rows]);

  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return rows.filter((i) => i.status === "scheduled" && i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === today).length;
  }, [rows]);

  async function complete(i: Interview) {
    try { await invoke(`interviews/${idOf(i.path)}`, "complete"); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }
  async function cancel(i: Interview) {
    if (!(await confirm({ title: "Cancel this interview?", destructive: true, confirmLabel: "Cancel interview" }))) return;
    try { await invoke(`interviews/${idOf(i.path)}`, "cancel"); reload(); }
    catch (e) { toast({ title: "Couldn't cancel", description: (e as Error).message, variant: "destructive" }); }
  }
  async function del(i: Interview) {
    if (!(await confirm({ title: "Delete this interview?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`interviews/${idOf(i.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  const openApps = apps.filter((a) => a.status === "active");
  const newBtn = (
    <AccessAction collection="interviews" create label="Schedule an interview">
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> Schedule interview</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Interviews" description="Scheduled interviews across your pipeline. Complete them and capture scorecards." actions={newBtn} />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Today", value: todayCount, icon: Clock, tone: todayCount ? "warning" : "muted" },
              { label: "Scheduled", value: rows.filter((i) => i.status === "scheduled").length, icon: CalendarClock, tone: "primary" },
              { label: "Completed", value: rows.filter((i) => i.status === "done").length, icon: CheckCircle2, tone: "success" },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No interviews scheduled" description="Schedule an interview on an active application to get started." action={newBtn} />
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
                  {i.status === "scheduled" && i.scheduled_start_time && new Date(i.scheduled_start_time).toDateString() === new Date().toDateString() && (
                    <Badge variant="warning">Today</Badge>
                  )}
                  <Badge variant={sm.variant}>{sm.label}</Badge>
                  <div className="flex items-center gap-1">
                    {/* After the interview the scorecard is the pending action - promote it. */}
                    <Button size="sm" variant={i.status === "done" ? "default" : "outline"} className="h-7" onClick={() => setScorecardFor(i)}><ClipboardList className="h-3.5 w-3.5" /> Scorecard</Button>
                    {can.includes("complete") && i.status === "scheduled" && <Button size="sm" variant="ghost" className="h-7" onClick={() => complete(i)}><Check className="h-3.5 w-3.5" /> Done</Button>}
                    {can.includes("cancel") && i.status === "scheduled" && <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => cancel(i)} aria-label="Cancel interview"><X className="h-3.5 w-3.5" /> Cancel</Button>}
                    {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(i)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
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
          apps={openApps}
          candName={(ref) => candForApp(ref)}
          reqName={(ref) => reqForApp(ref)}
          employees={employees}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
      {scorecardFor && (
        <ScorecardDialog
          interview={scorecardFor}
          me={me}
          criteria={cfg.scorecard_criteria}
          empName={empName}
          onClose={() => setScorecardFor(null)}
        />
      )}
    </div>
  );
}

function InterviewDialog({ interview, apps, candName, reqName, employees, onClose, onSaved }: {
  interview: Interview | null;
  apps: Application[];
  candName: (ref?: string) => string;
  reqName: (ref?: string) => string;
  employees: Employee[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!interview;
  const [application, setApplication] = useState(interview?.application ? idOf(interview.application) : "");
  const [title, setTitle] = useState(interview?.title ?? "");
  const [mode, setMode] = useState(interview?.mode ?? "video");
  const [start, setStart] = useState(toLocalInput(interview?.scheduled_start_time));
  const [end, setEnd] = useState(toLocalInput(interview?.scheduled_end_time));
  const [location, setLocation] = useState(interview?.location ?? "");
  const [panel, setPanel] = useState<string[]>((interview?.interviewers ?? []).map(idOf));
  const [busy, setBusy] = useState(false);
  const endError = start && end && end <= start ? "Must end after it starts." : undefined;
  const valid = !!title.trim() && (editing || !!application) && !endError;

  const togglePanel = (id: string) => setPanel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        mode,
        scheduled_start_time: fromLocalInput(start),
        scheduled_end_time: fromLocalInput(end),
        location: location.trim() || null,
        interviewers: panel.map((id) => `employees/${id}`),
      };
      if (!editing) body.application = `applications/${application}`;
      if (editing) await patch(`interviews/${idOf(interview!.path)}`, body, interview!.etag);
      else await create<Interview>("interviews", body);
      toast({ title: editing ? "Updated" : "Interview scheduled", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onEnterSubmit={() => { if (valid && !busy) void save(); }}>
        <DialogHeader><DialogTitle>{editing ? "Edit interview" : "Schedule an interview"}</DialogTitle></DialogHeader>
        {!editing && (
          <Field label="Application">
            <Combobox
              value={application}
              onValueChange={setApplication}
              options={apps.map((a) => ({ value: idOf(a.path), label: `${candName(a.path)} · ${reqName(a.path)}` }))}
              placeholder="Pick an active application"
              emptyText="No active applications to interview."
            />
          </Field>
        )}
        <FieldRow>
          <Field label="Round / title"><Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Technical round" /></Field>
          <Field label="Mode">
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{MODES.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Starts"><Input type="datetime-local" value={start} onChange={(e) => {
            const v = e.target.value;
            setStart(v);
            // Default a 1-hour slot so scheduling is one field, not two.
            if (v && !end) { const d = new Date(v); d.setHours(d.getHours() + 1); setEnd(toLocalInput(d.toISOString())); }
          }} /></Field>
          <Field label="Ends" error={endError}><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </FieldRow>
        <Field label="Location / link (optional)"><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room or meeting URL" /></Field>
        <Field label="Interview panel">
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
            {employees.map((e) => (
              <label key={e.path} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={panel.includes(idOf(e.path))} onChange={() => togglePanel(idOf(e.path))} />
                {`${e.first_name} ${e.last_name}`.trim()}
              </label>
            ))}
          </div>
        </Field>
        {interview && <ActivitySection resource={interview.path} className="border-t pt-3" />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>{editing ? "Save" : "Schedule"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScorecardDialog({ interview, me, criteria, empName, onClose }: {
  interview: Interview;
  me: Me;
  criteria: { key: string; label: string }[];
  empName: (ref: string) => string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [all, setAll] = useState<InterviewFeedback[]>([]);
  const [mine, setMine] = useState<InterviewFeedback | null>(null);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [overall, setOverall] = useState("");
  const [rec, setRec] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const overallError = overall !== "" && (Number(overall) < 1 || Number(overall) > 5) ? "Rate between 1 and 5." : undefined;

  useEffect(() => {
    get<ListResponse<InterviewFeedback>>(`interview-feedback?interview=interviews/${idOf(interview.path)}&max_page_size=200`)
      .then((r) => {
        const list = r.results ?? [];
        setAll(list);
        const own = list.find((f) => f.author && idOf(f.author) === me.employee_id) ?? null;
        setMine(own);
        if (own) { setRatings(own.ratings ?? {}); setOverall(own.overall_rating != null ? String(own.overall_rating) : ""); setRec(own.recommendation ?? ""); setComment(own.comment ?? ""); }
      })
      .catch(() => {});
  }, [interview, me.employee_id]);

  async function save() {
    setBusy(true);
    try {
      const body = {
        interview: `interviews/${idOf(interview.path)}`,
        ratings,
        overall_rating: overall ? Number(overall) : null,
        recommendation: rec || null,
        comment: comment.trim() || null,
      };
      if (mine) await patch(`interview-feedback/${idOf(mine.path)}`, body, mine.etag);
      else await create<InterviewFeedback>("interview-feedback", body);
      toast({ title: "Scorecard saved", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const others = all.filter((f) => f.path !== mine?.path);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onEnterSubmit={() => { if (!busy && !overallError) void save(); }}>
        <DialogHeader><DialogTitle>Scorecard · {interview.title}</DialogTitle></DialogHeader>

        {others.length > 0 && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other panelists</p>
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

        <p className="text-sm font-medium">Your evaluation</p>
        <div className="space-y-2">
          {criteria.map((c) => (
            <div key={c.key} className="flex items-center justify-between gap-2">
              <span className="text-sm">{c.label}</span>
              <Select value={ratings[c.key] != null ? String(ratings[c.key]) : ""} onValueChange={(v) => setRatings((r) => ({ ...r, [c.key]: Number(v) }))}>
                <SelectTrigger className="w-24"><SelectValue placeholder="–" /></SelectTrigger>
                <SelectContent>{[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <FieldRow>
          <Field label="Overall (1-5)" error={overallError}><Input type="number" min={1} max={5} value={overall} onChange={(e) => setOverall(e.target.value)} /></Field>
          <Field label="Recommendation">
            <Select value={rec} onValueChange={setRec}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{Object.entries(REC_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Comments"><Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={save} loading={busy} disabled={!!overallError}>Save scorecard</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
