import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Rocket, UserPlus, Lock, Unlock, BarChart3, Coins } from "lucide-react";
import { create, patch, invoke, remove, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { calibrationNote } from "@/lib/calibrationNote";
import { todayStr, addDaysYmd, daysBetweenYmd } from "@/lib/orgDay";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { BurnupPoint, Department, Employee, Review, ReviewCycle } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chart } from "@/components/common/Chart";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

const STATE: Record<ReviewCycle["state"], { label: string; variant: "muted" | "secondary" | "success" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  ACTIVE: { label: "Active", variant: "secondary" },
  CLOSED: { label: "Closed", variant: "success" },
};
const EMPTY = { name: "", period_start: "", period_end: "", goal_setting_due_date: "", self_due_date: "", manager_due_date: "" };

// The last calendar day of the quarter starting at month `firstMonth` (0-based). Day 0 of the month AFTER the
// quarter is the day before it begins, i.e. the quarter's last - stated in UTC so the answer is the date
// itself and not the machine's evening.
const quarterEnd = (year: number, firstMonth: number) => new Date(Date.UTC(year, firstMonth + 3, 0)).toISOString().slice(0, 10);
// The periods a cycle is actually run over, named the way people name them. Each also proposes the name, so
// one chip fills the whole top half of the form.
//
// Which quarter is "this" one comes from the ORG's day (lib/orgDay), not the browser's: a reviewer in another
// timezone must be offered the same quarter as everyone else, and on the last day of a quarter the two
// disagree about which one that is.
function periodPresets(): { label: string; name: string; start: string; end: string }[] {
  const today = todayStr();
  const y = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const quarter = (year: number, index: number) => ({
    label: `Q${index + 1} ${String(year).slice(2)}`,
    name: `Q${index + 1} ${year} Review`,
    start: `${year}-${String(index * 3 + 1).padStart(2, "0")}-01`,
    end: quarterEnd(year, index * 3),
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
// How long is left to get this cycle's goals agreed, in the words a chaser would use.
function goalSettingCountdown(due: string): string {
  const days = daysBetweenYmd(todayStr(), due);
  if (days > 1) return `${days} days to the goal deadline`;
  if (days === 1) return "goal deadline is tomorrow";
  if (days === 0) return "goal deadline is today";
  return `${-days} days past the goal deadline`;
}

// Whole months between two dates, for the "covers 6 months" line.
function spanLabel(start: string, end: string): string {
  const days = daysBetweenYmd(start, end) + 1;
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.44);
  return months % 12 === 0 && months >= 12 ? `${months / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
}

export default function ReviewCycles({ embedded }: { embedded?: boolean }) {
  const { rows, state, error, reload } = useCollection<ReviewCycle>("review-cycles");
  // COMPLETE: the participant picker chooses from this list, so a window silently excludes people from a cycle.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewCycle | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [picker, setPicker] = useState<{ cycle: ReviewCycle; mode: "launch" | "enroll" } | null>(null);
  // Chosen but not committed: the preview stage between picking people and creating their reviews.
  const [pending, setPending] = useState<{ cycle: ReviewCycle; mode: "launch" | "enroll"; refs: string[] } | null>(null);
  // Which framework competencies this cycle rates. Empty = all of them, which is both the default and what
  // clearing the selection means, so the two states are one state.
  const [pickedCompetencies, setPickedCompetencies] = useState<string[]>([]);
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  useEffect(() => {
    getSetting<{ competencies?: PerformanceFramework["competencies"]; scale?: PerformanceFramework["scale"] }>("performance")
      .then((cfg) => { if (cfg.value?.competencies?.length) setFramework({ ...DEFAULT_PERFORMANCE, ...cfg.value }); })
      .catch(() => { /* the defaults are a working framework */ });
  }, []);
  const [calibrating, setCalibrating] = useState<string | null>(null); // cycle path whose calibration panel is open
  const [paying, setPaying] = useState<string | null>(null); // cycle path whose variable-pay panel is open

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
      // Goal setting belongs at the START of the period it covers - a goal agreed in the last week measures
      // nothing. Two weeks in is the deadline most orgs land on.
      goal_setting_due_date: f.goal_setting_due_date || addDaysYmd(p.start, 14),
      self_due_date: f.self_due_date || addDaysYmd(p.end, 14),
      manager_due_date: f.manager_due_date || addDaysYmd(p.end, 28),
    }));
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setPickedCompetencies([]); setOpen(true); }
  function openEdit(c: ReviewCycle) {
    setEditing(c);
    setForm({ name: c.name, period_start: c.period_start ?? "", period_end: c.period_end ?? "", goal_setting_due_date: c.goal_setting_due_date ?? "", self_due_date: c.self_due_date ?? "", manager_due_date: c.manager_due_date ?? "" });
    setPickedCompetencies(c.competency_keys ?? []);
    setOpen(true);
  }

  async function submit() {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      // Date fields are `format: date`, and "" is not a date - an empty one is left out.
      ...(form.period_start ? { period_start: form.period_start } : {}),
      ...(form.period_end ? { period_end: form.period_end } : {}),
      ...(form.goal_setting_due_date ? { goal_setting_due_date: form.goal_setting_due_date } : {}),
      ...(form.self_due_date ? { self_due_date: form.self_due_date } : {}),
      ...(form.manager_due_date ? { manager_due_date: form.manager_due_date } : {}),
      // Always sent, including empty: clearing the selection is a real edit ("ask about all of them again").
      competency_keys: pickedCompetencies,
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
                    {/* Reviewees with no goals attached: their review has nothing to score, and the time to
                        fix that is while the cycle is young - not when a manager opens an empty goals panel. */}
                    {(c.review_count ?? 0) > (c.goal_coverage ?? 0) && (
                      <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                        {(c.review_count ?? 0) - (c.goal_coverage ?? 0)} of {c.review_count} {(c.review_count ?? 0) - (c.goal_coverage ?? 0) === 1 ? "reviewee has" : "reviewees have"} no goals in this cycle
                        {/* Against the deadline, while there is still time to do something about it - a
                            coverage gap with no date attached is a fact nobody is on the hook for. */}
                        {c.goal_setting_due_date && ` · ${goalSettingCountdown(c.goal_setting_due_date)}`}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(c.review_count ?? 0) > 0 && (
                      <Button variant={calibrating === c.path ? "secondary" : "ghost"} size="sm" onClick={() => setCalibrating(calibrating === c.path ? null : c.path)}>
                        <BarChart3 className="h-3.5 w-3.5" /> Calibration
                      </Button>
                    )}
                    {(c.review_count ?? 0) > 0 && can.includes("variablePay") && (
                      <Button variant={paying === c.path ? "secondary" : "ghost"} size="sm" onClick={() => setPaying(paying === c.path ? null : c.path)}>
                        <Coins className="h-3.5 w-3.5" /> Variable pay
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
                {paying === c.path && <VariablePayPanel cycle={c} employees={employees} />}
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
          <Field label="Goals agreed by (optional)" hint="When this cycle's goals have to be set. The cycle counts down to it while people still have time to act.">
            <Input type="date" value={form.goal_setting_due_date} onChange={(e) => setForm({ ...form, goal_setting_due_date: e.target.value })} />
          </Field>
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
          {/* What this cycle asks about. The framework is org-wide, so a probation review and an annual review
              had to rate the same five things; this narrows the questions without inventing competencies,
              which would make two cycles' scores incomparable. */}
          {framework.competencies.length > 1 && (
            <Field
              label="Competencies rated"
              hint={pickedCompetencies.length === 0 ? "All of them. Untick any this cycle should not ask about." : `${pickedCompetencies.length} of ${framework.competencies.length}. Ratings are stored against the framework's own keys, so cycles stay comparable.`}
            >
              <div className="flex flex-wrap gap-1.5">
                {framework.competencies.map((c) => {
                  // No selection means "all of them", so every chip reads as on until somebody narrows it.
                  const on = pickedCompetencies.length === 0 || pickedCompetencies.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      title={c.description || undefined}
                      onClick={() => {
                        const current = pickedCompetencies.length === 0 ? framework.competencies.map((x) => x.key) : pickedCompetencies;
                        const next = on ? current.filter((k) => k !== c.key) : [...current, c.key];
                        // Back to every competency is back to "no selection" - the same thing, stored as null.
                        setPickedCompetencies(next.length === framework.competencies.length ? [] : next);
                      }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </Field>
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
  const onProbation = picked.filter((e) => !!e.probation_end_date && e.probation_end_date >= todayStr());
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
  // The cycle's attainment curve, computed server-side over the goals THIS caller may see and read in the
  // same lazy breath as the reviews - a calibration meeting wants the shape of the quarter, and one final
  // number cannot tell a steady climb from a week of back-filling.
  const [burnup, setBurnup] = useState<BurnupPoint[]>([]);
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  const [dept, setDept] = useState("all");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
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
        // One row asked for, because the curve is what this call is for - the goals themselves are already on
        // the reviews. A caller who cannot read goals simply gets no curve.
        const curve = await get<{ burnup?: BurnupPoint[] }>(
          `goals?cycle=${encodeURIComponent(cycle.path)}&burnup=true&max_page_size=1`,
        ).catch(() => null);
        if (live && curve?.burnup) setBurnup(curve.burnup);
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
  // Rating against delivery: the two halves of a performance conversation, which a single distribution bar
  // can't separate. Only reviews carrying both a rating and a goal score can be placed.
  const placed = rated.filter((r) => r.goal_attainment);
  // One sentence about the shape of this distribution, from the rows already on screen.
  const note = calibrationNote(
    rated.filter((r) => r.overall_rating != null).map((r) => ({ rating: r.overall_rating!, departmentId: deptOf(r.employee) })),
    framework.scale,
    (id) => departments.find((d) => idOf(d.path) === id)?.display_name ?? "",
  );

  const empName = (ref?: string) => {
    const e = employees.find((x) => idOf(x.path) === idOf(ref ?? ""));
    return e ? `${e.first_name} ${e.last_name}` : "Someone";
  };

  return (
    // MASKED FROM SESSION REPLAY. `reviews` is on instrument.ts's SENSITIVE_PAGES for a reason that names this
    // exact surface - "a replay of the calibration grid or a reviewer's draft undoes that from outside" - but
    // the calibration grid lives on the review-CYCLES page, which the route mask does not cover. The panel
    // carries it itself, like the seven profile panels do: the distribution, the nine-box and the names on it
    // are named people's ratings. Headings, labels and buttons stay readable through instrument.ts's `unmask`
    // list, so what this hides is the values.
    <div data-sentry-mask className="mt-2 space-y-3 rounded-lg border bg-muted/20 p-4">
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
      {/* THE SHAPE OF THE DISTRIBUTION, IN WORDS. Assembled from the counts, not written by a model - see
          lib/calibrationNote.ts for why that is the design rather than a limitation. It names cohorts and
          counts; it never names a person and never suggests moving anybody's rating. */}
      {note.text && (
        <p className="text-sm">
          {note.text}
          <span className="ml-1.5 text-xs text-muted-foreground">Facts only. What to do about it is the meeting's.</span>
        </p>
      )}
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
      {burnup.length > 1 && (
        <div className="space-y-1 border-t pt-3">
          <p className="text-sm font-medium">Attainment through the cycle</p>
          <Chart
            type="line"
            height={200}
            labels={burnup.map((p) => p.at.slice(5))}
            datasets={[
              { name: "Attained", values: burnup.map((p) => p.attained) },
              { name: "Expected", values: burnup.map((p) => p.expected) },
            ]}
            format={(v) => `${v}%`}
            hideDots
            ariaLabel="Weighted goal attainment across the cycle, against the straight line the cycle should follow"
            // Deliberately not a filter: a point is the cycle's weighted attainment on one past date - a
            // percentage, not a set of reviews. See `everyChart.spec.ts`'s exemption list.
          />
        </div>
      )}
      <NineBox reviews={placed} scale={framework.scale} name={empName} missing={rated.length - placed.length} />
    </div>
  );
}

type VariablePayLine = NonNullable<ReviewCycle["variable_pay"]>[number];

/**
 * What the cycle's attainment is worth, and the press that pays it.
 *
 * Two steps on purpose: the server computes and reports, then the same arithmetic is re-run when awarding, so
 * nothing anybody typed decides an amount. A line that cannot be paid says why (no goals scored, no target on
 * their compensation, already awarded) rather than quietly showing a blank.
 */
function VariablePayPanel({ cycle, employees }: { cycle: ReviewCycle; employees: Employee[] }) {
  const [lines, setLines] = useState<VariablePayLine[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  // `useCallback` so the effect can depend on the loader itself rather than on a hand-listed subset of what
  // the loader reads - the identity moves with the cycle, so it fires exactly when it fired before.
  const load = useCallback(async () => {
    try {
      const res = await invoke<ReviewCycle>(`review-cycles/${idOf(cycle.path)}`, "variablePay");
      setLines(res.variable_pay ?? []);
      // Everything payable is pre-selected: the common press is "pay what the cycle earned", and hunting for
      // fourteen checkboxes to reach it is how people end up paying the wrong set.
      setPicked((res.variable_pay ?? []).filter((l) => !l.blocked && (l.recommended ?? 0) > 0).map((l) => l.employee));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cycle.path]);
  useEffect(() => { void load(); }, [load]);

  const name = (ref?: string) => {
    const e = employees.find((x) => idOf(x.path) === idOf(ref ?? ""));
    return e ? `${e.first_name} ${e.last_name}` : "Someone";
  };
  const money = (n: number | null | undefined, currency: string) =>
    n == null ? "-" : `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  if (error) return <div className="mt-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">Couldn't compute variable pay: {error}</div>;
  if (!lines) return <TableSkeleton rows={4} cols={4} className="mt-2 rounded-lg border bg-muted/20 px-4" />;

  const payable = lines.filter((l) => !l.blocked && (l.recommended ?? 0) > 0);
  const chosen = lines.filter((l) => picked.includes(l.employee));
  const total = chosen.reduce((s, l) => s + (l.recommended ?? 0), 0);
  const currency = lines[0]?.currency ?? "INR";

  async function award() {
    const ok = await confirm({
      title: `Award ${money(total, currency)}?`,
      description: `${chosen.length} ${chosen.length === 1 ? "person" : "people"}. This writes a bonus each, at the figure computed here, payable by the next payroll run.`,
      confirmLabel: "Award variable pay",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await invoke<ReviewCycle>(`review-cycles/${idOf(cycle.path)}`, "award", undefined, { employees: picked });
      setLines(res.variable_pay ?? []);
      setPicked([]);
      toast({
        title: `${res.awarded?.awarded ?? 0} payout${(res.awarded?.awarded ?? 0) === 1 ? "" : "s"} awarded`,
        description: res.awarded ? `${money(res.awarded.total, res.awarded.currency ?? currency)} in total${res.awarded.skipped ? `, ${res.awarded.skipped} skipped` : ""}.` : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({ title: "Couldn't award", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Variable pay</p>
        <p className="text-xs text-muted-foreground">Target variable pay x what each person attained. Nothing is paid until you award it.</p>
      </div>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews in this cycle you can see.</p>
      ) : (
        <>
          <div className="scroll-shadow-x overflow-x-auto [--scroll-ground:hsl(var(--card))]">
            <table className="table-stack w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="w-8 py-1.5" />
                  <th className="py-1.5 font-medium">Person</th>
                  <th className="py-1.5 text-right font-medium">Attained</th>
                  <th className="py-1.5 text-right font-medium">Target</th>
                  <th className="py-1.5 text-right font-medium">Recommended</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.employee} className={cn("border-b last:border-0", l.blocked && "opacity-70")}>
                    <td className="py-1.5">
                      <Checkbox
                        checked={picked.includes(l.employee)}
                        disabled={!!l.blocked || !(l.recommended ?? 0)}
                        onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, l.employee] : p.filter((x) => x !== l.employee)))}
                        aria-label={`Award ${name(l.employee)}`}
                      />
                    </td>
                    <td className="py-1.5" data-label="Person">
                      {name(l.employee)}
                      {l.blocked && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {l.blocked === "already_awarded" ? `already awarded ${money(l.awarded, l.currency)}`
                            : l.blocked === "no_target" ? "no variable pay target"
                            : l.blocked === "not_shared" ? "review not shared yet"
                            // The server withholds the target and the recommendation from a reader with no
                            // compensation grant (services/variablePay.ts). Say so, rather than leaving two
                            // dashes that read as "this person has no target".
                            : l.blocked === "comp_not_visible" ? "needs compensation access to price"
                            : "nothing scored yet"}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums" data-label="Attained">{l.attainment != null ? `${l.attainment}%` : "-"}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground" data-label="Target">{money(l.target, l.currency)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums" data-label="Recommended">{money(l.recommended, l.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{money(total, currency)}</span>{" "}
              <span className="text-muted-foreground">across {chosen.length} of {payable.length} payable</span>
            </p>
            <AccessAction verb="award" objectPath={cycle.path} can={cycle.access?.can} label="Award variable pay">
              <Button size="sm" loading={busy} disabled={!chosen.length} onClick={award}>Award variable pay</Button>
            </AccessAction>
          </div>
        </>
      )}
    </div>
  );
}

// Attainment bands, low to high. 100% is "delivered what was asked", so it is a band boundary rather than a
// point on a gradient: the interesting split is short of target / on target / beyond it.
const ATTAINMENT_BANDS = [
  { key: "under", label: "Under 70%", test: (s: number) => s < 70 },
  { key: "on", label: "70-99%", test: (s: number) => s >= 70 && s < 100 },
  { key: "over", label: "100%+", test: (s: number) => s >= 100 },
];

/**
 * Rating against goal attainment - the grid a calibration meeting actually argues over.
 *
 * A rating distribution says how generous the managers were; it cannot say whether the generosity followed
 * delivery. Crossing the two puts the two conversations that matter in the corners: strong ratings on weak
 * delivery (top-left) and weak ratings on delivered goals (bottom-right). Both are invisible in a bar chart.
 *
 * Rating bands are thirds of whatever scale the org configured, so a 4-level or 6-level framework bands the
 * same way a 5-level one does.
 */
function NineBox({ reviews, scale, name, missing }: {
  reviews: Review[];
  scale: { value: number; label: string }[];
  name: (ref?: string) => string;
  missing: number;
}) {
  const ordered = [...scale].sort((a, b) => a.value - b.value);
  const bandOf = (v: number) => {
    const i = ordered.findIndex((s) => s.value === v);
    return i < 0 ? 1 : Math.min(2, Math.floor((i * 3) / Math.max(1, ordered.length)));
  };
  const bandLabel = (band: number) => {
    const vals = ordered.filter((s) => bandOf(s.value) === band).map((s) => s.value);
    if (!vals.length) return "-";
    return vals.length === 1 ? `${vals[0]}` : `${vals[0]}-${vals[vals.length - 1]}`;
  };
  const cell = (band: number, att: typeof ATTAINMENT_BANDS[number]) =>
    reviews.filter((r) => bandOf(r.overall_rating!) === band && att.test(r.goal_attainment!.score));

  if (!reviews.length) {
    return (
      <p className="border-t pt-3 text-sm text-muted-foreground">
        Rating against delivery appears once shared reviews carry goals{missing > 0 ? ` (${missing} rated review${missing === 1 ? " has" : "s have"} no goals attached to this cycle)` : ""}.
      </p>
    );
  }
  return (
    <div className="space-y-1.5 border-t pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Rating against delivery</p>
        <p className="text-xs text-muted-foreground">
          {reviews.length} placed{missing > 0 ? ` · ${missing} without goals` : ""}
        </p>
      </div>
      <div className="scroll-shadow-x overflow-x-auto [--scroll-ground:hsl(var(--card))]">
        <div className="grid min-w-[22rem] grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1">
          <span />
          {ATTAINMENT_BANDS.map((a) => (
            <span key={a.key} className="pb-0.5 text-center text-[11px] text-muted-foreground">{a.label}</span>
          ))}
          {[2, 1, 0].map((band) => (
            <Fragment key={band}>
              <span className="self-center pr-1 text-[11px] tabular-nums text-muted-foreground">Rating {bandLabel(band)}</span>
              {ATTAINMENT_BANDS.map((a) => {
                const rows = cell(band, a);
                // The two corners worth arguing about: high rating on weak delivery, low rating on delivered goals.
                const flag = (band === 2 && a.key === "under") || (band === 0 && a.key === "over");
                return (
                  <div
                    key={a.key}
                    title={rows.map((r) => `${name(r.employee)} · ${r.overall_rating} · ${r.goal_attainment!.score}%`).join("\n") || "Nobody"}
                    className={cn(
                      "min-h-[3.25rem] rounded-md border p-1.5 text-center",
                      rows.length ? (flag ? "border-amber-400/70 bg-amber-500/10" : "bg-background") : "border-dashed opacity-60",
                    )}
                  >
                    <span className="text-sm font-semibold tabular-nums">{rows.length || ""}</span>
                    {rows.length > 0 && (
                      <p className="truncate text-[10px] leading-tight text-muted-foreground">
                        {name(rows[0]!.employee)}{rows.length > 1 ? ` +${rows.length - 1}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
