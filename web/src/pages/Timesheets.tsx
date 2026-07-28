import { useCallback, useEffect, useMemo, useState } from "react";
import { Timer, ChevronLeft, ChevronRight, Plus, Send, Check, X } from "lucide-react";
import { get, create, patch, remove, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { Employee, Me, Project, TimeEntry, TimeEntryStatus } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const DAY = 86_400_000;
// Local calendar date - toISOString() would shift local midnight into the previous UTC day
// (in IST the whole week grid would be labeled one day off).
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(d: Date) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x;
}
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayNum = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(2).replace(/0$/, ""));

// Per-status cell styling so the grid itself shows where each entry is in draft → submitted → approved.
// Draft stays neutral (editable); rejected stays editable so it can be fixed and resubmitted.
const CELL: Record<TimeEntryStatus, string> = {
  DRAFT: "",
  SUBMITTED: "bg-muted/50 text-muted-foreground",
  APPROVED: "bg-success/10 text-success",
  REJECTED: "bg-destructive/10 text-destructive hover:bg-destructive/15",
};
const LEGEND: { status: TimeEntryStatus; label: string; swatch: string }[] = [
  { status: "DRAFT", label: "Draft", swatch: "border bg-card" },
  { status: "SUBMITTED", label: "Submitted", swatch: "bg-muted" },
  { status: "APPROVED", label: "Approved", swatch: "bg-success/30" },
  { status: "REJECTED", label: "Rejected", swatch: "bg-destructive/30" },
];

