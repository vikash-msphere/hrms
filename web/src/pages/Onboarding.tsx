import { useEffect, useMemo, useRef, useState } from "react";
import { UserPlus, UserMinus, Plus, Check, RotateCcw, ChevronRight, CheckCircle2, Circle, Trash2, Ban, ShieldCheck, Upload, FileDown } from "lucide-react";
import { get, create, patch, invoke, remove, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useIntent } from "@/lib/intent";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { DEFAULT_TRANSITION_TEMPLATES, type TransitionTemplate } from "@/lib/transitions";
import type { Employee, Transition, TransitionKind, TransitionTask, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { ActivitySection } from "@/components/common/ActivitySection";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

// Name for an employee ref, for the places a subject is shown rather than picked.
const employeeLabel = (employees: Employee[], ref: string) => {
  const e = employees.find((x) => idOf(x.path) === idOf(ref));
  return e ? `${e.first_name} ${e.last_name}` : "this employee";
};
const KIND: Record<TransitionKind, { label: string; icon: typeof UserPlus }> = {
  onboarding: { label: "Onboarding", icon: UserPlus },
  offboarding: { label: "Offboarding", icon: UserMinus },
};
const STATE: Record<Transition["state"], { label: string; variant: "secondary" | "success" | "muted" }> = {
  ACTIVE: { label: "Active", variant: "secondary" },
  COMPLETED: { label: "Completed", variant: "success" },
  CANCELLED: { label: "Cancelled", variant: "muted" },
};
const STATE_ORDER: Record<Transition["state"], number> = { ACTIVE: 0, COMPLETED: 1, CANCELLED: 2 };

export default function Onboarding({ me }: { me: Me }) {
  const { rows: transitions, state, error, reload } = useCollection<Transition>("transitions");
  const { rows: myTasks, reload: reloadTasks } = useCollection<TransitionTask>("transition-tasks");
  const { rows: employees, state: empState } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<TransitionTemplate[]>(DEFAULT_TRANSITION_TEMPLATES);
  // The start dialog, optionally pre-filled with who it is for and when they start (the pipeline hand-off
  // knows both). `fill` points it at a process that already exists but has no checklist yet, so choosing a
  // template lands its tasks on that row instead of opening a second one.
  const [starting, setStarting] = useState<{ employee?: string; anchor?: string; template?: string; fill?: Transition } | null>(null);
  // A transition to scroll to and ring, after arriving from somewhere that named a person.
  const [focus, setFocus] = useState<string | null>(null);
  // Key of the row an action is in flight for (task path, or `${transition path}:${verb}`) - drives the
  // clicked button's spinner and blocks double-fires.
  const [acting, setActing] = useState<string | null>(null);
  const reloadAll = () => { reload(); reloadTasks(); };

  useEffect(() => {
    getSetting<{ templates?: TransitionTemplate[] }>("transition-templates")
      .then((s) => { if (s.value?.templates?.length) setTemplates(s.value.templates); })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  // Arriving from a hired card on the pipeline board. It hands over the hire's employee ref (the application
  // records who it became), their email as a fallback for hires converted before that was stamped, and their
  // start date off the accepted offer. What happens next depends on what onboarding they already have:
  // a checklist that exists is opened and ringed, one opened without a template (a rule fired with no
  // template, or a template HR has since renamed) gets the dialog pointed at it so a template can be chosen,
  // and no process at all gets the start dialog filled in. Held in state rather than acted on inside the
  // handler because the intent fires on mount, before the collections have landed.
  type PendingHire = { employee?: string; email?: string; name?: string; startDate?: string };
  const [pendingHire, setPendingHire] = useState<PendingHire | null>(null);
  useIntent("onboard-hire", (arg) => setPendingHire((arg ?? {}) as PendingHire));
  useEffect(() => {
    if (!pendingHire || state === "loading" || empState === "loading") return;
    const { employee, email, name, startDate } = pendingHire;
    setPendingHire(null);
    const emp = employee
      ? employees.find((e) => idOf(e.path) === idOf(employee))
      : email
        ? employees.find((e) => e.work_email?.toLowerCase() === email.toLowerCase())
        : undefined;
    // The ref is authoritative even when the employee list didn't include them (it is one page of rows).
    const ref = employee ?? (emp ? `employees/${idOf(emp.path)}` : null);
    if (!ref) {
      toast({
        title: `${name ?? "This hire"} has no employee record yet`,
        description: "Hiring them from the pipeline board creates it, and onboarding opens from there.",
        variant: "destructive",
      });
      return;
    }
    const anchor = startDate || emp?.start_date || todayStr();
    const template = templates.find((t) => t.kind === "onboarding")?.id;
    const live = transitions.find((t) => t.kind === "onboarding" && t.state === "ACTIVE" && t.employee && idOf(t.employee) === idOf(ref));
    if (live && (live.task_count ?? live.tasks?.length ?? 0) > 0) {
      setFocus(live.path);
      // The ring is a "here it is" flash, not a permanent mark on the row.
      setTimeout(() => setFocus((f) => (f === live.path ? null : f)), 2500);
    } else {
      setStarting({ employee: ref, anchor: live?.anchor_date || anchor, template, fill: live });
    }
  }, [pendingHire, state, empState, employees, transitions, templates, toast]);

  const openTasks = useMemo(() => myTasks.filter((t) => t.status === "TODO"), [myTasks]);
  // Active processes first so the ones needing attention aren't buried under finished history.
  const sorted = useMemo(() => [...transitions].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]), [transitions]);

  async function taskAct(t: { path: string }, verb: string, body?: Record<string, unknown>) {
    if (acting) return;
    setActing(t.path);
    try { await invoke(`transition-tasks/${idOf(t.path)}`, verb, undefined, body); reloadAll(); }
    catch (e) { toast({ title: "Couldn't update task", description: (e as Error).message, variant: "destructive" }); }
    finally { setActing(null); }
  }
  async function uploadTaskDoc(t: TransitionTask, file: File) {
    if (acting) return;
    setActing(t.path);
    try { await upload(`transition-tasks/${idOf(t.path)}`, file, { verb: "upload" }); toast({ title: "Document uploaded", variant: "success" }); reloadAll(); }
    catch (e) { toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" }); }
    finally { setActing(null); }
  }
  async function viewTaskDoc(t: TransitionTask) {
    if (!t.document) return;
    try { await download(`personal-documents/${idOf(t.document)}`, t.title); }
    catch (e) { toast({ title: "Couldn't open", description: (e as Error).message, variant: "destructive" }); }
  }
  async function transitionAct(tr: Transition, verb: string, body?: Record<string, unknown>) {
    // Completing an offboarding terminates the employee + disables their login - confirm first.
    if (verb === "complete" && tr.kind === "offboarding" && !(await confirm({ title: "Complete offboarding?", description: `This marks ${empName(tr.employee)} as terminated and disables their login.`, destructive: true, confirmLabel: "Complete" }))) return;
    if (acting) return;
    setActing(`${tr.path}:${verb}`);
    try { await invoke(`transitions/${idOf(tr.path)}`, verb, undefined, body); reloadAll(); }
    catch (e) { toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" }); }
    finally { setActing(null); }
  }
  async function del(tr: Transition) {
    if (!(await confirm({ title: `Delete the "${tr.name}" process?`, description: `For ${empName(tr.employee)}.`, destructive: true, confirmLabel: "Delete" }))) return;
    if (acting) return;
    setActing(`${tr.path}:delete`);
    try { await remove(`transitions/${idOf(tr.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
    finally { setActing(null); }
  }

  const startBtn = (
    <AccessAction collection="transitions" create label="Start a process">
      <Button onClick={() => setStarting({})}><Plus className="h-4 w-4" /> Start process</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Onboarding & Offboarding" description="Run onboarding and offboarding checklists. Track each task to done." actions={<>{startBtn}<PageSettings me={me} host="transitions" /></>} />

      {openTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">Your tasks</h2>
          <div className="space-y-2">
            {openTasks.map((t) => {
              const overdue = !!t.due_date && t.due_date < todayStr();
              return (
                <Card key={t.path} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="font-medium">{t.title}{t.doc_type && <Badge variant="secondary" className="ml-2 gap-1 align-middle"><Upload className="h-3 w-3" /> {t.doc_type}</Badge>}</p>
                    <p className="text-xs text-muted-foreground">for {empName(t.subject)}{t.due_date && <span className={cn("tabular-nums", overdue && "font-medium text-destructive")}> · due {formatDate(t.due_date)}{overdue ? " · overdue" : ""}</span>}</p>
                  </div>
                  {t.doc_type
                    ? <AccessAction collection="transition-tasks" objectPath={t.path} can={t.access?.can} verb="upload" label="Upload task document"><UploadButton label="Upload file" busy={acting === t.path} onPick={(f) => uploadTaskDoc(t, f)} /></AccessAction>
                    : <AccessAction collection="transition-tasks" objectPath={t.path} can={t.access?.can} verb="complete" label="Complete task"><Button size="sm" loading={acting === t.path} onClick={() => taskAct(t, "complete")}><Check className="h-3.5 w-3.5" /> Mark done</Button></AccessAction>}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {transitions.length === 0 ? (
          <EmptyState illustration="onboarding" icon={UserPlus} title="No processes yet" description="Start an onboarding or offboarding to track its checklist here." action={startBtn} />
        ) : (
          <div className="space-y-3">
            {sorted.map((tr) => (
              <TransitionCard key={tr.path} transition={tr} focus={focus === tr.path} subjectName={empName(tr.employee)} empName={empName} acting={acting} onTask={taskAct} onTransition={transitionAct} onDelete={() => del(tr)} onAddTask={(body) => transitionAct(tr, "appendTask", body)} onUpload={uploadTaskDoc} onViewDoc={viewTaskDoc} />
            ))}
          </div>
        )}
      </DataState>

      {starting && (
        <StartDialog
          employees={employees}
          templates={templates}
          existing={transitions}
          initialEmployee={starting.employee}
          initialAnchor={starting.anchor}
          initialTemplate={starting.template}
          fill={starting.fill}
          onClose={() => setStarting(null)}
          onStarted={() => { setStarting(null); toast({ title: starting.fill ? "Checklist added" : "Process started", variant: "success" }); reload(); }}
        />
      )}
    </div>
  );
}

function TransitionCard({ transition: tr, focus, subjectName, empName, acting, onTask, onTransition, onDelete, onAddTask, onUpload, onViewDoc }: {
  transition: Transition;
  /** Arrived here for this process: open it, scroll it into view and ring it. */
  focus?: boolean;
  subjectName: string;
  empName: (ref?: string) => string;
  acting: string | null;
  onTask: (t: { path: string }, verb: string) => void;
  onTransition: (tr: Transition, verb: string) => void;
  onDelete: () => void;
  onAddTask: (body: Record<string, unknown>) => void;
  onUpload: (t: TransitionTask, file: File) => void;
  onViewDoc: (t: TransitionTask) => void;
}) {
  // Active processes open expanded - the checklist IS the page's point; finished ones stay collapsed history.
  const [open, setOpen] = useState(tr.state === "ACTIVE");
  const [newTask, setNewTask] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus]);
  const can = tr.access?.can ?? [];
  const canManage = can.includes("appendTask") || can.includes("update");
  const k = KIND[tr.kind];
  const tasks = tr.tasks ?? [];
  const done = tr.done_count ?? 0;
  const total = tr.task_count ?? tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const overdueCount = tr.state === "ACTIVE" ? tasks.filter((t) => t.status !== "DONE" && !!t.due_date && t.due_date < todayStr()).length : 0;

  return (
    <Card ref={cardRef} id={`transition-${idOf(tr.path)}`} className={cn("overflow-hidden transition-shadow", focus && "ring-2 ring-primary")}>
      {/* A real <button>, not a clickable div: this is the only way to open a transition's task list, and as
          a div it had no keyboard route in at all (no role, no tab stop, no Enter/Space) and announced
          nothing about being expandable. Nothing inside it is interactive, so a button is safe to wrap it. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <k.icon className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{subjectName}</span>
            <Badge variant="muted">{k.label}</Badge>
            <Badge variant={STATE[tr.state].variant}>{STATE[tr.state].label}</Badge>
            {overdueCount > 0 && <Badge variant="destructive">{overdueCount} overdue</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{tr.name}{tr.anchor_date && <span className="tabular-nums"> · {tr.kind === "onboarding" ? "starts" : "last day"} {formatDate(tr.anchor_date)}</span>}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Progress goes green once every task is done - "finished" reads at a glance. */}
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", total > 0 && done === total ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
          <span className="text-xs tabular-nums text-muted-foreground">{done}/{total}</span>
        </div>
      </button>

      {open && (
        // The header is a sibling button now rather than an ancestor, so nothing here has a click to swallow.
        <div className="border-t bg-muted/20 p-4">
          <div className="space-y-1.5">
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks.</p>
            ) : tasks.map((t) => {
              const isDone = t.status === "DONE";
              const overdue = !isDone && !!t.due_date && t.due_date < todayStr();
              return (
                // Wraps, and the title carries a real basis rather than `flex-1`'s zero one: a task can trail
                // a verification badge, a document-type badge, a view link and an upload button, and flex
                // line-breaking reads the basis - a zero-basis title never triggers the break it needs.
                <div key={t.path} className="flex flex-wrap items-center gap-2 rounded-md bg-background px-3 py-2 text-sm">
                  {canManage ? (
                    <button type="button" disabled={acting === t.path} onClick={() => onTask(t, isDone ? "reopen" : "complete")} className={cn("shrink-0 disabled:opacity-50", isDone ? "text-success" : "text-muted-foreground hover:text-foreground")} aria-label={isDone ? "Reopen" : "Mark done"}>
                      {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                    </button>
                  ) : (
                    isDone ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn("min-w-0 flex-1 basis-40", isDone && "text-muted-foreground line-through")}>{t.title}</span>
                  {t.background_check && <Badge variant="secondary" className="shrink-0 gap-1" title="Tracked as a background-verification check"><ShieldCheck className="h-3 w-3" /> Verification</Badge>}
                  {t.doc_type && !t.document && <Badge variant="outline" className="shrink-0 gap-1" title="Document collection task"><Upload className="h-3 w-3" /> {t.doc_type}</Badge>}
                  {t.document && <button type="button" onClick={() => onViewDoc(t)} className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline" title="View uploaded document"><FileDown className="h-3.5 w-3.5" /> {t.doc_type ?? "Document"}</button>}
                  {canManage && t.doc_type && !t.document && <UploadButton label="Upload" small busy={acting === t.path} onPick={(f) => onUpload(t, f)} />}
                  <span className="shrink-0 text-xs text-muted-foreground">{empName(t.assignee)}{t.due_date && <span className={cn("tabular-nums", overdue && "font-medium text-destructive")}> · {formatDate(t.due_date)}{overdue ? " · overdue" : ""}</span>}</span>
                </div>
              );
            })}
          </div>

          {canManage && tr.state === "ACTIVE" && (
            <div className="mt-2 flex items-center gap-2">
              <Input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="Add a task…" className="h-8" onKeyDown={(e) => { if (e.key === "Enter" && newTask.trim()) { onAddTask({ title: newTask.trim() }); setNewTask(""); } }} />
              <Button size="sm" variant="outline" disabled={!newTask.trim()} loading={acting === `${tr.path}:appendTask`} onClick={() => { onAddTask({ title: newTask.trim() }); setNewTask(""); }}><Plus className="h-3.5 w-3.5" /> Add</Button>
            </div>
          )}

          {canManage && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              {tr.state === "ACTIVE" && can.includes("complete") && <AccessAction collection="transitions" objectPath={tr.path} verb="complete" can={can} label="Complete process"><Button size="sm" variant="outline" loading={acting === `${tr.path}:complete`} onClick={() => onTransition(tr, "complete")}><Check className="h-3.5 w-3.5" /> Complete</Button></AccessAction>}
              {tr.state === "ACTIVE" && can.includes("cancel") && <AccessAction collection="transitions" objectPath={tr.path} verb="cancel" can={can} label="Cancel process"><Button size="sm" variant="outline" loading={acting === `${tr.path}:cancel`} onClick={() => onTransition(tr, "cancel")}><Ban className="h-3.5 w-3.5" /> Cancel</Button></AccessAction>}
              {tr.state !== "ACTIVE" && can.includes("reopen") && <AccessAction collection="transitions" objectPath={tr.path} verb="reopen" can={can} label="Reopen process"><Button size="sm" variant="outline" loading={acting === `${tr.path}:reopen`} onClick={() => onTransition(tr, "reopen")}><RotateCcw className="h-3.5 w-3.5" /> Reopen</Button></AccessAction>}
              {can.includes("delete") && <Button size="sm" variant="ghost" className="text-destructive" loading={acting === `${tr.path}:delete`} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>}
            </div>
          )}
          {/* The transition's own edits, and beneath it the whole departure/arrival: its tasks and the notice
              period, which are separate records with separate trails. */}
          <ActivitySection resource={tr.path} className="mt-3 border-t pt-3" label="Changes to this transition" />
          <ActivitySection caseRoot={tr.path} label={`The whole ${tr.kind}`} />
        </div>
      )}
    </Card>
  );
}

// Start an onboarding/offboarding: pick the employee, kind, a template, and the anchor date.
//
// The same dialog fills in a process that already exists with an empty checklist (`fill`) - the hire hand-off
// lands here when a rule opened onboarding without a template. Then the subject and kind are settled, the
// only questions left are which template and which date, and Save patches that row rather than making a
// second one.
function StartDialog({ employees, templates, existing, initialEmployee, initialAnchor, initialTemplate, fill, onClose, onStarted }: {
  employees: Employee[];
  templates: TransitionTemplate[];
  // Processes already on file, so an employee who is mid-onboarding isn't quietly given a second checklist.
  existing: Transition[];
  /** Pre-picked subject, when the caller already knows who this is for (e.g. a hire off the pipeline board). */
  initialEmployee?: string;
  /** Pre-filled anchor date - a hire's start date off their accepted offer. */
  initialAnchor?: string;
  /** Pre-picked template, so the common case is one click. */
  initialTemplate?: string;
  /** An existing, checklist-less process to fill in instead of creating a new one. */
  fill?: Transition;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [employee, setEmployee] = useState(initialEmployee ?? "");
  const [kind, setKind] = useState<TransitionKind>(fill?.kind ?? "onboarding");
  const [template, setTemplate] = useState(initialTemplate ?? "");
  const [anchor, setAnchor] = useState(initialAnchor ?? todayStr());
  const kindTemplates = templates.filter((t) => t.kind === kind);
  const chosen = kindTemplates.find((t) => t.id === template);
  // Only a warning worth showing when this dialog would create a second process.
  const active = !fill && employee ? existing.find((t) => t.state === "ACTIVE" && t.kind === kind && t.employee && idOf(t.employee) === idOf(employee)) : undefined;

  async function start() {
    if (fill) await patch(`transitions/${idOf(fill.path)}`, { template, anchor_date: anchor || null });
    else await create("transitions", { employee, kind, template: template || undefined, anchor_date: anchor || undefined });
    onStarted();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={fill ? "Set up this checklist" : "Start a process"}
      description={fill
        ? "This process was opened without a template, so it has no tasks yet. Choose one and its tasks are created, dated from the day below."
        : "Creates a dated checklist and assigns each task to whoever owns it. People are notified about the tasks that land on them."}
      collection="transitions"
      objectPath={fill?.path}
      guardLabel="process"
      form={{ employee, kind, template, anchor }}
      submitLabel={fill ? "Add checklist" : "Start"}
      canSubmit={fill ? !!template : !!employee}
      whyNot={fill ? "Choose a template." : "Choose who this process is for."}
      onSubmit={start}
    >
        {/* Filling in an existing process: who and which kind are already settled, so they read, not edit. */}
        {fill ? (
          <Field label="Process">
            <p className="text-sm">
              {KIND[kind].label} for <span className="font-medium">{employeeLabel(employees, employee)}</span>
            </p>
          </Field>
        ) : (
          <>
            <Field label="Type">
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={kind === "onboarding" ? "default" : "outline"} onClick={() => { setKind("onboarding"); setTemplate(""); }}><UserPlus className="h-4 w-4" /> Onboarding</Button>
                <Button type="button" size="sm" variant={kind === "offboarding" ? "default" : "outline"} onClick={() => { setKind("offboarding"); setTemplate(""); }}><UserMinus className="h-4 w-4" /> Offboarding</Button>
              </div>
            </Field>
            <Field label="Employee">
              <Combobox
                value={employee}
                onValueChange={setEmployee}
                placeholder="Choose an employee…"
                searchPlaceholder="Search employees…"
                options={employees.map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
              />
            </Field>
          </>
        )}
        <Field label="Template" hint={chosen ? `${chosen.tasks.length} task${chosen.tasks.length === 1 ? "" : "s"} will be created.` : fill ? "Pick the checklist this process should run." : "Without one you get an empty checklist to fill in yourself."}>
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger><SelectValue placeholder={fill ? "Choose a template…" : "No template (empty checklist)"} /></SelectTrigger>
            <SelectContent>
              {kindTemplates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.tasks.length} tasks)</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={kind === "onboarding" ? "Start date" : "Last working day"}
          hint={kind === "onboarding" ? "Task due dates are offset from this day." : "Tasks are due relative to this day, and completing the process terminates them."}
        >
          <Input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
        </Field>
        {active && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            This person already has an active {KIND[kind].label.toLowerCase()} in progress. Starting another gives them two checklists to work through.
          </p>
        )}
    </WriteDialog>
  );
}

// A button that opens the file picker and hands the chosen file to onPick (resets so the same file can re-upload).
function UploadButton({ label, onPick, small, busy }: { label: string; onPick: (f: File) => void; small?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
      <Button size="sm" variant="outline" loading={busy} className={cn("shrink-0", small && "h-7 px-2 text-xs")} onClick={() => ref.current?.click()}><Upload className="h-3.5 w-3.5" /> {label}</Button>
    </>
  );
}
