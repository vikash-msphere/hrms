import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Target, Plus, Pencil, Trash2, CheckCircle2, CalendarDays, ClipboardCheck, Clock3, Eye, Hourglass, MessageSquareDashed, Network, Sparkles, TrendingDown, Users, Search, Link2, X, ChevronLeft, ChevronRight } from "lucide-react";
import { create, patch, invoke, remove, get } from "@/api";
import { navigate, setRouteRecord, recordUrl } from "@/router";
import { describeError, isConflict } from "@/lib/formError";
import { measuredPct, measureLabel, numOrNone, weightedProgress } from "@/lib/goalMeasure";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd, daysBetweenYmd } from "@/lib/orgDay";
import type { Department, Employee, Goal, GoalConfidence, GoalKind, GoalStage, GoalStatus, Me, ReviewCycle, Card as KanbanCard } from "@/types";
import { Chart, ChartCard } from "@/components/common/Chart";
import { PageHeader } from "@/components/common/PageHeader";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { fireIntent, useIntent } from "@/lib/intent";
import { readLocal, writeLocal } from "@/lib/localPref";
import { PageSettings } from "@/components/common/SettingsButton";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { LinesSkeleton } from "@/components/common/Skeletons";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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

// How the goals are laid out. `tree` is the alignment cascade: alignment exists per goal (a parent and its
// children in the drawer), and nothing rendered it from the top - which is the view that makes a
// mis-parented goal, or a whole team hanging off nothing, obvious at a glance.
type GoalView = "flat" | "quarter" | "tree";
type Filter = "all" | "active" | "overdue" | "at_risk" | "quiet" | "unagreed" | "completed" | "cancelled";
const FILTERS: Filter[] = ["all", "active", "overdue", "at_risk", "quiet", "unagreed", "completed", "cancelled"];
const isOpen = (g: Goal) => g.status === "in_progress" || g.status === "not_started";
// A goal the server says is behind its own pace, or whose owner has said so. Both halves matter: the
// arithmetic catches the goal nobody has admitted to, the owner's call catches the one that looks fine on
// paper because the deadline is still far away.
const isAtRisk = (g: Goal) => isOpen(g) && (g.pace === "at_risk" || g.confidence === "at_risk" || g.confidence === "off_track");
// Silence. The server counts the days (a write, a progress move or a comment resets it).
const isQuiet = (g: Goal) => isOpen(g) && (g.stale_days ?? 0) >= STALE_DAYS;
const STALE_DAYS = 21;
const matchesFilter = (g: Goal, f: Filter) =>
  f === "all" ? true
  : f === "active" ? isOpen(g)
  : f === "overdue" ? isOpen(g) && !!g.due_date && g.due_date < todayStr()
  : f === "at_risk" ? isAtRisk(g)
  : f === "quiet" ? isQuiet(g)
  // Everything still in the goal-setting handshake: the owner's own drafts and whatever is sitting with a
  // manager. One filter for both halves, because "not agreed yet" is the state anyone is chasing.
  : f === "unagreed" ? g.stage !== "AGREED"
  : g.status === f;
const FILTER_KEY = "goals:filter";

const EMPTY = {
  title: "", description: "", weight: "", status: "not_started" as GoalStatus, kind: "objective" as GoalKind, due_date: "", employee: "me", parent: "none", cycle: "none", blockedBy: "none", department: "none",
  // The measure. Strings because these are text inputs; "" means "not set", which is what makes a goal manual.
  unit: "", baseline: "", target: "", current: "",
};
const num = numOrNone;
// Relative due phrase: "5d left" / "due today" / "3d overdue". `soon` = within a week.
const dueRel = (ymd: string): { text: string; overdue: boolean; soon: boolean } => {
  const days = daysBetweenYmd(todayStr(), ymd);
  if (days > 0) return { text: `${days}d left`, overdue: false, soon: days <= 7 };
  if (days === 0) return { text: "due today", overdue: false, soon: true };
  return { text: `${-days}d overdue`, overdue: true, soon: false };
};
// The month index (0-11) of a "YYYY-MM-DD", and the last calendar day of the month `ahead` months on. Day 0
// of the following month is the last of this one, and it is stated in UTC so the answer is the date itself.
// These used to be built from `new Date()`'s LOCAL parts and formatted with a local `ymd`, which made the
// quarter a goal is filed under the READER's quarter - on the last day of March, two people looking at the
// same board sorted the same goal into different buckets.
const monthIdx = (ymd: string) => Number(ymd.slice(5, 7)) - 1;
const monthEndFrom = (ymd: string, ahead: number) => new Date(Date.UTC(Number(ymd.slice(0, 4)), monthIdx(ymd) + ahead + 1, 0)).toISOString().slice(0, 10);
// Quarter bucket for the grouped view. Sort key orders chronologically; undated goals sink to the end.
const currentQuarterStartStr = () => {
  const t = todayStr();
  return `${t.slice(0, 4)}-${String(Math.floor(monthIdx(t) / 3) * 3 + 1).padStart(2, "0")}-01`;
};
const nextQuarterEndStr = () => {
  const t = todayStr();
  return monthEndFrom(t, Math.floor(monthIdx(t) / 3) * 3 + 5 - monthIdx(t)); // end of the quarter AFTER this one
};
const quarterOf = (g: Goal): { label: string; sort: number } => {
  if (!g.due_date) return { label: "No due date", sort: Infinity };
  const [y, m] = g.due_date.split("-").map(Number);
  const q = Math.ceil((m ?? 1) / 3);
  return { label: `Q${q} ${y}`, sort: (y ?? 9999) * 4 + q };
};
// Quick-set chips for the due-date field.
const quickDue = (): { label: string; value: string }[] => {
  const t = todayStr();
  return [
    { label: "2 weeks", value: addDaysYmd(t, 14) },
    { label: "End of month", value: monthEndFrom(t, 0) },
    { label: "End of quarter", value: monthEndFrom(t, Math.floor(monthIdx(t) / 3) * 3 + 2 - monthIdx(t)) },
  ];
};

