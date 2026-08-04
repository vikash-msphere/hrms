import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Rocket, UserPlus, Lock, Unlock, BarChart3, Loader2 } from "lucide-react";
import { create, patch, invoke, remove, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Review, ReviewCycle } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const STATE: Record<ReviewCycle["state"], { label: string; variant: "muted" | "secondary" | "success" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  ACTIVE: { label: "Active", variant: "secondary" },
  CLOSED: { label: "Closed", variant: "success" },
};
const EMPTY = { name: "", period_start: "", period_end: "", self_due_date: "", manager_due_date: "" };

export default function ReviewCycles({ embedded }: { embedded?: boolean }) {
  const { rows, state, error, reload } = useCollection<ReviewCycle>("review-cycles");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewCycle | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [picker, setPicker] = useState<{ cycle: ReviewCycle; mode: "launch" | "enroll" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState<string | null>(null); // cycle path whose calibration panel is open

  const sorted = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);
  const badRange = !!form.period_start && !!form.period_end && form.period_end < form.period_start;

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(c: ReviewCycle) {
    setEditing(c);
    setForm({ name: c.name, period_start: c.period_start ?? "", period_end: c.period_end ?? "", self_due_date: c.self_due_date ?? "", manager_due_date: c.manager_due_date ?? "" });
    setOpen(true);
  }

  async function submit() {
    const body = {
      name: form.name.trim(),
      period_start: form.period_start || null,
      period_end: form.period_end || null,
      self_due_date: form.self_due_date || null,
      manager_due_date: form.manager_due_date || null,
    };
    setBusy(true);
    try {
      if (editing) await patch(`review-cycles/${idOf(editing.path)}`, body, editing.etag);
      else await create("review-cycles", body);
      toast({ title: editing ? "Cycle updated" : "Cycle created", variant: "success" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function runVerb(c: ReviewCycle, verb: string, body?: Record<string, unknown>, okMsg?: string) {
    try {
      await invoke(`review-cycles/${idOf(c.path)}`, verb, undefined, body);
      if (okMsg) toast({ title: okMsg, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function del(c: ReviewCycle) {
    if (!(await confirm({ title: `Delete the "${c.name}" cycle?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`review-cycles/${idOf(c.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  async function onPick(refs: string[]) {
    if (!picker) return;
    await runVerb(picker.cycle, picker.mode === "launch" ? "launch" : "enroll", { employees: refs }, picker.mode === "launch" ? "Cycle launched" : "Reviewees added");
    setPicker(null);
  }

  const createBtn = (
    <AccessAction create collection="review-cycles" label="Review cycle">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New cycle</Button>
    </AccessAction>
  );

  return (
    // Embedded (Settings tab) renders outside the page-level route scope; bind the collection explicitly so
    // every affordance manages review-cycles either way.
    <AccessScope collection="review-cycles">
    <div>
      {!embedded && <PageHeader accessCollection="review-cycles" title="Review Cycles" description="Run performance review cycles. Pick who's reviewed; track each cycle to close." actions={createBtn} />}
      {embedded && (
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Review cycles</h3>
            <p className="text-sm text-muted-foreground">Create a cycle, choose who's reviewed, and launch. Reviews appear on each person's Reviews page.</p>
          </div>
          {createBtn}
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={Rocket} title="No review cycles" description="Create a cycle to start a round of performance reviews." action={createBtn} />
        ) : (
          <div className="space-y-3">
            {sorted.map((c) => {
              const can = c.access?.can ?? [];
              return (
                <AccessItem key={c.path} objectPath={c.path} can={can} why={c.access?.why} label={c.name}>
                <div>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <Badge variant={STATE[c.state].variant}>{STATE[c.state].label}</Badge>
                      <span className="text-xs text-muted-foreground">{c.review_count ?? 0} {c.review_count === 1 ? "review" : "reviews"}</span>
                    </div>
                    {(c.period_start || c.period_end) && (
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{c.period_start ?? "…"} → {c.period_end ?? "…"}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(c.review_count ?? 0) > 0 && (
                      <Button variant={calibrating === c.path ? "secondary" : "ghost"} size="sm" onClick={() => setCalibrating(calibrating === c.path ? null : c.path)}>
                        <BarChart3 className="h-3.5 w-3.5" /> Calibration
                      </Button>
                    )}
                    {c.state === "DRAFT" && can.includes("launch") && (
                      <AccessAction verb="launch" objectPath={c.path} can={can} label="Launch cycle">
                        <Button size="sm" onClick={() => setPicker({ cycle: c, mode: "launch" })}><Rocket className="h-3.5 w-3.5" /> Launch</Button>
                      </AccessAction>
                    )}
                    {c.state === "ACTIVE" && can.includes("enroll") && (
                      <AccessAction verb="enroll" objectPath={c.path} can={can} label="Add reviewees">
                        <Button variant="outline" size="sm" onClick={() => setPicker({ cycle: c, mode: "enroll" })}><UserPlus className="h-3.5 w-3.5" /> Add people</Button>
                      </AccessAction>
                    )}
                    {c.state === "ACTIVE" && can.includes("close") && (
                      <AccessAction verb="close" objectPath={c.path} can={can} label="Close cycle">
                        <Button variant="outline" size="sm" onClick={() => runVerb(c, "close", undefined, "Cycle closed")}><Lock className="h-3.5 w-3.5" /> Close</Button>
                      </AccessAction>
                    )}
                    {c.state === "CLOSED" && can.includes("reopen") && (
                      <AccessAction verb="reopen" objectPath={c.path} can={can} label="Reopen cycle">
                        <Button variant="outline" size="sm" onClick={() => runVerb(c, "reopen", undefined, "Cycle reopened")}><Unlock className="h-3.5 w-3.5" /> Reopen</Button>
                      </AccessAction>
                    )}
                    {can.includes("update") && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(c)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                    )}
                    {c.state === "DRAFT" && can.includes("delete") && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(c)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                </Card>
                {calibrating === c.path && <CalibrationPanel cycle={c} employees={employees} departments={departments} />}
                </div>
                </AccessItem>
              );
            })}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim() && !badRange) submit(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit cycle" : "New review cycle"}</DialogTitle></DialogHeader>
          <Field label="Name"><Input value={form.name} placeholder="e.g. H1 2026 Review" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Period start (optional)"><Input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} /></Field>
            <Field label="Period end (optional)" error={badRange ? "End is before the start." : undefined}><Input type="date" value={form.period_end} min={form.period_start || undefined} onChange={(e) => setForm({ ...form, period_end: e.target.value })} /></Field>
            <Field label="Self-review due (optional)"><Input type="date" value={form.self_due_date} onChange={(e) => setForm({ ...form, self_due_date: e.target.value })} /></Field>
            <Field label="Manager review due (optional)"><Input type="date" value={form.manager_due_date} onChange={(e) => setForm({ ...form, manager_due_date: e.target.value })} /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || badRange}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {picker && (
        <EmployeePicker
          title={picker.mode === "launch" ? `Launch "${picker.cycle.name}"` : `Add people to "${picker.cycle.name}"`}
          confirmLabel={picker.mode === "launch" ? "Launch cycle" : "Add reviewees"}
          employees={employees}
          departments={departments}
          onClose={() => setPicker(null)}
          onConfirm={onPick}
        />
      )}
    </div>
    </AccessScope>
  );
}

// HR calibration: the distribution of shared overall ratings for one cycle, optionally narrowed to a
// department. Reviews are fetched only when the panel opens (lazy, like every secondary read) and the
// chart is a single-hue count-per-rating column set: counts direct-labelled, text in ink tokens, the
// primary hue carrying the (single) series. Ratings appear only once SHARED, so a mid-flight cycle shows
// completion alongside a partial distribution.
function CalibrationPanel({ cycle, employees, departments }: { cycle: ReviewCycle; employees: Employee[]; departments: Department[] }) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  const [dept, setDept] = useState("all");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cfg = await get<{ value?: Partial<PerformanceFramework> }>("settings/performance").catch(() => ({ value: undefined }));
        if (live && cfg.value?.competencies?.length && cfg.value.scale?.length) setFramework({ ...DEFAULT_PERFORMANCE, ...cfg.value });
        const rows: Review[] = [];
        let pageToken: string | undefined;
        // The server caps list pages at 100; follow the cursor a few pages so a big cycle still sums right.
        for (let i = 0; i < 5; i++) {
          const page = await get<{ results: Review[]; next_page_token?: string }>(
            `reviews?cycle=${encodeURIComponent(cycle.path)}&max_page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
          );
          rows.push(...page.results);
          pageToken = page.next_page_token || undefined;
          if (!pageToken) break;
        }
        if (live) setReviews(rows);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [cycle.path]);

  const deptOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e.department ? idOf(e.department) : ""]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [employees]);

  if (error) return <div className="mt-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">Couldn't load reviews: {error}</div>;
  if (!reviews) return <div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading ratings…</div>;

  const scoped = dept === "all" ? reviews : reviews.filter((r) => deptOf(r.employee) === idOf(dept));
  const rated = scoped.filter((r) => r.overall_rating != null);
  const done = scoped.filter((r) => r.state === "ACKNOWLEDGED").length;
  const avg = rated.length ? rated.reduce((s, r) => s + (r.overall_rating ?? 0), 0) / rated.length : null;
  const counts = framework.scale.map((s) => ({ ...s, count: rated.filter((r) => r.overall_rating === s.value).length }));
  const max = Math.max(1, ...counts.map((c) => c.count));

  return (
    <div className="mt-2 space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Calibration</p>
        {departments.length > 0 && (
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={d.path}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span><span className="font-semibold tabular-nums">{scoped.length}</span> <span className="text-muted-foreground">reviews</span></span>
        <span><span className="font-semibold tabular-nums">{rated.length}</span> <span className="text-muted-foreground">rated</span></span>
        <span><span className="font-semibold tabular-nums">{done}</span> <span className="text-muted-foreground">acknowledged</span></span>
        {avg != null && <span><span className="font-semibold tabular-nums">{avg.toFixed(1)}</span> <span className="text-muted-foreground">average · {ratingLabel(framework.scale, Math.round(avg))}</span></span>}
      </div>
      {rated.length === 0 ? (
        <p className="text-sm text-muted-foreground">No shared ratings {dept === "all" ? "yet" : "in this department yet"}. The distribution fills in as managers share reviews.</p>
      ) : (
        <div className="flex items-end gap-2">
          {counts.map((c) => (
            <div key={c.value} className="flex flex-1 flex-col items-center gap-1" title={`${c.label}: ${c.count}`}>
              <span className="text-xs tabular-nums text-muted-foreground">{c.count || ""}</span>
              <div className="flex h-24 w-full items-end justify-center">
                <div
                  className="w-full max-w-14 rounded-t-[4px] bg-primary"
                  style={{ height: `${Math.max(c.count ? 6 : 1, (c.count / max) * 100)}%`, opacity: c.count ? 1 : 0.15 }}
                />
              </div>
              <span className="border-t pt-1 text-xs font-medium tabular-nums">{c.value}</span>
              <span className="hidden text-center text-[10px] leading-tight text-muted-foreground sm:block">{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
