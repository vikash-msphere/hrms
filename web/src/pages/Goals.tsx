import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Target, Plus, Pencil, Trash2, CheckCircle2, CalendarDays, ClipboardCheck, Clock3, Eye, Hourglass, Network, Sparkles, TrendingDown, Users, Search, Link2, X, ChevronDown, ChevronLeft, ChevronRight , ListChecks, Ruler, AlignLeft, HeartPulse, PenLine, MessageSquare, SquareKanban } from "lucide-react";
import { create, patch, invoke, remove, get, getAllPages } from "@/api";
import { navigate, setRouteRecord, recordUrl, routeRecord } from "@/router";
import { describeError, isConflict } from "@/lib/formError";
import { measuredPct, measureLabel, numOrNone, weightedProgress, measureGaps, GAP_MESSAGE } from "@/lib/goalMeasure";
import {
  STALE_DAYS, TONE_FILL, confidenceOf, dueRel, goalTone, isBehind, isOpen, matchingTemplates, retroSeed, sortGoals, statusForProgress,
} from "@/lib/goalState";
import {
  ConfidencePicker, GoalDueChip, GoalKindMark, GoalMeasureChip, GoalPaceChip, GoalProgressBar, GoalQuietChip,
  GoalRing, GoalStageBadge, GoalStatusBadge,
} from "@/components/common/GoalChips";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd, daysBetweenYmd } from "@/lib/orgDay";
import type { Department, Employee, Goal, GoalConfidence, GoalCounts, GoalKind, GoalStage, GoalStatus, GoalTemplate, Me, ReviewCycle, Card as KanbanCard } from "@/types";
import { Chart, ChartCard, ChartStrip } from "@/components/common/Chart";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { useChartFocus } from "@/lib/chartFocus";
import { PageHeader } from "@/components/common/PageHeader";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { useMentions } from "@/components/common/MentionPicker";
import { RichText } from "@/lib/richText";
import { fireIntent, useIntent } from "@/lib/intent";
import { readLocal, writeLocal, userKey } from "@/lib/localPref";
import { readUrlQuery, writeUrlQuery } from "@/lib/urlQuery";
import { useCanReadOthers } from "@/lib/perm";
import { PageSettings } from "@/components/common/SettingsButton";
import { TeamTriage } from "@/components/common/TeamTriage";
import { GoalBlockers } from "@/components/common/GoalBlockers";
import { GoalCoverage } from "@/components/common/GoalCoverage";
import { GoalSimilarCard } from "@/components/common/GoalSimilarCard";
import { GoalMeasureSuggest } from "@/components/common/GoalMeasureSuggest";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useDebounced } from "@/hooks/useDebounced";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { LinesSkeleton } from "@/components/common/Skeletons";
import { Field, FieldRow } from "@/components/common/Field";
import { FormSection } from "@/components/common/FormSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { useConfirm } from "@/components/common/confirm";
import { FilterChip } from "@/components/common/FilterChips";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/common/SearchInput";
import { Textarea } from "@/components/ui/textarea";
import { DraftButton } from "@/components/common/DraftButton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/use-toast";

const STATUSES: { value: GoalStatus; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// How the goals are laid out. `tree` is the alignment cascade: alignment exists per goal (a parent and its
// children in the drawer), and nothing rendered it from the top - which is the view that makes a
// mis-parented goal, or a whole team hanging off nothing, obvious at a glance.
type GoalView = "flat" | "quarter" | "tree";
/** Whose goals the page is answering about. The read's own filter, not a pass over what came back. */
type GoalScope = "mine" | "team" | "all";
const SCOPES: { value: GoalScope; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "team", label: "My team" },
  { value: "all", label: "Everyone" },
];
// `trouble` is the union of overdue, at-risk and quiet - the one chip a manager chases by, and the reason the
// Team goals page opened on "Needs attention". Its members are chips of their own for anyone who wants to cut
// finer; it is the question asked first.
type Filter = "all" | "active" | "trouble" | "due_soon" | "overdue" | "at_risk" | "quiet" | "unagreed" | "completed" | "cancelled";
const FILTERS: Filter[] = ["all", "active", "trouble", "due_soon", "overdue", "at_risk", "quiet", "unagreed", "completed", "cancelled"];
// A `Filter` IS the server's `?state=`, name for name - the chip narrows the read now, so the page no longer
// carries a predicate for each one. It used to, and so did Team goals and the profile's Performance tab: three
// definitions of "at risk" that did not agree. The rules live in lib/goalState.ts for the chips a row draws
// itself, and in services/goals.ts#goalStateSql for the ones a question is asked of the whole collection with;
// test/goalStateSql.test.ts holds those two to each other.
// Namespaced to the caller: a chip filter is the reader's own, and a shared key opened B's Goals page on A's.
const FILTER_KEY = () => userKey("goals:filter");

const EMPTY = {
  title: "", description: "", weight: "", status: "not_started" as GoalStatus, kind: "objective" as GoalKind, due_date: "", employee: "me", parent: "none", cycle: "none", blockedBy: "none", department: "none",
  // The measure. Strings because these are text inputs; "" means "not set", which is what makes a goal manual.
  unit: "", baseline: "", target: "", current: "",
};
const num = numOrNone;
// The units a measure is nearly always in, offered as chips beside the box. Typing "%" is not the work; the
// work was knowing the field wanted a word like "customers" rather than a sentence.
const QUICK_UNITS = ["%", "days", "hours", "customers", "tickets"];
/**
 * The measure's "current" for a form: asked on an edit, implied on a new goal.
 *
 * A goal written today is where its baseline says it is - a box asking where it has got to, answered by the box
 * above it, is a question with one right answer. With a target and no baseline the start is 0, which is what
 * the percentage already assumes, so a target-only goal is measured from the moment it is created instead of
 * quietly staying manual.
 */
const currentFor = (editing: boolean, f: { current: string; baseline: string; target: string }) =>
  editing ? f.current : (f.current.trim() || f.baseline.trim() || (num(f.target) != null ? "0" : ""));
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
// The quarter view's own order: the groups are drawn oldest first and a goal keeps its place inside its
// group, which a stable sort on the quarter key reproduces exactly. Used for the drawer's walk order, so
// `sort()` is given a copy rather than the array the grid is rendering from.
const byQuarter = (list: Goal[]) => [...list].sort((a, b) => quarterOf(a).sort - quarterOf(b).sort);

/**
 * The forest the alignment cascade draws: what hangs off what, and the order each level is drawn in.
 *
 * Shared by the cascade and by the drawer's walk order, because they have to be the same sequence - a
 * "4 of 12" that counts a different arrangement from the one on screen is worse than no counter.
 */
function alignmentForest(goals: Goal[]) {
  const visible = new Set(goals.map((g) => idOf(g.path)));
  const children = new Map<string, Goal[]>();
  for (const g of goals) {
    const p = g.parent ? idOf(g.parent) : "";
    if (!p || !visible.has(p)) continue;
    (children.get(p) ?? children.set(p, []).get(p)!).push(g);
  }
  // Heaviest first, then by title: the same order the review scores them in.
  const rank = (a: Goal, b: Goal) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title);
  for (const list of children.values()) list.sort(rank);
  // Rooted on the goals whose parent is NOT in view, so a filtered set renders as a forest rather than
  // vanishing because its parents were filtered out.
  const roots = goals.filter((g) => !g.parent || !visible.has(idOf(g.parent))).sort(rank);
  return { visible, roots, children };
}

/** The cascade flattened top to bottom - the rows in the order a reader's eye travels them. */
function alignmentOrder(goals: Goal[]): Goal[] {
  const { roots, children } = alignmentForest(goals);
  const out: Goal[] = [];
  // `seen` guards the walk rather than trusting the data: the server refuses to create a parent cycle, but a
  // walk that meets one would hang the tab, and this is rendering somebody else's rows.
  const seen = new Set<string>();
  const walk = (g: Goal) => {
    const id = idOf(g.path);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(g);
    for (const k of children.get(id) ?? []) walk(k);
  };
  for (const r of roots) walk(r);
  return out;
}

// Quick-set chips for the due-date field.
const quickDue = (): { label: string; value: string }[] => {
  const t = todayStr();
  const all = [
    { label: "2 weeks", value: addDaysYmd(t, 14) },
    { label: "End of month", value: monthEndFrom(t, 0) },
    { label: "End of quarter", value: monthEndFrom(t, Math.floor(monthIdx(t) / 3) * 3 + 2 - monthIdx(t)) },
  ];
  // In the last month of a quarter these name the same day, and two chips for one date both light up when
  // either is pressed - which reads as a control that did not take the press. First label wins.
  return all.filter((o, i) => all.findIndex((x) => x.value === o.value) === i);
};