export default function Timesheets({ me }: { me: Me }) {
  const { rows: projects, state: projectsState } = useCollection<Project>("projects");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null); // "<path>|<verb>" of the in-flight decision
  const canApprove = usePermission("time-entries.approve");
  const meRef = me.employee_id ? `employees/${me.employee_id}` : "";

  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymd(new Date(+weekStart + i * DAY))), [weekStart]);
  const [mine, setMine] = useState<TimeEntry[]>([]);
  const [weekLoaded, setWeekLoaded] = useState(false);
  const [pending, setPending] = useState<TimeEntry[]>([]);
  const [extraProjects, setExtraProjects] = useState<string[]>([]); // project ids added to the grid this week
  const [cell, setCell] = useState<{ projectId: string; date: string; existing?: TimeEntry } | null>(null);

  const activeProjects = useMemo(() => projects.filter((p) => p.status !== "archived"), [projects]);
  const projectById = useMemo(() => new Map(projects.map((p) => [idOf(p.path), p])), [projects]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  const loadWeek = useCallback(async () => {
    if (!meRef) { setWeekLoaded(true); return; }
    try {
      const r = await get<{ results: TimeEntry[] }>(`time-entries?employee=${encodeURIComponent(meRef)}&from=${days[0]}&to=${days[6]}&max_page_size=500`);
      setMine(r.results ?? []);
    } catch (e) { toast({ title: "Couldn't load the week's entries", description: (e as Error).message, variant: "destructive" }); }
    finally { setWeekLoaded(true); }
  }, [meRef, days[0], days[6]]);
  const loadPending = useCallback(async () => {
    if (!canApprove) return;
    try { const r = await get<{ results: TimeEntry[] }>(`time-entries?status=SUBMITTED&max_page_size=200`); setPending((r.results ?? []).filter((e) => idOf(e.employee ?? "") !== me.employee_id)); }
    catch { setPending([]); }
  }, [canApprove, me.employee_id]);
  useEffect(() => { void loadWeek(); }, [loadWeek]);
  useEffect(() => { void loadPending(); }, [loadPending]);

  // (projectId|date) -> entry (one cell = one entry; new logs create one).
  const byCell = useMemo(() => {
    const m = new Map<string, TimeEntry>();
    for (const e of mine) if (e.project && e.date) m.set(`${idOf(e.project)}|${e.date}`, e);
    return m;
  }, [mine]);
  const gridProjects = useMemo(() => {
    const ids = new Set<string>([...mine.map((e) => idOf(e.project ?? "")), ...extraProjects].filter(Boolean));
    return [...ids].map((id) => projectById.get(id)).filter(Boolean) as Project[];
  }, [mine, extraProjects, projectById]);

  const dayTotal = (d: string) => mine.filter((e) => e.date === d).reduce((s, e) => s + e.hours, 0);
  const weekTotal = mine.reduce((s, e) => s + e.hours, 0);
  const draftCount = mine.filter((e) => e.status === "DRAFT" || e.status === "REJECTED").length;

  async function submitWeek() {
    const toSubmit = mine.filter((e) => e.status === "DRAFT" || e.status === "REJECTED");
    setSubmitting(true);
    try {
      for (const e of toSubmit) await invoke(`time-entries/${idOf(e.path)}`, "submit");
      toast({ title: `Submitted ${toSubmit.length} ${toSubmit.length === 1 ? "entry" : "entries"}`, variant: "success" });
      loadWeek();
    } catch (e) { toast({ title: "Couldn't submit", description: (e as Error).message, variant: "destructive" }); }
    finally { setSubmitting(false); }
  }
  async function decide(e: TimeEntry, verb: "approve" | "reject") {
    setDeciding(`${e.path}|${verb}`);
    try {
      await invoke(`time-entries/${idOf(e.path)}`, verb);
      toast({ title: verb === "approve" ? "Entry approved" : "Entry rejected", variant: "success" });
      loadPending(); loadWeek();
    } catch (err) { toast({ title: verb === "approve" ? "Couldn't approve the entry" : "Couldn't reject the entry", description: (err as Error).message, variant: "destructive" }); }
    finally { setDeciding(null); }
  }

  return (
    <div>
      <PageHeader title="Timesheets" actions={<PageSettings me={me} host="timesheets" />} />

      {canApprove && pending.length > 0 && (
        <Card className="mb-6 p-4">
          <h2 className="mb-2 text-sm font-semibold">Awaiting your approval ({pending.length})</h2>
          <div className="space-y-2">
            {pending.map((e) => (
              <div key={e.path} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span><span className="font-medium">{empName(e.employee)}</span> · {projectById.get(idOf(e.project ?? ""))?.name ?? "Project"} · <span className="tabular-nums">{fmt(e.hours)}h</span> · {formatDate(e.date)}{e.description ? ` · ${e.description}` : ""}</span>
                <span className="flex gap-1">
                  <Button size="sm" variant="outline" loading={deciding === `${e.path}|approve`} disabled={deciding === `${e.path}|reject`} onClick={() => decide(e, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" loading={deciding === `${e.path}|reject`} disabled={deciding === `${e.path}|approve`} onClick={() => decide(e, "reject")}><X className="h-3.5 w-3.5" /> Reject</Button>
                  <RowActivityButton resource={e.path} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w - 7 * DAY))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="min-w-[12rem] text-center text-sm font-medium tabular-nums">{dayNum(days[0])} - {dayNum(days[6])}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w + 7 * DAY))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>
        <span className="ml-auto text-sm text-muted-foreground">Week total <span className="font-semibold tabular-nums text-foreground">{fmt(weekTotal)}h</span></span>
        {draftCount > 0 && <Button size="sm" onClick={submitWeek} loading={submitting}><Send className="h-3.5 w-3.5" /> Submit week ({draftCount})</Button>}
      </div>

      {!weekLoaded || projectsState === "loading" ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : gridProjects.length === 0 && activeProjects.length === 0 ? (
        <EmptyState icon={Timer} title="No projects" description="Ask HR to add projects in Settings → Payroll → Projects before logging time." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">Project</th>
                  {days.map((d, i) => (
                    <th key={d} className={cn("px-2 py-2 text-center font-medium", d === ymd(new Date()) && "text-primary")}>
                      <div>{WEEKDAY[i]}</div><div className="text-xs font-normal tabular-nums text-muted-foreground">{new Date(d + "T00:00:00").getDate()}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridProjects.map((p) => (
                  <tr key={p.path} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 whitespace-nowrap border-r bg-card px-3 py-2 font-medium">{p.name}{p.client ? <span className="ml-1 text-xs text-muted-foreground">· {p.client}</span> : null}</td>
                    {days.map((d) => {
                      const e = byCell.get(`${idOf(p.path)}|${d}`);
                      const locked = e && (e.status === "SUBMITTED" || e.status === "APPROVED");
                      return (
                        <td key={d} className="border-r p-1 last:border-0 text-center align-middle">
                          <button type="button" disabled={!!locked} onClick={() => setCell({ projectId: idOf(p.path), date: d, existing: e })}
                            className={cn("h-10 w-full rounded-md text-sm tabular-nums transition-colors", e ? "font-medium" : "text-muted-foreground", locked ? "cursor-default" : "hover:bg-muted/50", e && CELL[e.status])}>
                            {e ? `${fmt(e.hours)}h` : "·"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t bg-muted/20">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-2">
                    <AddProjectRow projects={activeProjects.filter((p) => !gridProjects.some((g) => g.path === p.path))} onAdd={(id) => setExtraProjects((x) => [...x, id])} />
                  </td>
                  {days.map((d) => <td key={d} className="px-2 py-2 text-center text-xs font-medium tabular-nums text-muted-foreground">{dayTotal(d) ? `${fmt(dayTotal(d))}h` : ""}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
          {/* Legend: what the cell tints mean (draft/rejected stay editable; submitted/approved are locked). */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {LEGEND.map((l) => (
              <span key={l.status} className="inline-flex items-center gap-1.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", l.swatch)} />
                {l.label}
              </span>
            ))}
          </div>
        </>
      )}

      {cell && (
        <LogDialog
          project={projectById.get(cell.projectId)!}
          date={cell.date}
          existing={cell.existing}
          onClose={() => setCell(null)}
          onSave={async (hours, description) => {
            try {
              if (cell.existing) await patch(`time-entries/${idOf(cell.existing.path)}`, { hours, description: description || null }, cell.existing.etag);
              else await create("time-entries", { project: `projects/${cell.projectId}`, date: cell.date, hours, description: description || undefined, billable: projectById.get(cell.projectId)?.billable ?? true });
              setCell(null); loadWeek();
            } catch (e) { toast({ title: "Couldn't save the entry", description: (e as Error).message, variant: "destructive" }); }
          }}
          onRemove={cell.existing ? async () => {
            try { await remove(`time-entries/${idOf(cell.existing!.path)}`); setCell(null); loadWeek(); }
            catch (e) { toast({ title: "Couldn't remove the entry", description: (e as Error).message, variant: "destructive" }); }
          } : undefined}
        />
      )}
    </div>
  );
}

function AddProjectRow({ projects, onAdd }: { projects: Project[]; onAdd: (id: string) => void }) {
  const [v, setV] = useState("");
  if (projects.length === 0) return <span className="text-xs text-muted-foreground">All projects added</span>;
  return (
    <Select value={v} onValueChange={(id) => { onAdd(id); setV(""); }}>
      <SelectTrigger className="h-8 w-56"><span className="flex items-center gap-1.5 text-sm"><Plus className="h-3.5 w-3.5" /> Add project</span></SelectTrigger>
      <SelectContent>{projects.map((p) => <SelectItem key={p.path} value={idOf(p.path)}>{p.name}{p.client ? ` · ${p.client}` : ""}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function LogDialog({ project, date, existing, onClose, onSave, onRemove }: {
  project: Project;
  date: string;
  existing?: TimeEntry;
  onClose: () => void;
  onSave: (hours: number, description: string) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [hours, setHours] = useState(existing ? String(existing.hours) : "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const busy = saving || removing;
  const n = Number(hours);
  const valid = hours.trim() !== "" && !Number.isNaN(n) && n > 0 && n <= 24;
  const save = async () => { setSaving(true); try { await onSave(n, description.trim()); } finally { setSaving(false); } };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && valid) save(); }}>
        <DialogHeader><DialogTitle>Log time</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{project.name}</span> · {dayNum(date)}{existing ? <> · <StatusBadge state={existing.status} /></> : null}</p>
        <Field label="Hours" error={hours.trim() !== "" && !valid ? "Enter between 0 and 24 hours." : undefined}>
          <Input type="number" min={0} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} autoFocus />
        </Field>
        <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" /></Field>
        <DialogFooter className="items-center">
          {onRemove && (
            <Button variant="ghost" size="sm" className="mr-auto text-destructive" loading={removing} disabled={saving}
              onClick={async () => { setRemoving(true); try { await onRemove(); } finally { setRemoving(false); } }}>
              Remove
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!valid || removing}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
