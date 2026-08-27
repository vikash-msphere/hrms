import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Rocket, UserPlus, Lock, Unlock, BarChart3 } from "lucide-react";
import { create, patch, invoke, remove, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Review, ReviewCycle } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/Skeletons";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

const STATE: Record<ReviewCycle["state"], { label: string; variant: "muted" | "secondary" | "success" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  ACTIVE: { label: "Active", variant: "secondary" },
  CLOSED: { label: "Closed", variant: "success" },
};
const EMPTY = { name: "", period_start: "", period_end: "", self_due_date: "", manager_due_date: "" };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => ymd(new Date());
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
// The periods a cycle is actually run over, named the way people name them. Each also proposes the name, so
// one chip fills the whole top half of the form.
function periodPresets(): { label: string; name: string; start: string; end: string }[] {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3);
  const quarter = (year: number, index: number) => ({
    label: `Q${index + 1} ${String(year).slice(2)}`,
    name: `Q${index + 1} ${year} Review`,
    start: ymd(new Date(year, index * 3, 1)),
    end: ymd(new Date(year, index * 3 + 3, 0)),
  });
  const prevQ = q === 0 ? quarter(y - 1, 3) : quarter(y, q - 1);
  return [
    { ...prevQ, label: `Last quarter (${prevQ.label})` },
    { ...quarter(y, q), label: `This quarter (${quarter(y, q).label})` },
    { label: `H1 ${y}`, name: `H1 ${y} Review`, start: `${y}-01-01`, end: `${y}-06-30` },
    { label: `H2 ${y}`, name: `H2 ${y} Review`, start: `${y}-07-01`, end: `${y}-12-31` },
    { label: `${y}`, name: `${y} Annual Review`, start: `${y}-01-01`, end: `${y}-12-31` },
  ];
}
// Whole months between two dates, for the "covers 6 months" line.
function spanLabel(start: string, end: string): string {
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.44);
  return months % 12 === 0 && months >= 12 ? `${months / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
}

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
  // Chosen but not committed: the preview stage between picking people and creating their reviews.
  const [pending, setPending] = useState<{ cycle: ReviewCycle; mode: "launch" | "enroll"; refs: string[] } | null>(null);
  const [calibrating, setCalibrating] = useState<string | null>(null); // cycle path whose calibration panel is open

  const sorted = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);
  const badRange = !!form.period_start && !!form.period_end && form.period_end < form.period_start;
  // Read the schedule back before it is saved: what the cycle covers, and in what order the two stages fall.
  const span = form.period_start && form.period_end && !badRange ? spanLabel(form.period_start, form.period_end) : null;
  const stagesOutOfOrder = !!form.self_due_date && !!form.manager_due_date && form.manager_due_date < form.self_due_date;
  const dueBeforePeriodEnds = !!form.period_end && ((!!form.self_due_date && form.self_due_date < form.period_end) || (!!form.manager_due_date && form.manager_due_date < form.period_end));
  const dupName = useMemo(() => {
    const n = form.name.trim().toLowerCase();
    return n.length > 2 ? rows.find((c) => c.path !== editing?.path && c.name.trim().toLowerCase() === n) ?? null : null;
  }, [rows, form.name, editing?.path]);
  // One chip fills the period and, while the name is still untouched, names the cycle after it.
  function applyPreset(p: { name: string; start: string; end: string }) {
    setForm((f) => ({
      ...f,
      name: f.name.trim() ? f.name : p.name,
      period_start: p.start,
      period_end: p.end,
      // Two weeks for the self-review, two more for the manager's: the cadence the reminders assume.
      self_due_date: f.self_due_date || addDays(p.end, 14),
      manager_due_date: f.manager_due_date || addDays(p.end, 28),
    }));
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(c: ReviewCycle) {
    setEditing(c);
    setForm({ name: c.name, period_start: c.period_start ?? "", period_end: c.period_end ?? "", self_due_date: c.self_due_date ?? "", manager_due_date: c.manager_due_date ?? "" });
    setOpen(true);
  }

  async function submit() {
    const body = {
      name: form.name.trim(),
      // Date fields are `format: date`, and "" is not a date - an empty one is left out.
      ...(form.period_start ? { period_start: form.period_start } : {}),
      ...(form.period_end ? { period_end: form.period_end } : {}),
      ...(form.self_due_date ? { self_due_date: form.self_due_date } : {}),
      ...(form.manager_due_date ? { manager_due_date: form.manager_due_date } : {}),
    };
    if (editing) await patch(`review-cycles/${idOf(editing.path)}`, body, editing.etag);
    else await create("review-cycles", body);
    toast({ title: editing ? "Cycle updated" : "Cycle created", variant: "success" });
    reload();
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

  // Picking people does not launch anything: the picker hands over to a preview that says what launching will
  // actually do. Launch is the irreversible half of this page (forty people get work to do) and it used to be
  // the half that said least.
  function onPick(refs: string[]) {
    if (!picker) return;
    setPending({ cycle: picker.cycle, mode: picker.mode, refs });
    setPicker(null);
  }
  async function commitPending() {
    if (!pending) return;
    await runVerb(pending.cycle, pending.mode === "launch" ? "launch" : "enroll", { employees: pending.refs }, pending.mode === "launch" ? "Cycle launched" : "Reviewees added");
    setPending(null);
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit cycle" : "New review cycle"}
        description="The window a review covers and when each stage is due. Nobody is asked for anything until the cycle is launched."
        collection="review-cycles"
        objectPath={editing?.path}
        guardLabel="review cycle"
        form={form}
        draftKey={editing ? undefined : "review-cycle:new"}
        applyDraft={(d) => setForm(d)}
        onStartOver={editing ? undefined : () => setForm(EMPTY)}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={!!form.name.trim() && !badRange}
        whyNot={!form.name.trim() ? "Name the cycle, e.g. H1 2026 Review." : "The period ends before it starts."}
        onSubmit={submit}
      >
          {/* The five periods anyone runs a cycle over. Picking one fills the dates and, if the name is still
              empty, names the cycle - the whole top of this form in one tap. */}
          {!editing && (
            <div className="flex flex-wrap gap-1.5">
              {periodPresets().map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
                    form.period_start === p.start && form.period_end === p.end
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <Field label="Name"><Input value={form.name} placeholder="e.g. H1 2026 Review" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          {dupName && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A {STATE[dupName.state].label.toLowerCase()} cycle is already called “{dupName.name}”
              {(dupName.review_count ?? 0) > 0 ? ` with ${dupName.review_count} ${dupName.review_count === 1 ? "review" : "reviews"} on it` : ""}.
            </p>
          )}
          <FieldRow>
            <Field label="Period start (optional)"><Input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} /></Field>
            <Field label="Period end (optional)" error={badRange ? "End is before the start." : undefined} hint={span ? `Covers ${span}.` : undefined}><Input type="date" value={form.period_end} min={form.period_start || undefined} onChange={(e) => setForm({ ...form, period_end: e.target.value })} /></Field>
          </FieldRow>
          <FieldRow>
            <Field label="Self-review due (optional)" hint="Everyone reviewed is nudged as this date approaches."><Input type="date" value={form.self_due_date} onChange={(e) => setForm({ ...form, self_due_date: e.target.value })} /></Field>
            <Field label="Manager review due (optional)" hint="Managers are nudged as this date approaches."><Input type="date" value={form.manager_due_date} onChange={(e) => setForm({ ...form, manager_due_date: e.target.value })} /></Field>
          </FieldRow>
          {/* Dates that will read as a mistake later, said now. Both are legal, so neither blocks the save. */}
          {stagesOutOfOrder && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Managers are due before their reports have written anything. The self-review usually lands first.
            </p>
          )}
          {!stagesOutOfOrder && dueBeforePeriodEnds && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A review is due before the period it covers has finished.
            </p>
          )}
          {!editing && (
            <p className="text-xs text-muted-foreground">
              Creating it asks nobody for anything. Launching is a separate step, and that is when one review per
              person you pick appears on their Reviews page.
            </p>
          )}
      </WriteDialog>

      {picker && (
        <EmployeePicker
          title={picker.mode === "launch" ? `Launch "${picker.cycle.name}"` : `Add people to "${picker.cycle.name}"`}
          confirmLabel="Review and launch"
          employees={employees}
          departments={departments}
          onClose={() => setPicker(null)}
          onConfirm={onPick}
        />
      )}

      {pending && (
        <LaunchPreview
          cycle={pending.cycle}
          mode={pending.mode}
          refs={pending.refs}
          employees={employees}
          onBack={() => { setPicker({ cycle: pending.cycle, mode: pending.mode }); setPending(null); }}
          onClose={() => setPending(null)}
          onConfirm={commitPending}
        />
      )}
    </div>
    </AccessScope>
  );
}

/**
 * What launching will actually do, before it does it.
 *
 * Launch is the one irreversible press on this page: it puts a review on forty people's plates and emails their
 * managers. The picker that used to sit in front of it said nothing at all - not even how many people were
 * selected - so the three things that go wrong went wrong silently:
 *
 *   - somebody has no manager, so nobody owns their manager review and it sits unwritten until someone asks;
 *   - somebody joined after the period started, so they are being reviewed on weeks they were not here;
 *   - somebody is on probation, where a review cycle is usually the wrong instrument.
 *
 * None of them blocks the launch - all three are legitimate, and HR is the one who knows - but each is named
 * with the people it applies to, because "3 people have no manager" is only useful if you can see who.
 */
function LaunchPreview({ cycle, mode, refs, employees, onBack, onClose, onConfirm }: {
  cycle: ReviewCycle;
  mode: "launch" | "enroll";
  refs: string[];
  employees: Employee[];
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const picked = useMemo(
    () => refs.map((r) => employees.find((e) => idOf(e.path) === idOf(r))).filter((e): e is Employee => !!e),
    [refs, employees],
  );
  const name = (e: Employee) => `${e.first_name} ${e.last_name}`;
  const noManager = picked.filter((e) => !e.manager);
  const joinedLate = picked.filter((e) => !!cycle.period_start && !!e.start_date && e.start_date > cycle.period_start);
  const onProbation = picked.filter((e) => !!e.probation_end_date && e.probation_end_date >= todayIso());
  // Names, then "and N more" - a list of forty is not a warning anybody reads.
  const few = (list: Employee[]) => list.slice(0, 3).map(name).join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "");

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={mode === "launch" ? `Launch “${cycle.name}”` : `Add people to “${cycle.name}”`}
      description={mode === "launch"
        ? "One review per person appears on their Reviews page, and their manager is asked for theirs."
        : "One review per person is added to a cycle that is already running."}
      collection="review-cycles"
      objectPath={cycle.path}
      form={refs}
      submitLabel={mode === "launch" ? `Launch for ${picked.length}` : `Add ${picked.length}`}
      canSubmit={picked.length > 0}
      whyNot="Pick at least one person."
      onSubmit={onConfirm}
      footerStart={<Button type="button" variant="ghost" size="sm" onClick={onBack}>Change who</Button>}
      submitAccess={(b) => (
        <AccessAction verb={mode === "launch" ? "launch" : "enroll"} objectPath={cycle.path} can={cycle.access?.can} label={mode === "launch" ? "Launch cycle" : "Add reviewees"}>{b}</AccessAction>
      )}
    >
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">{picked.length} {picked.length === 1 ? "review" : "reviews"} will be created</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {cycle.period_start && cycle.period_end
            ? `Covering ${formatDate(cycle.period_start)} to ${formatDate(cycle.period_end)}.`
            : "This cycle has no period set, so each review says only which cycle it belongs to."}
          {cycle.self_due_date ? ` Self-reviews due ${formatDate(cycle.self_due_date)}.` : ""}
          {cycle.manager_due_date ? ` Manager reviews due ${formatDate(cycle.manager_due_date)}.` : ""}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{few(picked)}.</p>
      </div>

      {noManager.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {noManager.length === 1 ? `${name(noManager[0]!)} has no manager` : `${noManager.length} people have no manager`}, so nobody
          is asked for their manager review: {few(noManager)}.
        </p>
      )}
      {joinedLate.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {joinedLate.length === 1 ? "One person joined" : `${joinedLate.length} people joined`} after the period started, so part of it
          is before their first day: {few(joinedLate)}.
        </p>
      )}
      {onProbation.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {onProbation.length === 1 ? "One person is" : `${onProbation.length} people are`} still on probation, which usually has its own
          conversation: {few(onProbation)}.
        </p>
      )}
      {noManager.length === 0 && joinedLate.length === 0 && onProbation.length === 0 && picked.length > 0 && (
        <p className="text-xs text-muted-foreground">Everyone picked has a manager and was here for the whole period.</p>
      )}
    </WriteDialog>
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
        const cfg = await getSetting<Partial<PerformanceFramework>>("performance").catch(() => ({ value: undefined }));
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
  if (!reviews) return <TableSkeleton rows={4} cols={3} className="mt-2 rounded-lg border bg-muted/20 px-4" />;

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