export default function Goals({ me, openId }: { me: Me; openId?: string }) {
  // "all" reads every goal; a cycle path (or `none`) narrows the READ, so the answer covers goals past the
  // first page rather than whichever ones this browser already had.
  const [cycleFilter, setCycleFilter] = useState("all");
  const { rows, state, error, reload } = useCollection<Goal>("goals", { params: cycleFilter === "all" ? undefined : { cycle: cycleFilter } });
  useDeepOpen(openId, rows, openDetail);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  // Review cycles: a small, flat catalogue used to attach a goal to the cycle whose review will score it, and
  // to name that cycle on the card. Empty for anyone who can't read them, which just hides the field.
  const { rows: reviewCycles } = useCollection<ReviewCycle>("review-cycles");
  // For the department-owned chip and its picker; empty for anybody who cannot read departments.
  const { rows: departments } = useCollection<Department>("departments");
  const deptName = (ref?: string | null) => departments.find((d) => idOf(d.path) === idOf(ref ?? ""))?.display_name;
  const cycleName = (ref?: string | null) => reviewCycles.find((c) => idOf(c.path) === idOf(ref ?? ""))?.name;
  // Which goal's drawer is open. Declared up here because it also decides whether the board tasks are read.
  const [detailPath, setDetailPath] = useState<string | null>(null);
  // Board tasks: needed as ROWS only by the open goal's drawer, which lists the linked tasks and offers the
  // unlinked ones to link. The wall of goal cards reads its "3/5 tasks" chip off each goal (the server rolls
  // the linked tasks up per page), so a page nobody has opened a goal on reads no cards at all.
  const { rows: cards, reload: reloadCards } = useCollection<KanbanCard>("cards", { enabled: !!detailPath });
  // Board tasks linked to a goal — the goal's progress derives from these (delivered share, weighted by points).
  const linkedFor = (g: Goal) => cards.filter((c) => c.goal && idOf(c.goal) === idOf(g.path) && !c.delete_time);
  const { toast } = useToast();
  const sd = useSoftDelete("goals", "goal", reload);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState(EMPTY);
  // The version the edit dialog is writing against. Refreshed from the server when a save loses a race, so the
  // next press can deliberately overwrite what the other person did.
  const [etag, setEtag] = useState<string | undefined>(undefined);
  // The chip filter persists across visits (Boards does the same for its chip filters); search doesn't.
  const [filter, setFilterState] = useState<Filter>(() => {
    const v = readLocal(FILTER_KEY) as Filter | null;
    return v && FILTERS.includes(v) ? v : "all";
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    writeLocal(FILTER_KEY, f);
  };
  const [q, setQ] = useState("");
  const [view, setViewState] = useState<GoalView>(() => {
    const saved = readLocal("goals:view");
    return saved === "quarter" || saved === "tree" ? saved : "flat";
  });
  const setView = (v: GoalView) => {
    setViewState(v);
    writeLocal("goals:view", v);
  };

  const empById = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const goalById = useMemo(() => new Map(rows.map((g) => [idOf(g.path), g])), [rows]);
  const parentOf = (g: Goal) => (g.parent ? goalById.get(idOf(g.parent)) : undefined);
  const childrenOf = (g: Goal) => rows.filter((c) => c.parent && idOf(c.parent) === idOf(g.path) && !c.delete_time);
  // Self + everything below it - the set a goal may NOT align under (the server rejects cycles too).
  const descendantsOf = (g: Goal) => {
    const out = new Set([idOf(g.path)]);
    const walk = (p: Goal) => { for (const c of childrenOf(p)) if (!out.has(idOf(c.path))) { out.add(idOf(c.path)); walk(c); } };
    walk(g);
    return out;
  };
  const empName = (ref?: string) => {
    const e = ref ? empById.get(idOf(ref)) : undefined;
    return e ? `${e.first_name} ${e.last_name}` : ref ? "Employee" : "";
  };
  // `useCallback` so the two memos below can name the predicate they filter with rather than restating the
  // field it reads; the identity moves with that field, so neither recomputes more often than before.
  const isMine = useCallback((g: Goal) => !!g.employee && idOf(g.employee) === me.employee_id, [me.employee_id]);

  const sortGoals = (list: Goal[]) =>
    [...list].sort((a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      (b.create_time ?? "").localeCompare(a.create_time ?? ""),
    );
  const myGoals = useMemo(() => sortGoals(rows.filter(isMine)), [rows, isMine]);
  const teamGoals = useMemo(() => sortGoals(rows.filter((g) => !isMine(g))), [rows, isMine]);
  const matchesQuery = (g: Goal) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return (
      g.title.toLowerCase().includes(s) ||
      (g.description ?? "").toLowerCase().includes(s) ||
      empName(g.employee).toLowerCase().includes(s)
    );
  };
  const myShown = myGoals.filter((g) => matchesFilter(g, filter) && matchesQuery(g));
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const teamShown = teamGoals.filter(
    (g) => matchesFilter(g, filter) && matchesQuery(g) && (!ownerFilter || (g.employee && idOf(g.employee) === ownerFilter)),
  );
  // What the drawer walks with ‹ › and j/k: the goals on screen, in the order they are on screen. A review pass
  // over eight team goals is then one drawer rather than eight round trips through the grid.
  const drawerQueue = [...myShown, ...teamShown];

  // Per-owner rollup over team goals: who's on track, who's slipping - sorted so trouble floats up.
  const rollup = useMemo(() => {
    const by = new Map<string, Goal[]>();
    for (const g of teamGoals) {
      if (!g.employee) continue;
      const id = idOf(g.employee);
      const list = by.get(id) ?? [];
      list.push(g);
      by.set(id, list);
    }
    return [...by.entries()]
      .map(([id, list]) => {
        const active = list.filter(isOpen);
        const avg = weightedProgress(active);
        const overdue = active.filter((g) => g.due_date && g.due_date < todayStr()).length;
        return { id, active: active.length, avg, overdue };
      })
      .sort((a, b) => b.overdue - a.overdue || b.active - a.active);
  }, [teamGoals]);
  const [rollupOpen, setRollupOpen] = useState(() => readLocal("goals:rollup") !== "0");
  const toggleRollup = () => {
    setRollupOpen((o) => {
      writeLocal("goals:rollup", o ? "0" : "1");
      return !o;
    });
  };

  // Scoreboard over MY goals: what's in flight, how far along (weight-weighted), what's done, what's slipping.
  const stats = useMemo(() => {
    const active = myGoals.filter((g) => g.status === "in_progress" || g.status === "not_started");
    const done = myGoals.filter((g) => g.status === "completed");
    const overdue = active.filter((g) => g.due_date && g.due_date < todayStr());
    const avg = weightedProgress(active);
    return { active: active.length, avg, done: done.length, overdue: overdue.length };
  }, [myGoals]);

  const [rebalanceFor, setRebalanceFor] = useState<string | null>(null);

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

  // Counted over the goals the chips actually narrow: the search and the picked owner already applied, the
  // status dimension the chips own left open. A count taken org-wide would contradict the grid below it.
  const countable = useMemo(
    () => rows.filter((g) => matchesQuery(g) && (isMine(g) || !ownerFilter || (!!g.employee && idOf(g.employee) === ownerFilter))),
    [rows, q, ownerFilter, me.employee_id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const counts = useMemo(() => ({
    all: countable.length,
    active: countable.filter((g) => matchesFilter(g, "active")).length,
    overdue: countable.filter((g) => matchesFilter(g, "overdue")).length,
    at_risk: countable.filter(isAtRisk).length,
    quiet: countable.filter(isQuiet).length,
    unagreed: countable.filter((g) => g.stage !== "AGREED").length,
    completed: countable.filter((g) => g.status === "completed").length,
    cancelled: countable.filter((g) => g.status === "cancelled").length,
  }), [countable]);
  // Clicking a stat tile toggles the matching filter on/off.
  const toggleFilter = (f: Filter) => setFilter(filter === f ? "all" : f);

  // The set, rather than the goals in it: what state everything is in, and how each owner's in-flight work is
  // progressing. Both over `countable` / `rollup`, the sets the chips and the team overview already agree on.
  const goalCharts = useMemo(() => {
    const STATES: { key: string; label: string; color: string }[] = [
      { key: "not_started", label: "Not started", color: "#8a8a85" },
      { key: "in_progress", label: "In progress", color: "#2a78d6" },
      { key: "completed", label: "Completed", color: "#1baf7a" },
      { key: "cancelled", label: "Cancelled", color: "#e34948" },
    ];
    const states = STATES.map((s) => ({ ...s, n: countable.filter((g) => g.status === s.key).length })).filter((s) => s.n > 0);
    const owners = rollup.filter((r) => r.active > 0).slice(0, 10);
    const ownerName = (id: string) => {
      const e = empById.get(id);
      return e ? `${e.first_name} ${e.last_name}` : id;
    };
    return {
      total: countable.length,
      // A goal state is the same state the cards, chips and rings show, so it keeps that meaning's colour.
      states: { labels: states.map((s) => s.label), values: states.map((s) => s.n), colors: states.map((s) => s.color) },
      owners: { labels: owners.map((r) => ownerName(r.id)), values: owners.map((r) => r.avg) },
      ownerIds: owners.map((r) => r.id),
      ownerAvg: owners.length ? Math.round(owners.reduce((s, r) => s + r.avg, 0) / owners.length) : 0,
    };
  }, [countable, rollup, empById]);

  function openCreate() {
    setEditing(null);
    setEtag(undefined);
    setForm({ ...EMPTY });
    setOpen(true);
  }
  // Opening a goal writes its id into the hash (replaceState - no history churn), so the drawer is linkable and
  // a pasted link reopens exactly this goal through useDeepOpen.
  function openDetail(g: Goal) {
    setDetailPath(g.path);
    setRouteRecord(idOf(g.path));
  }
  function closeDetail() {
    setDetailPath(null);
    setRouteRecord(null);
  }
  // The drawer always renders the LIVE row (reload after an update swaps rows; a stale snapshot would revert the slider).
  const detailGoal = detailPath ? rows.find((g) => g.path === detailPath) ?? null : null;

  // The comment thread and the progress history come from the item Get, not the list - one goal's
  // conversation and one goal's climb, read when the drawer opens and never on the way past. Kept as their own
  // copy so a list reload doesn't drop them: the drawer renders the live LIST row, which carries neither.
  const [thread, setThread] = useState<{ path: string; comments: NonNullable<Goal["comments"]>; history: NonNullable<Goal["history"]> } | null>(null);
  useEffect(() => {
    if (!detailPath) { setThread(null); return; }
    let live = true;
    void get<Goal>(`goals/${idOf(detailPath)}`)
      .then((full) => { if (live) setThread({ path: detailPath, comments: full.comments ?? [], history: full.history ?? [] }); })
      .catch(() => { if (live) setThread({ path: detailPath, comments: [], history: [] }); });
    return () => { live = false; };
    // Re-read on the open goal's etag as well as its path: moving progress from inside the drawer changes the
    // very series the sparkline draws, and a copy taken once at open would go on showing the climb without
    // the step the person just made.
  }, [detailPath, detailGoal?.etag]);

  async function postComment(g: Goal, body: string) {
    const updated = await invoke<Goal>(`goals/${idOf(g.path)}`, "comment", undefined, { body });
    // The `:comment` answer is the same item read, history included, so the sparkline is kept rather than
    // dropped by the very call that refreshed the thread.
    setThread({ path: g.path, comments: updated.comments ?? [], history: updated.history ?? [] });
    reload(); // update_time moved, and the card's "recently active" ordering follows it
  }

  // Move a measured goal's current value. This IS its progress: the server recomputes the percentage and
  // completes the goal when the target is reached, so there is no slider to keep in step.
  async function setCurrentValue(g: Goal, value: number) {
    try {
      await patch(`goals/${idOf(g.path)}`, { current_value: value }, g.etag);
      const pct = measuredPct(g.baseline_value ?? undefined, g.target_value ?? undefined, value);
      toast({ title: pct === 100 ? "Target reached - goal complete" : `Now ${value}${g.unit ? ` ${g.unit}` : ""}${pct != null ? ` · ${pct}%` : ""}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the measure", description: (e as Error).message, variant: "destructive" });
    }
  }
  function openEdit(g: Goal) {
    setEditing(g);
    setEtag(g.etag);
    setForm({
      title: g.title,
      description: g.description ?? "",
      weight: g.weight != null ? String(g.weight) : "",
      status: g.status,
      due_date: g.due_date ?? "",
      employee: g.employee ? `employees/${idOf(g.employee)}` : "me",
      kind: (g.kind ?? "objective") as GoalKind,
      parent: g.parent ? `goals/${idOf(g.parent)}` : "none",
      cycle: g.cycle ? `review-cycles/${idOf(g.cycle)}` : "none",
      blockedBy: g.blocked_by ? `goals/${idOf(g.blocked_by)}` : "none",
      department: g.department ? `departments/${idOf(g.department)}` : "none",
      unit: g.unit ?? "",
      baseline: g.baseline_value != null ? String(g.baseline_value) : "",
      target: g.target_value != null ? String(g.target_value) : "",
      current: g.current_value != null ? String(g.current_value) : "",
    });
    setOpen(true);
  }

  // Throws to fail: WriteDialog pins the message in the form and keeps what was typed.
  async function submit() {
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      weight: form.weight === "" ? 0 : Number(form.weight),
      status: form.status,
      // A date field is `format: date` in the contract, and "" is not a date - an empty one is left out.
      ...(form.due_date ? { due_date: form.due_date } : {}),
      parent: form.parent === "none" ? "" : form.parent,
      kind: form.kind,
      blocked_by: form.blockedBy === "none" ? "" : form.blockedBy,
      department: form.department === "none" ? "" : form.department,
      // The review cycle this goal answers to. Cleared the same way a parent is: "" detaches it, and the
      // reviewee's review stops scoring it.
      cycle: form.cycle === "none" ? "" : form.cycle,
      // The measure travels whole, so clearing the target really does hand the goal back to manual progress.
      unit: form.unit.trim(),
      baseline_value: num(form.baseline) ?? null,
      target_value: num(form.target) ?? null,
      current_value: num(form.current) ?? null,
    };
    if (editing) {
      try {
        const saved = await patch<Goal>(`goals/${idOf(editing.path)}`, body, etag ?? editing.etag);
        setEtag(saved.etag);
      } catch (e) {
        // Lost race: the owner moved progress (or a manager edited the goal) while this dialog was open. Take
        // their etag so the next press goes through, and say so - "etag mismatch" tells nobody anything.
        if (isConflict(e)) {
          const fresh = await get<Goal>(`goals/${idOf(editing.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this goal while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
      toast({ title: "Goal updated", variant: "success" });
    } else {
      // Owner defaults to self; a manager/HR can file one for someone else (the server checks they may).
      const owner = form.employee && form.employee !== "me" ? { employee: form.employee } : {};
      await create<Goal>("goals", { ...body, ...owner });
      toast({ title: "Goal created", variant: "success" });
    }
    reload();
  }

  // The updateProgress verb: move a goal's progress (auto-advancing status off "not started" / to "completed").
  // An optional note travels with it into the goal's activity history.
  async function setProgress(g: Goal, progress: number, note?: string) {
    const status: GoalStatus | undefined =
      progress >= 100 && g.status !== "completed" ? "completed"
      : progress > 0 && g.status === "not_started" ? "in_progress"
      : undefined;
    try {
      await invoke(`goals/${idOf(g.path)}`, "updateProgress", undefined, {
        progress,
        ...(status ? { status } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      toast({ title: progress >= 100 ? "Goal marked complete" : `Progress set to ${progress}%`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update progress", description: (e as Error).message, variant: "destructive" });
    }
  }

  // The `setConfidence` verb: the owner's forward-looking call, which anyone who may report progress may also
  // make. Narrow on purpose - admitting a goal is slipping must not require rights to rewrite its definition.
  async function setConfidence(g: Goal, confidence: GoalConfidence) {
    try {
      await invoke(`goals/${idOf(g.path)}`, "setConfidence", undefined, { confidence });
      toast({ title: `Marked ${confidenceOf(confidence)!.label.toLowerCase()}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't set confidence", description: (e as Error).message, variant: "destructive" });
    }
  }

  // The closing note. An ordinary field write, kept as its own press so writing it does not mean opening the
  // whole edit form on a goal that is finished.
  async function saveRetro(g: Goal, retro: string) {
    try {
      await patch(`goals/${idOf(g.path)}`, { retro: retro || null }, g.etag);
      toast({ title: "Note saved", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't save the note", description: (e as Error).message, variant: "destructive" });
    }
  }

  // The goal-setting handshake. Three one-press moves, so the whole exchange happens on the goal itself
  // rather than in chat: the owner submits a draft, the manager agrees it, or sends it back saying why.
  async function runStage(g: Goal, verb: "propose" | "approve" | "requestChanges", body?: Record<string, unknown>, okMsg?: string) {
    try {
      await invoke(`goals/${idOf(g.path)}`, verb, undefined, body);
      toast({ title: okMsg ?? "Done", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the goal", description: (e as Error).message, variant: "destructive" });
    }
  }
  // Follow somebody else's goal. `reload()` rather than a local flip: the eye's state is a field on the goal
  // resource, so the list the drawer reads from has to carry the new value or the button springs back.
  async function toggleWatch(g: Goal) {
    try {
      await invoke(`goals/${idOf(g.path)}`, g.watching ? "unwatch" : "watch");
      toast({ title: g.watching ? "Stopped following" : "Following this goal", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't change that", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Contributors: the whole split is edited at once, because the shares only mean anything together.
  const [contribFor, setContribFor] = useState<Goal | null>(null);
  const [contribRows, setContribRows] = useState<{ employee: string; share: string }[]>([]);
  const contribTotal = contribRows.reduce((s2, r) => s2 + (Number(r.share) || 0), 0);
  // The split the goal's linked tasks already imply, derived by the server from who delivered each task and
  // how big it was. A first draft of the shares, never the credit: only a saved contributor scores.
  const suggestedContribRows = (g: Goal) => (g.suggested_contributors ?? []).map((c) => ({ employee: c.employee, share: String(c.share) }));
  // Open the editor on what is saved, falling back to the task split for a goal nobody has split yet - which
  // is the case where a manager would otherwise be reading the board and doing the percentages by hand.
  const openContributors = (g: Goal) => {
    setContribFor(g);
    const saved = (g.contributors ?? []).map((c) => ({ employee: c.employee, share: String(c.share ?? 0) }));
    setContribRows(saved.length ? saved : suggestedContribRows(g));
  };
  const contribSuggested = contribFor ? suggestedContribRows(contribFor) : [];
  const sameAsSuggested = contribSuggested.length === contribRows.length
    && contribSuggested.every((s2) => contribRows.some((r) => r.employee === s2.employee && (Number(r.share) || 0) === Number(s2.share)));

  // Sending a goal back needs a reason - a goal returned with no note is a goal returned twice - so it opens
  // a form rather than firing on the press.
  const [changesFor, setChangesFor] = useState<Goal | null>(null);
  const [changesNote, setChangesNote] = useState("");

  // Carry-over: clone an open, past-quarter goal into next quarter (progress kept) and cancel the original.
  // Undo deletes the clones and restores the originals' status. Sequential writes; user-initiated and rare.
  const canCarry = (g: Goal) =>
    isOpen(g) && !!g.due_date && g.due_date < currentQuarterStartStr() && (g.access?.can ?? []).includes("update");
  // The cycle the carried-over copy belongs to: the one whose review period contains its new due date. A goal
  // that rolls into next quarter is next quarter's goal, and attaching it now means the next review scores it
  // even if that cycle is already running (launching only claims goals that exist at launch).
  const nextCycleRef = useMemo(() => {
    const due = nextQuarterEndStr();
    const hit = reviewCycles.find((c) => c.state !== "CLOSED" && c.period_start && c.period_end && c.period_start <= due && due <= c.period_end);
    return hit ? `review-cycles/${idOf(hit.path)}` : undefined;
  }, [reviewCycles]);
  async function carryOver(list: Goal[]) {
    const made: { copy: Goal; old: Goal; oldStatus: GoalStatus }[] = [];
    try {
      for (const g of list) {
        const copy = await create<Goal>("goals", {
          title: g.title,
          description: g.description ?? "",
          weight: g.weight ?? 0,
          progress: g.progress ?? 0,
          status: g.status,
          due_date: nextQuarterEndStr(),
          ...(g.employee ? { employee: `employees/${idOf(g.employee)}` } : {}),
          ...(g.parent ? { parent: `goals/${idOf(g.parent)}` } : {}),
          ...(nextCycleRef ? { cycle: nextCycleRef } : {}),
        });
        await patch(`goals/${idOf(g.path)}`, { status: "cancelled" }, g.etag);
        made.push({ copy, old: g, oldStatus: g.status });
      }
      closeDetail();
      reload();
      toast({
        title: made.length === 1 ? "Goal carried over" : `${made.length} goals carried over`,
        description: `New due date ${formatDate(nextQuarterEndStr())}; the originals were cancelled.`,
        variant: "success",
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () => {
            Promise.all(made.map(async (m) => {
              await remove(`goals/${idOf(m.copy.path)}`);
              await patch(`goals/${idOf(m.old.path)}`, { status: m.oldStatus });
            }))
              .then(() => { toast({ title: "Carry-over undone", variant: "success" }); reload(); })
              .catch((e) => toast({ title: "Couldn't undo", description: (e as Error).message, variant: "destructive" }));
          },
        },
      });
    } catch (e) {
      toast({ title: "Couldn't carry over", description: (e as Error).message, variant: "destructive" });
      if (made.length) reload(); // partial progress is visible truth
    }
  }

  // Goal-side task linking (the board card editor is the other direction): PATCH the card's goal ref;
  // the server re-derives the goal's progress from its linked cards on every link/unlink/delivery.
  async function linkCard(g: Goal, card: KanbanCard, unlink = false) {
    try {
      // A CLEARED reference goes out as "", never null: the contract types the field as a string (see api.ts,
      // "No nulls on the wire"), so unlinking with a null is refused by the proxy with a 422 the worker never
      // sees - the same trap the task editor's department picker fell into.
      await patch(`cards/${idOf(card.path)}`, { goal: unlink ? "" : g.path }, card.etag);
      toast({ title: unlink ? "Task unlinked" : "Task linked", description: card.title, variant: "success" });
      reloadCards();
      reload(); // the goal's derived progress may have shifted
    } catch (e) {
      toast({ title: unlink ? "Couldn't unlink task" : "Couldn't link task", description: (e as Error).message, variant: "destructive" });
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

  // Alignment targets for the dialog: any visible, non-cancelled goal that isn't the goal itself or below it.
  // A key result never parents anything - the ladder is objective -> key result, one rung deep, or the
  // "weighted average of my children" rule stops meaning anything.
  const alignables = rows.filter((g) => g.status !== "cancelled" && g.kind !== "key_result" && (!editing || !descendantsOf(editing).has(idOf(g.path))));

  // The measure, read back live: the percentage the server will compute, and the two shapes worth naming (a
  // target that equals the baseline measures nothing; a target below it counts down).
  const measurePct = measuredPct(num(form.baseline), num(form.target), num(form.current));
  const targetEqualsBaseline = num(form.target) != null && num(form.target) === (num(form.baseline) ?? 0);
  const countsDown = num(form.target) != null && num(form.target)! < (num(form.baseline) ?? 0);

  // Duplicate guard: an open goal the same owner already has under this title.
  const dupTitle = useMemo(() => {
    const t = form.title.trim().toLowerCase();
    if (t.length < 3 || !dialogOwnerId) return null;
    return rows.find((g) =>
      g.path !== editing?.path && isOpen(g) && g.employee && idOf(g.employee) === dialogOwnerId && g.title.trim().toLowerCase() === t,
    ) ?? null;
  }, [rows, form.title, dialogOwnerId, editing?.path]);

  useIntent("new-goal", openCreate);

  const createBtn = (
    <AccessAction collection="goals" create label="New goal">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New goal</Button>
    </AccessAction>
  );

  // Flat grid, or (in the quarter view) one sub-grid per due quarter.
  const gridView = (list: Goal[], team = false) => {
    if (view === "flat") return grid(list, team);
    const groups = new Map<string, { sort: number; goals: Goal[] }>();
    for (const g of list) {
      const { label, sort } = quarterOf(g);
      const grp = groups.get(label) ?? { sort, goals: [] };
      grp.goals.push(g);
      groups.set(label, grp);
    }
    return (
      <div className="space-y-4">
        {[...groups.entries()].sort((a, b) => a[1].sort - b[1].sort).map(([label, grp]) => (
          <div key={label} className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {label} <span className="tabular-nums text-muted-foreground/70">{grp.goals.length}</span>
            </h3>
            {grid(grp.goals, team)}
          </div>
        ))}
      </div>
    );
  };

  const grid = (list: Goal[], team = false) => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((g) => (
        <AccessItem key={g.path} collection="goals" objectPath={g.path} can={g.access?.can} why={g.access?.why} label={g.title}>
          <GoalCard
            goal={g}
            owner={team && g.employee ? empById.get(idOf(g.employee)) : undefined}
            parentTitle={parentOf(g)?.title}
            cycleTitle={cycleName(g.cycle)}
            blockedByTitle={g.blocked_by ? rows.find((x) => idOf(x.path) === idOf(g.blocked_by!))?.title : undefined}
            deptTitle={deptName(g.department)}
            onOpen={() => openDetail(g)}
            onEdit={() => openEdit(g)}
            onDelete={() => sd.softDelete(g)}
            onProgress={(p) => setProgress(g, p)}
          />
        </AccessItem>
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
            {/* A wall of goal cards says how each goal is doing and nothing about how the SET is doing.
                These two do: what state the goals are in, and how far along each owner's are - which is the
                question the team overview chips answer one person at a time. They lead the page: every tile
                and chip below them filters the goals, so those belong next to the goals. */}
            {goalCharts.total > 2 && (
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCard title="Goals by state" description="Every goal in view, by where it has got to.">
                  <Chart
                    type="donut"
                    height={200}
                    labels={goalCharts.states.labels}
                    datasets={[{ name: "Goals", values: goalCharts.states.values }]}
                    colors={goalCharts.states.colors}
                    ariaLabel="Goals by state"
                  />
                </ChartCard>
                {goalCharts.owners.labels.length > 1 && (
                  <ChartCard title="Progress by owner" description="Weighted average progress across each person's goals in flight.">
                    <Chart
                      type="bar"
                      height={Math.min(320, Math.max(160, goalCharts.owners.labels.length * 34 + 60))}
                      labels={goalCharts.owners.labels}
                      datasets={[{ name: "Progress", values: goalCharts.owners.values }]}
                      markers={goalCharts.ownerAvg > 0 ? [{ label: `Team ${goalCharts.ownerAvg}%`, value: goalCharts.ownerAvg }] : undefined}
                      format={(v) => `${v}%`}
                      ariaLabel="Average progress on goals in flight, by owner"
                      onSelect={(i) => { const id = goalCharts.ownerIds[i]; setOwnerFilter((f) => (f === id ? null : id ?? null)); }}
                    />
                  </ChartCard>
                )}
              </div>
            )}

            {/* My scoreboard: only when the caller owns goals. Overdue tile heats up when non-zero. */}
            {myGoals.length > 0 && (
              // Counts and percentages - short enough to sit two across a phone rather than filling four
              // rows above the goals themselves.
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="Active goals" value={String(stats.active)} onClick={() => toggleFilter("active")} active={filter === "active"} />
                <StatTile label="Average progress" value={`${stats.avg}%`} bar={stats.avg} />
                <StatTile label="Completed" value={String(stats.done)} onClick={() => toggleFilter("completed")} active={filter === "completed"} />
                <StatTile label="Overdue" value={String(stats.overdue)} alert={stats.overdue > 0} onClick={() => toggleFilter("overdue")} active={filter === "overdue"} />
              </div>
            )}
            {me.employee_id && openWeightSum(me.employee_id) > 100 && (
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Your open goals total {openWeightSum(me.employee_id)} weight, over the usual 100.{" "}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setRebalanceFor(me.employee_id!)}>Rebalance</button>
              </p>
            )}

            {filter === "overdue" && (() => {
              const carryable = [...myShown, ...teamShown].filter(canCarry);
              if (!carryable.length) return null;
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300/60 bg-amber-50/50 px-3 py-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                  <span>{carryable.length} overdue goal{carryable.length === 1 ? "" : "s"} from earlier quarters.</span>
                  <AccessAction collection="goals" create label="Carry goals over">
                    <Button size="sm" variant="outline" onClick={() => carryOver(carryable)}>Carry over to next quarter</Button>
                  </AccessAction>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center gap-1.5">
              {filterChip("all", "All")}
              {filterChip("active", "Active")}
              {(counts.overdue > 0 || filter === "overdue") && filterChip("overdue", "Overdue")}
              {/* Behind pace, and gone quiet: both arrive weeks before a missed date, and both are hidden
                  inside "Active" until you ask for them by name. Shown only when there are any. */}
              {(counts.at_risk > 0 || filter === "at_risk") && filterChip("at_risk", "At risk")}
              {(counts.quiet > 0 || filter === "quiet") && filterChip("quiet", "Gone quiet")}
              {(counts.unagreed > 0 || filter === "unagreed") && filterChip("unagreed", "Not agreed")}
              {filterChip("completed", "Completed")}
              {filterChip("cancelled", "Cancelled")}
              {/* Wraps, because the three controls in here are 550px of fixed widths (a 176px cycle select,
                  the view toggle, a 176px search box) and a phone is 390: without it the row could not break
                  and the whole PAGE scrolled sideways - and only once an org had a review cycle to pick from,
                  which is why an empty database never showed it. */}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {/* Narrow to one cycle's goals, or to the ones no cycle will score. Filtered by the SERVER
                    (`?cycle=`), because "which goals belong to H1" is a question about every goal, not about
                    the page of them this browser happens to hold. */}
                {reviewCycles.length > 0 && (
                  <Select value={cycleFilter} onValueChange={setCycleFilter}>
                    <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All cycles</SelectItem>
                      <SelectItem value="none">No cycle</SelectItem>
                      {reviewCycles.map((c) => (
                        <SelectItem key={c.path} value={`review-cycles/${idOf(c.path)}`}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className="flex overflow-hidden rounded-md border text-xs font-medium">
                  {(["flat", "quarter", "tree"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      title={v === "tree" ? "The alignment cascade: what rolls up into what, from the top" : undefined}
                      className={cn("px-2.5 py-1 transition-colors", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
                    >
                      {v === "flat" ? "All" : v === "quarter" ? "By quarter" : "Alignment"}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search goals…" className="h-8 w-44 pl-8 text-sm sm:w-56" />
                </div>
              </div>
            </div>

            {/* The cascade replaces the two owner sections rather than sitting beside them: its whole point is
                that it does NOT split the goals by whose they are - it splits them by what they roll up into,
                which is a different question and the one alignment is for. */}
            {view === "tree" && (
              <AlignmentTree
                goals={[...myShown, ...teamShown]}
                all={rows}
                empName={empName}
                meId={me.employee_id}
                onOpen={(g) => openDetail(g)}
              />
            )}

            {view !== "tree" && myShown.length > 0 && (
              <section className="space-y-3">
                {teamShown.length > 0 && (
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Target className="h-3.5 w-3.5" /> My goals <span className="font-normal tabular-nums text-muted-foreground/70">{myShown.length}</span>
                  </h2>
                )}
                {gridView(myShown)}
              </section>
            )}
            {view !== "tree" && (teamShown.length > 0 || ownerFilter) && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Users className="h-3.5 w-3.5" /> Team goals <span className="font-normal tabular-nums text-muted-foreground/70">{teamShown.length}</span>
                  {rollup.length >= 2 && (
                    <button type="button" className="ml-auto font-medium normal-case tracking-normal text-primary hover:underline" onClick={toggleRollup}>
                      {rollupOpen ? "Hide overview" : "Team overview"}
                    </button>
                  )}
                </h2>
                {rollup.length >= 2 && rollupOpen && (
                  <div className="flex flex-wrap gap-2">
                    {rollup.map((r) => {
                      const e = empById.get(r.id);
                      if (!e) return null;
                      const name = `${e.first_name} ${e.last_name}`;
                      const selected = ownerFilter === r.id;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setOwnerFilter(selected ? null : r.id)}
                          className={cn(
                            "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/50",
                            selected && "border-primary ring-1 ring-primary",
                          )}
                        >
                          <PhotoAvatar employeeId={r.id} name={name} photo={e.photo} className="h-6 w-6" />
                          <span className="max-w-[7rem] truncate font-medium">{name}</span>
                          <span className="tabular-nums text-muted-foreground">{r.active} active</span>
                          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${r.avg}%` }} />
                          </span>
                          <span className="tabular-nums text-muted-foreground">{r.avg}%</span>
                          {r.overdue > 0 && <Badge variant="destructive">{r.overdue} overdue</Badge>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {teamShown.length > 0
                  ? gridView(teamShown, true)
                  : <p className="text-sm text-muted-foreground">No goals match for this person. <button type="button" className="font-medium text-primary hover:underline" onClick={() => setOwnerFilter(null)}>Show whole team</button></p>}
              </section>
            )}
            {myShown.length === 0 && teamShown.length === 0 && !ownerFilter && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {q.trim() ? "Nothing matches this search." : "Nothing matches this filter."}{" "}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setFilter("all"); setQ(""); }}>Show all</button>
              </p>
            )}
          </div>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={<span className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> {editing ? "Edit goal" : "New goal"}</span>}
        description={editing
          ? "Changes show on the owner's Goals page. Weight only counts while the goal is open."
          : "The owner sees it on their Goals page straight away. Weight is how much it counts toward their 100; link board tasks later and progress follows their delivery."}
        collection="goals"
        objectPath={editing?.path}
        guardLabel="goal"
        form={form}
        draftKey={editing ? undefined : "goal:new"}
        applyDraft={(d) => setForm(d)}
        onStartOver={editing ? undefined : () => setForm({ ...EMPTY })}
        submitLabel={editing ? "Save changes" : "Create goal"}
        canSubmit={!!form.title.trim() && !weightInvalid && !targetEqualsBaseline && !(form.kind === "key_result" && form.parent === "none")}
        whyNot={[
          !form.title.trim() && "Give the goal a title.",
          weightInvalid && "Weight has to be between 0 and 100.",
          form.kind === "key_result" && form.parent === "none" && "Pick the objective this key result sits under.",
          targetEqualsBaseline && "The target and the baseline are the same number.",
        ]}
        onSubmit={submit}
        addAnother={editing ? undefined : () => setForm({ ...EMPTY, employee: form.employee })}
        addAnotherLabel="Save & add another"
        submitAccess={(b) => (editing
          ? <AccessAction label="Edit goal" can={editing.access?.can}>{b}</AccessAction>
          : <AccessAction create label="New goal">{b}</AccessAction>)}
      >
          <Field label="Title" field="title"><Input value={form.title} placeholder="e.g. Ship the billing revamp" onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
          <Field label="Description (optional)" field="description"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" /></Field>
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
          {/* The measure. A goal that counts something doesn't need anyone's estimate of how far along it is:
              with a target and a current value the percentage is arithmetic, and the slider stops being an
              opinion poll. Baseline matters for the goals that start above zero - churn 8% to 4% with 6% today
              is half done, not nearly finished. */}
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Measure (optional)</p>
              {measurePct != null && (
                <span className="text-xs font-medium tabular-nums text-primary">{measurePct}% complete</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {measurePct != null
                ? "Progress is computed from these numbers, so the slider is read-only for this goal."
                : "Give it a target and progress stops being a guess. Leave empty to move progress by hand."}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Field label="Baseline" field="baseline_value" hint="Where it started.">
                <Input type="number" value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} placeholder="0" />
              </Field>
              <Field label="Current" field="current_value">
                <Input type="number" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} placeholder="0" />
              </Field>
              <Field label="Target" field="target_value" error={targetEqualsBaseline ? "Target and baseline are the same, so there is nothing to measure." : undefined}>
                <Input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="60" />
              </Field>
              <Field label="Unit" field="unit" hint="customers, %, days">
                <Input value={form.unit} maxLength={24} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="customers" />
              </Field>
            </div>
            {measurePct === 100 && (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Saving this hits the target, which completes the goal.</p>
            )}
            {countsDown && (
              <p className="mt-2 text-xs text-muted-foreground">Counting down from {form.baseline} to {form.target}{form.unit ? ` ${form.unit}` : ""}.</p>
            )}
          </div>
          <FieldRow>
            <Field
              label="Weight"
              field="weight"
              hint={otherWeights > 0 ? `Other open goals total ${otherWeights}; with this one ${weightTotal} of 100.` : "Relative importance (0-100)."}
              error={weightInvalid ? "Weight must be between 0 and 100." : undefined}
            >
              <Input type="number" min={0} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Due date (optional)">
              <Input type="date" value={form.due_date} min={!editing ? todayStr() : undefined} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {quickDue().map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => setForm({ ...form, due_date: o.value })}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                      form.due_date === o.value ? "border-primary text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Field>
          </FieldRow>
          {!weightInvalid && weightTotal > 100 && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Open goals would total {weightTotal} weight, over the usual 100.{" "}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setOpen(false); setRebalanceFor(dialogOwnerId || null); }}>
                Rebalance
              </button>
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
          {/* The review cycle this goal answers to. A cycle's review scores exactly the goals attached to it,
              so this is the field that decides whether the goal shows up in someone's review at all. */}
          {reviewCycles.length > 0 && (
            <Field label="Review cycle (optional)" hint="The cycle whose review scores this goal.">
              <Select value={form.cycle} onValueChange={(v) => setForm({ ...form, cycle: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No cycle</SelectItem>
                  {reviewCycles.map((c) => (
                    <SelectItem key={c.path} value={`review-cycles/${idOf(c.path)}`}>
                      {c.name}{c.state === "CLOSED" ? " (closed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {/* Objective or key result. A KR is one of the numbers under an objective, so choosing it makes the
              alignment below mandatory - and hands the objective's percentage to the arithmetic. */}
          <Field label="Kind" hint={form.kind === "key_result" ? "A number under an objective. Its objective's progress is the weighted average of its key results." : "A goal in its own right. Add key results under it and its progress becomes theirs."}>
            <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as GoalKind })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="objective">Objective</SelectItem>
                <SelectItem value="key_result">Key result</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {departments.length > 0 && (
            <Field label="Owned by a team (optional)" hint="Set when a department owns this goal. The person above stays the accountable lead.">
              <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">One person owns it</SelectItem>
                  {departments.filter((d) => !d.delete_time).map((d) => (
                    <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {/* Waiting on another goal. Distinct from alignment: that says what this rolls UP into, this says
              what has to move first - and it is the answer to "why did this sit at 20% all quarter" far more
              often than effort is. */}
          {alignables.length > 0 && (
            <Field label="Waiting on (optional)" hint="Another goal that has to move before this one can.">
              <Combobox
                value={form.blockedBy}
                onValueChange={(v) => setForm({ ...form, blockedBy: v })}
                searchPlaceholder="Search goals…"
                options={[
                  { value: "none", label: "Not blocked" },
                  ...rows.filter((g) => g.status !== "cancelled" && (!editing || g.path !== editing.path)).map((g) => ({
                    value: `goals/${idOf(g.path)}`,
                    label: g.employee && idOf(g.employee) !== me.employee_id ? `${g.title} - ${empName(g.employee)}` : g.title,
                  })),
                ]}
              />
            </Field>
          )}
          {alignables.length > 0 && (
            <Field
              label={form.kind === "key_result" ? "Objective" : "Aligns to"}
              hint={form.kind === "key_result" ? "The objective this key result proves. Required." : "Optional parent goal this one rolls up under."}
              error={form.kind === "key_result" && form.parent === "none" ? "A key result needs an objective to sit under." : undefined}
            >
              <Combobox
                value={form.parent}
                onValueChange={(v) => setForm({ ...form, parent: v })}
                searchPlaceholder="Search goals…"
                options={[
                  { value: "none", label: "No alignment" },
                  ...alignables.map((g) => ({
                    value: `goals/${idOf(g.path)}`,
                    label: g.employee && idOf(g.employee) !== me.employee_id ? `${g.title} - ${empName(g.employee)}` : g.title,
                  })),
                ]}
              />
            </Field>
          )}
          {/* Same title already open for the same person: warned, never blocked - two goals may honestly share a
              name, and the owner is the one who knows. */}
          {dupTitle && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {dialogOwnerId === me.employee_id ? "You already have" : `${empName(`employees/${dialogOwnerId}`)} already has`} an open goal called
              “{dupTitle.title}”{dupTitle.due_date ? `, due ${formatDate(dupTitle.due_date)}` : ""}.
            </p>
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>

      <RebalanceDialog
        // Keyed on the owner so the weights seed at mount rather than in an effect (see the dialog).
        key={rebalanceFor ?? "none"}
        ownerId={rebalanceFor}
        goals={rebalanceFor ? sortGoals(rows.filter((g) => g.employee && idOf(g.employee) === rebalanceFor && isOpen(g))) : []}
        ownerName={rebalanceFor === me.employee_id ? "your" : `${empName(`employees/${rebalanceFor}`)}'s`}
        onClose={() => setRebalanceFor(null)}
        onSaved={() => { setRebalanceFor(null); reload(); }}
        onRefresh={reload}
      />

      <Sheet open={!!detailGoal} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        {detailGoal && (
          <GoalDrawer
            goal={detailGoal}
            owner={detailGoal.employee ? empById.get(idOf(detailGoal.employee)) : undefined}
            mine={isMine(detailGoal)}
            parent={parentOf(detailGoal)}
            kids={childrenOf(detailGoal)}
            kidOwnerName={empName}
            onOpenGoal={openDetail}
            queue={drawerQueue}
            onStep={(g) => openDetail(g)}
            onCopyLink={() => {
              navigator.clipboard.writeText(recordUrl("goals", idOf(detailGoal.path))).then(
                () => toast({ title: "Link copied", description: "Anyone who can see this goal can open it." }),
                () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
              );
            }}
            linked={linkedFor(detailGoal)}
            linkable={cards.filter((c) => !c.delete_time && !c.goal && !c.deliver_time && (c.access?.can ?? []).includes("update"))}
            onLink={(c) => linkCard(detailGoal, c)}
            onUnlink={(c) => linkCard(detailGoal, c, true)}
            comments={thread?.path === detailGoal.path ? thread.comments : undefined}
            history={thread?.path === detailGoal.path ? thread.history : undefined}
            onComment={(body) => postComment(detailGoal, body)}
            onCurrentValue={(v) => setCurrentValue(detailGoal, v)}
            employees={employees}
            onEdit={() => { closeDetail(); openEdit(detailGoal); }}
            onDelete={() => { closeDetail(); void sd.softDelete(detailGoal); }}
            onProgress={(p, note) => setProgress(detailGoal, p, note)}
            onConfidence={(c) => setConfidence(detailGoal, c)}
            onRetro={(retro) => saveRetro(detailGoal, retro)}
            onContributors={() => openContributors(detailGoal)}
            onWatch={() => toggleWatch(detailGoal)}
            onPropose={() => runStage(detailGoal, "propose", undefined, "Submitted for approval")}
            onApprove={() => runStage(detailGoal, "approve", undefined, "Goal agreed")}
            onRequestChanges={() => setChangesFor(detailGoal)}
            onCarryOver={canCarry(detailGoal) ? () => carryOver([detailGoal]) : undefined}
          />
        )}
      </Sheet>

      {/* Who else worked on this goal, and how much of it was theirs. Sent as a whole set. */}
      <WriteDialog
        open={!!contribFor}
        onClose={() => setContribFor(null)}
        title="Contributors"
        description={contribFor ? `A share of “${contribFor.title}” counts in that person's own review, at this goal's weight scaled by it. The owner keeps whatever is left.` : undefined}
        collection="goals"
        objectPath={contribFor?.path}
        guardLabel="contributors"
        form={{ rows: contribRows }}
        submitLabel="Save contributors"
        canSubmit={contribTotal <= 100 && contribRows.every((r) => r.employee)}
        whyNot={[contribTotal > 100 && `The shares add up to ${contribTotal}% - a goal cannot credit more than itself.`]}
        onSubmit={async () => {
          const g = contribFor!;
          await invoke(`goals/${idOf(g.path)}`, "setContributors", undefined, {
            contributors: contribRows.filter((r) => r.employee).map((r) => ({ employee: r.employee, share: Number(r.share) || 0 })),
          });
          toast({ title: "Contributors saved", variant: "success" });
          setContribFor(null);
          closeDetail();
          reload();
        }}
      >
        <div className="space-y-2">
          {/* What the board already says: who delivered the linked tasks, and how big their share of the
              delivered work was. The manager still decides - this only saves them doing the arithmetic. */}
          {contribSuggested.length > 0 && (
            <div className="rounded-md border border-dashed bg-muted/40 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">Split implied by the linked tasks</span>
                {sameAsSuggested ? (
                  <span className="text-muted-foreground">In use</span>
                ) : (
                  <Button variant="outline" size="sm" className="h-7" onClick={() => setContribRows(contribSuggested)}>Use this split</Button>
                )}
              </div>
              <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                {(contribFor?.suggested_contributors ?? []).map((c) => (
                  <li key={c.employee} className="tabular-nums">
                    {empName(c.employee)} - {c.share}% · {c.delivered_points} pt{c.delivered_points === 1 ? "" : "s"} across {c.delivered_tasks} delivered task{c.delivered_tasks === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-muted-foreground">
                Shares of the work delivered on the board. The owner keeps the rest, including anything unassigned or not yet delivered.
              </p>
            </div>
          )}
          {contribRows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Combobox
                  value={r.employee}
                  onValueChange={(v) => setContribRows((rows) => rows.map((x, j) => (j === i ? { ...x, employee: v } : x)))}
                  searchPlaceholder="Search people…"
                  options={employees
                    .filter((e) => idOf(e.path) !== idOf(contribFor?.employee ?? ""))
                    .map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
                />
              </div>
              <Input
                type="number" min={0} max={100} className="w-20"
                value={r.share}
                onChange={(e) => setContribRows((rows) => rows.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)))}
                aria-label="Share (%)"
              />
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive" aria-label="Remove contributor" onClick={() => setContribRows((rows) => rows.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => setContribRows((rows) => [...rows, { employee: "", share: "" }])}>
              <Plus className="h-3.5 w-3.5" /> Add contributor
            </Button>
            <span className={cn("text-xs tabular-nums", contribTotal > 100 ? "font-medium text-destructive" : "text-muted-foreground")}>
              {contribTotal}% shared · owner keeps {Math.max(0, 100 - contribTotal)}%
            </span>
          </div>
        </div>
      </WriteDialog>

      {/* Send a proposed goal back. The note lands as a comment on the goal, so the owner's reply has
          somewhere to go and the exchange stays on the record it is about. */}
      <WriteDialog
        open={!!changesFor}
        onClose={() => { setChangesFor(null); setChangesNote(""); }}
        title="Send this goal back"
        description={changesFor ? `“${changesFor.title}” goes back to a draft, with your note on the goal.` : undefined}
        collection="goals"
        objectPath={changesFor?.path}
        guardLabel="note"
        form={{ note: changesNote }}
        submitLabel="Send back"
        canSubmit={!!changesNote.trim()}
        whyNot={[!changesNote.trim() && "Say what needs changing."]}
        onSubmit={async () => {
          const g = changesFor!;
          await invoke(`goals/${idOf(g.path)}`, "requestChanges", undefined, { note: changesNote.trim() });
          toast({ title: "Sent back with your note", variant: "success" });
          setChangesFor(null);
          setChangesNote("");
          closeDetail();
          reload();
        }}
      >
        <Field label="What needs changing?" field="note">
          <Textarea rows={4} value={changesNote} onChange={(e) => setChangesNote(e.target.value)} placeholder="e.g. make this measurable - what number are we aiming at?" autoFocus />
        </Field>
      </WriteDialog>
    </div>
    </TooltipProvider>
  );
}

// One owner's open goals with inline weight inputs and a live total - fix an over-100 spread in one place
// instead of reopening each goal. Saves one PATCH per changed goal (writes are rare and user-initiated).
function RebalanceDialog({ ownerId, goals, ownerName, onClose, onSaved, onRefresh }: {
  ownerId: string | null;
  goals: Goal[];
  ownerName: string;
  onClose: () => void;
  onSaved: () => void;
  /** Reload the rows without closing - for a run of writes that stopped partway. */
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  // Seeded once, at mount: the parent keys this component on the owner, so opening it for someone else
  // remounts with their weights. Seeding in an effect instead would land AFTER the discard guard has taken its
  // baseline, and an untouched dialog would ask about changes nobody made on the way out.
  const [weights, setWeights] = useState<Record<string, string>>(() =>
    Object.fromEntries(goals.map((g) => [g.path, String(g.weight ?? 0)])),
  );
  const val = (g: Goal) => Number(weights[g.path] ?? g.weight ?? 0) || 0;
  const total = goals.reduce((s, g) => s + val(g), 0);
  const invalid = goals.some((g) => val(g) < 0 || val(g) > 100);
  const changed = goals.filter((g) => val(g) !== (g.weight ?? 0));
  const editable = goals.filter((g) => (g.access?.can ?? []).includes("update"));
  const locked = goals.length - editable.length;
  const lockedTotal = goals.filter((g) => !(g.access?.can ?? []).includes("update")).reduce((s, g) => s + val(g), 0);
  const editableTotal = editable.reduce((s, g) => s + val(g), 0);
  // What the dialog opened with, so "Undo" is one press rather than remembering six numbers.
  const seeded = useMemo(() => Object.fromEntries(goals.map((g) => [g.path, String(g.weight ?? 0)])), [goals]);
  const undoable = changed.length > 0;

  // The room the editable rows have to share: what is left of 100 after the weights nobody here can move.
  const room = Math.max(0, 100 - lockedTotal);
  const spread = (next: number[]) => setWeights((w) => ({ ...w, ...Object.fromEntries(editable.map((g, i) => [g.path, String(next[i] ?? 0)])) }));
  // Equal shares, with the rounding remainder handed to the first rows so the total lands exactly on `room`
  // instead of 99 or 101.
  const even = () => {
    const base = Math.floor(room / editable.length);
    const rem = room - base * editable.length;
    spread(editable.map((_, i) => base + (i < rem ? 1 : 0)));
  };
  // Keep the relative sizes, scale them to fit. Same remainder handling, biggest-first so the rounding lands on
  // the goals that matter most.
  const normalise = () => {
    if (editableTotal === 0) return;
    const raw = editable.map((g) => (val(g) / editableTotal) * room);
    const floored = raw.map((n) => Math.floor(n));
    let rem = room - floored.reduce((s, n) => s + n, 0);
    const order = raw.map((n, i) => ({ i, frac: n - Math.floor(n) })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) { if (rem <= 0) break; floored[i]! += 1; rem--; }
    spread(floored);
  };

  async function save() {
    // One PATCH per changed goal, and a failure halfway leaves the ones already written: refresh the rows and
    // say how far it got, rather than reporting a clean failure over a half-applied spread.
    let done = 0;
    try {
      for (const g of changed) { await patch(`goals/${idOf(g.path)}`, { weight: val(g) }, g.etag); done++; }
    } catch (e) {
      if (done > 0) onRefresh();
      throw new Error(done === 0
        ? describeError(e)
        : `${done} of ${changed.length} goals were rebalanced before this failed: ${describeError(e)}`);
    }
    toast({ title: "Weights updated", description: `${changed.length} goal${changed.length === 1 ? "" : "s"} rebalanced.`, variant: "success" });
  }

  return (
    <WriteDialog
      open={!!ownerId}
      onClose={onClose}
      title={<span className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> Rebalance weights</span>}
      description={`Spread ${ownerName} open goals' weights; 100 total is the convention. Completed and cancelled goals don't count.`}
      collection="goals"
      guardLabel="weights"
      form={weights}
      submitLabel="Save weights"
      canSubmit={!invalid && changed.length > 0}
      whyNot={invalid ? "Every weight has to be between 0 and 100." : "Change a weight to save."}
      onSubmit={save}
      onSaved={onSaved}
      footerStart={
        <span className={cn("text-sm font-medium tabular-nums", total > 100 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          Total: {total} / 100
        </span>
      }
    >
      {/* Hitting 100 across seven goals is arithmetic, and doing arithmetic in seven number inputs is how
          weights end up at 105 and stay there. Two spreads and an undo cover every real case: they weigh the
          same, or they keep their relative sizes. Only editable rows move; the rest are somebody else's. */}
      {editable.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={even}>Split evenly</Button>
          <Button type="button" variant="outline" size="sm" disabled={editableTotal === 0} onClick={normalise}>Scale to 100</Button>
          {undoable && <Button type="button" variant="ghost" size="sm" onClick={() => setWeights(seeded)}>Undo</Button>}
          <span className="text-xs text-muted-foreground">
            {locked > 0
              ? `Across the ${editable.length} you can edit; the other ${locked} hold ${lockedTotal}.`
              : `Across all ${editable.length}.`}
          </span>
        </div>
      )}
      <ul className="space-y-2">
        {goals.map((g) => {
          const editable = (g.access?.can ?? []).includes("update");
          const moved = val(g) - (g.weight ?? 0);
          return (
            <li key={g.path} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm" title={g.title}>{g.title}</span>
              {/* What this row is about to change by, beside the row it changes - the total alone doesn't say
                  which goal moved. */}
              {moved !== 0 && (
                <span className={cn("shrink-0 text-xs tabular-nums", moved > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  {moved > 0 ? "+" : ""}{moved}
                </span>
              )}
              <Input
                type="number" min={0} max={100}
                value={weights[g.path] ?? String(g.weight ?? 0)}
                onChange={(e) => setWeights((w) => ({ ...w, [g.path]: e.target.value }))}
                className="h-8 w-20 text-right tabular-nums"
                disabled={!editable}
                aria-label={`Weight for ${g.title}`}
              />
            </li>
          );
        })}
      </ul>
      {locked > 0 && (
        <p className="text-xs text-muted-foreground">
          {locked} of these {locked === 1 ? "is" : "are"} read-only for you, so {locked === 1 ? "its weight" : "their weights"} can't move here.
        </p>
      )}
    </WriteDialog>
  );
}

// Right-docked detail drawer: the "see everything" surface for one goal - full description, progress with an
// optional what-changed note, linked board tasks (link/unlink from the goal side), and the activity history.
function GoalDrawer({ goal, owner, mine, parent, kids, kidOwnerName, onOpenGoal, queue, onStep, onCopyLink, linked, linkable, onLink, onUnlink, onEdit, onDelete, onProgress, onConfidence, onContributors, onWatch, onRetro, onPropose, onApprove, onRequestChanges, onCarryOver, comments, history, onComment, onCurrentValue, employees }: {
  goal: Goal;
  owner?: Employee;
  mine: boolean;
  parent?: Goal;
  kids: Goal[];
  kidOwnerName: (ref?: string) => string;
  onOpenGoal: (g: Goal) => void;
  /** The goals on screen, in screen order - what ‹ › and j/k walk. */
  queue: Goal[];
  onStep: (g: Goal) => void;
  onCopyLink: () => void;
  linked: KanbanCard[];
  linkable: KanbanCard[];
  onLink: (c: KanbanCard) => void;
  onUnlink: (c: KanbanCard) => void;
  onEdit: () => void;
  onDelete: () => void;
  onProgress: (progress: number, note?: string) => void;
  /** The owner's forward-looking call, through the narrow `:setConfidence` verb. */
  onConfidence: (confidence: GoalConfidence) => void;
  /** Open the contributor editor for this goal. */
  onContributors: () => void;
  /** Follow / unfollow this goal (a toggle - the current state is `goal.watching`). */
  onWatch: () => void;
  /** Save the closing "what happened" note. */
  onRetro: (retro: string) => void;
  /** The goal-setting handshake: submit, agree, or send back with a reason. */
  onPropose: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onCarryOver?: () => void;
  /** The thread from the item Get. `undefined` while it is still loading, `[]` when there is nothing yet. */
  comments?: NonNullable<Goal["comments"]>;
  /** The progress series, also item-Get only: a list row carries an empty one, so it cannot come off `goal`. */
  history?: NonNullable<Goal["history"]>;
  onComment: (body: string) => Promise<void>;
  /** Move a measured goal's current value - the measure IS its progress. */
  onCurrentValue: (value: number) => void;
  /** For putting a face and a name on each comment; the list is already in the page's cache. */
  employees: Employee[];
}) {
  const can = goal.access?.can ?? [];
  const canEdit = can.includes("update");
  const canDelete = can.includes("delete");
  const hasLinked = linked.length > 0;
  const closed = goal.status === "completed" || goal.status === "cancelled";
  const canProgress = !hasLinked && !closed && !goal.measured && !goal.rolled_up && (canEdit || can.includes("updateProgress"));
  const badge = statusBadge[goal.status];
  const due = goal.due_date ? dueRel(goal.due_date) : null;
  const overdue = !!due?.overdue && !closed;
  const tone = goal.status === "completed" ? "done" : overdue ? "overdue" : goal.status === "cancelled" ? "muted" : "normal";

  // A measured goal owns its own progress (the server recomputes it), so the slider is not offered for one.
  const measured = !!goal.measured;
  const canMeasure = measured && !closed && canEdit;
  const [cur, setCur] = useState(String(goal.current_value ?? 0));
  const curMoved = cur.trim() !== "" && !Number.isNaN(Number(cur)) && Number(cur) !== (goal.current_value ?? 0);
  const curPct = measuredPct(goal.baseline_value ?? undefined, goal.target_value ?? undefined, Number(cur));

  const [prog, setProg] = useState(goal.progress ?? 0);
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  useEffect(() => { setProg(goal.progress ?? 0); setNote(""); setDraft(""); setCur(String(goal.current_value ?? 0)); }, [goal.path, goal.progress, goal.current_value]);
  const dirty = prog !== (goal.progress ?? 0);
  const save = () => { if (dirty) { onProgress(prog, note); setNote(""); } };

  // Queue position in whatever list the drawer was opened from. Stepping is blocked while a progress move is
  // unsaved - walking away from it would silently drop it.
  const qIndex = queue.findIndex((g) => g.path === goal.path);
  const canStep = (delta: number) => qIndex >= 0 && !!queue[qIndex + delta] && !dirty;
  const step = (delta: number) => { const next = queue[qIndex + delta]; if (next) onStep(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      // Typing a note (or dragging the slider) owns the keyboard; j/k only walk when nothing is being edited.
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-bound each render on purpose: the handler closes over the queue position and the unsaved flag, and a
    // stale copy of either would step to the wrong goal or step away from unsaved progress.
  });

  async function post() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try { await onComment(body); setDraft(""); } finally { setPosting(false); }
  }

  const deliveredPts = linked.reduce((s, c) => s + (c.deliver_time ? c.size ?? 0 : 0), 0);
  const totalPts = linked.reduce((s, c) => s + (c.size ?? 0), 0);

  // Who agreed the goal, from the page's employee cache. Six months later "agreed by whom, and when" is the
  // question an attainment figure has to be able to answer.
  const agreedByName = (() => {
    const e = employees.find((x) => idOf(x.path) === idOf(goal.agreed_by ?? ""));
    return e ? `${e.first_name} ${e.last_name}` : undefined;
  })();

  // Aligned progress: weight-weighted average of the children the viewer can see (display-only, never stored).
  const rolledUp = !!goal.rolled_up;
  const [retroDraft, setRetroDraft] = useState(goal.retro ?? "");
  useEffect(() => setRetroDraft(goal.retro ?? ""), [goal.path, goal.retro]);
  const openKids = kids.filter((k) => k.status !== "cancelled");
  // Cancelled children dropped whole, then the shared rule - so this display figure and the objective's stored
  // progress (services/goals.ts#recomputeObjectiveProgress) are the same arithmetic over the same rows.
  const alignedPct = weightedProgress(openKids);

  return (
    <SheetContent className="flex flex-col sm:max-w-lg">
      <SheetHeader>
        {/* Walk the list this drawer was opened from, so a review pass is one drawer instead of twelve - and
            hand over a link to this one goal, since the drawer now has a route of its own. */}
        <div className="flex items-center gap-0.5 pr-8 text-xs text-muted-foreground">
          {queue.length > 1 && qIndex >= 0 && (
            <>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous goal" title={dirty ? "Save your progress change first" : "Previous goal (k)"}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{qIndex + 1}/{queue.length}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next goal" title={dirty ? "Save your progress change first" : "Next goal (j)"}><ChevronRight className="h-4 w-4" /></Button>
            </>
          )}
          {/* Follow somebody else's goal your own plans turn on: progress moves, comments, and the confidence
              call turning at-risk. Not offered on your own goal - you are already told everything. */}
          {!mine && (
            <AccessAction verb={goal.watching ? "unwatch" : "watch"} can={can} label="Follow this goal">
              <button
                type="button"
                onClick={onWatch}
                title={goal.watching ? "Stop following this goal" : "Hear about progress, comments and slippage on this goal"}
                className={cn("ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground", goal.watching && "font-medium text-foreground")}
              >
                <Eye className="h-3.5 w-3.5" /> {goal.watching ? "Watching" : "Watch"}
              </button>
            </AccessAction>
          )}
          <button type="button" onClick={onCopyLink} title="Copy a link to this goal" className={cn("inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground", mine && "ml-auto")}>
            <Link2 className="h-3.5 w-3.5" /> Copy link
          </button>
        </div>
        <SheetTitle className="flex items-start gap-3 pr-6">
          <Ring pct={goal.progress ?? 0} tone={tone} />
          <span className={cn("min-w-0 flex-1 leading-snug", goal.status === "cancelled" && "text-muted-foreground line-through")}>{goal.title}</span>
        </SheetTitle>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {goal.due_date && (
            <span className={cn("inline-flex items-center gap-1 tabular-nums", overdue ? "font-medium text-rose-600 dark:text-rose-400" : due?.soon && !closed ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              <CalendarDays className="h-3 w-3" /> {formatDate(goal.due_date)}{!closed && due ? ` · ${due.text}` : ""}
            </span>
          )}
          {goal.weight ? <span className="text-muted-foreground">· weight {goal.weight}</span> : null}
        </div>
        {owner && !mine && (
          // A div, not a <p>: PhotoAvatar renders a div, and a div inside a <p> is invalid HTML the browser
          // silently reparents (React says so as a validateDOMNesting warning).
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <PhotoAvatar employeeId={idOf(owner.path)} name={`${owner.first_name} ${owner.last_name}`} photo={owner.photo} className="h-6 w-6" />
            {owner.first_name} {owner.last_name}
          </div>
        )}
      </SheetHeader>
      <SheetBody className="space-y-5">
        {/* The goal-setting handshake, at the top because until it is done this goal is a proposal rather than
            an objective - and the one press it needs should not be below the fold. Nothing renders once the
            goal is agreed, which is every goal in an org that has not turned approval on. */}
        {goal.stage !== "AGREED" && (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-sm font-medium">
              {goal.stage === "DRAFT" ? "Draft - not agreed yet" : "Waiting for approval"}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {goal.stage === "DRAFT"
                  ? "Submit it when it says what you mean; your manager agrees it or sends it back."
                  : "Your manager has it. It counts once they agree it."}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {goal.stage === "DRAFT" && can.includes("propose") && (
                <AccessAction verb="propose" can={can} label="Submit goal for approval">
                  <Button size="sm" onClick={onPropose}><CheckCircle2 className="h-3.5 w-3.5" /> Submit for approval</Button>
                </AccessAction>
              )}
              {goal.stage === "PROPOSED" && can.includes("approve") && (
                <AccessAction verb="approve" can={can} label="Approve goal">
                  <Button size="sm" onClick={onApprove}><CheckCircle2 className="h-3.5 w-3.5" /> Agree this goal</Button>
                </AccessAction>
              )}
              {goal.stage === "PROPOSED" && can.includes("requestChanges") && (
                <AccessAction verb="requestChanges" can={can} label="Send goal back">
                  <Button variant="outline" size="sm" onClick={onRequestChanges}>Send back…</Button>
                </AccessAction>
              )}
            </div>
          </div>
        )}
        {goal.stage === "AGREED" && goal.agreed_time && agreedByName && (
          <p className="text-xs text-muted-foreground">Agreed by {agreedByName} on {formatDate(goal.agreed_time.slice(0, 10))}.</p>
        )}
        {parent && (
          <p className="text-xs text-muted-foreground">
            Aligns to{" "}
            <button type="button" className="inline-flex max-w-full items-center gap-1 align-bottom font-medium text-primary hover:underline" onClick={() => onOpenGoal(parent)}>
              <Link2 className="h-3 w-3 shrink-0" /> <span className="truncate">{parent.title}</span>
            </button>
          </p>
        )}
        {goal.description && <p className="whitespace-pre-wrap text-sm text-foreground/90">{goal.description}</p>}

        {/* Where this stands, in the two senses that matter: the arithmetic (pace, silence, the shape of the
            climb) and the owner's own call. Hidden on a finished goal - neither question applies any more. */}
        {!closed && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Health</p>
              {goal.expected_progress != null && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {goal.progress ?? 0}% against {goal.expected_progress}% expected
                  {goal.drift != null && goal.drift !== 0 && (
                    <span className={cn("ml-1 font-medium", goal.drift < 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
                      ({goal.drift > 0 ? "+" : ""}{goal.drift})
                    </span>
                  )}
                </span>
              )}
            </div>
            {(history?.length ?? 0) > 1 && <ProgressSparkline history={history!} />}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">Owner's call</span>
              <AccessAction verb="setConfidence" can={can} label="Set goal confidence">
                <ConfidencePicker value={goal.confidence} onPick={(v) => onConfidence(v)} />
              </AccessAction>
            </div>
            {goal.confidence_note && <p className="text-sm text-foreground/90">{goal.confidence_note}</p>}
            {(goal.stale_days ?? 0) >= STALE_DAYS && (
              <p className="text-xs text-muted-foreground">Nothing has happened on this goal in {goal.stale_days} days.</p>
            )}
          </div>
        )}

        {/* What actually happened, in the owner's words. Offered while the goal is closing or closed, and
            carried into the review PDF - a percentage says how far it got and nothing about why. */}
        {(closed || (goal.progress ?? 0) >= 80) && (canEdit || mine) && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What happened</p>
            <Textarea
              rows={3}
              value={retroDraft}
              onChange={(e) => setRetroDraft(e.target.value)}
              placeholder="What actually happened here? What would you do differently?"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={retroDraft.trim() === (goal.retro ?? "").trim()} onClick={() => onRetro(retroDraft.trim())}>Save note</Button>
              <span className="text-xs text-muted-foreground">Carried into the review for this cycle.</span>
            </div>
          </div>
        )}

        {/* Who else worked on this. Their share scores in THEIR review at this goal's weight scaled by it, so
            the split is a statement about two reviews, not a label.

            A COMPLETED goal still shows it, unlike the progress and retro editors above: the moment somebody
            credits the people who delivered a goal is when it lands, and the server has never required the
            goal to be open. Only a cancelled goal hides it - it scores for nobody, so there is no share to
            argue about. */}
        {(goal.contributors?.length || goal.suggested_contributors?.length || canEdit) && goal.status !== "cancelled" && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Contributors{goal.contributors?.length ? ` · ${goal.contributors.reduce((s2, c) => s2 + (c.share ?? 0), 0)}% shared` : ""}
              </p>
              {canEdit && (
                <AccessAction verb="setContributors" can={can} label="Set contributors">
                  <Button variant="ghost" size="sm" onClick={onContributors}>{goal.contributors?.length ? "Edit" : "Add"}</Button>
                </AccessAction>
              )}
            </div>
            {goal.contributors?.length ? (
              <ul className="space-y-1">
                {goal.contributors.map((c) => (
                  <li key={c.employee} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{kidOwnerName(c.employee)}{c.note ? <span className="text-muted-foreground"> · {c.note}</span> : null}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{c.share}%</span>
                  </li>
                ))}
              </ul>
            ) : goal.suggested_contributors?.length ? (
              // Nobody credited, but the board says other people delivered the work - the case where the
              // credit silently lands entirely on the owner. Say the split the tasks imply, on the goal.
              <p className="text-sm text-muted-foreground">
                Nobody else is credited yet. The linked tasks were delivered by{" "}
                {goal.suggested_contributors.map((c) => `${kidOwnerName(c.employee)} (${c.share}%)`).join(", ")}
                {canEdit ? " - open the editor to credit them." : "."}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Nobody else is credited. A share here counts in that person's own review.</p>
            )}
          </div>
        )}

        {kids.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {rolledUp
                // The objective's own percentage IS this set, computed by the server over every key result -
                // including any this viewer cannot see. The old line ("% of what you can see") was honest
                // about a client-side average that two people read differently; there is nothing to hedge now.
                ? `Key results · ${goal.progress ?? 0}% weighted`
                : `Aligned goals · ${alignedPct}% of what you can see`}
            </p>
            <ul className="space-y-1.5">
              {kids.map((k) => (
                <li key={k.path}>
                  <button type="button" className="flex w-full items-center gap-2 rounded text-left text-sm hover:bg-accent/50" onClick={() => onOpenGoal(k)}>
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", k.status === "completed" ? "bg-emerald-500" : k.status === "cancelled" ? "bg-muted-foreground/40" : "bg-primary")} />
                    <span className={cn("min-w-0 flex-1 truncate", k.status === "cancelled" && "text-muted-foreground line-through")}>{k.title}</span>
                    <span className="text-[11px] text-muted-foreground">{kidOwnerName(k.employee)}</span>
                    <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">{k.progress ?? 0}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* A measured goal reports its number, and the number is the only thing worth editing here: the slider
            would be an opinion the next save overwrites. */}
        {measured && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Measure</p>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tabular-nums">
                  {measureLabel(goal)}
                  {goal.baseline_value != null && goal.baseline_value !== 0 && (
                    <span className="ml-1.5 font-normal text-muted-foreground">from {goal.baseline_value}</span>
                  )}
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", tone === "done" ? "bg-emerald-500" : tone === "overdue" ? "bg-rose-500" : "bg-primary")} style={{ width: `${goal.progress ?? 0}%` }} />
                </div>
              </div>
              {canMeasure && (
                <div className="flex items-end gap-1.5">
                  <Input
                    type="number"
                    value={cur}
                    onChange={(e) => setCur(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && curMoved) onCurrentValue(Number(cur)); }}
                    className="h-8 w-24 text-right tabular-nums"
                    aria-label={`Current value${goal.unit ? ` in ${goal.unit}` : ""}`}
                  />
                  <Button size="sm" className="h-8" disabled={!curMoved} onClick={() => onCurrentValue(Number(cur))}>Update</Button>
                </div>
              )}
            </div>
            {curMoved && curPct != null && (
              <p className="text-xs text-muted-foreground">
                Saving {cur}{goal.unit ? ` ${goal.unit}` : ""} puts this at {curPct}%{curPct === 100 ? " and completes the goal" : ""}.
              </p>
            )}
          </div>
        )}

        {canProgress && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Progress</p>
            <div className="flex items-center gap-2">
              <AccessAction verb="updateProgress" can={can} label="Update goal progress">
                <input
                  type="range" min={0} max={100} step={5} value={prog}
                  onChange={(e) => setProg(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer accent-primary"
                  aria-label="Set progress"
                />
              </AccessAction>
              <span className="w-10 shrink-0 text-right text-sm font-medium tabular-nums">{prog}%</span>
            </div>
            {dirty && (
              <div className="flex items-center gap-2">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" className="h-8 text-sm" onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
                <Button size="sm" onClick={save}>Save</Button>
              </div>
            )}
            {!dirty && !closed && (
              <Button variant="outline" size="sm" className="text-emerald-600 dark:text-emerald-400" onClick={() => onProgress(100)}>
                <CheckCircle2 className="h-4 w-4" /> Mark complete
              </Button>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Linked tasks{hasLinked && totalPts > 0 ? ` · ${deliveredPts}/${totalPts} pts` : ""}
            </p>
            {!closed && linkable.length > 0 && (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => setPicking((p) => !p)}>
                <Link2 className="h-3.5 w-3.5" /> Link tasks
              </button>
            )}
          </div>
          {picking && (
            <Combobox
              value=""
              onValueChange={(v) => {
                const c = linkable.find((x) => x.path === v);
                if (c) onLink(c);
                setPicking(false);
              }}
              searchPlaceholder="Search tasks…"
              options={linkable.map((c) => ({ value: c.path, label: c.title }))}
            />
          )}
          {hasLinked ? (
            <ul className="space-y-1.5">
              {linked.map((c) => (
                <li key={c.path} className="group/task flex items-center gap-2 text-sm">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.deliver_time ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                  <span className={cn("min-w-0 flex-1 truncate", c.deliver_time && "text-muted-foreground line-through")}>{c.title}</span>
                  {c.size != null && <span className="text-[11px] tabular-nums text-muted-foreground">{c.size}</span>}
                  {!closed && (c.access?.can ?? []).includes("update") && (
                    <button type="button" className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/task:opacity-100" onClick={() => onUnlink(c)} aria-label={`Unlink ${c.title}`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No board tasks linked{hasLinked ? "" : " - progress is set manually"}.</p>
          )}
          {hasLinked && <p className="text-[11px] text-muted-foreground">Progress derives from linked-task delivery.</p>}
        </div>

        {/* The conversation the goal used to lose. A quarterly goal gets discussed at least monthly, and until
            this existed the only writable text on it was the owner's own progress note - so the discussion
            happened in chat and the goal recorded nothing. */}
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Comments{comments?.length ? ` · ${comments.length}` : ""}
          </p>
          {comments === undefined ? (
            <LinesSkeleton rows={2} />
          ) : comments.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing yet. A note here reaches {mine ? "your manager" : "the owner"}.</p>
          ) : (
            <ul className="space-y-2.5">
              {comments.map((c, i) => {
                const emp = c.author ? employees.find((e) => idOf(e.path) === idOf(c.author!)) : undefined;
                const name = emp ? `${emp.first_name} ${emp.last_name}` : c.author_email ?? "Someone";
                return (
                  <li key={`${c.create_time}-${i}`} className="flex gap-2">
                    {emp
                      ? <PhotoAvatar employeeId={idOf(emp.path)} name={name} photo={emp.photo} className="h-6 w-6 shrink-0" />
                      : <span className="h-6 w-6 shrink-0 rounded-full bg-muted" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{name}</span> · {formatDate(c.create_time)}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm">{c.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {can.includes("comment") && (
            <div className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Add a comment${mine ? "" : " for " + (owner ? owner.first_name : "the owner")}…`}
                className="text-sm"
                // Cmd/Ctrl+Enter posts, matching every other multi-line box in the app.
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !posting) void post(); }}
              />
              <AccessAction verb="comment" can={can} label="Comment on goal">
                <Button size="sm" disabled={!draft.trim() || posting} loading={posting} onClick={() => void post()}>Post</Button>
              </AccessAction>
            </div>
          )}
        </div>

        <ActivitySection resource={goal.path} className="border-t pt-3" />

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {canEdit && <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
          {/* A completed goal is the moment recognition is worth something, and it used to produce one
              notification to one manager and nothing else. Opens the kudos composer with the owner filled in. */}
          {goal.status === "completed" && !mine && goal.employee && (
            <AccessAction collection="announcements" verb="giveKudos" label="Give kudos">
              <Button variant="outline" size="sm" onClick={() => { navigate("announcements"); fireIntent("give-kudos", `employees/${idOf(goal.employee!)}`); }}>
                <Sparkles className="h-3.5 w-3.5" /> Say well done
              </Button>
            </AccessAction>
          )}
          {onCarryOver && (
            <AccessAction collection="goals" create label="Carry goal over">
              <Button variant="outline" size="sm" onClick={onCarryOver}><CalendarDays className="h-3.5 w-3.5" /> Carry to next quarter</Button>
            </AccessAction>
          )}
          {canDelete && <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>}
        </div>
      </SheetBody>
    </SheetContent>
  );
}

// Tiles with an onClick double as filter toggles (`active` marks the one currently applied).
function StatTile({ label, value, bar, alert, onClick, active }: {
  label: string; value: string; bar?: number; alert?: boolean; onClick?: () => void; active?: boolean;
}) {
  const inner = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", alert && "text-rose-600 dark:text-rose-400")}>{value}</p>
      {bar != null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${bar}%` }} />
        </div>
      )}
    </>
  );
  const tone = cn(
    "rounded-lg border p-3",
    alert && "border-rose-300/70 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20",
    active && "border-primary ring-1 ring-primary",
  );
  if (!onClick) return <div className={tone}>{inner}</div>;
  return (
    <button type="button" onClick={onClick} className={cn(tone, "text-left transition-colors hover:bg-accent/50")}>
      {inner}
    </button>
  );
}

/**
 * The alignment cascade: what rolls up into what, from the top down.
 *
 * Alignment already existed per goal - the drawer names a goal's parent and lists its children - and that is
 * the wrong end to read it from. The questions this view answers cannot be answered one card at a time: is
 * anything hanging off nothing, is a whole team's work parented under one person's objective, does the shape
 * of the quarter match what was agreed.
 *
 * Rooted on the goals in view whose parent is NOT in view: a filtered set (one owner, one cycle, at-risk
 * only) still has to render as a forest rather than vanish because its parents were filtered out. Children
 * beyond the visible set are not invented - this shows the goals the caller can see, and says how many it
 * could not where a parent has more.
 */
function AlignmentTree({ goals, all, empName, meId, onOpen }: {
  goals: Goal[];
  /** Every goal the page holds, for counting children that the current filter hides. */
  all: Goal[];
  empName: (ref?: string) => string;
  meId?: string | null;
  onOpen: (g: Goal) => void;
}) {
  const visible = useMemo(() => new Set(goals.map((g) => idOf(g.path))), [goals]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Goal[]>();
    for (const g of goals) {
      const p = g.parent ? idOf(g.parent) : "";
      if (!p || !visible.has(p)) continue;
      (m.get(p) ?? m.set(p, []).get(p)!).push(g);
    }
    // Heaviest first, then by title: the same order the review scores them in.
    for (const list of m.values()) list.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title));
    return m;
  }, [goals, visible]);
  const hiddenChildCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of all) {
      const p = g.parent ? idOf(g.parent) : "";
      if (!p || g.delete_time || visible.has(idOf(g.path))) continue;
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [all, visible]);
  const roots = useMemo(
    () => goals
      .filter((g) => !g.parent || !visible.has(idOf(g.parent)))
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title)),
    [goals, visible],
  );

  if (!roots.length) return <p className="text-sm text-muted-foreground">No goals match these filters.</p>;

  const row = (g: Goal, depth: number): ReactNode => {
    const kids = childrenOf.get(idOf(g.path)) ?? [];
    const hidden = hiddenChildCount.get(idOf(g.path)) ?? 0;
    const mine = !!g.employee && idOf(g.employee) === meId;
    const badge = statusBadge[g.status];
    return (
      <li key={g.path} className="min-w-0">
        {/* Indent with a real left border per level rather than padding alone: at three levels deep, padding
            on its own stops reading as a hierarchy. */}
        <div className={cn("min-w-0", depth > 0 && "border-l pl-3 sm:pl-4")}>
          <button
            type="button"
            onClick={() => onOpen(g)}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
          >
            <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{g.progress ?? 0}%</span>
            {/* One bar per row, because a wall of donuts at four levels of indent is unreadable. */}
            <span className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
              <span
                className={cn("block h-full rounded-full", g.status === "completed" ? "bg-emerald-500" : g.status === "cancelled" ? "bg-muted-foreground/40" : "bg-primary")}
                style={{ width: `${Math.min(100, Math.max(0, g.progress ?? 0))}%` }}
              />
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-sm", g.status === "cancelled" && "text-muted-foreground line-through")}>
              {g.title}
              {g.kind === "key_result" && <span className="ml-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">KR</span>}
            </span>
            {g.weight ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">wt {g.weight}</span> : null}
            {isAtRisk(g) && <TrendingDown className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
            {g.status !== "in_progress" && <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>}
            <span className={cn("hidden shrink-0 text-xs sm:inline", mine ? "font-medium text-foreground" : "text-muted-foreground")}>
              {mine ? "You" : empName(g.employee)}
            </span>
          </button>
          {(kids.length > 0 || hidden > 0) && (
            <ul className="mt-0.5 space-y-0.5">
              {kids.map((k) => row(k, depth + 1))}
              {/* Honesty about what the filter or the caller's scope is hiding: a parent that silently shows
                  three of its seven children misreports the shape of the quarter. */}
              {hidden > 0 && (
                <li className="border-l pl-3 sm:pl-4">
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {hidden} more {hidden === 1 ? "goal" : "goals"} under this one {hidden === 1 ? "is" : "are"} outside these filters.
                  </p>
                </li>
              )}
            </ul>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Network className="h-3.5 w-3.5" /> Alignment
        <span className="font-normal tabular-nums text-muted-foreground/70">{goals.length}</span>
      </h2>
      {/* Deep nesting plus long titles overflow on a phone, so the cascade scrolls sideways inside its own
          card - and says so, rather than cutting a title off at the edge with no hint there is more. */}
      <Card className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto p-2">
        <ul className="min-w-0 space-y-0.5">{roots.map((g) => row(g, 0))}</ul>
      </Card>
    </section>
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

// How the three confidence calls read and colour, in the order a picker offers them.
const CONFIDENCE: { value: GoalConfidence; label: string; short: string; className: string }[] = [
  { value: "on_track", label: "On track", short: "On track", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "at_risk", label: "At risk", short: "At risk", className: "text-amber-600 dark:text-amber-400" },
  { value: "off_track", label: "Off track", short: "Off track", className: "text-rose-600 dark:text-rose-400" },
];
const confidenceOf = (v?: string | null) => CONFIDENCE.find((c) => c.value === v);

// The goal-setting handshake, as the card says it. AGREED is the resting state and gets no badge: in an org
// that has not turned approval on, every goal is agreed and a badge on all of them says nothing.
const STAGE_BADGE: Record<string, { label: string; variant: "muted" | "secondary" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  PROPOSED: { label: "Awaiting approval", variant: "secondary" },
};

/**
 * Where this goal should be by now, said in one chip.
 *
 * The owner's own call wins the chip when they have made one - a person who has said "at risk" has told you
 * more than the arithmetic can - and the drift rides along beside it. On track and silent otherwise: a chip on
 * every healthy goal is a chip nobody reads.
 */
function PaceChip({ goal }: { goal: Goal }) {
  const conf = confidenceOf(goal.confidence);
  const behind = goal.pace === "behind" || goal.pace === "at_risk";
  if (!conf && !behind) return null;
  const drift = goal.drift;
  const driftText = drift != null && drift < 0 ? `${-drift} pts behind` : drift != null && drift > 0 ? `${drift} pts ahead` : null;
  const tone = conf?.className ?? (goal.pace === "at_risk" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400");
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-medium", tone)}
      title={[conf ? `Owner says: ${conf.label}` : null, goal.expected_progress != null ? `Should be about ${goal.expected_progress}% by now` : null, goal.confidence_note]
        .filter(Boolean)
        .join(" · ")}
    >
      <TrendingDown className="h-3 w-3" />
      {conf ? conf.short : driftText ?? "Behind"}
      {conf && driftText && <span className="font-normal text-muted-foreground">· {driftText}</span>}
    </span>
  );
}

/** The three-way confidence call, as a segmented control. Writes through `:setConfidence`. */
function ConfidencePicker({ value, onPick, disabled }: { value?: string | null; onPick: (v: GoalConfidence) => void; disabled?: boolean }) {
  return (
    <div className="flex overflow-hidden rounded-md border text-xs font-medium">
      {CONFIDENCE.map((c) => (
        <button
          key={c.value}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.value)}
          className={cn(
            "px-2.5 py-1 transition-colors disabled:opacity-50",
            value === c.value ? "bg-primary text-primary-foreground" : cn("hover:bg-accent", c.className),
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * How progress actually moved, drawn small.
 *
 * The series comes off the goal's own Get (rebuilt from the audit trail), so opening a goal answers "was this
 * a steady climb or a week of back-filling?" - the question a manager cannot ask a single percentage.
 * Deliberately axis-less and tiny: it is a shape, not a report.
 */
function ProgressSparkline({ history }: { history: NonNullable<Goal["history"]> }) {
  if (history.length < 2) return null;
  const w = 240, h = 40;
  const t0 = Date.parse(history[0]!.at_time);
  const t1 = Date.parse(history[history.length - 1]!.at_time);
  const span = Math.max(1, t1 - t0);
  const pt = (p: { at_time: string; progress: number }) => [
    ((Date.parse(p.at_time) - t0) / span) * w,
    h - (Math.max(0, Math.min(100, p.progress)) / 100) * h,
  ] as const;
  // Stepped, because progress does not drift between updates - it sits where it was left until somebody moves
  // it, and a smooth line would invent a climb that never happened.
  let d = "";
  let prev: readonly [number, number] | null = null;
  for (const p of history) {
    const [x, y] = pt(p);
    d += prev ? ` L ${x} ${prev[1]} L ${x} ${y}` : `M ${x} ${y}`;
    prev = [x, y];
  }
  if (prev) d += ` L ${w} ${prev[1]}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none" role="img" aria-label="Progress over time">
      <path d={`${d} L ${w} ${h} L 0 ${h} Z`} className="fill-primary/10" />
      <path d={d} className="fill-none stroke-primary" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// One goal card: progress donut + title/chips, description, and a single slider as the progress control
// (read-only viewers get no slider - the donut already shows the %). "Mark complete" is one click away.
function GoalCard({ goal, owner, parentTitle, cycleTitle, blockedByTitle, deptTitle, onOpen, onEdit, onDelete, onProgress }: {
  goal: Goal;
  owner?: Employee;
  parentTitle?: string;
  cycleTitle?: string;
  blockedByTitle?: string;
  /** Set when a department owns this goal rather than one person. */
  deptTitle?: string;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onProgress: (progress: number) => void;
}) {
  const can = goal.access?.can ?? [];
  const canEdit = can.includes("update");
  const canDelete = can.includes("delete");
  // Delivery rollup straight off the goal (the server groups the linked tasks once per page), so a wall of
  // goal cards costs no read of the cards collection. When tasks are linked, progress is derived server-side
  // from their delivery — the manual slider is hidden.
  const linkedCount = goal.linked_tasks ?? 0;
  const hasLinked = linkedCount > 0;
  const delivered = goal.delivered_tasks ?? 0;
  const totalPts = goal.task_points ?? 0;
  const deliveredPts = goal.delivered_task_points ?? 0;
  // WHICH tasks they are is a click away, and only then worth a read: the popover lists titles, so it needs the
  // rows the chip above no longer does. Every card on the wall shares the one store entry, so opening several
  // popovers still costs a single read - and opening none costs nothing.
  const [tasksOpen, setTasksOpen] = useState(false);
  const { rows: allCards } = useCollection<KanbanCard>("cards", { enabled: tasksOpen });
  const linked = useMemo(
    () => allCards.filter((c) => c.goal && idOf(c.goal) === idOf(goal.path) && !c.delete_time),
    [allCards, goal.path],
  );
  // A measured goal's percentage is arithmetic on its numbers, so the card shows the numbers and no slider:
  // dragging one would be overwritten by the next measure update anyway.
  // Three things own a goal's percentage instead of the slider: linked tasks, a measure, and key results.
  const canProgress = !hasLinked && !goal.measured && !goal.rolled_up && (canEdit || can.includes("updateProgress"));
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
    <Card
      className={cn("group flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:border-primary/40", overdue && "border-rose-300/70 dark:border-rose-900/60", goal.status === "cancelled" && "opacity-75")}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}
    >
      {/* Wraps on a phone, where the action cluster is drawn permanently (no hover to reveal it) and its three
          finger-sized buttons take ~130px of a ~290px card - leaving the goal's own title, the one thing the
          card is for, truncated to two words. `order-last w-full` sends the cluster to a line of its own
          below `sm`, and the title gets the width back. */}
      <div className="flex flex-wrap items-start gap-3">
        <Ring pct={prog} tone={tone} />
        <div className="min-w-0 flex-1">
          <h3 className={cn("truncate font-semibold", goal.status === "cancelled" && "text-muted-foreground line-through")} title={goal.title}>{goal.title}</h3>
          {owner && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <PhotoAvatar employeeId={idOf(owner.path)} name={`${owner.first_name} ${owner.last_name}`} photo={owner.photo} className="h-6 w-6" />
              <span className="truncate">{owner.first_name} {owner.last_name}</span>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {goal.kind === "key_result" && <Badge variant="outline">Key result</Badge>}
            {/* A goal a TEAM owns. The named employee is still the accountable lead - this says the work is
                the department's, which is how cross-team objectives stop being one person's private problem. */}
            {deptTitle && <Badge variant="secondary">{deptTitle}</Badge>}
            {goal.rolled_up && <span className="text-muted-foreground">· from key results</span>}
            {/* Effort against outcome: the pairing that catches hours going into something that is not
                moving. Only shown when a project actually points here. */}
            {goal.logged_hours != null && (
              <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground" title="Approved hours booked against this goal">
                <Clock3 className="h-3 w-3" /> {goal.logged_hours}h
              </span>
            )}
            {STAGE_BADGE[goal.stage ?? "AGREED"] && (
              <Badge variant={STAGE_BADGE[goal.stage!]!.variant}>{STAGE_BADGE[goal.stage!]!.label}</Badge>
            )}
            {/* Where this should be by now, and how long since anybody said anything. Both computed by the
                server from dates the row already carried - and both invisible on this card until now, which
                is how a goal reaches its due date at 30% with nobody surprised. */}
            <PaceChip goal={goal} />
            {isQuiet(goal) && (
              <span className="inline-flex items-center gap-1 text-muted-foreground" title={`No progress, edit or comment for ${goal.stale_days} days`}>
                <MessageSquareDashed className="h-3 w-3" /> quiet {goal.stale_days}d
              </span>
            )}
            {due && !closed && (
              <span title={formatDate(goal.due_date)} className={cn("inline-flex items-center gap-1 tabular-nums", overdue ? "font-medium text-rose-600 dark:text-rose-400" : due.soon ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                <CalendarDays className="h-3 w-3" /> {due.text}
              </span>
            )}
            {goal.weight ? <span className="text-muted-foreground">· weight {goal.weight}</span> : null}
            {/* The measure says more than the percentage does: "42 of 60 customers" is checkable, "70%" is not. */}
            {goal.measured && (
              <span className="inline-flex items-center gap-1 font-medium tabular-nums text-muted-foreground">
                <Target className="h-3 w-3" /> {measureLabel(goal)}
              </span>
            )}
            {/* Which review will score this goal - the difference between a goal that counts and one that is
                just work, and invisible until it was said on the card. */}
            {cycleTitle && (
              <span className="inline-flex max-w-[11rem] items-center gap-1 text-muted-foreground" title={`Scored in ${cycleTitle}`}>
                <ClipboardCheck className="h-3 w-3 shrink-0" /> <span className="truncate">{cycleTitle}</span>
              </span>
            )}
            {blockedByTitle && (
              <span className="inline-flex max-w-[11rem] items-center gap-1 font-medium text-amber-600 dark:text-amber-400" title={`Waiting on ${blockedByTitle}`}>
                <Hourglass className="h-3 w-3 shrink-0" /> <span className="truncate">waiting on {blockedByTitle}</span>
              </span>
            )}
            {parentTitle && (
              <span className="inline-flex max-w-[11rem] items-center gap-1 text-muted-foreground" title={`Aligns to ${parentTitle}`}>
                <Link2 className="h-3 w-3 shrink-0" /> <span className="truncate">{parentTitle}</span>
              </span>
            )}
            {hasLinked && (
              <Popover open={tasksOpen} onOpenChange={setTasksOpen}>
                <PopoverTrigger asChild>
                  <button type="button" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground hover:underline">
                    <Target className="h-3 w-3" /> {delivered}/{linkedCount} tasks{totalPts > 0 ? ` · ${deliveredPts}/${totalPts} pts` : ""}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
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
        <div className="order-last flex w-full shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:order-none sm:w-auto sm:justify-start" onClick={(e) => e.stopPropagation()}>
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
        <div className="mt-auto flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <AccessAction verb="updateProgress" can={can} label="Update goal progress">
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
          </AccessAction>
          <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-muted-foreground">{prog}%</span>
        </div>
      )}

      {hasLinked && !closed && <p className="mt-auto pt-1 text-[11px] text-muted-foreground">Progress syncs from linked tasks.</p>}
    </Card>
  );
}
