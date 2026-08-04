import { useEffect, useMemo, useRef, useState } from "react";
import { UserPlus, UserMinus, Plus, Check, RotateCcw, ChevronRight, CheckCircle2, Circle, Trash2, X, Ban, ShieldCheck, Upload, FileDown } from "lucide-react";
import { get, create, invoke, remove, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const todayStr = () => new Date().toISOString().slice(0, 10);
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
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<TransitionTemplate[]>(DEFAULT_TRANSITION_TEMPLATES);
  const [starting, setStarting] = useState(false);
  // Key of the row an action is in flight for (task path, or `${transition path}:${verb}`) - drives the
  // clicked button's spinner and blocks double-fires.
  const [acting, setActing] = useState<string | null>(null);
  const reloadAll = () => { reload(); reloadTasks(); };

  useEffect(() => {
    get<{ value?: { templates?: TransitionTemplate[] } }>("settings/transition-templates")
      .then((s) => { if (s.value?.templates?.length) setTemplates(s.value.templates); })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

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
      <Button onClick={() => setStarting(true)}><Plus className="h-4 w-4" /> Start process</Button>
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
                    ? <AccessAction collection="transition-tasks" objectPath={t.path} verb="upload" label="Upload task document"><UploadButton label="Upload file" busy={acting === t.path} onPick={(f) => uploadTaskDoc(t, f)} /></AccessAction>
                    : <AccessAction collection="transition-tasks" objectPath={t.path} verb="complete" label="Complete task"><Button size="sm" loading={acting === t.path} onClick={() => taskAct(t, "complete")}><Check className="h-3.5 w-3.5" /> Mark done</Button></AccessAction>}
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
              <TransitionCard key={tr.path} transition={tr} subjectName={empName(tr.employee)} empName={empName} acting={acting} onTask={taskAct} onTransition={transitionAct} onDelete={() => del(tr)} onAddTask={(body) => transitionAct(tr, "appendTask", body)} onUpload={uploadTaskDoc} onViewDoc={viewTaskDoc} />
            ))}
          </div>
        )}
      </DataState>

      {starting && <StartDialog employees={employees} templates={templates} onClose={() => setStarting(false)} onStarted={() => { setStarting(false); toast({ title: "Process started", variant: "success" }); reload(); }} toastErr={(m) => toast({ title: "Couldn't start", description: m, variant: "destructive" })} />}
    </div>
  );
}

function TransitionCard({ transition: tr, subjectName, empName, acting, onTask, onTransition, onDelete, onAddTask, onUpload, onViewDoc }: {
  transition: Transition;
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
  const can = tr.access?.can ?? [];
  const canManage = can.includes("appendTask") || can.includes("update");
  const k = KIND[tr.kind];
  const tasks = tr.tasks ?? [];
  const done = tr.done_count ?? 0;
  const total = tr.task_count ?? tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const overdueCount = tr.state === "ACTIVE" ? tasks.filter((t) => t.status !== "DONE" && !!t.due_date && t.due_date < todayStr()).length : 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex cursor-pointer flex-wrap items-center gap-3 p-4 hover:bg-muted/30" onClick={() => setOpen((o) => !o)}>
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
      </div>

      {open && (
        <div className="border-t bg-muted/20 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="space-y-1.5">
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks.</p>
            ) : tasks.map((t) => {
              const isDone = t.status === "DONE";
              const overdue = !isDone && !!t.due_date && t.due_date < todayStr();
              return (
                <div key={t.path} className="flex items-center gap-2 rounded-md bg-background px-3 py-2 text-sm">
                  {canManage ? (
                    <button type="button" disabled={acting === t.path} onClick={() => onTask(t, isDone ? "reopen" : "complete")} className={cn("shrink-0 disabled:opacity-50", isDone ? "text-success" : "text-muted-foreground hover:text-foreground")} aria-label={isDone ? "Reopen" : "Mark done"}>
                      {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                    </button>
                  ) : (
                    isDone ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn("min-w-0 flex-1", isDone && "text-muted-foreground line-through")}>{t.title}</span>
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
          <ActivitySection resource={tr.path} className="mt-3 border-t pt-3" />
        </div>
      )}
    </Card>
  );
}

// Start an onboarding/offboarding: pick the employee, kind, a template, and the anchor date.
function StartDialog({ employees, templates, onClose, onStarted, toastErr }: {
  employees: Employee[];
  templates: TransitionTemplate[];
  onClose: () => void;
  onStarted: () => void;
  toastErr: (msg: string) => void;
}) {
  const [employee, setEmployee] = useState("");
  const [kind, setKind] = useState<TransitionKind>("onboarding");
  const [template, setTemplate] = useState("");
  const [anchor, setAnchor] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const kindTemplates = templates.filter((t) => t.kind === kind);

  async function start() {
    setBusy(true);
    try {
      await create("transitions", { employee, kind, template: template || undefined, anchor_date: anchor || undefined });
      onStarted();
    } catch (e) {
      toastErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && employee) start(); }}>
        <DialogHeader><DialogTitle>Start a process</DialogTitle></DialogHeader>
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
        <Field label="Template">
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger><SelectValue placeholder="No template (empty checklist)" /></SelectTrigger>
            <SelectContent>
              {kindTemplates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.tasks.length} tasks)</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={kind === "onboarding" ? "Start date" : "Last working day"}>
          <Input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button onClick={start} loading={busy} disabled={!employee}>Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
