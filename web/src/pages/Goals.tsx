import { useEffect, useMemo, useState } from "react";
import { Target, Plus, Pencil, Trash2, CheckCircle2, CalendarDays, Users } from "lucide-react";
import { create, patch, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { Employee, Goal, GoalStatus, Me, Card as KanbanCard } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/use-toast";
import { TruncationNotice } from "@/components/common/TruncationNotice";

const STATUSES: { value: GoalStatus; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];
const statusBadge: Record<GoalStatus, { label: string; variant: "muted" | "secondary" | "success" | "destructive" }> = {
  not_started: { label: "Not started", variant: "muted" },
  in_progress: { label: "In progress", variant: "secondary" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};
// Active goals sort ahead of finished ones; within a bucket the due date decides.
const STATUS_RANK: Record<GoalStatus, number> = { in_progress: 0, not_started: 1, completed: 2, cancelled: 3 };

type Filter = "all" | "active" | "completed" | "cancelled";
const matchesFilter = (g: Goal, f: Filter) =>
  f === "all" ? true : f === "active" ? g.status === "in_progress" || g.status === "not_started" : g.status === f;

const EMPTY = { title: "", description: "", weight: "", status: "not_started" as GoalStatus, due_date: "", employee: "me" };
const todayStr = () => new Date().toISOString().slice(0, 10);
// Relative due phrase: "5d left" / "due today" / "3d overdue".
const dueRel = (ymd: string): { text: string; overdue: boolean } => {
  const days = Math.round((Date.parse(ymd + "T00:00:00Z") - Date.parse(todayStr() + "T00:00:00Z")) / 86400000);
  if (days > 0) return { text: `${days}d left`, overdue: false };
  if (days === 0) return { text: "due today", overdue: false };
  return { text: `${-days}d overdue`, overdue: true };
};

export default function Goals({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Goal>("goals");
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: cards } = useCollection<KanbanCard>("cards");
  // Board tasks linked to a goal — the goal's progress derives from these (delivered share, weighted by points).
  const linkedFor = (g: Goal) => cards.filter((c) => c.goal && idOf(c.goal) === idOf(g.path) && !c.delete_time);
  const { toast } = useToast();
  const sd = useSoftDelete("goals", "goal", reload);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  const isMine = (g: Goal) => !!g.employee && idOf(g.employee) === me.employee_id;

  const sortGoals = (list: Goal[]) =>
    [...list].sort((a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      (b.create_time ?? "").localeCompare(a.create_time ?? ""),
    );
  const myGoals = useMemo(() => sortGoals(rows.filter(isMine)), [rows, me.employee_id]);
  const teamGoals = useMemo(() => sortGoals(rows.filter((g) => !isMine(g))), [rows, me.employee_id]);
  const myShown = myGoals.filter((g) => matchesFilter(g, filter));
  const teamShown = teamGoals.filter((g) => matchesFilter(g, filter));

  // Scoreboard over MY goals: what's in flight, how far along (weight-weighted), what's done, what's slipping.
  const stats = useMemo(() => {
    const active = myGoals.filter((g) => g.status === "in_progress" || g.status === "not_started");
    const done = myGoals.filter((g) => g.status === "completed");
    const overdue = active.filter((g) => g.due_date && g.due_date < todayStr());
    const wsum = active.reduce((s, g) => s + (g.weight || 1), 0);
    const avg = wsum > 0 ? Math.round(active.reduce((s, g) => s + (g.progress ?? 0) * (g.weight || 1), 0) / wsum) : 0;
    return { active: active.length, avg, done: done.length, overdue: overdue.length };
  }, [myGoals]);

  // Weight-sum feedback: what an owner's OPEN goals' weights add up to (completed/cancelled don't count).
  const openWeightSum = (ownerId: string, excludePath?: string) =>
    rows.reduce(
      (s, g) =>
        g.employee && idOf(g.employee) === ownerId && g.path !== excludePath &&
        (g.status === "not_started" || g.status === "in_progress")
          ? s + (g.weight || 0)
          : s,
      0,
    );

  const counts = useMemo(() => ({
    all: rows.length,
    active: rows.filter((g) => matchesFilter(g, "active")).length,
    completed: rows.filter((g) => g.status === "completed").length,
    cancelled: rows.filter((g) => g.status === "cancelled").length,
  }), [rows]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY });
    setOpen(true);
  }
  function openEdit(g: Goal) {
    setEditing(g);
    setForm({
      title: g.title,
      description: g.description ?? "",
      weight: g.weight != null ? String(g.weight) : "",
      status: g.status,
      due_date: g.due_date ?? "",
      employee: g.employee ? `employees/${idOf(g.employee)}` : "me",
    });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      weight: form.weight === "" ? 0 : Number(form.weight),
      status: form.status,
      due_date: form.due_date || null,
    };
    try {
      if (editing) {
        await patch(`goals/${idOf(editing.path)}`, body, editing.etag);
        toast({ title: "Goal updated", variant: "success" });
      } else {
        // Owner defaults to self; a manager/HR can file one for someone else (the server checks they may).
        const owner = form.employee && form.employee !== "me" ? { employee: form.employee } : {};
        await create<Goal>("goals", { ...body, ...owner });
        toast({ title: "Goal created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // The updateProgress verb: move a goal's progress (auto-advancing status off "not started" / to "completed").
  async function setProgress(g: Goal, progress: number) {
    const status: GoalStatus | undefined =
      progress >= 100 && g.status !== "completed" ? "completed"
      : progress > 0 && g.status === "not_started" ? "in_progress"
      : undefined;
    try {
      await invoke(`goals/${idOf(g.path)}`, "updateProgress", undefined, status ? { progress, status } : { progress });
      toast({ title: progress >= 100 ? "Goal marked complete" : `Progress set to ${progress}%`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update progress", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Live weight-sum feedback for the dialog: what the chosen owner's open goals would total with this one.
  const dialogOwnerId = editing
    ? (editing.employee ? idOf(editing.employee) : me.employee_id ?? "")
    : form.employee === "me" ? me.employee_id ?? "" : idOf(form.employee);
  const otherWeights = dialogOwnerId ? openWeightSum(dialogOwnerId, editing?.path) : 0;
  const weightInvalid = form.weight !== "" && (Number(form.weight) < 0 || Number(form.weight) > 100);
  const weightTotal =
    otherWeights +
    (form.status === "not_started" || form.status === "in_progress" ? (form.weight === "" ? 0 : Number(form.weight) || 0) : 0);

  useIntent("new-goal", openCreate);

  const createBtn = (
    <AccessAction collection="goals" create label="New goal">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New goal</Button>
    </AccessAction>
  );

  const grid = (list: Goal[], team = false) => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((g) => (
        <GoalCard
          key={g.path}
          goal={g}
          ownerName={team ? empName(g.employee) : ""}
          linked={linkedFor(g)}
          onEdit={() => openEdit(g)}
          onDelete={() => sd.softDelete(g)}
          onProgress={(p) => setProgress(g, p)}
        />
      ))}
    </div>
  );

  const filterChip = (f: Filter, label: string) => (
    <button
      key={f}
      type="button"
      onClick={() => setFilter(f)}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        filter === f ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{counts[f]}</span>
    </button>
  );

  return (
    <TooltipProvider delayDuration={150}>
    <div>
      <PageHeader
        title="Goals"
        description="Set and track performance goals."
        actions={<>{createBtn}<PageSettings me={me} host="goals" /></>}
      />

      <TruncationNotice collection="goals" what="goals" className="mb-3" />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState illustration="goals" icon={Target} title="No goals yet" description="Create a goal to start tracking what you're working toward." action={createBtn} />
        ) : (
          <div className="space-y-6">
            {/* My scoreboard: only when the caller owns goals. Overdue tile heats up when non-zero. */}
            {myGoals.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-4">
                <StatTile label="Active goals" value={String(stats.active)} />
                <StatTile label="Average progress" value={`${stats.avg}%`} bar={stats.avg} />
                <StatTile label="Completed" value={String(stats.done)} />
                <StatTile label="Overdue" value={String(stats.overdue)} alert={stats.overdue > 0} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {filterChip("all", "All")}
              {filterChip("active", "Active")}
              {filterChip("completed", "Completed")}
              {filterChip("cancelled", "Cancelled")}
            </div>

            {myShown.length > 0 && (
              <section className="space-y-3">
                {teamShown.length > 0 && <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Target className="h-3.5 w-3.5" /> My goals</h2>}
                {grid(myShown)}
              </section>
            )}
            {teamShown.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Users className="h-3.5 w-3.5" /> Team goals</h2>
                {grid(teamShown, true)}
              </section>
            )}
            {myShown.length === 0 && teamShown.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing matches this filter. <button type="button" className="font-medium text-primary hover:underline" onClick={() => setFilter("all")}>Show all</button>
              </p>
            )}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.title.trim() && !weightInvalid) submit(); }}>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> {editing ? "Edit goal" : "New goal"}</DialogTitle></DialogHeader>
          <Field label="Title"><Input value={form.title} placeholder="e.g. Ship the billing revamp" onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
          <Field label="Description (optional)"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" /></Field>
          {!editing && (
            <Field label="For" hint="Who this goal belongs to.">
              <Combobox
                value={form.employee}
                onValueChange={(v) => setForm({ ...form, employee: v })}
                searchPlaceholder="Search people…"
                options={[{ value: "me", label: "Myself" }, ...employees.filter((e) => idOf(e.path) !== me.employee_id).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
              />
            </Field>
          )}
          <FieldRow>
            <Field
              label="Weight"
              hint={otherWeights > 0 ? `Other open goals total ${otherWeights}; with this one ${weightTotal} of 100.` : "Relative importance (0-100)."}
              error={weightInvalid ? "Weight must be between 0 and 100." : undefined}
            >
              <Input type="number" min={0} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Due date (optional)">
              <Input type="date" value={form.due_date} min={!editing ? todayStr() : undefined} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
          </FieldRow>
          {!weightInvalid && weightTotal > 100 && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Open goals would total {weightTotal} weight, over the usual 100. Consider rebalancing.
            </p>
          )}
          <Field label="Status">
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as GoalStatus })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.title.trim() || weightInvalid}>{editing ? "Save changes" : "Create goal"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}

function StatTile({ label, value, bar, alert }: { label: string; value: string; bar?: number; alert?: boolean }) {
  return (
    <div className={cn("rounded-lg border p-3", alert && "border-rose-300/70 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", alert && "text-rose-600 dark:text-rose-400")}>{value}</p>
      {bar != null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${bar}%` }} />
        </div>
      )}
    </div>
  );
}

// SVG progress donut: the goal's % at a glance, colored by state (emerald done / rose overdue / primary).
function Ring({ pct, tone }: { pct: number; tone: "done" | "overdue" | "normal" | "muted" }) {
  const r = 18, c = 2 * Math.PI * r;
  const stroke = tone === "done" ? "stroke-emerald-500" : tone === "overdue" ? "stroke-rose-500" : tone === "muted" ? "stroke-muted-foreground/50" : "stroke-primary";
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90">
        <circle cx="22" cy="22" r={r} className="fill-none stroke-muted" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} className={cn("fill-none transition-all", stroke)} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">{Math.round(pct)}</span>
    </div>
  );
}

// One goal card: progress donut + title/chips, description, and a single slider as the progress control
// (read-only viewers get no slider - the donut already shows the %). "Mark complete" is one click away.
function GoalCard({ goal, ownerName, linked, onEdit, onDelete, onProgress }: {
  goal: Goal;
  ownerName: string;
  linked: KanbanCard[];
  onEdit: () => void;
  onDelete: () => void;
  onProgress: (progress: number) => void;
}) {
  const can = goal.access?.can ?? [];
  const canEdit = can.includes("update");
  const canDelete = can.includes("delete");
  // When board tasks are linked, progress is derived server-side from their delivery — the manual slider is hidden.
  const hasLinked = linked.length > 0;
  const delivered = linked.filter((c) => c.deliver_time).length;
  const totalPts = linked.reduce((s, c) => s + (c.size ?? 0), 0);
  const deliveredPts = linked.reduce((s, c) => s + (c.deliver_time ? c.size ?? 0 : 0), 0);
  const canProgress = !hasLinked && (canEdit || can.includes("updateProgress"));
  const badge = statusBadge[goal.status];
  const due = goal.due_date ? dueRel(goal.due_date) : null;
  const closed = goal.status === "completed" || goal.status === "cancelled";
  const overdue = !!due?.overdue && !closed;
  const tone = goal.status === "completed" ? "done" : overdue ? "overdue" : goal.status === "cancelled" ? "muted" : "normal";

  // Local slider value; commit on release so we don't fire a request per pixel. Re-sync if the goal changes.
  const [prog, setProg] = useState(goal.progress ?? 0);
  useEffect(() => setProg(goal.progress ?? 0), [goal.progress]);
  const commit = () => { if (prog !== (goal.progress ?? 0)) onProgress(prog); };

  return (
    <Card className={cn("group flex flex-col gap-3 p-4", overdue && "border-rose-300/70 dark:border-rose-900/60")}>
      <div className="flex items-start gap-3">
        <Ring pct={prog} tone={tone} />
        <div className="min-w-0 flex-1">
          <h3 className={cn("truncate font-semibold", goal.status === "cancelled" && "text-muted-foreground line-through")} title={goal.title}>{goal.title}</h3>
          {ownerName && <p className="truncate text-xs text-muted-foreground">{ownerName}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {due && !closed && (
              <span title={formatDate(goal.due_date)} className={cn("inline-flex items-center gap-1 tabular-nums", overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                <CalendarDays className="h-3 w-3" /> {due.text}
              </span>
            )}
            {goal.weight ? <span className="text-muted-foreground">· weight {goal.weight}</span> : null}
            {hasLinked && (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground hover:underline">
                    <Target className="h-3 w-3" /> {delivered}/{linked.length} tasks{totalPts > 0 ? ` · ${deliveredPts}/${totalPts} pts` : ""}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2">
                  <p className="mb-1 text-xs font-medium">Linked tasks</p>
                  <ul className="max-h-56 space-y-1 overflow-y-auto">
                    {linked.map((c) => (
                      <li key={c.path} className="flex items-center gap-2 text-sm">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.deliver_time ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                        <span className={cn("truncate", c.deliver_time && "text-muted-foreground line-through")}>{c.title}</span>
                        {c.size != null && <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{c.size}</span>}
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {canProgress && !closed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-600 dark:text-emerald-400" onClick={() => onProgress(100)} aria-label="Mark complete"><CheckCircle2 className="h-4 w-4" /></Button>
              </TooltipTrigger>
              <TooltipContent>Mark complete</TooltipContent>
            </Tooltip>
          )}
          {canEdit && <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
          {canDelete && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>

      {goal.description && <p className="line-clamp-2 text-sm text-foreground/80">{goal.description}</p>}

      {canProgress && !closed && (
        <div className="mt-auto flex items-center gap-2 pt-1">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={prog}
            onChange={(e) => setProg(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            className="h-1.5 w-full cursor-pointer accent-primary"
            aria-label="Set progress"
          />
          <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-muted-foreground">{prog}%</span>
        </div>
      )}

      {hasLinked && !closed && <p className="mt-auto pt-1 text-[11px] text-muted-foreground">Progress syncs from linked tasks.</p>}
    </Card>
  );
}