export default function Goals({ me, openId, scope: forcedScope }: {
  me: Me;
  openId?: string;
  /** The scope this ROUTE is about. `/team-goals` is this page with `all` pinned (every team the reader can see,
   *  grouped by team); `/goals` lets the reader choose. The sidebar keeps both entries, and both land on one
   *  surface rather than two that overlap. */
  scope?: GoalScope;
}) {
  // WHAT THIS PAGE IS SHOWING LIVES IN THE ADDRESS, AND IT NARROWS THE READ.
  //
  // Everything that narrows these goals - the chip, the cycle, the picked person, the search, the layout -
  // was component state or a localStorage key, so the one thing a person does with a filtered page could not
  // be done with it: "here are the at-risk goals in Q3" was a screenshot or a sentence of instructions. The
  // chart pick beside them (`?slice=`) has been shareable since it existed, which made the mixture stranger
  // still - and a dashboard tile counting overdue goals had nowhere to send the reader but the whole list.
  //
  // The address wins where it says something; the remembered chip and layout are the default when it is
  // silent, so arriving by a bare `/goals` still lands where the reader left off. Written with
  // `writeUrlQuery` (replaceState), the way LeaveCalendar's eight filters are: a filter toggle is not a
  // history entry to press Back through.
  const [cycleFilter, setCycleFilter] = useState(() => readUrlQuery("cycle") ?? "all");
  const [filter, setFilterState] = useState<Filter>(() => {
    const url = readUrlQuery("filter") as Filter | null;
    if (url && FILTERS.includes(url)) return url;
    // A LINK TO ONE GOAL OUTRANKS THE REMEMBERED CHIP.
    //
    // The chip narrows the READ now, so arriving at `/goals/<id>` while "Completed" was the chip left on last
    // week fetches a page the linked goal is not in - and the reader follows a notification about a goal and
    // is told the link points at nothing. The remembered chip is a convenience for opening the page; it has no
    // business answering a request for a named record.
    if (openId) return "all";
    const key = FILTER_KEY();
    const v = (key ? readLocal(key) : null) as Filter | null;
    return v && FILTERS.includes(v) ? v : "all";
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    const key = FILTER_KEY();
    if (key) writeLocal(key, f);
  };
  const [q, setQ] = useState(() => readUrlQuery("q") ?? "");
  const [view, setViewState] = useState<GoalView>(() => {
    const url = readUrlQuery("view");
    if (url === "flat" || url === "quarter" || url === "tree") return url;
    const saved = readLocal("goals:view");
    return saved === "quarter" || saved === "tree" ? saved : "flat";
  });
  const setView = (v: GoalView) => {
    setViewState(v);
    writeLocal("goals:view", v);
  };
  // One person, picked from the team overview or the owner bar chart.
  const [ownerFilter, setOwnerFilter] = useState<string | null>(() => readUrlQuery("owner"));
  // Which team OWNS the goals. A goal can be marked as a department's, and the only page that offered this
  // filter was the one being folded in here - so the set somebody files a team goal to be part of was
  // unreachable from the page called Goals.
  const [deptFilter, setDeptFilter] = useState(() => readUrlQuery("dept") ?? "all");

  // ONE QUESTION AT A TIME.
  //
  // This page used to answer two at once: the reader's own goals, and then everybody else's, stacked in one
  // scroll under one set of filters that meant different things for each half. It had to explain itself in
  // copy ("these tiles count your OWN goals; the chips count everything in view"), and the grid of other
  // people's carried a comment distinguishing it from the Team goals page - two names for overlapping sets.
  // When the code needs a paragraph to tell two surfaces apart, nobody using it can.
  //
  // So the reader says WHOSE goals they are looking at, and the page answers that one question. It is also the
  // read: `mine` is `?employee=me`, `team` is `?manager=me` (the people who report to them and everyone in the departments they manage), `all` is
  // everything their scope allows. The switcher is hidden entirely for somebody whose grant reaches no further
  // than their own rows - the same gate the sidebar puts on the Team goals tab - and their scope is `mine`,
  // which is the honest name for what they were always seeing.
  const canSeeOthers = useCanReadOthers("goals");
  const [scope, setScopeState] = useState<GoalScope>(() => {
    if (forcedScope) return forcedScope;
    const url = readUrlQuery("scope");
    if (url === "mine" || url === "team" || url === "all") return url;
    // A link to one goal outranks the remembered scope, for the reason it outranks the remembered chip: the
    // scope is the read, and `mine` fetches a page that somebody else's goal is not in - so following a
    // notification about a report's goal would be told the link points at nothing.
    if (openId) return "all";
    const saved = readLocal("goals:scope");
    return saved === "team" || saved === "all" ? saved : "mine";
  });
  const setScope = (s: GoalScope) => {
    // On `/team-goals` the route IS the scope, so changing it moves to the page that can hold the new one -
    // otherwise the sidebar would say "Team goals" over a wall of the reader's own.
    if (forcedScope && s !== forcedScope) {
      writeLocal("goals:scope", s);
      navigate(s === "mine" ? "goals" : `goals?scope=${s}`);
      return;
    }
    setScopeState(s);
    writeLocal("goals:scope", s);
    // A person picked inside one scope is not a filter to carry into another.
    setOwnerFilter(null);
  };
  // Forced to `mine` for a caller who cannot see anybody else's: the switcher is not rendered, and a `?scope=`
  // in a pasted link must not put them in a scope that would read as empty.
  const activeScope: GoalScope = canSeeOthers ? scope : "mine";

  // EVERY FILTER IS A QUERY PARAMETER, AND THE NUMBERS COME BACK WITH THE ROWS.
  //
  // All of this used to happen in the browser over `rows` - one server page, capped at 100. For a handful of
  // goals that is the whole collection and every number on the page is right. For HR in a large org the page
  // said "At risk 3" and meant "3 of the hundred we loaded", with a truncation banner above doing the
  // apologising. `?state=` and `?q=` narrow the READ (the search through the same index global search uses,
  // so it finds goals this browser never held), and `counts=true` returns the chip numbers and the per-owner
  // rollup counted over the WHOLE filtered set - one request for the rows and the numbers together, which is
  // also what keeps them describing the same query.
  // The search is DEBOUNCED, because it is a request now: keyed straight off the box it would fetch once per
  // keystroke (the store keys on the params, so every character is a new read). One request per pause in the
  // typing, the way the directory's box already works.
  const settledQ = useDebounced(q.trim(), 250);
  const params = useMemo(() => {
    const p: Record<string, string> = { counts: "true" };
    if (cycleFilter !== "all") p.cycle = cycleFilter;
    if (filter !== "all") p.state = filter;
    // The scope IS a read filter. A picked person narrows inside it, and outranks it - "show me Priya's" is
    // already an answer to "whose", so it replaces `?manager=` rather than fighting it.
    if (ownerFilter) p.employee = `employees/${ownerFilter}`;
    else if (activeScope === "mine" && me.employee_id) p.employee = `employees/${me.employee_id}`;
    else if (activeScope === "team" && me.employee_id) p.manager = `employees/${me.employee_id}`;
    if (deptFilter !== "all") p.department = deptFilter;
    if (settledQ.length >= 2) p.q = settledQ;
    // The numbers on the Mine / My team / Everyone chips. Only asked for by a reader who sees those chips: in
    // Mine or My team it costs the server one more pass over everything the reader can list.
    if (canSeeOthers) p.scope_counts = "true";
    return p;
  }, [cycleFilter, filter, ownerFilter, settledQ, activeScope, deptFilter, me.employee_id, canSeeOthers]);
  const { rows, state, error, reload, hasMore, loadMore, meta } = useCollection<Goal>("goals", { params });
  /** The chip numbers and the team rollup, over the whole filtered set. Absent until the first read lands. */
  const counts = (meta as { counts?: GoalCounts } | undefined)?.counts;
  useDeepOpen(openId, rows, openDetail);
  // A link that names a goal this page has not loaded.
  //
  // `rows` is ONE server page (100 rows), narrowed further by the cycle picker, so a link out of a
  // notification, an activity feed or a chat message routinely points past it. `useDeepOpen` looked for the
  // row, did not find it, and did nothing at all: the reader followed a link to one goal and landed on a wall
  // of everybody else's, with nothing on screen saying the link had even been understood.
  //
  // So the cursor is walked until the goal turns up - but only so far. This is a deliberate chase after a
  // deliberate press, not a speculative prefetch (see the note in useCollection on why `all: true` is
  // opt-in), and a five-page ceiling keeps a bad link from reading the whole collection. Past it, and past
  // the end of the cursor, the page says so rather than going on looking.
  // `routeRecord()` and not `openId` alone, for the reason useDeepOpen gives: the record segment is written
  // and cleared with `setRouteRecord`, which replaces the address without announcing a route change, so
  // `openId` outlives the URL. Without this the banner came back the moment a filter moved, long after the
  // reader had opened the linked goal and closed it again.
  const openMissing = !!openId && routeRecord() === openId && state === "ready" && !rows.some((g) => idOf(g.path) === openId);
  const chased = useRef(0);
  useEffect(() => { chased.current = 0; }, [openId, cycleFilter]);
  useEffect(() => {
    if (!openMissing || !hasMore || chased.current >= 5) return;
    chased.current += 1;
    void loadMore();
  }, [openMissing, hasMore, loadMore, rows]);
  const openLost = openMissing && (!hasMore || chased.current >= 5);
  // Following the cursor because the reader asked to, rather than because a link pointed past the window.
  const [loadingMore, setLoadingMore] = useState(false);
  const pageIn = async () => {
    setLoadingMore(true);
    try { await loadMore(); } finally { setLoadingMore(false); }
  };
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  // Review cycles: a small, flat catalogue used to attach a goal to the cycle whose review will score it, and
  // to name that cycle on the card. Empty for anyone who can't read them, which just hides the field.
  const { rows: reviewCycles } = useCollection<ReviewCycle>("review-cycles", { all: true });
  // For the department-owned chip and its picker; empty for anybody who cannot read departments.
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  // `useCallback` so the search memo below can depend on it rather than on `departments` by hand.
  const deptName = useCallback(
    (ref?: string | null) => departments.find((d) => idOf(d.path) === idOf(ref ?? ""))?.display_name,
    [departments],
  );
  const cycleName = (ref?: string | null) => reviewCycles.find((c) => idOf(c.path) === idOf(ref ?? ""))?.name;
  // Which goal's drawer is open. Declared up here because it also decides whether the board tasks are read.
  const [detailPath, setDetailPath] = useState<string | null>(null);
  // Board tasks: needed as ROWS only by the open goal's drawer, which lists the linked tasks and offers the
  // unlinked ones to link. The wall of goal cards reads its "3/5 tasks" chip off each goal (the server rolls
  // the linked tasks up per page), so a page nobody has opened a goal on reads no cards at all.
  const { rows: cards, reload: reloadCards, hasMore: moreCards } = useCollection<KanbanCard>("cards", { enabled: !!detailPath });
  // Board tasks linked to a goal — the goal's progress derives from these (delivered share, weighted by points).
  const linkedFor = (g: Goal) => cards.filter((c) => c.goal && idOf(c.goal) === idOf(g.path) && !c.delete_time);
  const { toast } = useToast();
  const confirm = useConfirm();
  const sd = useSoftDelete("goals", "goal", reload);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState(EMPTY);
  // Whether the measure card is unfolded although the form holds no measure yet - the one piece of the
  // dialog's state that is not a field. Cleared when the dialog closes, so every fresh goal starts folded.
  const [measureOpen, setMeasureOpen] = useState(false);
  // Which of the editor's tabs is showing. Every open starts on Details.
  const [goalTab, setGoalTab] = useState("details");
  useEffect(() => { if (open) setGoalTab("details"); }, [open]);
  // Same rules as the task editor's panels (Boards.tsx): the gap between sections is what separates them, and
  // an edit's panels hold one height so a tab switch does not walk Save and Cancel up and down.
  const goalPanel = cn("grid content-start gap-7 data-[state=inactive]:hidden", editing && "sm:min-h-[30rem]");
  // The edit dialog's form as it was loaded, serialized. Only the Rebalance link reads it - see `openEdit`.
  const [editBaseline, setEditBaseline] = useState("");
  // The version the edit dialog is writing against. Refreshed from the server when a save loses a race, so the
  // next press can deliberately overwrite what the other person did.
  const [etag, setEtag] = useState<string | undefined>(undefined);
  // Back into the address. The neutral value goes out as null, so an unfiltered page leaves a clean URL.
  useEffect(() => { writeUrlQuery("filter", filter === "all" ? null : filter); }, [filter]);
  useEffect(() => { writeUrlQuery("cycle", cycleFilter === "all" ? null : cycleFilter); }, [cycleFilter]);
  useEffect(() => { writeUrlQuery("view", view === "flat" ? null : view); }, [view]);
  useEffect(() => { writeUrlQuery("q", q.trim() ? q : null); }, [q]);
  useEffect(() => { writeUrlQuery("owner", ownerFilter); }, [ownerFilter]);
  // `mine` is the default, so it leaves the address clean; the other two are what somebody shares.
  useEffect(() => { writeUrlQuery("scope", activeScope === "mine" ? null : activeScope); }, [activeScope]);
  useEffect(() => { writeUrlQuery("dept", deptFilter === "all" ? null : deptFilter); }, [deptFilter]);

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
  const isMine = useCallback((g: Goal) => !!g.employee && idOf(g.employee) === me.employee_id, [me.employee_id]);
  // A `useCallback` over the two things it actually reads. It used to be a plain function, which the `counts`
  // memo below could only depend on by restating `q` - and it also matches on the OWNER's name, which comes
  // from `empById`. Employees land in their own read, usually after the goals: searching for a colleague then
  // filtered the grid (recomputed every render) while the chip counts above it kept the numbers from before
  // the names existed, and stayed there until something else moved.
  // A NAME TYPED INTO THE SEARCH BOX IS AN OWNER, NOT A TITLE.
  //
  // The search used to match the owner's and the team's name as well as the goal's own words, because it ran
  // over rows the browser held and could see both. The read cannot: the index behind `?q=` covers the goal
  // itself, which is what lets it find goals this page never loaded. So a query that names somebody in the
  // directory offers their own filter instead - the affordance the feed already uses for an author, and a
  // better answer than a substring match, because picking it narrows the READ to every goal they own.
  const ownerSuggestions = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2 || ownerFilter) return [];
    return employees
      .filter((e) => `${e.first_name} ${e.last_name}`.toLowerCase().includes(s) && idOf(e.path) !== me.employee_id)
      .slice(0, 3);
  }, [q, ownerFilter, employees, me.employee_id]);
  // One list. The read has already answered whose goals these are, so there is nothing left to split.
  const shown = sortGoals(rows.filter((g) => !g.delete_time));

  // Per-owner rollup: who is carrying what, who is slipping, and whose weights are over 100 - counted over the
  // whole filtered set by the server rather than over the page. Built from `teamGoals` it was a rollup of
  // whichever of a manager's twelve reports fell inside the first hundred rows, and the over-100 weight
  // warning could only appear when the evidence for it happened to be loaded.
  const rollup = useMemo(
    () =>
      (counts?.owners ?? [])
        .filter((o) => idOf(o.employee) !== me.employee_id)
        .map((o) => ({ id: idOf(o.employee), active: o.active, avg: o.progress, overdue: o.overdue, weight: o.weight }))
        // Trouble floats up: the order the question is asked in.
        .sort((a, b) => b.overdue - a.overdue || b.active - a.active),
    [counts, me.employee_id],
  );
  const [rollupOpen, setRollupOpen] = useState(() => readLocal("goals:rollup") !== "0");
  const toggleRollup = () => {
    setRollupOpen((o) => {
      writeLocal("goals:rollup", o ? "0" : "1");
      return !o;
    });
  };

  // THE SCOREBOARD OVER MY OWN GOALS, ASKED AS ITS OWN QUESTION.
  //
  // Four tiles headed "Your goals", computed from `rows.filter(isMine)`. For an employee that is right, because
  // the page is their goals and nothing else. For a manager or HR it was whichever of their own goals happened
  // to fall in a page of the org's - so the number under "Active goals" was not their workload, it was a
  // coincidence of pagination. One extra read, `?employee=me&counts=true`, with `max_page_size=1` because only
  // the counts are wanted; the store dedupes it and it is the same request the Mine scope will make.
  const myParams = useMemo(
    () => (me.employee_id ? { employee: `employees/${me.employee_id}`, counts: "true" } : undefined),
    [me.employee_id],
  );
  const { meta: myMeta } = useCollection<Goal>("goals", { params: myParams, max: 1, enabled: !!me.employee_id });
  const mine = (myMeta as { counts?: GoalCounts } | undefined)?.counts;
  const stats = {
    active: mine?.states.active,
    done: mine?.states.completed,
    overdue: mine?.states.overdue,
    // The owner rollup over that same read is a single row - the reader's own - and it already carries the
    // weighted average and the weight total, so the tile and the rebalance warning read one number each.
    // `avg` stays UNDEFINED until the read lands, for the reason the three counts beside it do: "Average
    // progress 0%" is a claim, and it was being made about every reader for the beat before the answer came
    // back - on the one tile of the four that had been left printing a zero.
    avg: mine?.owners[0]?.progress,
    // A missing rollup row is a reader with no open goals, so nothing can be over 100 - a zero is the right
    // reading here rather than "not known yet".
    weight: mine?.owners[0]?.weight ?? 0,
  };

  const [rebalanceFor, setRebalanceFor] = useState<string | null>(null);
  // The owner's open goals, read as the owner's - not filtered out of this page's window.
  //
  // A spread is arithmetic over a SET: `even`/`normalise` share 100 across the rows they are handed, so a row
  // that was missing keeps its old weight and the real total goes over 100. For an employee the page's window
  // is their own handful of goals and the two coincide; for a manager or HR it is a page of the department's
  // or the org's, which a single cycle passes - and rebalancing a report is the ordinary path. Goal weights
  // drive weighted attainment in a review, which is what variable pay is computed from, so "correct only if
  // nothing was missing" is not a usable guarantee. The route takes `?employee=`; this asks it.
  const [rebalanceSet, setRebalanceSet] = useState<{ owner: string; goals: Goal[]; complete: boolean } | null>(null);
  useEffect(() => {
    if (!rebalanceFor) { setRebalanceSet(null); return; }
    let live = true;
    void getAllPages<Goal>(`goals?employee=${encodeURIComponent(`employees/${rebalanceFor}`)}&max_page_size=100`, 500)
      .then(({ results, truncated }) => { if (live) setRebalanceSet({ owner: rebalanceFor, goals: results.filter(isOpen), complete: !truncated }); })
      // A failed read used to open the dialog on an empty list under the "showing part of their goals, more
      // exist than could be loaded" heading - which describes a page cap, not a request that did not come
      // back, and left an empty dialog with a Save button as the whole account of what went wrong.
      .catch((e) => {
        if (!live) return;
        setRebalanceFor(null);
        toast({ title: "Couldn't load the goals to rebalance", description: (e as Error).message, variant: "destructive" });
      });
    return () => { live = false; };
  }, [rebalanceFor, toast]);

  // Clicking a stat tile toggles the matching filter on/off.
  const toggleFilter = (f: Filter) => setFilter(filter === f ? "all" : f);
  /** Whether anything is narrowing the read, so an empty answer can say which rather than "no goals yet". */
  const filtered = filter !== "all" || cycleFilter !== "all" || deptFilter !== "all" || !!ownerFilter || q.trim().length >= 2;
  const clearFilters = () => { setFilter("all"); setCycleFilter("all"); setDeptFilter("all"); setOwnerFilter(null); setQ(""); cf.clear(); };

  // The set, rather than the goals in it: what state everything is in, and how each owner's in-flight work is
  // progressing. Both from the server's counts, so the picture, the chips beside it and the grid below all
  // describe the same query - the donut used to be drawn from the loaded page, which made it a picture of a
  // pagination boundary on any org large enough to need one.
  const goalCharts = useMemo(() => {
    const STATES: { key: string; label: string; color: string }[] = [
      { key: "not_started", label: "Not started", color: "#8a8a85" },
      { key: "in_progress", label: "In progress", color: "#2a78d6" },
      { key: "completed", label: "Completed", color: "#1baf7a" },
      { key: "cancelled", label: "Cancelled", color: "#e34948" },
    ];
    const states = STATES.map((s) => ({ ...s, n: counts?.states[s.key] ?? 0 })).filter((s) => s.n > 0);
    const owners = rollup.filter((r) => r.active > 0).slice(0, 10);
    const ownerName = (id: string) => {
      const e = empById.get(id);
      return e ? `${e.first_name} ${e.last_name}` : id;
    };
    // The owner bar grows a row per owner; the donut takes the same height when they share the strip. Frappe
    // draws the ring from the height, so a fixed 200 sat as a small ring in a card stretched to the bar's 320.
    const ownersH = Math.min(320, Math.max(160, owners.length * 34 + 60));
    return {
      heights: { owners: ownersH, states: Math.max(260, owners.length > 1 ? ownersH : 0) },
      total: counts?.states.all ?? 0,
      // A goal state is the same state the cards, chips and rings show, so it keeps that meaning's colour.
      states: { labels: states.map((s) => s.label), values: states.map((s) => s.n), colors: states.map((s) => s.color), keys: states.map((s) => s.key), names: new Map(states.map((s) => [s.key, s.label])) },
      owners: { labels: owners.map((r) => ownerName(r.id)), values: owners.map((r) => r.avg) },
      ownerIds: owners.map((r) => r.id),
      ownerAvg: owners.length ? Math.round(owners.reduce((s, r) => s + r.avg, 0) / owners.length) : 0,
    };
  }, [counts, rollup, empById]);
  // The state donut narrows both grids to that status. It is a finer cut than the chips beside it - those
  // group work by what needs doing (overdue, at risk, unagreed), which crosses two of these states - so the
  // two filters compose rather than overwrite each other. The owner bar drives `ownerFilter`, which already
  // has its own visible control in the team overview below.
  const cf = useChartFocus<Goal, "state">({
    state: {
      keys: goalCharts.states.keys,
      label: (k) => goalCharts.states.names.get(k) ?? k,
      match: (g, k) => g.status === k,
    },
  });
  const picked = cf.apply(shown);
  // What the drawer walks with ‹ › and j/k: the goals on screen, IN THE ORDER THEY ARE ON SCREEN.
  //
  // It was the flat list in all three views, and two of the three do not render in that order: "By quarter"
  // groups the cards under Q1/Q2/Q3 headings and Alignment draws a cascade. So the drawer opened on a goal,
  // said "4 of 12", and › walked to a card that was somewhere else entirely - and the counter described a
  // sequence nothing on the page had. Each view now hands over its own order.
  const drawerQueue =
    view === "tree" ? alignmentOrder(picked)
    : view === "quarter" ? byQuarter(picked)
    : picked;

  function openCreate() {
    setEditing(null);
    setEtag(undefined);
    setForm({ ...EMPTY });
    setFromTemplate("");
    setOpen(true);
  }
  // The org's goal blueprints, offered where a goal is actually written.
  //
  // The catalogue and its `:apply` verb are HR's bulk door - stamp this template onto thirty people - and it
  // lives on a settings page. Somebody filing ONE goal had no way to reach the wording their org had already
  // agreed on, so the ramp-up goal every new joiner gets was retyped from memory every time. This fills the
  // form and leaves it editable; nothing is written until Create is pressed, so it is a starting point rather
  // than a second way to create goals.
  //
  // Read only while the dialog is open (D1 reads are demand-led), and empty for anyone without
  // `goal-templates.read` - which hides the control rather than disabling it.
  const { rows: templates } = useCollection<GoalTemplate>("goal-templates", { enabled: open });
  const usableTemplates = templates.filter((t) => !t.delete_time && !t.disabled);
  // Which one the form was filled from - held so the picker reads back what it did rather than snapping to
  // "Select…" the moment it fills eight fields.
  const [fromTemplate, setFromTemplate] = useState("");
  // Recomputed as they type, over rows the dialog already holds. Only while the title is long enough to be
  // a phrase rather than a first word.
  const titleMatches = useMemo(
    () => (form.title.trim().length < 6 ? [] : matchingTemplates(`${form.title} ${form.description}`, usableTemplates)),
    [form.title, form.description, usableTemplates],
  );
  function applyTemplate(t: GoalTemplate) {
    setFromTemplate(t.path);
    setForm((f) => ({
      ...f,
      title: t.title ?? f.title,
      description: t.description ?? "",
      weight: t.weight != null ? String(t.weight) : f.weight,
      unit: t.unit ?? "",
      baseline: t.baseline_value != null ? String(t.baseline_value) : "",
      target: t.target_value != null ? String(t.target_value) : "",
      // The template holds an INTERVAL, not a date, so the same blueprint is still right next quarter - the
      // date is computed when it is used (the same rule services/goalTemplates.ts applies on `:apply`).
      due_date: t.due_in_days != null ? addDaysYmd(todayStr(), t.due_in_days) : f.due_date,
      department: t.department ? `departments/${idOf(t.department)}` : f.department,
    }));
  }

  // A key result, filed under the objective it proves.
  //
  // The ladder is the whole point of an objective, and adding a rung to one meant pressing New goal, changing
  // Kind, then finding the objective again in a combobox of every goal in the org - by title, with no
  // indication of which of the four similarly named ones was the one just open. Everything a key result
  // inherits from its parent comes with it: the owner, the cycle that scores it, the team that owns it and the
  // date it answers to. All of it is still editable in the form.
  function openKeyResult(parent: Goal) {
    setEditing(null);
    setEtag(undefined);
    setForm({
      ...EMPTY,
      kind: "key_result",
      parent: `goals/${idOf(parent.path)}`,
      // "me" rather than an explicit self-reference: the create path sends the field only when it names
      // somebody else, and that is what a self-scoped policy allows without any right over other people.
      employee: parent.employee && idOf(parent.employee) !== me.employee_id ? `employees/${idOf(parent.employee)}` : "me",
      cycle: parent.cycle ? `review-cycles/${idOf(parent.cycle)}` : "none",
      department: parent.department ? `departments/${idOf(parent.department)}` : "none",
      due_date: parent.due_date ?? "",
    });
    setOpen(true);
  }
  // Opening a goal writes its id into the path (replaceState - no history churn), so the drawer is linkable and
  // a pasted link reopens exactly this goal through useDeepOpen.
  function openDetail(g: Goal) {
    setDetailPath(g.path);
    setRouteRecord(idOf(g.path));
  }
  function closeDetail() {
    setDetailPath(null);
    setRouteRecord(null);
  }
  // Reported by the drawer, because the unsaved slider lives there and the sheet lives here.
  const [progressDirty, setProgressDirty] = useState(false);
  // Every other way out of the drawer already refuses to leave an unsaved progress move behind: ‹ › and j/k
  // are disabled while one is pending. Closing the sheet - Esc, the X, a click on the overlay - dropped it
  // without a word, and the note typed alongside it with it.
  async function requestCloseDetail() {
    if (
      progressDirty &&
      !(await confirm({
        title: "Discard this progress change?",
        description: "The slider has moved but nothing has been saved. Closing the goal loses the change and the note with it.",
        confirmLabel: "Discard",
        destructive: true,
      }))
    ) return;
    closeDetail();
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
    const loaded = {
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
    };
    setForm(loaded);
    // What this editing session started from. WriteDialog's own discard guard holds its baseline privately, and
    // the Rebalance link below leaves by a door the guard does not watch - so the page keeps one too.
    setEditBaseline(JSON.stringify(loaded));
    setOpen(true);
  }

  // Throws to fail: WriteDialog pins the message in the form and keeps what was typed.
  async function submit() {
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      weight: form.weight === "" ? 0 : Number(form.weight),
      // STATUS TRAVELS ONLY WHEN IT IS AN ANSWER. Sending back the value the dialog loaded (or the default it
      // opened with) made every save an EXPLICIT status, and an explicit status is exactly what stops the
      // server completing a goal whose measure reached its target - `!has("status")` in services/goals.ts.
      // So a goal edited to "60 of 60 customers" saved at 100% and "In progress", under a form that had just
      // said saving it would complete it.
      ...(editing
        ? (form.status === editing.status ? {} : { status: form.status })
        : (form.status === EMPTY.status ? {} : { status: form.status })),
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
      current_value: num(currentFor(!!editing, form)) ?? null,
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
  // Answers whether it landed. The two sliders both have to know: progress is written through here and read
  // back off a reloaded row, so between the press and the new row arriving the local value and `goal.progress`
  // still disagree - and a control that calls that "unsaved" asks to discard a change that was just saved,
  // while one that assumes success goes quiet after a write that failed.
  async function setProgress(g: Goal, progress: number, note?: string): Promise<boolean> {
    // The shared rule, not a fourth copy of it: what a percentage implies about status is stated in
    // lib/goalState.ts because the review's own progress row writes through the same verb.
    const status = statusForProgress(progress, g.status);
    try {
      await invoke(`goals/${idOf(g.path)}`, "updateProgress", undefined, {
        progress,
        ...(status ? { status } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      toast({ title: progress >= 100 ? "Goal marked complete" : `Progress set to ${progress}%`, variant: "success" });
      reload();
      return true;
    } catch (e) {
      toast({ title: "Couldn't update progress", description: (e as Error).message, variant: "destructive" });
      return false;
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
  // The first person named on two rows, or null. The picker below also hides whoever is already on another
  // row, so this only catches a split restored from a draft or seeded from the task suggestion.
  const contribDupe = contribRows.find((r, i) => r.employee && contribRows.findIndex((x) => x.employee === r.employee) !== i)?.employee ?? null;
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
  // The note is written into the goal's comment thread, so it carries mentions exactly as a comment does.
  const changesRef = useRef<HTMLTextAreaElement>(null);
  const changesMentions = useMentions({ value: changesNote, onChange: setChangesNote, textareaRef: changesRef, employees });

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
    // One goal, from its own drawer, is a deliberate press on the thing it is about, and the toast that
    // follows undoes it. The banner's press is neither: it acts on every carryable goal in view - other
    // people's included - and cancelling somebody's goal reaches their notifications and their review. That
    // one says what it is about to do first.
    if (
      list.length > 1 &&
      !(await confirm({
        title: `Carry ${list.length} goals into next quarter?`,
        description: `Each is copied with its progress and a due date of ${formatDate(nextQuarterEndStr())}, and the original is cancelled. Undo is offered once it is done.`,
        confirmLabel: "Carry them over",
      }))
    ) return;
    const made: { copy: Goal; old: Goal; oldStatus: GoalStatus }[] = [];
    try {
      for (const g of list) {
        // Everything the edit form above sends, minus the two things carry-over decides for itself (the due
        // date and the cycle). A partial copy is worse than a clean loss here: dropping `unit`/`baseline`/
        // `target`/`current` left the goal carrying the old PERCENTAGE with nothing behind it, so
        // `measuredPct` returned null, the measure control vanished from the drawer, and a key result silently
        // became a manual-progress goal - while the number that feeds weighted attainment in a review, and
        // through `review-cycles:award` variable pay, survived. `kind` is on the same list: without it a
        // `key_result` comes back as an `objective`.
        const copy = await create<Goal>("goals", {
          title: g.title,
          description: g.description ?? "",
          weight: g.weight ?? 0,
          progress: g.progress ?? 0,
          status: g.status,
          kind: g.kind,
          due_date: nextQuarterEndStr(),
          // The measure travels whole, the way the edit form sends it.
          unit: g.unit ?? null,
          baseline_value: g.baseline_value ?? null,
          target_value: g.target_value ?? null,
          current_value: g.current_value ?? null,
          ...(g.employee ? { employee: `employees/${idOf(g.employee)}` } : {}),
          ...(g.parent ? { parent: `goals/${idOf(g.parent)}` } : {}),
          ...(g.department ? { department: `departments/${idOf(g.department)}` } : {}),
          ...(g.blocked_by ? { blocked_by: `goals/${idOf(g.blocked_by)}` } : {}),
          ...(nextCycleRef ? { cycle: nextCycleRef } : {}),
        });
        await patch(`goals/${idOf(g.path)}`, { status: "cancelled" }, g.etag);
        made.push({ copy, old: g, oldStatus: g.status });
      }
      closeDetail();
      reload();
      toast({
        title: made.length === 1 ? "Goal carried over" : `${made.length} goals carried over`,
        // Said, because the copy quietly loses its review cycle when no open cycle covers the new due date -
        // and a goal attached to no cycle is scored by no review, which is the whole point of carrying it.
        description: `New due date ${formatDate(nextQuarterEndStr())}; the originals were cancelled.${nextCycleRef ? "" : " No open review cycle covers that date, so the copies are not attached to one."}`,
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
      // WRITTEN AGAINST A VERSION READ NOW, not against the one the drawer's list is holding. Those rows come
      // from the cards collection with its own freshness window, so the version beside them can be seconds old
      // by the time somebody presses the button - and anything that touched the card in between (a drag across
      // the board, an automation, this reader's own delivery a moment ago) turns the press into a lost-update
      // refusal that has nothing to do with what they asked for. There is nothing to merge here either way: the
      // whole edit is one reference, which the button names in full, so a stale version protects nobody. One
      // indexed row read is the price of the button meaning what it says.
      const fresh = await get<KanbanCard>(`cards/${idOf(card.path)}`);
      await patch(`cards/${idOf(card.path)}`, { goal: unlink ? "" : g.path }, fresh.etag);
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

  // THE OWNER'S WHOLE OPEN SPREAD, NOT THIS PAGE'S WINDOW.
  //
  // This used to add up the weights in `rows` - one server page, narrowed by every filter above the grid. So
  // with the chip on "Completed" the hint read "Other open goals total 0" and the over-100 warning could not
  // fire at all, on the one form whose job is to set that number; and for a manager filing a goal for a report
  // it counted whichever of their goals happened to fall in the loaded page. The page's own warning was moved
  // onto the server's counts for exactly this reason (see `stats.weight`) and the dialog was left behind.
  //
  // One `?employee=…&counts=true` read, `max_page_size=1` because only the owner rollup is wanted, and only
  // while the dialog is open. The store keys on the params, so picking a different owner is one small read and
  // the reader's own goals cost nothing at all - it is the same request the scoreboard above already makes.
  const ownerParams = useMemo(
    () => (open && dialogOwnerId ? { employee: `employees/${dialogOwnerId}`, counts: "true" } : undefined),
    [open, dialogOwnerId],
  );
  const { meta: ownerMeta } = useCollection<Goal>("goals", { params: ownerParams, max: 1, enabled: !!ownerParams });
  const ownerCounts = (ownerMeta as { counts?: GoalCounts } | undefined)?.counts;
  // The goal being edited is already inside that total, and the form is about to replace its weight - so it
  // comes out, the way the old `excludePath` took it out.
  const editingOpenWeight = editing && isOpen(editing) ? editing.weight ?? 0 : 0;
  const otherWeights = Math.max(0, (ownerCounts?.owners[0]?.weight ?? 0) - editingOpenWeight);
  const weightInvalid = form.weight !== "" && (Number(form.weight) < 0 || Number(form.weight) > 100);
  const weightTotal =
    otherWeights +
    (form.status === "not_started" || form.status === "in_progress" ? (form.weight === "" ? 0 : Number(form.weight) || 0) : 0);

  // Alignment targets for the dialog: any visible, non-cancelled goal that isn't the goal itself or below it.
  // A key result never parents anything - the ladder is objective -> key result, one rung deep, or the
  // "weighted average of my children" rule stops meaning anything.
  const alignables = rows.filter((g) => g.status !== "cancelled" && g.kind !== "key_result" && (!editing || !descendantsOf(editing).has(idOf(g.path))));
  // Anything still live that is not this goal. Waiting on something is not alignment: a key result is a
  // perfectly ordinary thing to be blocked by, and a goal may wait on one of its own children.
  const blockables = rows.filter((g) => g.status !== "cancelled" && (!editing || g.path !== editing.path));

  // The measure, read back live: the percentage the server will compute, and the two shapes worth naming (a
  // target that equals the baseline measures nothing; a target below it counts down).
  const measurePct = measuredPct(num(form.baseline), num(form.target), num(currentFor(!!editing, form)));
  const targetEqualsBaseline = num(form.target) != null && num(form.target) === (num(form.baseline) ?? 0);
  const countsDown = num(form.target) != null && num(form.target)! < (num(form.baseline) ?? 0);
  // A measure that reaches its target completes the goal - the rule the slider follows and the one the server
  // applies to a measured write. The form said so in a sentence and then sent the status the Select still
  // held, so it was a promise the save broke. Flipped here, where the reader can see it happen and change it
  // back. Nothing auto-reopens a goal whose number later comes down, which is the server's rule too, and a
  // cancelled goal is not quietly revived by its numbers.
  useEffect(() => {
    if (!open || measurePct !== 100) return;
    setForm((f) => (f.status === "completed" || f.status === "cancelled" ? f : { ...f, status: "completed" }));
  }, [open, measurePct]);
  // THE MEASURE IS OPTIONAL, AND LOOKED COMPULSORY. Five boxes sat open in the middle of the form for every
  // goal, between what it is called and what it is worth, so "ship the billing revamp" - moved by hand, like
  // most goals - was asked five questions it has no answers to and had to be scrolled past to reach Save. It
  // is folded away now, and unfolds itself whenever there IS a measure to show: a template that carries one, a
  // goal being edited that has one, an accepted suggestion, or the press of the button.
  const hasMeasureValues = !!(form.target.trim() || form.unit.trim() || form.baseline.trim() || form.current.trim());
  const showMeasure = measureOpen || hasMeasureValues;

  // A CLOSED cycle is not a cycle to file new work against: its review has already scored what was attached to
  // it, so a goal added now is scored by something that has happened. The one closed cycle worth listing is the
  // one this goal is already on - dropping it would silently detach the goal on the next save.
  const pickableCycles = useMemo(
    () => reviewCycles.filter((c) => c.state !== "CLOSED" || (!!editing?.cycle && idOf(editing.cycle) === idOf(c.path))),
    [reviewCycles, editing],
  );

  // WHO THE LEAD CAN BE, once a department owns the goal.
  //
  // Its own people first - that is who leads its goals - and everybody else after, carrying the name of the
  // department they are actually in. SORTED, NOT FILTERED: a Support goal is quite often led from outside
  // Support, an org part-way through filling in `employees.department` would offer a list with almost nobody
  // on it, and a picker that cannot name the right person is one people work around by leaving the department
  // blank - which loses the fact the goal belongs to the team. The order carries the recommendation; the
  // suffix says when a pick is a crossing.
  const ownerOptions = useMemo(() => {
    const pickedDept = form.department === "none" ? null : idOf(form.department);
    const named = (e: Employee) => `${e.first_name} ${e.last_name}`;
    const inPicked = (e: Employee) => !!pickedDept && !!e.department && idOf(e.department) === pickedDept;
    const elsewhere = (e: Employee) => `${named(e)} · ${deptName(e.department) ?? "No department"}`;
    const others = employees.filter((e) => idOf(e.path) !== me.employee_id);
    const mine = employees.find((e) => idOf(e.path) === me.employee_id);
    const meOutside = !!pickedDept && !(mine && inPicked(mine));
    return [
      // Myself stays at the top whatever the department: it is the default and the commonest answer. It says
      // where the reader sits when that is not the department picked, so "Myself" is not a silent crossing.
      { value: "me", label: meOutside ? `Myself · ${deptName(mine?.department) ?? "No department"}` : "Myself" },
      ...others.filter(inPicked).map((e) => ({ value: `employees/${idOf(e.path)}`, label: named(e) })),
      ...others.filter((e) => !inPicked(e)).map((e) => ({
        value: `employees/${idOf(e.path)}`,
        label: pickedDept ? elsewhere(e) : named(e),
      })),
    ];
  }, [employees, form.department, me.employee_id, deptName]);

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

  // From `2xl` more goals per row at the size they are three across (`grid-cols-fill`), not wider cards.
  const grid = (list: Goal[], team = false) => (
    <div className="grid gap-4 [--cell:20rem] md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-fill">
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
            onDelete={() => sd.softDelete(g, { subject: `"${g.title}"` })}
            onProgress={(p) => setProgress(g, p)}
          />
        </AccessItem>
      ))}
    </div>
  );

  // The shared chip. Pressing the one already on clears it back to "all" - it used to do nothing, so the only
  // way out of "Cancelled" (which this page REMEMBERS across visits, and which opens on an empty grid) was
  // the "Show all" link underneath.
  // The number is the server's, and it is OMITTED rather than guessed until the read lands - which is what
  // FilterChip's optional `count` is for ("omitted where counting it would cost a read the page has not
  // done"). A chip that shows a client-side count while waiting would flash the window's number and then
  // correct itself, which is the behaviour this whole pass is removing.
  const chipCount = (f: Filter) => (f === "all" ? counts?.states.all : counts?.states[f]);
  const filterChip = (f: Filter, label: string) => (
    <FilterChip key={f} active={filter === f} count={chipCount(f)} onClick={() => toggleFilter(f)}>{label}</FilterChip>
  );

  return (
    <TooltipProvider delayDuration={150}>
    <div>
      {/* The heading names the route, not the component. `/team-goals` is this page with the team scope
          pinned, and the sidebar entry beside it says "Team goals" - a page titled "Goals" under that entry
          would read as the wrong one having opened. */}
      <PageHeader
        accessCollection="goals"
        title={forcedScope ? "Team goals" : "Goals"}
        description={forcedScope
          ? "Goals across every team you can see, grouped by team."
          : "Set and track performance goals."}
        actions={<>{createBtn}<PageSettings me={me} host="goals" /></>}
      />

      {/* The truncation notice is GONE from this page, and that is the whole point of counting on the server.
          It said the view was incomplete and to go and use ⌘K, because every number above the list described
          a hundred rows. The numbers now describe the collection, the search reads the collection, and the
          foot of the list says "showing 100 of 342" - so the banner would be warning about a window that no
          longer decides any of the answers. */}

      {/* Outside DataState, and above the empty state, because the two cases it covers are exactly the ones
          where the page below it is misleading: an empty grid that looks like "you have no goals", and a full
          grid of goals that are not the one asked for. */}
      {openLost && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <span>
            {/* Any filter can be the reason now, not only the cycle - all of them narrow the read. */}
            {filtered
              ? "The goal this link points to is outside the filters this page is showing."
              : "The goal this link points to is not here. It may have been deleted, or it may be outside what you can see."}
          </span>
          {filtered && (
            <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>
          )}
        </div>
      )}

      {/* WHOSE, then WHICH - and it has to be ON SCREEN for that order to mean anything.
          This row decides what the whole page is about, and it used to sit below two charts and a scoreboard:
          a reader looking for their team's goals, or for everybody's, had to scroll past a donut of their own
          to find out the page could answer that at all. The charts describe whatever the scope selected, so
          they belong after it.
          ABOVE `DataState` for the same reason: an empty read is a state of one SCOPE. "My team - no goals
          yet" is an answer; the same words with no way to switch back read as the page being broken.
          Hidden entirely for a reader whose grant reaches no further than their own goals - "Mine" alone is
          not a choice, and the sidebar applies the same gate to the Team goals tab. */}
      {canSeeOthers && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Showing</span>
          {SCOPES.map((sc) => (
            <FilterChip key={sc.value} active={activeScope === sc.value} count={counts?.scopes?.[sc.value]} onClick={() => setScope(sc.value)}>{sc.label}</FilterChip>
          ))}
          {/* The triage layout for the same goals: one row per goal, worst first, with agree and
              ask-for-an-update on the row. It lands on Needs attention, which is the set being chased. */}
          {activeScope !== "mine" && (
            <button type="button" className="ml-auto text-xs font-medium text-primary hover:underline" onClick={() => navigate("team-goals?filter=trouble")}>
              Chase up
            </button>
          )}
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {/* AN EMPTY READ IS NOT AN EMPTY COLLECTION.
            Every filter narrows the READ now - the chip and the search as well as the cycle - so `rows` is
            empty whenever the current narrowing matches nothing, and this branch owns the whole page
            including the controls. Printing "No goals yet. Create a goal." there tells somebody with fifty
            goals they have none AND takes away the only control that could undo it. So the flat empty state
            is kept for the one case it describes - nothing filtered, nothing found - and every other empty
            read falls through to the page below, which renders its chips, its pickers and a line saying what
            is narrowing it. */}
        {rows.length === 0 && !filtered ? (
          // Empty means something different in each scope, and only one of them is an invitation to write a
          // goal. "My team" empty is usually "you have no reports", which no amount of Create fixes.
          activeScope === "team" ? (
            <EmptyState
              illustration="goals"
              icon={Users}
              title="No goals under you"
              description="Nobody on your team has a goal yet. Your team is the people who report to you, plus everyone in the departments that list you as a manager, sub-departments included."
              action={<Button variant="outline" onClick={() => setScope("all")}>Show everyone</Button>}
            />
          ) : activeScope === "all" ? (
            <EmptyState illustration="goals" icon={Target} title="No goals yet" description="Nobody you can see has filed a goal." action={createBtn} />
          ) : (
            <EmptyState illustration="goals" icon={Target} title="No goals yet" description="Create a goal to start tracking what you're working toward." action={createBtn} />
          )
        ) : (
          <div className="space-y-6">
            {/* A wall of goal cards says how each goal is doing and nothing about how the SET is doing.
                These two do: what state the goals are in, and how far along each owner's are - which is the
                question the team overview chips answer one person at a time. They lead the page: every tile
                and chip below them filters the goals, so those belong next to the goals. */}
            {/* Six, not three. A donut cut into three slices of one goal each is a picture of nothing, and it
                was the first thing on the page for anybody with a handful of goals of their own - pushing the
                goals themselves below the fold to say what the four tiles under it already say in words. */}
            {goalCharts.total >= 6 && (
              <ChartStrip id="goals">
                <ChartCard title="Goals by state" description="Every goal in view, by where it has got to.">
                  <Chart
                    type="donut"
                    height={goalCharts.heights.states}
                    labels={goalCharts.states.labels}
                    datasets={[{ name: "Goals", values: goalCharts.states.values }]}
                    colors={goalCharts.states.colors}
                    ariaLabel="Goals by state"
                    {...cf.chart("state")}
                  />
                </ChartCard>
                {goalCharts.owners.labels.length > 1 && (
                  <ChartCard title="Progress by owner" description="Weighted average progress across each person's goals in flight.">
                    <Chart
                      type="bar"
                      height={goalCharts.heights.owners}
                      labels={goalCharts.owners.labels}
                      datasets={[{ name: "Progress", values: goalCharts.owners.values }]}
                      markers={goalCharts.ownerAvg > 0 ? [{ label: `Team ${goalCharts.ownerAvg}%`, value: goalCharts.ownerAvg }] : undefined}
                      format={(v) => `${v}%`}
                      ariaLabel="Average progress on goals in flight, by owner"
                      onSelect={(i) => { const id = goalCharts.ownerIds[i]; setOwnerFilter((f) => (f === id ? null : id ?? null)); }}
                      selected={ownerFilter && goalCharts.ownerIds.indexOf(ownerFilter) >= 0 ? goalCharts.ownerIds.indexOf(ownerFilter) : null}
                    />
                  </ChartCard>
                )}
              </ChartStrip>
            )}

            {/* The scoreboard is the MINE scope's, and now it only appears there. It counts the reader's own
                goals, which is why it needed a "Your goals" heading to sit over a grid of everybody's, and
                why the chips beside it had to be explained as answering a different question. One scope at a
                time and both of those go away. */}
            {activeScope === "mine" && !ownerFilter && (stats.active ?? 0) + (stats.done ?? 0) > 0 && (
              // Counts and percentages - short enough to sit two across a phone rather than filling four
              // rows above the goals themselves.
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {/* A dash until the counts land, rather than a zero: "Active goals 0" is a claim, and it was
                    being made about every reader for the beat before the read returned. */}
                <StatTile label="Active goals" value={stats.active == null ? "-" : String(stats.active)} onClick={() => toggleFilter("active")} active={filter === "active"} />
                <StatTile label="Average progress" value={stats.avg == null ? "-" : `${stats.avg}%`} bar={stats.avg} />
                <StatTile label="Completed" value={stats.done == null ? "-" : String(stats.done)} onClick={() => toggleFilter("completed")} active={filter === "completed"} />
                <StatTile label="Overdue" value={stats.overdue == null ? "-" : String(stats.overdue)} alert={!!stats.overdue} onClick={() => toggleFilter("overdue")} active={filter === "overdue"} />
              </div>
            )}
            {/* The reader's own weight total, from the read that is about them - it used to be summed over
                whichever of their goals were in the page, so the warning could only appear when the evidence
                happened to be loaded, and the figure it quoted was a subtotal. */}
            {me.employee_id && stats.weight > 100 && (
              <p className="text-xs font-medium text-warning">
                Your open goals total {stats.weight} weight, over the usual 100.{" "}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setRebalanceFor(me.employee_id!)}>Rebalance</button>
              </p>
            )}

            {filter === "overdue" && (() => {
              const carryable = picked.filter(canCarry);
              if (!carryable.length) return null;
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
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
              {/* The chasing question, in the scopes where chasing is what the reader came to do. */}
              {activeScope !== "mine" && (!!chipCount("trouble") || filter === "trouble") && filterChip("trouble", "Needs attention")}
              {/* Landing this week. Sits between "Active" and "Overdue" because that is the order the dates
                  run in, and it is the only chip on the row about work that has not gone wrong yet. */}
              {(!!chipCount("due_soon") || filter === "due_soon") && filterChip("due_soon", "Due this week")}
              {(!!chipCount("overdue") || filter === "overdue") && filterChip("overdue", "Overdue")}
              {/* Behind pace, and gone quiet: both arrive weeks before a missed date, and both are hidden
                  inside "Active" until you ask for them by name. Shown only when there are any. */}
              {(!!chipCount("at_risk") || filter === "at_risk") && filterChip("at_risk", "At risk")}
              {(!!chipCount("quiet") || filter === "quiet") && filterChip("quiet", "Gone quiet")}
              {(!!chipCount("unagreed") || filter === "unagreed") && filterChip("unagreed", "Not agreed")}
              {filterChip("completed", "Completed")}
              {filterChip("cancelled", "Cancelled")}
              {/* The picked person, said where every other filter is said. The control that sets this lives
                  inside the team overview, which is collapsible and REMEMBERS being collapsed - so picking
                  somebody, hiding the overview and coming back later left a page showing one person's goals
                  with nothing on it naming the filter and no way to clear it. The owner bar chart sets the
                  same state from the top of the page, out of sight of the chips it narrows. */}
              {ownerFilter && (
                <FilterChip active onClick={() => setOwnerFilter(null)} title="Show everybody's goals again">
                  <span className="inline-flex items-center gap-1">
                    {empName(`employees/${ownerFilter}`)} only <X className="h-3 w-3" />
                  </span>
                </FilterChip>
              )}
              {/* Wraps, because the three controls in here are 550px of fixed widths (a 176px cycle select,
                  the view toggle, a 176px search box) and a phone is 390: without it the row could not break
                  and the whole PAGE scrolled sideways - and only once an org had a review cycle to pick from,
                  which is why an empty database never showed it. */}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {/* Narrow to one cycle's goals, or to the ones no cycle will score. Filtered by the SERVER
                    (`?cycle=`), because "which goals belong to H1" is a question about every goal, not about
                    the page of them this browser happens to hold. */}
                {/* Which team owns them. Only where it can mean something: in `mine` every goal is the
                    reader's own and the question is about the org's teams, not theirs. */}
                {activeScope !== "mine" && departments.length > 0 && (
                  <Select value={deptFilter} onValueChange={setDeptFilter}>
                    <SelectTrigger className="h-8 w-44 text-xs" aria-label="Owning team"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any team</SelectItem>
                      <SelectItem value="none">No team</SelectItem>
                      {departments.filter((d) => !d.delete_time).map((d) => (
                        <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {reviewCycles.length > 0 && (
                  <Select value={cycleFilter} onValueChange={setCycleFilter}>
                    {/* Named, because a select whose only label is its own current value announces as
                        "All cycles, combobox" - which says what it holds and never what it decides. */}
                    <SelectTrigger className="h-8 w-44 text-xs" aria-label="Review cycle"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All cycles</SelectItem>
                      <SelectItem value="none">No cycle</SelectItem>
                      {reviewCycles.map((c) => (
                        <SelectItem key={c.path} value={`review-cycles/${idOf(c.path)}`}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className="flex overflow-hidden rounded-md border text-xs font-medium" role="group" aria-label="Goal layout">
                  {(["flat", "quarter", "tree"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      aria-pressed={view === v}
                      title={v === "tree" ? "The alignment cascade: what rolls up into what, from the top" : undefined}
                      className={cn("px-2.5 py-1 transition-colors", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
                    >
                      {/* The default layout is named for what it draws in this scope: a grid of the reader's
                          own goals, or the per-person triage over other people's. */}
                      {v === "flat" ? (activeScope === "mine" ? "All" : "By person") : v === "quarter" ? "By quarter" : "Alignment"}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search goals…" aria-label="Search goals" className="h-8 w-44 pl-8 text-sm sm:w-56" />
                </div>
              </div>
            </div>

            {/* The search matches a goal's own words, across the whole collection. A query that also names
                somebody in the directory offers their filter instead, which is the better answer anyway: it
                narrows the read to every goal they own rather than to the ones whose text happens to contain
                their name. */}
            {ownerSuggestions.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Looking for someone's goals?
                {ownerSuggestions.map((e) => (
                  <button
                    key={e.path}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => { setOwnerFilter(idOf(e.path)); setQ(""); }}
                  >
                    <PhotoAvatar employeeId={idOf(e.path)} name={`${e.first_name} ${e.last_name}`} photo={e.photo} className="h-4 w-4" />
                    {e.first_name} {e.last_name}
                  </button>
                ))}
              </p>
            )}

            <ChartFilterNote label={cf.activeLabel} shown={picked.length} total={shown.length} onClear={cf.clear} />

            {/* The cascade replaces the grid rather than sitting beside it: its whole point is that it does
                NOT split the goals by whose they are - it splits them by what they roll up into, which is a
                different question and the one alignment is for. */}
            {view === "tree" && (
              <AlignmentTree
                goals={picked}
                all={rows}
                empName={empName}
                meId={me.employee_id}
                onOpen={(g) => openDetail(g)}
              />
            )}

            {view !== "tree" && (picked.length > 0 || ownerFilter) && (
              <section className="space-y-3">
                {/* No heading over the reader's own scope: the scope chips above already say whose these are,
                    and a heading repeating it is the page explaining itself again. The overview belongs to the
                    scopes that cover other people. */}
                {activeScope !== "mine" && rollup.length >= 2 && (
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> By owner
                    <button type="button" className="ml-auto font-medium normal-case tracking-normal text-primary hover:underline" onClick={toggleRollup}>
                      {rollupOpen ? "Hide overview" : "Show overview"}
                    </button>
                  </h2>
                )}
                {activeScope !== "mine" && rollup.length >= 2 && rollupOpen && (
                  <div className="flex flex-wrap gap-2">
                    {rollup.map((r) => {
                      const e = empById.get(r.id);
                      if (!e) return null;
                      const name = `${e.first_name} ${e.last_name}`;
                      const selected = ownerFilter === r.id;
                      return (
                        // A div wrapping two buttons rather than one button: the chip filters, and an
                        // over-100 spread needs its own press. RebalanceDialog was reachable from exactly one
                        // place - a warning the caller only ever saw about their OWN goals - so a manager
                        // looking at a report whose weights add to 130 had nowhere to go but the goals one at
                        // a time.
                        <div
                          key={r.id}
                          className={cn(
                            "flex items-center gap-2 rounded-lg border pr-1 text-xs transition-colors",
                            selected ? "border-primary ring-1 ring-primary" : "hover:bg-accent/50",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setOwnerFilter(selected ? null : r.id)}
                            aria-pressed={selected}
                            className="flex items-center gap-2 py-1.5 pl-2.5 text-left"
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
                          {r.weight > 100 && (
                            <button
                              type="button"
                              onClick={() => setRebalanceFor(r.id)}
                              title={`${name}'s open goals total ${r.weight} weight, over the usual 100. Rebalance them.`}
                              className="rounded-full bg-warning/10 px-2 py-0.5 font-medium tabular-nums text-warning transition-colors hover:bg-warning/20"
                            >
                              {r.weight} wt
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* THE TRIAGE IS A LAYOUT, and it is the right one for other people's goals: a wall of cards
                    cannot answer "who is sliding and who has gone quiet", which is a comparison. It used to be
                    a page of its own with its own filters, its own counts and copy explaining how it differed
                    from this grid. Same rows, same scope, drawn the way the question wants. */}
                {picked.length > 0 && activeScope !== "mine" && view === "flat" ? (
                  <>
                    {/* WHAT TO UNBLOCK FIRST, above the chasing pass rather than inside it: a triage row asks
                        "who is sliding", and this answers "why", which is the question to settle first. */}
                    <GoalBlockers goals={picked} onOpen={openDetail} />
                    {/* The two questions a wall of cards cannot answer: which goals roll up to nothing, and
                        who has not set one. Counted over the rows already on screen. */}
                    <GoalCoverage goals={picked} employees={employees} onOpen={openDetail} />
                    <TeamTriage goals={picked} employees={employees} departments={departments} me={me} deptName={deptName} onChanged={reload} onOpen={openDetail} />
                  </>
                ) : picked.length > 0
                  // The owner's face rides on the card in any scope but `mine`, where every card is the
                  // reader's and a row of identical avatars says nothing.
                  ? gridView(picked, activeScope !== "mine")
                  : <p className="text-sm text-muted-foreground">No goals match for this person. <button type="button" className="font-medium text-primary hover:underline" onClick={() => setOwnerFilter(null)}>Show everyone in this scope</button></p>}
              </section>
            )}
            {/* The cascade prints its own "no goals match these filters", so this line is for the grid only -
                it used to print underneath it, saying the same thing twice. And it used to be withheld
                whenever a chart slice was picked, which is the one case where the reason the grid is empty is
                furthest from the grid: the pick lives in a donut at the top of the page. */}
            {view !== "tree" && picked.length === 0 && !ownerFilter && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {/* Said of the whole collection now, not of a page of it: the search and the chip are the
                    read, so "nothing matches" is a fact about every goal this caller can see rather than
                    about the hundred rows that happened to be loaded. */}
                {q.trim()
                  ? `No goal you can see matches “${q.trim()}”.`
                  : cf.picked
                    ? `Nothing is both ${cf.activeLabel?.toLowerCase()} and in this filter.`
                    : cycleFilter !== "all"
                      ? `Nothing in ${cycleName(cycleFilter) ?? "this cycle"} matches this filter.`
                      : "Nothing matches this filter."}{" "}
                <button type="button" className="font-medium text-primary hover:underline" onClick={clearFilters}>Clear filters</button>
              </p>
            )}

            {/* The way past the first page. The server caps a list at 100 rows, so a large set arrives a page
                at a time - but the numbers above no longer describe the page, which is what makes this a
                request for more CARDS rather than for a more honest answer. */}
            {hasMore && (
              <div className="pt-1 text-center">
                <Button variant="outline" size="sm" loading={loadingMore} onClick={() => pageIn()}>Load more goals</Button>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Showing {rows.length}{counts?.states.all ? ` of ${counts.states.all}` : ""}. The chips and charts above count them all.
                </p>
              </div>
            )}
          </div>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => { setOpen(false); setMeasureOpen(false); }}
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
        onStartOver={editing ? undefined : () => { setForm({ ...EMPTY }); setFromTemplate(""); setMeasureOpen(false); }}
        submitLabel={editing ? "Save changes" : "Create goal"}
        canSubmit={!!form.title.trim() && !weightInvalid && !targetEqualsBaseline && !(form.kind === "key_result" && form.parent === "none")}
        whyNot={[
          !form.title.trim() && "Give the goal a title.",
          weightInvalid && "Weight has to be between 0 and 100.",
          form.kind === "key_result" && form.parent === "none" && "Pick the objective this key result sits under.",
          targetEqualsBaseline && "The target and the baseline are the same number.",
        ]}
        onSubmit={submit}
        // WHAT CARRIES OVER TO THE NEXT GOAL. Somebody pressing this is filing a SET - a team's quarter, a
        // joiner's first month - so the answers that describe the set stay and the ones that describe the goal
        // go. Keeping only the owner meant retyping the department, the cycle and the date for every goal in
        // the batch, which is the batch's whole point.
        addAnother={editing ? undefined : () => {
          setForm({ ...EMPTY, employee: form.employee, department: form.department, cycle: form.cycle, due_date: form.due_date });
          setFromTemplate("");
          setMeasureOpen(false);
        }}
        addAnotherLabel="Save & add another"
        // Wide enough for the sections' name margin beside a two-column field row (FormSection).
        className="max-w-2xl lg:max-w-3xl"
        submitAccess={(b) => (editing
          ? <AccessAction label="Edit goal" can={editing.access?.can}>{b}</AccessAction>
          : <AccessAction create label="New goal">{b}</AccessAction>)}
      >
          {/* Only when the org has blueprints and this reader may see them, and only on a NEW goal - stamping
              a template over a goal somebody is editing would silently rewrite its wording and its measure. */}
          {!editing && usableTemplates.length > 0 && (
            <Field label="Start from a template (optional)" hint="Fills the form below. Everything stays editable.">
              <Combobox
                value={fromTemplate}
                onValueChange={(v) => { const t = usableTemplates.find((x) => x.path === v); if (t) applyTemplate(t); }}
                searchPlaceholder="Search templates…"
                options={usableTemplates.map((t) => ({
                  value: t.path,
                  label: t.group_name ? `${t.group_name} · ${t.title}` : t.title ?? "Template",
                }))}
              />
            </Field>
          )}
          {/* The title IS the dialog's heading, as on the task editor: set large and borderless, an input
              only when touched (the border comes back on hover and focus). */}
          <Input
            aria-label="Title"
            value={form.title}
            placeholder="e.g. Ship the billing revamp"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            autoFocus
            className="-mx-2 h-auto w-[calc(100%+1rem)] border-transparent bg-transparent px-2 py-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input sm:text-xl"
          />
          {/* THE TEMPLATE THAT MATCHES WHAT THEY ARE TYPING, which the dropdown above cannot offer: a list of
              thirty blueprints is a list nobody scrolls, so the org's agreed wording goes unused and the
              ramp-up goal gets retyped from memory every time. Words shared, nothing sent anywhere. */}
          {!editing && !fromTemplate && usableTemplates.length > 0 && titleMatches.length > 0 && (
            <div className="-mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Templates like this:</span>
              {titleMatches.map(({ template }) => (
                <button
                  key={template.path}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="max-w-56 truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                >
                  + {template.group_name ? `${template.group_name} · ` : ""}{template.title}
                </button>
              ))}
            </div>
          )}
          {/* Same title already open for the same person: warned, never blocked - two goals may honestly share a
              name, and the owner is the one who knows. Under the title, the field it is about. */}
          {dupTitle && (
            <p className="text-xs text-warning">
              {dialogOwnerId === me.employee_id ? "You already have" : `${empName(`employees/${dialogOwnerId}`)} already has`} an open goal called
              “{dupTitle.title}”{dupTitle.due_date ? `, due ${formatDate(dupTitle.due_date)}` : ""}.
            </p>
          )}
          {/* The goal at a glance, from whichever tab is open: live form values, each a way to the tab that
              holds its field. */}
          {editing && (() => {
            const fact = "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
            const pct = measurePct ?? editing.progress;
            return (
              <div className="-mx-2 -mt-2 flex flex-wrap items-center gap-y-1">
                <button type="button" className={cn(fact, "bg-muted font-medium text-foreground")} onClick={() => setGoalTab("alignment")}>
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" /> {STATUSES.find((s) => s.value === form.status)?.label ?? form.status}
                </button>
                {pct != null && (
                  <button type="button" className={cn(fact, "tabular-nums")} onClick={() => setGoalTab("alignment")}>
                    {Math.round(pct)}% done
                  </button>
                )}
                <button type="button" className={fact} onClick={() => setGoalTab("details")}>
                  <Users className="h-3.5 w-3.5" /> {empName(editing.employee) || "Somebody else"}
                </button>
                {form.weight.trim() && (
                  <button type="button" className={cn(fact, "tabular-nums")} onClick={() => setGoalTab("details")}>
                    Weight {form.weight}
                  </button>
                )}
                {form.due_date && (
                  <button type="button" className={fact} onClick={() => setGoalTab("details")}>
                    <CalendarDays className="h-3.5 w-3.5" /> {formatDate(form.due_date)}
                  </button>
                )}
                <button type="button" className={fact} onClick={() => setGoalTab("alignment")}>
                  {form.kind === "key_result" ? "Key result" : "Objective"}
                </button>
              </div>
            );
          })()}
          {/* TWO TABS, the task editor's shape: this form asks fourteen questions, and one scroll of them put
              Save below the fold. A tab that holds a reason Save is refused says so with a marker, since the
              reader may not be looking at it. Panels are force-mounted and only hidden, so a switch keeps what
              each holds and fires no read. */}
          <Tabs value={goalTab} onValueChange={setGoalTab}>
            <TabsList variant="segmented" aria-label="Goal sections">
              <TabsTrigger value="details">
                Details
                {weightInvalid && <><span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /><span className="sr-only">(needs attention)</span></>}
              </TabsTrigger>
              <TabsTrigger value="alignment">
                Alignment & progress
                {(targetEqualsBaseline || (form.kind === "key_result" && form.parent === "none")) && <><span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /><span className="sr-only">(needs attention)</span></>}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" forceMount className={goalPanel}>
          <FormSection
            title="Description"
            icon={AlignLeft}
            aside={(
              <DraftButton
                collection="goals"
                kind="goal"
                existing={form.description}
                hint="e.g. cut checkout errors, measured by the weekly error rate, by the end of Q2"
                onDraft={(text) => setForm({ ...form, description: text })}
              />
            )}
          >
            <Textarea aria-label="Description (optional)" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" />
          </FormSection>
          {/* WHOSE GOAL IS THIS - one question, answered left to right.
              It used to be two, a form apart and both of them called something with "team" in it: a full-width
              "For" up here, and a full-width "Owned by a team (optional)" six fields below, on a page where
              "team" already means the reader's direct reports. Nothing said the second one did not replace the
              first, and a department goal still needs the one person who answers for it.
              So the shape of the goal is asked first, and the second column relabels itself to say what the
              person picked in it IS - the owner, or the lead the department's goal hangs on. */}
          {(departments.length > 0 || !editing) && (
            <FormSection title="Ownership" icon={Users}>
            <FieldRow>
              {departments.length > 0 && (
                <Field label="Owned by" hint="A department's goal reads as the whole team's, and still has one lead.">
                  <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">One person</SelectItem>
                      {departments.filter((d) => !d.delete_time).map((d) => (
                        <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field
                label={form.department === "none" ? "Owner" : "Accountable lead"}
                hint={form.department === "none"
                  ? "Whose goal this is. They see it on their own Goals page."
                  : `The one person answerable for it. ${deptName(form.department) ?? "That team"}'s people come first, but anybody can lead it.`}
              >
                {/* The owner is fixed once the goal exists - only the create path sends it - so on an edit the
                    column states who it is rather than disappearing and leaving "Owned by" to explain a pairing
                    with nothing beside it. Stated, not disabled: a greyed-out box reads as a control this
                    reader is locked out of, and nobody can change this one. */}
                {editing ? (
                  <p className="flex h-9 items-center text-sm">{empName(editing.employee) || "Somebody else"}</p>
                ) : (
                  <Combobox
                    value={form.employee}
                    onValueChange={(v) => setForm({ ...form, employee: v })}
                    searchPlaceholder="Search people…"
                    options={ownerOptions}
                  />
                )}
              </Field>
            </FieldRow>
            </FormSection>
          )}
          {/* How much it counts, by when, and which review scores it. */}
          <FormSection title="Commitment" icon={CalendarDays}>
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
                    // Pressing the chip already set clears the date, the way the filter chips above clear
                    // themselves - it was the one control on this form that could be turned on and not off.
                    aria-pressed={form.due_date === o.value}
                    onClick={() => setForm({ ...form, due_date: form.due_date === o.value ? "" : o.value })}
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
            {/* The review cycle this goal answers to. A cycle's review scores exactly the goals attached to it,
                so this is the field that decides whether the goal shows up in someone's review at all. */}
            {pickableCycles.length > 0 && (
              <Field label="Review cycle (optional)" hint="The cycle whose review scores this goal.">
                <Select value={form.cycle} onValueChange={(v) => setForm({ ...form, cycle: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No cycle</SelectItem>
                    {pickableCycles.map((c) => (
                      <SelectItem key={c.path} value={`review-cycles/${idOf(c.path)}`}>
                        {c.name}{c.state === "CLOSED" ? " (closed)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldRow>
          {!weightInvalid && weightTotal > 100 && (
            <p className="text-xs font-medium text-warning">
              Open goals would total {weightTotal} weight, over the usual 100.{" "}
              {/* THIS LINK LEAVES BY A DOOR THE DISCARD GUARD DOES NOT WATCH. It closes the dialog itself
                  rather than through `onOpenChange`, and an edit carries no draft (`draftKey` is create-only),
                  so pressing it used to throw away everything typed without a word. A new goal is safe - its
                  draft is in sessionStorage - so only an edit with changes is worth stopping for. */}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={async () => {
                  if (editing && JSON.stringify(form) !== editBaseline) {
                    const ok = await confirm({
                      title: "Leave this goal to rebalance?",
                      description: "Rebalancing closes this editor, and the changes you have made to this goal have not been saved.",
                      confirmLabel: "Leave and rebalance",
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  setOpen(false);
                  setMeasureOpen(false);
                  setRebalanceFor(dialogOwnerId || null);
                }}
              >
                Rebalance
              </button>
            </p>
          )}
          </FormSection>
            </TabsContent>

            {/* Where the goal sits, then how far along it is: the kind and the parent decide how progress is
                worked out (a key result's rolls up, an objective's can come from its key results), so the
                measure reads best under them. */}
            <TabsContent value="alignment" forceMount className={goalPanel}>
          {/* What kind of goal, and what it rolls up into: one decides whether the other is required. */}
          <FormSection title="Structure" icon={Network}>
          <FieldRow>
            {/* Objective or key result. A KR is one of the numbers under an objective, so choosing it makes
                the alignment beside it mandatory - and hands the objective's percentage to the arithmetic. */}
            <Field label="Kind" hint={form.kind === "key_result" ? "A number under an objective. Its objective's progress is the weighted average of its key results." : "A goal in its own right. Add key results under it and its progress becomes theirs."}>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as GoalKind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="objective">Objective</SelectItem>
                  <SelectItem value="key_result">Key result</SelectItem>
                </SelectContent>
              </Select>
            </Field>
              {/* What this rolls UP into, beside the kind that decides whether it must. */}
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
          </FieldRow>
          {/* A key result cannot be saved without an objective, and the picker for one was hidden whenever
              there were no objectives to pick - so choosing "Key result" in an empty org left the form
              refusing to save, explaining why, and offering no control that could put it right. */}
          {alignables.length === 0 && form.kind === "key_result" && state === "ready" && (
            <p className="text-xs text-warning">
              There are no objectives to put this under yet. Create the objective first, then add its key results.
            </p>
          )}
          </FormSection>
          {/* What has to move FIRST - the answer to "why did this sit at 20% all quarter" far more often than
              effort is. Gated on its OWN options, not on the alignment field's: `alignables` drops every key
              result (nothing parents a KR), so in an org whose visible goals are all key results this field
              vanished, although every one of them is a perfectly good thing to be waiting on. */}
          {blockables.length > 0 && (
            <FormSection title="Depends on" icon={Hourglass}>
            <FieldRow>
                <Field label="Waiting on (optional)" hint="Another goal that has to move before this one can.">
                  <Combobox
                    value={form.blockedBy}
                    onValueChange={(v) => setForm({ ...form, blockedBy: v })}
                    searchPlaceholder="Search goals…"
                    options={[
                      { value: "none", label: "Not blocked" },
                      ...blockables.map((g) => ({
                        value: `goals/${idOf(g.path)}`,
                        label: g.employee && idOf(g.employee) !== me.employee_id ? `${g.title} - ${empName(g.employee)}` : g.title,
                      })),
                    ]}
                  />
                </Field>
            </FieldRow>
            </FormSection>
          )}
          {/* ONLY ON A GOAL THAT EXISTS. A goal being written is "Not started" - that is what writing one
              means - and the only other honest answer at birth comes from the measure, which sets it above
              without asking. Offering Completed and Cancelled in the same breath as Create was offering to
              file work as finished or abandoned before it had been agreed with anybody. */}
          {editing && (
            <FormSection title="Status" icon={ClipboardCheck}>
              <FieldRow>
                <Field label="Status">
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as GoalStatus })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              </FieldRow>
            </FormSection>
          )}
          {/* The measure. A goal that counts something doesn't need anyone's estimate of how far along it is:
              with a target and a current value the percentage is arithmetic, and the slider stops being an
              opinion poll. Baseline matters for the goals that start above zero - churn 8% to 4% with 6% today
              is half done, not nearly finished.

              Folded until it is wanted (`showMeasure`), because most goals do not count anything and the ones
              that do are better asked two questions than five.

              Folded, the sentence sits BESIDE the button and centred on it: `min-w-0 flex-1` on the text and no
              `flex-wrap` on the row, so the buttons keep their width and the prose wraps inside what is left
              instead of dropping to a line of its own. */}
          <FormSection
            title="Measure"
            icon={Ruler}
            count={showMeasure && measurePct != null ? `${measurePct}% complete` : undefined}
            /* The way back out. Emptying four boxes by hand was the only way to un-measure a goal, and a
               half-emptied measure is the state that saves a target with no unit. */
            aside={showMeasure ? (
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => { setForm({ ...form, unit: "", baseline: "", target: "", current: "" }); setMeasureOpen(false); }}
              >
                Remove
              </button>
            ) : undefined}
          >
          {!showMeasure ? (
            <div className="flex items-center gap-3 rounded-lg border border-dashed p-2.5">
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setMeasureOpen(true)}>
                <Ruler className="h-4 w-4" /> Add a measure
              </Button>
              {/* Offered in the folded state too, so a saved goal with no measure can be given one without
                  first opening boxes the model is about to fill in. */}
              {editing && (
                // Wrapped, because the row no longer wraps: without this the second button is the thing the
                // flex line squashes when the sentence beside it is long.
                <div className="shrink-0">
                  <GoalMeasureSuggest
                    goalId={idOf(editing.path)}
                    can={editing.access?.can}
                    onPropose={(p) => setForm((f) => ({
                      ...f,
                      unit: p.unit ?? f.unit,
                      baseline: p.baseline_value != null ? String(p.baseline_value) : f.baseline,
                      target: p.target_value != null ? String(p.target_value) : f.target,
                    }))}
                  />
                </div>
              )}
              {/* NOT "moved by hand" flat: a goal has three other ways to know where it is. An objective with
                  key results takes theirs (weighted), a goal with linked board tasks takes their delivered
                  share (services/cards.ts#recomputeGoalProgress), and only a goal with none of the four is
                  somebody's estimate on a slider. */}
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {form.kind === "key_result"
                  ? "Optional, and the thing a key result usually is - a number its objective can count."
                  : "Optional. Without one, progress follows this goal's key results or linked tasks, and otherwise moves by hand."}
              </p>
            </div>
          ) : (
          <div>
            <p className="text-xs text-muted-foreground">
              {measurePct != null
                ? "Progress is computed from these numbers, so the slider is read-only for this goal."
                : "Give it a target and progress stops being a guess."}
            </p>
            {/* TARGET FIRST. The old order asked for the baseline before the target - the number that needs
                explaining before the one the goal is actually about - and gave "Current" no hint at all, so a
                new goal was asked where it had got to on the day it was written. It is last now, and optional:
                left empty on a new goal it takes the baseline (`currentFor`), which is where a goal starts. */}
            {/* Two across, never four: beside the section's name margin, four number boxes are narrower than
                the numbers (and the hints) some of them hold. */}
            <div className="mt-3 grid gap-x-3 gap-y-4 sm:grid-cols-2">
              <Field label="Target" field="target_value" hint="Where it has to get to." error={targetEqualsBaseline ? "Target and baseline are the same, so there is nothing to measure." : undefined}>
                <Input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="60" autoFocus={measureOpen && !hasMeasureValues} />
              </Field>
              <Field label="Unit" field="unit" hint="What the numbers count.">
                <Input value={form.unit} maxLength={24} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="customers" />
              </Field>
              <Field label="Baseline" field="baseline_value" hint="Where it started. 0 for most goals.">
                <Input type="number" value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} placeholder="0" />
              </Field>
              <Field label="Current" field="current_value" hint={editing ? "Where it is today." : "Only if it has already moved."}>
                <Input type="number" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} placeholder={form.baseline.trim() || "0"} />
              </Field>
            </div>
            {/* The unit is a word, and a blank box does not say which kind of word. Same toggle-off behaviour
                as the due-date chips above. */}
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {QUICK_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={form.unit === u}
                  onClick={() => setForm({ ...form, unit: form.unit === u ? "" : u })}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    form.unit === u ? "border-primary text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
            {/* The measure said back as a sentence, because four boxes of digits are not one. */}
            {num(form.target) != null && !targetEqualsBaseline && (
              <p className="mt-2 text-xs text-muted-foreground">
                {countsDown ? "Counting down from " : "From "}{form.baseline.trim() || "0"} to {form.target}{form.unit ? ` ${form.unit}` : ""}
                {form.current.trim() ? `, at ${form.current} today` : ""}.
              </p>
            )}
            {/* The fix for the gap the line above names. Only on a SAVED goal with the measure still empty:
                the proposal is read off the goal's own title and description, and a goal being created has
                not got either of them on the server yet. */}
            {editing && !form.unit.trim() && !form.target.trim() && (
              <div className="mt-3">
                <GoalMeasureSuggest
                  goalId={idOf(editing.path)}
                  can={editing.access?.can}
                  onPropose={(p) => setForm((f) => ({
                    ...f,
                    // A null means "the goal does not say", which must not wipe what somebody has typed.
                    unit: p.unit ?? f.unit,
                    baseline: p.baseline_value != null ? String(p.baseline_value) : f.baseline,
                    target: p.target_value != null ? String(p.target_value) : f.target,
                  }))}
                />
              </div>
            )}
            {measurePct === 100 && (
              <p className="mt-2 text-xs text-success">Saving this hits the target, which completes the goal.</p>
            )}
          </div>
          )}
          </FormSection>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
            </TabsContent>
          </Tabs>
      </WriteDialog>

      {/* Mounted only once the owner's own goals have been read, so the weights still seed at mount rather
          than in an effect (see the dialog) - and `complete` tells it whether it may claim to hold the whole
          open set, which is the precondition for offering a spread at all. */}
      {rebalanceSet && rebalanceSet.owner === rebalanceFor && (
        <RebalanceDialog
          key={rebalanceFor ?? "none"}
          ownerId={rebalanceFor}
          goals={sortGoals(rebalanceSet.goals)}
          complete={rebalanceSet.complete}
          ownerName={rebalanceFor === me.employee_id ? "your" : `${empName(`employees/${rebalanceFor}`)}'s`}
          onClose={() => setRebalanceFor(null)}
          onSaved={() => { setRebalanceFor(null); reload(); }}
          onRefresh={reload}
        />
      )}

      <Sheet open={!!detailGoal} onOpenChange={(o) => { if (!o) void requestCloseDetail(); }}>
        {detailGoal && (
          <GoalDrawer
            onDirtyChange={setProgressDirty}
            deptTitle={deptName(detailGoal.department)}
            cycleTitle={cycleName(detailGoal.cycle)}
            // To THAT cycle's reviews, not to the whole list: the Reviews page keeps its cycle picker in
            // `?cycle=`, and landing on every review ever written - to find the cycle whose name was just
            // clicked - is the trip this link exists to save.
            onOpenReview={() => navigate(detailGoal.cycle ? `reviews?cycle=${encodeURIComponent(idOf(detailGoal.cycle))}` : "reviews")}
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
            linkablePartial={moreCards}
            onLink={(c) => linkCard(detailGoal, c)}
            onUnlink={(c) => linkCard(detailGoal, c, true)}
            comments={thread?.path === detailGoal.path ? thread.comments : undefined}
            history={thread?.path === detailGoal.path ? thread.history : undefined}
            onComment={(body) => postComment(detailGoal, body)}
            onCurrentValue={(v) => setCurrentValue(detailGoal, v)}
            employees={employees}
            blocker={detailGoal.blocked_by ? goalById.get(idOf(detailGoal.blocked_by)) : undefined}
            // The reverse edge, off the rows the page already holds - the same way the drawer's children are
            // found. Nothing in the app has ever shown this direction.
            blocking={rows.filter((g) => g.blocked_by && idOf(g.blocked_by) === idOf(detailGoal.path) && !g.delete_time)}
            onAddKeyResult={detailGoal.kind !== "key_result" ? () => { closeDetail(); openKeyResult(detailGoal); } : undefined}
            onOpenOwner={detailGoal.employee ? () => navigate(`employees/${idOf(detailGoal.employee!)}`) : undefined}
            onEdit={() => { closeDetail(); openEdit(detailGoal); }}
            // Closes only once the delete has gone through: a reader who backs out of the prompt stays on
            // the goal they were reading.
            onDelete={() => void sd.softDelete(detailGoal, { subject: `"${detailGoal.title}"`, onDeleted: closeDetail })}
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
        canSubmit={contribTotal <= 100 && contribRows.every((r) => r.employee) && !contribDupe}
        whyNot={[
          contribTotal > 100 && `The shares add up to ${contribTotal}% - a goal cannot credit more than itself.`,
          // Two rows for one person are two shares for one person, and the server adds them: 30 and 30 is a
          // 60% credit written as two mistakes that each look right.
          contribDupe && `${empName(contribDupe)} is listed twice. Put their whole share on one row.`,
        ]}
        onSubmit={async () => {
          const g = contribFor!;
          await invoke(`goals/${idOf(g.path)}`, "setContributors", undefined, {
            contributors: contribRows.filter((r) => r.employee).map((r) => ({ employee: r.employee, share: Number(r.share) || 0 })),
          });
          toast({ title: "Contributors saved", variant: "success" });
          setContribFor(null);
          // The DRAWER stays open. Crediting the people who delivered a goal is something you do while
          // looking at it - the editor is opened from the drawer's own Contributors panel, and that panel is
          // where the saved split reads back - so closing it dropped the reader onto the wall of cards and
          // made checking the split a second trip. (The same rule the board's `promoteTodo` states.)
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
                    // Not the owner (they keep whatever is left), and not anybody already on another row.
                    .filter((e) => idOf(e.path) !== idOf(contribFor?.employee ?? ""))
                    .filter((e) => {
                      const ref = `employees/${idOf(e.path)}`;
                      return ref === r.employee || !contribRows.some((x) => x.employee === ref);
                    })
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
          // The box holds display text; mentions go back to their stored form on the way out (lib/mentionText.ts).
          await invoke(`goals/${idOf(g.path)}`, "requestChanges", undefined, { note: changesMentions.toWire(changesNote.trim()) });
          toast({ title: "Sent back with your note", variant: "success" });
          setChangesFor(null);
          setChangesNote("");
          closeDetail();
          reload();
        }}
      >
        {/* The note lands in the goal's comment thread, so it is the same kind of text as a comment and takes
            the same picker: "ask [@Dev Shah](…) what the number should be" both reads as a chip on the goal
            and tells Dev, instead of naming somebody who never hears about it. */}
        <Field label="What needs changing?" field="note" hint="Lands as a comment on the goal. @ to mention somebody.">
          <div className="relative">
            <Textarea
              ref={changesRef}
              rows={4}
              value={changesNote}
              onChange={(e) => { setChangesNote(e.target.value); changesMentions.sync(); }}
              onKeyUp={changesMentions.sync}
              onClick={changesMentions.sync}
              onKeyDown={(e) => { changesMentions.onKeyDown(e); }}
              placeholder="e.g. make this measurable - what number are we aiming at?"
              autoFocus
            />
            {changesMentions.menu}
          </div>
        </Field>
      </WriteDialog>
    </div>
    </TooltipProvider>
  );
}

// One owner's open goals with inline weight inputs and a live total - fix an over-100 spread in one place
// instead of reopening each goal. Saves one PATCH per changed goal (writes are rare and user-initiated).
function RebalanceDialog({ ownerId, goals, complete, ownerName, onClose, onSaved, onRefresh }: {
  ownerId: string | null;
  goals: Goal[];
  /** Whether `goals` is known to be the owner's WHOLE open set. A spread over part of one sums to 100 across a
   *  subset while the rest keep their weights, so the two spread buttons are withheld when this is false
   *  rather than writing a total that is only right if nothing was missing. */
  complete: boolean;
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
      description={
        complete
          ? `Spread ${ownerName} open goals' weights; 100 total is the convention. Completed and cancelled goals don't count.`
          : `Showing part of ${ownerName} open goals - more exist than could be loaded, so the total below is not their whole spread. Individual weights can still be corrected.`
      }
      collection="goals"
      guardLabel="weights"
      form={weights}
      submitLabel="Save weights"
      canSubmit={!invalid && changed.length > 0}
      whyNot={invalid ? "Every weight has to be between 0 and 100." : "Change a weight to save."}
      onSubmit={save}
      onSaved={onSaved}
      footerStart={
        <span className={cn("text-sm font-medium tabular-nums", total > 100 ? "text-warning" : "text-muted-foreground")}>
          Total: {total} / 100
        </span>
      }
    >
      {/* Hitting 100 across seven goals is arithmetic, and doing arithmetic in seven number inputs is how
          weights end up at 105 and stay there. Two spreads and an undo cover every real case: they weigh the
          same, or they keep their relative sizes. Only editable rows move; the rest are somebody else's. */}
      {editable.length > 1 && complete && (
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
                <span className={cn("shrink-0 text-xs tabular-nums", moved > 0 ? "text-success" : "text-muted-foreground")}>
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
function GoalDrawer({ goal, owner, mine, parent, kids, kidOwnerName, onOpenGoal, queue, onStep, onCopyLink, linked, linkable, onLink, onUnlink, onEdit, onDelete, onProgress, onConfidence, onContributors, onWatch, onRetro, onPropose, onApprove, onRequestChanges, onCarryOver, onAddKeyResult, onOpenOwner, blocker, blocking, comments, history, onComment, onCurrentValue, onDirtyChange, linkablePartial, deptTitle, cycleTitle, onOpenReview, employees }: {
  goal: Goal;
  owner?: Employee;
  /** The department that owns this goal, when one does. */
  deptTitle?: string;
  /** The review cycle whose review scores this goal, when it is attached to one. */
  cycleTitle?: string;
  /** Go to the reviews for that cycle. */
  onOpenReview: () => void;
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
  onProgress: (progress: number, note?: string) => Promise<boolean>;
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
  /** The goal this one is waiting on, when it names one and the page holds it. */
  blocker?: Goal;
  /** The goals waiting on THIS one - the half nothing in the app has ever shown. */
  blocking: Goal[];
  /** File a key result under this goal, pre-filled from it. Absent on a key result - the ladder is one rung. */
  onAddKeyResult?: () => void;
  /** Open the owner's profile. Absent on a goal nobody owns (a team goal filed without a lead). */
  onOpenOwner?: () => void;
  /** The thread from the item Get. `undefined` while it is still loading, `[]` when there is nothing yet. */
  comments?: NonNullable<Goal["comments"]>;
  /** The progress series, also item-Get only: a list row carries an empty one, so it cannot come off `goal`. */
  history?: NonNullable<Goal["history"]>;
  onComment: (body: string) => Promise<void>;
  /** Move a measured goal's current value - the measure IS its progress. */
  onCurrentValue: (value: number) => void;
  /** Whether the progress slider has been moved and not saved, so the page can guard closing the sheet. */
  onDirtyChange: (dirty: boolean) => void;
  /** Whether `linkable` is only the first server page of tasks, so the picker can admit what it cannot offer. */
  linkablePartial?: boolean;
  /** For putting a face and a name on each comment; the list is already in the page's cache. */
  employees: Employee[];
}) {
  const can = goal.access?.can ?? [];
  const canEdit = can.includes("update");
  const canDelete = can.includes("delete");
  // The server's own count, not the rows on hand. The board tasks are read when the drawer OPENS, so for the
  // first beat of every open `linked` was empty: a goal whose progress is derived from its tasks was handed
  // the manual slider, and the arriving rows then took it away again mid-drag. The count rides on the goal
  // row (the list rolls it up per page), which is what the card has always read.
  const linkedCount = goal.linked_tasks ?? 0;
  const hasLinked = linkedCount > 0 || linked.length > 0;
  const closed = goal.status === "completed" || goal.status === "cancelled";
  const canProgress = !hasLinked && !closed && !goal.measured && !goal.rolled_up && (canEdit || can.includes("updateProgress"));
  // The shared tone, not a fourth hand-rolled copy of it. The local one left `muted` out of the colour it
  // fed, so a CANCELLED measured goal drew its bar in the ordinary primary blue - the one bar on the page
  // that still looked like live work.
  const tone = goalTone(goal);
  // A blocker that has already landed is not a blocker: the goal goes on reading as blocked everywhere it is
  // drawn while the thing it waited for finished weeks ago.
  const blockerDone = !!blocker && (blocker.status === "completed" || blocker.status === "cancelled");

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
  // Typing `@` offers the directory, and picking somebody writes the token the thread draws as a chip and the
  // server already reads to notify them (`goal.mention`, services/goals.ts). The notification half has worked
  // since goal comments existed; there was simply no way to author one but to type the raw markdown by hand.
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ value: draft, onChange: setDraft, textareaRef: draftRef, employees });
  const [posting, setPosting] = useState(false);
  // The progress controls track the live row, so a reload that brings somebody else's write moves them with
  // it rather than leaving the reader about to save a number they never chose.
  useEffect(() => { setProg(goal.progress ?? 0); setNote(""); }, [goal.path, goal.progress]);
  useEffect(() => { setCur(String(goal.current_value ?? 0)); }, [goal.path, goal.current_value]);
  // The comment draft belongs to the person typing it, not to the row, so it is cleared only when the drawer
  // moves to a different goal. It used to be cleared by the same effect as the sliders: saving a progress
  // move - or any reload that happened to carry a new progress or current value - silently threw away a
  // half-written comment, which is the only text on this page nobody can get back.
  useEffect(() => { setDraft(""); }, [goal.path]);
  // The value handed to the server and not yet read back. Without it, the beat between pressing Save and the
  // reloaded row arriving counts as unsaved work: ‹ › went dead and closing the goal asked whether to discard
  // a change that had just been saved. Cleared when the answer comes back - on success by the new progress
  // landing, on failure by `save` below, so a write that did not go through is still offered.
  const [sent, setSent] = useState<number | null>(null);
  useEffect(() => { setSent(null); }, [goal.path, goal.progress]);
  // Only while the slider is ON SCREEN (`canProgress`): a goal that has just closed at 100% swaps its slider
  // for the retro, and a `prog` left one render behind the row that closed it asked "Discard this progress
  // change? The slider has moved" about a slider that was no longer there, on a goal already saved.
  const dirty = canProgress && prog !== (goal.progress ?? 0) && prog !== sent;
  const save = async () => {
    if (!dirty) return;
    setSent(prog);
    const ok = await onProgress(prog, note);
    if (ok) setNote("");
    else setSent(null);
  };
  // Told to the page, which owns the sheet: closing it is the one way out of the drawer that did not check
  // for an unsaved progress move, while ‹ › and j/k have refused to walk away from one since they existed.
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

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
    // The box holds display text; mentions go back to their stored form on the way out (lib/mentionText.ts).
    const body = mentions.toWire(draft.trim());
    if (!body || posting) return;
    setPosting(true);
    try { await onComment(body); setDraft(""); } finally { setPosting(false); }
  }

  // Points off the goal row for the same reason the count is: rolled up by the server over every linked task,
  // including any this reader's card scope would not return.
  const deliveredPts = goal.delivered_task_points ?? linked.reduce((s, c) => s + (c.deliver_time ? c.size ?? 0 : 0), 0);
  const totalPts = goal.task_points ?? linked.reduce((s, c) => s + (c.size ?? 0), 0);

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

  // The drawer's tabs. Kept while ‹ › / j/k walk the queue: a pass through everybody's comments stays on
  // Discussion rather than being sent back to Overview at every step.
  const [tab, setTab] = useState("overview");
  // What the Connections tab holds, so its trigger can say there is something behind it.
  const connectionCount = (parent ? 1 : 0) + kids.length + (blocker ? 1 : 0) + blocking.length + Math.max(linkedCount, linked.length);
  // The gap between sections is what separates them (FormSection draws no box).
  const drawerPanel = "grid content-start gap-6 data-[state=inactive]:hidden";

  return (
    // `max-w-xl`: a little wider than the app's default drawer, for the tabs and the section lists inside it.
    <SheetContent className="flex flex-col sm:max-w-xl">
      <SheetHeader>
        {/* One spaced stack: SheetHeader lays its children out as a bare block, which set the nav row, the
            title, the chips, the owner line and the actions flush against each other. */}
        <div className="space-y-3">
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
                {/* The count, because a goal five people follow is a different object from one nobody reads -
                    every progress move on it reaches five bells. The server has answered `watcher_count` on
                    every row since watching existed and nothing had ever drawn it. */}
                <Eye className="h-3.5 w-3.5" /> {goal.watching ? "Watching" : "Watch"}
                {!!goal.watcher_count && <span className="tabular-nums">{goal.watcher_count}</span>}
              </button>
            </AccessAction>
          )}
          <button type="button" onClick={onCopyLink} title="Copy a link to this goal" className={cn("inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground", mine && "ml-auto")}>
            <Link2 className="h-3.5 w-3.5" /> Copy link
          </button>
        </div>
        <SheetTitle className="flex items-start gap-3 pr-6">
          <GoalRing goal={goal} />
          <span className={cn("min-w-0 flex-1 leading-snug", goal.status === "cancelled" && "text-muted-foreground line-through")}>{goal.title}</span>
        </SheetTitle>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <GoalStatusBadge goal={goal} />
          <GoalKindMark goal={goal} />
          {/* `absolute`, because a detail surface wants the date itself with the relative phrase after it -
              a list row wants the phrase alone. Both come out of the one chip now; this header used to write
              its own version, and the card another, and the profile tab a third. */}
          <GoalDueChip goal={goal} absolute />
          {goal.weight ? <span className="text-muted-foreground">· weight {goal.weight}</span> : null}
        </div>
        {/* WHO AND WHERE, as one line: the owner, the team that owns it, and the review that scores it. Three
            stacked lines of small print used to push the goal's body down before a word of it was read. */}
        {((owner && !mine) || deptTitle || cycleTitle) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {/* A div, not a <p>: PhotoAvatar renders a div, and a div inside a <p> is invalid HTML the browser
                silently reparents (React says so as a validateDOMNesting warning).

                The name goes to the person. Reading somebody else's goal is the moment their manager, their
                other goals and their leave are worth a look. */}
            {owner && !mine && (
              <span className="inline-flex items-center gap-1.5">
                <PhotoAvatar employeeId={idOf(owner.path)} name={`${owner.first_name} ${owner.last_name}`} photo={owner.photo} className="h-5 w-5" />
                {onOpenOwner ? (
                  <button type="button" className="font-medium hover:text-foreground hover:underline" onClick={onOpenOwner} title={`Open ${owner.first_name}'s profile`}>
                    {owner.first_name} {owner.last_name}
                  </button>
                ) : (
                  <>{owner.first_name} {owner.last_name}</>
                )}
              </span>
            )}
            {/* The team that owns it. The lead beside it stays accountable for it either way. */}
            {deptTitle && (
              <span className="inline-flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> <Badge variant="secondary">{deptTitle}</Badge>
              </span>
            )}
            {/* Which review scores this goal, and a way into it: `cycle` decides whether the goal counts toward
                anybody's attainment at all. */}
            {cycleTitle && (
              <span className="inline-flex items-center gap-1.5">
                <ClipboardCheck className="h-3.5 w-3.5 shrink-0" /> Scored in
                <button type="button" className="font-medium text-primary hover:underline" onClick={onOpenReview} title={`Open the reviews for ${cycleTitle}`}>
                  {cycleTitle}
                </button>
              </span>
            )}
          </div>
        )}
        {/* THE ACTIONS, up here rather than under the comment thread and the activity log, where Edit was the
            last thing in the drawer. Delete sits apart at the far end. */}
        {(canEdit || canDelete || (onAddKeyResult && !closed) || onCarryOver || (goal.status === "completed" && !mine && goal.employee)) && (
          // pt-1 on top of the stack's gap: the actions are a different kind of row from the facts above.
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {canEdit && <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
            {/* The rung under this objective, with the parent, the owner, the cycle and the date filled in.
                Not offered on a key result: the ladder is one rung deep, so nothing hangs under one. */}
            {onAddKeyResult && !closed && (
              <AccessAction collection="goals" create label="Add a key result">
                <Button variant="outline" size="sm" onClick={onAddKeyResult}><Plus className="h-3.5 w-3.5" /> Add key result</Button>
              </AccessAction>
            )}
            {/* A completed goal is the moment recognition is worth something. Opens the kudos composer with the
                owner filled in. */}
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
            {/* Quiet until reached for: grey like the drawer's other small print, red only under the pointer.
                It is a soft delete with an Undo on the toast, so it has no need to shout from the header of every
                goal. */}
            {canDelete && <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>}
          </div>
        )}
        </div>
      </SheetHeader>
      <SheetBody>
        {/* THREE TABS: how it is going, what it is connected to, and what people have said. One scroll of all
            of it put the comment box below fifteen blocks. Panels are force-mounted and only hidden, so a
            switch keeps a half-written comment or retro and fires no read. */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="segmented" aria-label="Goal details">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="connections">
              Connections
              {connectionCount > 0 && <span className="ml-1.5 rounded-full bg-background/80 px-1.5 text-[10px] leading-4 tabular-nums">{connectionCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="discussion">
              Discussion
              {!!comments?.length && <span className="ml-1.5 rounded-full bg-background/80 px-1.5 text-[10px] leading-4 tabular-nums">{comments.length}</span>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" forceMount className={drawerPanel}>
        {/* The goal-setting handshake, at the top because until it is done this goal is a proposal rather than
            an objective - and the one press it needs should not be below the fold. Nothing renders once the
            goal is agreed, which is every goal in an org that has not turned approval on. */}
        {goal.stage !== "AGREED" && (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            {/* Addressed to whoever is reading it. Both lines were written for the OWNER and shown to
                everybody: a manager opening a report's draft was told to "submit it when it says what you
                mean", and the approver looking at the goal sitting with them - with the Agree button right
                underneath - was told "your manager has it". */}
            <p className="text-sm font-medium">
              {goal.stage === "DRAFT" ? "Draft - not agreed yet" : can.includes("approve") ? "Waiting for you" : "Waiting for approval"}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {goal.stage === "DRAFT"
                  ? mine
                    ? "Submit it when it says what you mean; your manager agrees it or sends it back."
                    : "The owner is still drafting this. It counts once they submit it and it is agreed."
                  : can.includes("approve")
                    ? "Agree it, or send it back with what needs changing. It counts once it is agreed."
                    : mine
                      ? "Your manager has it. It counts once they agree it."
                      : "With whoever agrees this person's goals. It counts once they agree it."}
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
        {goal.description && (
          <FormSection stacked title="Description" icon={AlignLeft}>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{goal.description}</p>
          </FormSection>
        )}

        {/* PROGRESS, AND HOW IT IS MOVED: the number itself for a measured goal, the slider for one somebody
            estimates, and otherwise a line saying where the percentage comes from. Under it, what the goal
            cannot answer about itself while that is still cheap to fix. */}
        <FormSection
          stacked
          title="Progress"
          icon={Ruler}
          count={`${goal.progress ?? 0}%`}
        >
        {/* A measured goal reports its number, and the number is the only thing worth editing here: the slider
            would be an opinion the next save overwrites. */}
        {measured && (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tabular-nums">
                  {measureLabel(goal)}
                  {goal.baseline_value != null && goal.baseline_value !== 0 && (
                    <span className="ml-1.5 font-normal text-muted-foreground">from {goal.baseline_value}</span>
                  )}
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${goal.progress ?? 0}%` }} />
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
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" className="h-8 text-sm" onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
                <Button size="sm" onClick={() => save()}>Save</Button>
              </div>
            )}
            {!dirty && !closed && (
              <Button variant="outline" size="sm" className="text-success" onClick={() => onProgress(100)}>
                <CheckCircle2 className="h-4 w-4" /> Mark complete
              </Button>
            )}
          </div>
        )}

        {/* Neither control: the percentage is somebody else's arithmetic, so say whose. */}
        {!measured && !canProgress && (
          <div className="space-y-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${goal.progress ?? 0}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {rolledUp
                ? "The weighted average of its key results - see Connections."
                : hasLinked
                  ? `Follows the delivery of its linked tasks${totalPts > 0 ? ` (${deliveredPts}/${totalPts} points)` : ""} - see Connections.`
                  : closed
                    ? "Where it finished."
                    : "Set by the owner."}
            </p>
          </div>
        )}

        {/* WHAT THIS GOAL CANNOT ANSWER ABOUT ITSELF, while it is still cheap to fix. No measure means its
            progress is an estimate for the whole cycle and its review reads "70%" with nothing behind it.
            Arithmetic, so it appears with the AI layer switched off - the suggest button in Edit is the only
            part that costs anything. Hidden on a finished goal, where none of it can be acted on. */}
        {!closed && measureGaps(goal).length > 0 && (
          <div className="space-y-0.5 rounded-lg border border-dashed p-3">
            {measureGaps(goal).map((g) => (
              <p key={g} className="text-xs text-muted-foreground">{GAP_MESSAGE[g]}</p>
            ))}
            {canEdit && <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={onEdit}>Fix it in Edit</button>}
          </div>
        )}
        </FormSection>
        {/* Where this stands, in the two senses that matter: the arithmetic (pace, silence, the shape of the
            climb) and the owner's own call. Hidden on a finished goal - neither question applies any more. */}
        {!closed && (
          <FormSection
            stacked
            title="Health"
            icon={HeartPulse}
            aside={goal.expected_progress != null && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {goal.progress ?? 0}% against {goal.expected_progress}% expected
                {goal.drift != null && goal.drift !== 0 && (
                  <span className={cn("ml-1 font-medium", goal.drift < 0 ? "text-warning" : "text-success")}>
                    ({goal.drift > 0 ? "+" : ""}{goal.drift})
                  </span>
                )}
              </span>
            )}
          >
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
            {/* Effort against outcome, which is the pairing that catches hours going into something that is
                not moving. The card has carried it since projects could point at a goal; the drawer, where
                somebody goes to work out WHY a goal is behind, did not. */}
            {goal.logged_hours != null && (
              <p className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                <Clock3 className="h-3 w-3" /> {goal.logged_hours}h booked against this goal
                {(goal.progress ?? 0) === 0 && goal.logged_hours > 0 && <span className="font-medium text-warning">· nothing moved yet</span>}
              </p>
            )}
          </FormSection>
        )}

        {/* What actually happened, in the owner's words. Offered while the goal is closing or closed, and
            carried into the review PDF - a percentage says how far it got and nothing about why. */}
        {/* `canEdit`, not "canEdit or it is mine": the note is an ordinary field write, so an owner whose
            policy gives them `updateProgress` but not `update` was handed a textarea and a Save button that
            could only ever answer 403. */}
        {(closed || (goal.progress ?? 0) >= 80) && canEdit && (
          <FormSection stacked title="What happened" icon={PenLine}>
            {/* START FROM THE RECORD, not from a blank box. By the time a goal closes nobody remembers the
                shape of the quarter, so the answer is usually a sentence and a percentage that says nothing.
                The app holds the rest: where it started, where it got to, what was delivered against it. No
                model and no request - every line here is already on this page - and it lands as editable
                text the owner rewrites in their own words. */}
            {!retroDraft.trim() && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRetroDraft(retroSeed(goal, linked, history))}
              >
                <ListChecks className="h-4 w-4" /> Start from the record
              </Button>
            )}
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
          </FormSection>
        )}
        {/* Written by the owner, read by everybody who can see the goal. It lived only inside the editor
            above, so the one person who most needs it - a manager reading a finished goal they cannot edit -
            saw a percentage and none of the words explaining it. */}
        {!canEdit && goal.retro && (
          <FormSection stacked title="What happened" icon={PenLine}>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{goal.retro}</p>
          </FormSection>
        )}
          </TabsContent>

          <TabsContent value="connections" forceMount className={drawerPanel}>
        {/* WHERE IT SITS: what it rolls up into, and what rolls up into it. */}
        {(parent || kids.length > 0) && (
          <FormSection
            stacked
            title={rolledUp ? "Key results" : "Alignment"}
            icon={Network}
            count={kids.length > 0
              // The objective's own percentage IS this set, computed by the server over every key result -
              // including any this viewer cannot see. Aligned goals are a client-side average over what this
              // viewer can see, and say so.
              ? (rolledUp ? `${goal.progress ?? 0}% weighted` : `${alignedPct}% of what you can see`)
              : undefined}
          >
            {parent && (
              <p className="text-sm text-muted-foreground">
                Aligns to{" "}
                <button type="button" className="inline-flex max-w-full items-center gap-1 align-bottom font-medium text-primary hover:underline" onClick={() => onOpenGoal(parent)}>
                  <Link2 className="h-3 w-3 shrink-0" /> <span className="truncate">{parent.title}</span>
                </button>
              </p>
            )}
            {kids.length > 0 && (
              <ul className="space-y-1.5">
                {kids.map((k) => (
                  <li key={k.path}>
                    <button type="button" className="flex w-full items-center gap-2 rounded text-left text-sm hover:bg-accent/50" onClick={() => onOpenGoal(k)}>
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", k.status === "completed" ? "bg-success" : k.status === "cancelled" ? "bg-muted-foreground/40" : "bg-primary")} />
                      <span className={cn("min-w-0 flex-1 truncate", k.status === "cancelled" && "text-muted-foreground line-through")}>{k.title}</span>
                      <span className="text-[11px] text-muted-foreground">{kidOwnerName(k.employee)}</span>
                      <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">{k.progress ?? 0}%</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </FormSection>
        )}

        {/* WHAT IS IN THE WAY, AND WHO IS WAITING ON THIS. "Waiting on another goal" is more often the answer
            to "why did this sit at 20% all quarter" than effort is. The reverse half - a goal holding up three
            other people's work - is the most important fact about it, and was only visible by opening those
            three and reading their chips. */}
        {(blocker || blocking.length > 0) && (
          <FormSection stacked title="Dependencies" icon={Hourglass}>
            {blocker && (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <Hourglass className={cn("h-3.5 w-3.5 shrink-0", blockerDone ? "text-muted-foreground" : "text-warning")} />
                  <span className={blockerDone ? "text-muted-foreground" : "font-medium text-warning"}>Waiting on</span>
                  <button type="button" className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline" onClick={() => onOpenGoal(blocker)}>
                    <span className="truncate">{blocker.title}</span>
                  </button>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{blocker.progress ?? 0}%</span>
                  <GoalStatusBadge goal={blocker} className="shrink-0" />
                </div>
                {/* A finished blocker is the case worth saying out loud: the goal reads as blocked on every
                    card in the app while the thing it was waiting for landed weeks ago, and nobody clears a
                    field they cannot see. */}
                {blockerDone && (
                  <p className="text-xs text-muted-foreground">
                    That goal is {blocker.status === "cancelled" ? "cancelled" : "finished"}, so this is not really waiting on anything
                    {canEdit ? " - clear “Waiting on” in Edit." : "."}
                  </p>
                )}
              </div>
            )}
            {blocking.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm">
                  <span className="font-medium">{blocking.length} goal{blocking.length === 1 ? "" : "s"}</span>{" "}
                  {blocking.length === 1 ? "is" : "are"} waiting on this one.
                </p>
                <ul className="space-y-1">
                  {blocking.map((b) => (
                    <li key={b.path}>
                      <button type="button" className="flex w-full items-center gap-2 rounded text-left text-sm hover:bg-accent/50" onClick={() => onOpenGoal(b)}>
                        <Hourglass className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{b.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{kidOwnerName(b.employee)}</span>
                        <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">{b.progress ?? 0}%</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </FormSection>
        )}

        {/* Who else worked on this. Their share scores in THEIR review at this goal's weight scaled by it, so
            the split is a statement about two reviews, not a label.

            A COMPLETED goal still shows it, unlike the progress and retro editors above: the moment somebody
            credits the people who delivered a goal is when it lands, and the server has never required the
            goal to be open. Only a cancelled goal hides it - it scores for nobody, so there is no share to
            argue about. */}
        {(goal.contributors?.length || goal.suggested_contributors?.length || canEdit) && goal.status !== "cancelled" && (
          <FormSection
            stacked
            title="Contributors"
            icon={Users}
            count={goal.contributors?.length ? `${goal.contributors.reduce((s2, c) => s2 + (c.share ?? 0), 0)}% shared` : undefined}
            aside={canEdit && (
              <AccessAction verb="setContributors" can={can} label="Set contributors">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onContributors}>{goal.contributors?.length ? "Edit" : "Add"}</Button>
              </AccessAction>
            )}
          >
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
          </FormSection>
        )}

        <FormSection
          stacked
          title="Linked tasks"
          icon={SquareKanban}
          count={hasLinked && totalPts > 0 ? `${deliveredPts}/${totalPts} pts` : undefined}
          aside={!closed && linkable.length > 0 && (
            <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => setPicking((p) => !p)}>
              <Link2 className="h-3.5 w-3.5" /> Link tasks
            </button>
          )}
        >
          {picking && (
            <>
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
              {/* The picker searches the tasks this page HOLDS, and the tasks read is one server page. On a
                  busy board the task you are looking for is simply not among the options, and a combobox that
                  finds nothing reads as "no such task" rather than "not loaded". */}
              {linkablePartial && (
                <p className="text-[11px] text-muted-foreground">
                  Showing the first page of tasks. If the one you want is missing, link it from the task itself on its board.
                </p>
              )}
            </>
          )}
          {linked.length > 0 ? (
            <ul className="space-y-1.5">
              {linked.map((c) => (
                // The UNNAMED group, and that is the whole point of the change: `index.css` forces
                // `group-hover:opacity-100` visible on a coarse pointer, and it matches that class exactly -
                // so the named `group-hover/task:` this row used was excluded from the rule. Named groups are
                // reserved for cursor-only gestures (a column resize handle); unlinking a task is a real
                // action, and on a phone it was an invisible button still occupying its box. Nothing above
                // this row is a `group`, so the bare name cannot be claimed by an ancestor.
                <li key={c.path} className="group flex items-center gap-2 text-sm">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.deliver_time ? "bg-success" : "bg-muted-foreground/40")} />
                  <span className={cn("min-w-0 flex-1 truncate", c.deliver_time && "text-muted-foreground line-through")}>{c.title}</span>
                  {c.size != null && <span className="text-[11px] tabular-nums text-muted-foreground">{c.size}</span>}
                  {!closed && (c.access?.can ?? []).includes("update") && (
                    <button type="button" className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100" onClick={() => onUnlink(c)} aria-label={`Unlink ${c.title}`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : hasLinked ? (
            // The goal says tasks point at it and this reader has none of them on hand - the rows are still
            // arriving, or the boards they live on are outside what this person can read. Either way the
            // count is the honest thing to show, rather than "no board tasks linked" under a percentage that
            // those very tasks produced.
            <p className="text-xs text-muted-foreground">
              {linkedCount} linked task{linkedCount === 1 ? "" : "s"} on boards not shown here.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No board tasks linked - progress is set manually.</p>
          )}
          {hasLinked && <p className="text-[11px] text-muted-foreground">Progress derives from linked-task delivery.</p>}
        </FormSection>

        {/* Duplicated effort and missing alignment, both read off the index rather than off somebody having
            read all ninety goals. Asked for, so it costs nothing on a goal nobody is questioning. */}
        <GoalSimilarCard
          goalId={idOf(goal.path)}
          can={goal.access?.can}
          onOpenGoal={(path) => { const g = kids.find((k) => k.path === path); if (g) onOpenGoal(g); else navigate(path); }}
        />
          </TabsContent>

          <TabsContent value="discussion" forceMount className={drawerPanel}>
        {/* The conversation the goal used to lose. A quarterly goal gets discussed at least monthly, and until
            this existed the only writable text on it was the owner's own progress note - so the discussion
            happened in chat and the goal recorded nothing. */}
        <FormSection stacked title="Comments" icon={MessageSquare} count={comments?.length || undefined}>
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
                      {/* The same markdown-lite the board, the cards and the tickets render - which is what
                          turns `[@Priya Nair](employees/…)` into a chip that links to her, rather than the
                          raw token the server has been notifying people from all along. */}
                      <RichText source={c.body} className="text-sm" />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {can.includes("comment") && (
            <div className="flex items-start gap-2">
              {/* `relative`, because the mention menu is absolutely positioned inside the box's own container. */}
              <div className="relative min-w-0 flex-1">
                <Textarea
                  ref={draftRef}
                  rows={2}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); mentions.sync(); }}
                  onKeyUp={mentions.sync}
                  onClick={mentions.sync}
                  placeholder={`Add a comment${mine ? "" : " for " + (owner ? owner.first_name : "the owner")}… @ to mention`}
                  aria-label="Add a comment"
                  className="text-sm"
                  // The mention menu gets first refusal on the keys it uses; only what it did not take posts.
                  // Cmd/Ctrl+Enter posts, matching every other multi-line box in the app.
                  onKeyDown={(e) => {
                    if (mentions.onKeyDown(e)) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !posting) void post();
                  }}
                />
                {mentions.menu}
              </div>
              <AccessAction verb="comment" can={can} label="Comment on goal">
                <Button size="sm" disabled={!draft.trim() || posting} loading={posting} onClick={() => post()}>Post</Button>
              </AccessAction>
            </div>
          )}
        </FormSection>

        <ActivitySection resource={goal.path} />
          </TabsContent>
        </Tabs>
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
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", alert && "text-destructive")}>{value}</p>
      {bar != null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${bar}%` }} />
        </div>
      )}
    </>
  );
  const tone = cn(
    "rounded-lg border p-3",
    alert && "border-destructive/40 bg-destructive/5",
    active && "border-primary ring-1 ring-primary",
  );
  if (!onClick) return <div className={tone}>{inner}</div>;
  return (
    // `aria-pressed` because the ring is the only thing that says this tile is the filter currently applied.
    <button type="button" onClick={onClick} aria-pressed={!!active} className={cn(tone, "text-left transition-colors hover:bg-accent/50")}>
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
  // The same forest the drawer's walk order is built from, so the cascade and the "4 of 12" beside it can
  // never describe two different arrangements of the same goals.
  const { visible, roots, children: childrenOf } = useMemo(() => alignmentForest(goals), [goals]);
  const hiddenChildCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of all) {
      const p = g.parent ? idOf(g.parent) : "";
      if (!p || g.delete_time || visible.has(idOf(g.path))) continue;
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [all, visible]);
  // Which branches are folded. Everything open by default: the cascade's whole claim is that it shows the
  // shape, and one that opens half-drawn is a picture of the reader's last visit rather than the quarter.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const branches = useMemo(() => goals.filter((g) => goals.some((k) => k.parent && idOf(k.parent) === idOf(g.path))), [goals]);
  const allShut = branches.length > 0 && branches.every((g) => collapsed.has(g.path));

  if (!roots.length) return <p className="text-sm text-muted-foreground">No goals match these filters.</p>;

  const row = (g: Goal, depth: number): ReactNode => {
    const kids = childrenOf.get(idOf(g.path)) ?? [];
    const hidden = hiddenChildCount.get(idOf(g.path)) ?? 0;
    const shut = collapsed.has(g.path);
    const mine = !!g.employee && idOf(g.employee) === meId;
    return (
      <li key={g.path} className="min-w-0">
        {/* Indent with a real left border per level rather than padding alone: at three levels deep, padding
            on its own stops reading as a hierarchy. */}
        <div className={cn("min-w-0", depth > 0 && "border-l pl-3 sm:pl-4")}>
          <div className="flex min-w-0 items-center">
            {/* Fold a branch away. A cascade is read top-down - "is anything hanging off nothing, does the
                shape match what was agreed" - and at three levels across a department that question was
                being asked of forty rows at once, with no way to put a finished branch out of the way.
                A leaf keeps the same indent through a spacer, so the titles still line up. */}
            {kids.length > 0 ? (
              <button
                type="button"
                onClick={() => toggle(g.path)}
                aria-expanded={!shut}
                aria-label={shut ? `Expand ${g.title}` : `Collapse ${g.title}`}
                title={shut ? `Show the ${kids.length} under this` : "Fold this branch away"}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {shut ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            ) : (
              <span className="h-6 w-6 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => onOpen(g)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{g.progress ?? 0}%</span>
              {/* One bar per row, because a wall of donuts at four levels of indent is unreadable. Toned by
                  the shared rule, which means an overdue goal now reads as one here too - this row used to
                  colour by status alone, so a goal a month past its date was drawn exactly like a healthy
                  one. */}
              <GoalProgressBar goal={g} className="hidden w-16 shrink-0 sm:block" />
              <span className={cn("min-w-0 flex-1 truncate text-sm", g.status === "cancelled" && "text-muted-foreground line-through")}>
                {g.title} <GoalKindMark goal={g} />
              </span>
              {g.weight ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">weight {g.weight}</span> : null}
              {isBehind(g) && <TrendingDown className="h-3.5 w-3.5 shrink-0 text-warning" />}
              {g.status !== "in_progress" && <GoalStatusBadge goal={g} className="shrink-0" />}
              <span className={cn("hidden shrink-0 text-xs sm:inline", mine ? "font-medium text-foreground" : "text-muted-foreground")}>
                {mine ? "You" : empName(g.employee)}
              </span>
              {/* What is folded away, said on the row that folded it - a collapsed branch is otherwise
                  indistinguishable from a goal with nothing under it. */}
              {shut && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">+{kids.length}</span>}
            </button>
          </div>
          {!shut && (kids.length > 0 || hidden > 0) && (
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
        {branches.length > 0 && (
          <button
            type="button"
            className="ml-auto font-medium normal-case tracking-normal text-primary hover:underline"
            onClick={() => setCollapsed(allShut ? new Set() : new Set(branches.map((g) => g.path)))}
          >
            {allShut ? "Expand all" : "Collapse all"}
          </button>
        )}
      </h2>
      {/* Deep nesting plus long titles overflow on a phone, so the cascade scrolls sideways inside its own
          card - and says so, rather than cutting a title off at the edge with no hint there is more. */}
      <Card className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto p-2">
        <ul className="min-w-0 space-y-0.5">{roots.map((g) => row(g, 0))}</ul>
      </Card>
    </section>
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
  /** Resolves to whether the write landed, so the card can tell a sent value from an unsent one. */
  onProgress: (progress: number) => Promise<boolean>;
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
  const due = goal.due_date ? dueRel(goal.due_date) : null;
  const closed = goal.status === "completed" || goal.status === "cancelled";
  const overdue = !!due?.overdue && !closed;

  // Local slider value; commit on release so we don't fire a request per pixel. Re-sync if the goal changes.
  const [prog, setProg] = useState(goal.progress ?? 0);
  useEffect(() => setProg(goal.progress ?? 0), [goal.progress]);
  // What has already been sent, so the two events that commit cannot both send it. Releasing the pointer
  // writes, and the blur that follows when the reader clicks away arrives long before the reloaded row does -
  // so `prog !== goal.progress` was still true and the same value went a second time, with a second toast and
  // a second entry in the goal's history. Cleared by the new progress arriving.
  const sent = useRef<number | null>(null);
  useEffect(() => { sent.current = null; }, [goal.progress]);
  const commit = () => {
    if (prog === (goal.progress ?? 0) || prog === sent.current) return;
    sent.current = prog;
    void onProgress(prog).then((ok) => { if (!ok) sent.current = null; });
  };

  return (
    <Card
      // A focus ring, because this card is a tab stop that opens the drawer and had nothing to say so: every
      // other clickable card in the app (a leave request, a board card) draws one, and a keyboard reader
      // tabbing a wall of goals could not tell which one Enter would open.
      className={cn(
        "group flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:border-primary/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        overdue && "border-destructive/40",
        goal.status === "cancelled" && "opacity-75",
      )}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      // Space as well as Enter, and Space's page-scroll suppressed: a native button answers to both, and an
      // element that claims `role="button"` and ignores one is a card a keyboard reader cannot open.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
    >
      {/* Wraps on a phone, where the action cluster is drawn permanently (no hover to reveal it) and its three
          finger-sized buttons take ~130px of a ~290px card - leaving the goal's own title, the one thing the
          card is for, truncated to two words. `order-last w-full` sends the cluster to a line of its own
          below `sm`, and the title gets the width back. */}
      <div className="flex flex-wrap items-start gap-3">
        {/* `pct={prog}` so the donut follows the slider under the reader's thumb rather than the saved row. */}
        <GoalRing goal={goal} pct={prog} />
        <div className="min-w-0 flex-1">
          <h3 className={cn("truncate font-semibold", goal.status === "cancelled" && "text-muted-foreground line-through")} title={goal.title}>{goal.title}</h3>
          {owner && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <PhotoAvatar employeeId={idOf(owner.path)} name={`${owner.first_name} ${owner.last_name}`} photo={owner.photo} className="h-6 w-6" />
              <span className="truncate">{owner.first_name} {owner.last_name}</span>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <GoalStatusBadge goal={goal} />
            <GoalKindMark goal={goal} />
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
            <GoalStageBadge goal={goal} />
            {/* Where this should be by now, and how long since anybody said anything. Both computed by the
                server from dates the row already carried - and both invisible on this card until now, which
                is how a goal reaches its due date at 30% with nobody surprised. */}
            <GoalPaceChip goal={goal} />
            <GoalQuietChip goal={goal} />
            {!closed && <GoalDueChip goal={goal} />}
            {goal.weight ? <span className="text-muted-foreground">· weight {goal.weight}</span> : null}
            {/* The measure says more than the percentage does: "42 of 60 customers" is checkable, "70%" is not. */}
            {goal.measured && (
              <span className="inline-flex items-center gap-1 font-medium">
                <Target className="h-3 w-3" /> <GoalMeasureChip goal={goal} />
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
              <span className="inline-flex max-w-[11rem] items-center gap-1 font-medium text-warning" title={`Waiting on ${blockedByTitle}`}>
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
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.deliver_time ? "bg-success" : "bg-muted-foreground/40")} />
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
                <Button variant="ghost" size="icon" className="h-7 w-7 text-success" onClick={() => onProgress(100)} aria-label="Mark complete"><CheckCircle2 className="h-4 w-4" /></Button>
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
              // On blur, not on every key-up. A slider answers to the arrow keys, and `onKeyUp` fired a write
              // per press: taking a goal from 0 to 60 with the keyboard was twelve PATCHes, twelve reloads
              // and twelve success toasts, each one landing in the activity history as a separate move.
              // Releasing the pointer still commits, so the mouse gesture is unchanged.
              onBlur={commit}
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
