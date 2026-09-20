import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KanbanSquare, Plus, BarChart3, Ban, X, ChevronUp, ChevronDown, ChevronsUp, ChevronLeft, ChevronRight,
  AlertTriangle, Trash2, Flag, Target, Search, Tag, Info, MessageSquare, CalendarDays, History, Building2, ListChecks, AlignLeft,
  MoreHorizontal, List as ListIcon, UserRound, FileText, ExternalLink, Link2, SquareKanban, Pencil, Eye,
} from "lucide-react";
import { create, get, invoke, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useRoute, setQueryParam, setRouteRecord, recordUrl } from "@/router";
import { DataTable, type BulkAction, type Column } from "@/components/common/DataTable";
import { type TableInsight } from "@/components/common/TableInsights";
import { bulkInvoke, bulkSummary } from "@/lib/bulk";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import { idOf, cn, initials } from "@/lib/utils";
import { useRowKeys } from "@/lib/rowKeys";
import { todayStr, addDaysYmd, weekdayOf, daysBetweenYmd } from "@/lib/orgDay";
import { daysSince, fmtDaysCount } from "@/lib/tableDerive";
import { BLANK } from "@/lib/tableFilter";
import { allScope, mineColumn, mineScope, scopesOf, valueScope } from "@/lib/tableScope";
import { useCanSeeActivity } from "@/lib/perm";
import type { Me, Board, BoardMode, Card as CardT, CardComment, CardTodo, TicketChecklist, BoardColumn, WipScope, SwimlaneMode, Employee, Goal, Department, BoardMetrics, Sprint } from "@/types";
import type { Wire } from "@/wire";
import { resourceRoute } from "@/lib/resourceRoute";
import { Chart } from "@/components/common/Chart";
import { stackSeries } from "@/lib/chartTheme";
import { PageHeader } from "@/components/common/PageHeader";
import { SettingsButton } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { StatsSkeleton, PageSkeleton } from "@/components/common/Skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { useIntent } from "@/lib/intent";
import { Field, FieldRow } from "@/components/common/Field";
import { StatCard } from "@/components/common/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import type { Label as BoardLabel } from "@/types";
import { RichTextToolbar } from "@/components/common/RichTextToolbar";
import { DraftButton } from "@/components/common/DraftButton";
import { CardTriageCard } from "@/components/common/CardTriageCard";
import { RichText } from "@/lib/richText";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessTarget } from "@/components/access/AccessTarget";
import { ActivitySection } from "@/components/common/ActivitySection";
import { isConflict } from "@/lib/formError";
import { timeAgo } from "@/lib/activity";
import { readLocal, writeLocal, readLocalJson, writeLocalJson, userKey } from "@/lib/localPref";
import { useMentions } from "@/components/common/MentionPicker";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { TruncationNotice } from "@/components/common/TruncationNotice";

// Trello-style board frame: the columns row fills from its own top edge down to the viewport bottom, so
// every column is the same height regardless of card count and each column scrolls its cards internally
// (see the per-column `overflow-y-auto` body). Measuring the live top offset keeps this robust to whatever
// chrome sits above (top bar, page header, tabs, board toolbar) without a hand-tuned magic constant.
function useFillHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recompute = () => {
      // Below `md` the home indicator covers the last ~34px of the viewport, so a board sized to
      // `innerHeight` would put its bottom cards - and the drop zone at the end of a column - under the
      // gesture bar. Stop above it instead.
      const bottomChrome = window.matchMedia("(min-width: 768px)").matches ? 16 : 48;
      setHeight(Math.max(240, window.innerHeight - el.getBoundingClientRect().top - bottomChrome));
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);
  return { ref, height };
}

// Which task is open, in one place for all three views (kanban, list, scrum).
//
// Opening writes the id into the route path, so the task on screen has a URL to paste at somebody: the inbound
// half of that contract (`useDeepOpen`, `/boards/<cardId>` from the activity feed and notifications) has
// always existed, while nothing ever wrote it, which is why no task in this app has been linkable.
function useOpenCard(openId: string | undefined, cards: CardT[]) {
  const [editing, setEditing] = useState<CardT | null>(null);
  const openCard = useCallback((c: CardT) => { setEditing(c); setRouteRecord(idOf(c.path)); }, []);
  const closeCard = useCallback(() => { setEditing(null); setRouteRecord(null); }, []);
  useDeepOpen(openId, cards, openCard);
  return { editing, openCard, closeCard };
}

const NONE = "__none"; // lane key for cards with no assignee/goal/class/swimlane
const PRIORITY_LANES = [ // fixed swimlanes for swimlane_mode = "priority", severity high→low
  { key: "urgent", label: "Urgent" }, { key: "high", label: "High" }, { key: "medium", label: "Medium" }, { key: "low", label: "Low" },
];
const NO_DEPT = "__nodept"; // CardDialog: explicit "no department" (distinct from "" = use the org default)

/**
 * A suggested checklist, as lines, into staged items.
 *
 * The prompt asks for one bare step per line and the parser does not believe it. A model told not to number
 * a list numbers it anyway often enough to matter, and here the cost lands in the data: every line becomes a
 * checklist item verbatim, so one stray "1." or "- " is an item somebody has to edit by hand on a card they
 * have not created yet. Stripping the ornament is cheaper than trusting the instruction.
 *
 * Capped, and blank lines dropped: a model that ignores "three to seven" should not be able to stage forty
 * items into a dialog that renders them all.
 */
function toChecklistItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•‣]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}
// Repeating work. A Select cannot carry "" as a value, so the one-off case gets a sentinel like the above.
const NO_CADENCE = "__once";
const CADENCES: { value: string; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every quarter" },
];

// One-tap answers for the two slowest controls in the task dialog. Fibonacci-ish points because that is what
// the estimate scale is for ("bigger than a 3, smaller than an 8"), and the dates people actually pick.
const POINT_PRESETS = [1, 2, 3, 5, 8, 13];
// Off the ORG's day, via lib/orgDay. This used to step a local `new Date()` and then serialize it with
// `toISOString()`, which is UTC: for the first five and a half hours of every IST day the "Today" chip wrote
// YESTERDAY's date, so the card it created was overdue the moment it was saved.
const shiftDay = (n: number) => addDaysYmd(todayStr(), n);
const DUE_PRESETS: { label: string; value: () => string }[] = [
  { label: "Today", value: () => shiftDay(0) },
  { label: "Tomorrow", value: () => shiftDay(1) },
  // Next Monday, which is where "later this week" work really lands. The weekday comes off the org day too,
  // for the same reason - the browser's own weekday can already be tomorrow's.
  { label: "Next Mon", value: () => shiftDay(((8 - weekdayOf(todayStr())) % 7) || 7) },
  { label: "+1 week", value: () => shiftDay(7) },
];

// A small toggle pill for the preset rows. Not a Button: these sit under a field in threes and fours, and a
// row of outline buttons reads as four competing actions rather than one set of choices.
function Chip({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={!!active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition-colors",
        active ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
const RANK_STEP = 1024;
const PRIORITIES: CardT["priority"][] = ["low", "medium", "high", "urgent"];
const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-sky-600 dark:text-sky-400",
  high: "text-warning",
  urgent: "text-destructive",
};
const PRIORITY_ICON: Record<string, typeof ChevronUp> = { low: ChevronDown, medium: ChevronUp, high: ChevronsUp, urgent: AlertTriangle };

// A small colored priority glyph (icon, not text).
function PriorityIcon({ p, className = "" }: { p: CardT["priority"]; className?: string }) {
  const Icon = PRIORITY_ICON[p] ?? ChevronUp;
  return <Icon className={`h-3.5 w-3.5 ${PRIORITY_TONE[p]} ${className}`} aria-label={`${p} priority`} />;
}

// Colored label chips from a card's label keys, resolved against the board's catalog.
function LabelChips({ keys, catalog, max }: { keys?: string[]; catalog: BoardLabel[]; max?: number }) {
  if (!keys?.length) return null;
  const byKey = new Map(catalog.map((l) => [l.key, l]));
  const shown = max ? keys.slice(0, max) : keys;
  return (
    <>
      {shown.map((k) => {
        const l = byKey.get(k);
        const color = l?.color ?? "#64748b";
        return (
          <span key={k} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${color}22`, color }}>
            {l?.label ?? k}
          </span>
        );
      })}
      {max && keys.length > max && <span className="text-[10px] text-muted-foreground">+{keys.length - max}</span>}
    </>
  );
}

// The human task key (board prefix + per-board seq, e.g. MS-12); falls back to a wire-id slice for old rows.
const taskKey = (card: CardT) => card.key ?? `#${idOf(card.path).slice(0, 5).toUpperCase()}`;

const toggleSet = (s: Set<string>, k: string) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; };

/**
 * The order cards are drawn in: by rank, then by a STABLE tiebreaker.
 *
 * Rank alone is not a total order. Two people dropping into the same gap compute the same midpoint (`rankAt`
 * below is pure arithmetic over the neighbours, and the server stores what it is sent - `rank` carries no
 * unique constraint), and repeated midpoints into one gap eventually exhaust double precision, at which point
 * the new rank EQUALS its neighbour's. With nothing after the subtraction, the relative order of a tied pair
 * then falls out of whatever order the rows arrived in - so the same board can read differently for two people
 * looking at it, and a card can appear to move on its own between renders.
 *
 * `path` is the tiebreaker for the same reason services/keysetPage.ts breaks its own ties on `uuid`: it is
 * unique, stable, and identical for every viewer. Byte order carries no meaning, which is fine - a tie has no
 * meaning either. What it buys is that everybody sees the same one.
 */
const byRank = (a: CardT, b: CardT) =>
  (a.rank ?? 0) - (b.rank ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Fractional rank for inserting at position `idx` in a rank-sorted list (midpoint of the two neighbours).
const rankAt = (items: CardT[], idx: number) => {
  const lo = idx > 0 ? (items[idx - 1]!.rank ?? 0) : (items.length ? (items[0]!.rank ?? 0) - RANK_STEP : 0);
  const hi = idx < items.length ? (items[idx]!.rank ?? 0) : (items.length ? (items[items.length - 1]!.rank ?? 0) + RANK_STEP : RANK_STEP);
  return (lo + hi) / 2;
};

// Client-side board filtering, shared by Kanban + Scrum. Filters the already-fetched, access-scoped rows.
// Department filter matches on the card's own department (NONE when unset).
// With a `storageKey` the chip filters (not the search text) persist per board in localStorage, so a curated
// view survives navigation. Initialized once per mount - the views are keyed by board, so switching boards
// remounts and picks up that board's saved filter.
type SavedFilter = { assignees?: string[]; priorities?: string[]; labels?: string[]; departments?: string[]; mine?: boolean; reported?: boolean };
function useCardFilter(meId?: string | null, storageKey?: string) {
  const [saved] = useState((): SavedFilter => (storageKey ? readLocalJson<SavedFilter>(storageKey, {}) : {}));
  const [q, setQ] = useState("");
  const [assignees, setAssignees] = useState<Set<string>>(new Set(saved.assignees));
  const [priorities, setPriorities] = useState<Set<string>>(new Set(saved.priorities));
  const [labels, setLabels] = useState<Set<string>>(new Set(saved.labels));
  const [departments, setDepartments] = useState<Set<string>>(new Set(saved.departments));
  const [mine, setMine] = useState(!!saved.mine);
  // Tasks the caller FILED, which is a different question from the ones they are working on: "what did I ask
  // for, and where has it got to" had no answer on the board at all.
  const [reported, setReported] = useState(!!saved.reported);
  const active = !!q || assignees.size > 0 || priorities.size > 0 || labels.size > 0 || departments.size > 0 || mine || reported;
  const clear = () => { setQ(""); setAssignees(new Set()); setPriorities(new Set()); setLabels(new Set()); setDepartments(new Set()); setMine(false); setReported(false); };
  useEffect(() => {
    if (!storageKey) return;
    const any = assignees.size || priorities.size || labels.size || departments.size || mine || reported;
    writeLocalJson(storageKey, any ? ({ assignees: [...assignees], priorities: [...priorities], labels: [...labels], departments: [...departments], mine, reported } satisfies SavedFilter) : null);
  }, [assignees, priorities, labels, departments, mine, reported, storageKey]);
  const effDept = (c: CardT) => (c.department ? idOf(c.department) : NONE);
  // STABLE IDENTITY, because every consumer memoizes on it. `match` used to be a fresh closure per render, so
  // the board's `visible` list, its per-cell card lists and BoardToolbar's own `useMemo(…, [cards, filter])`
  // all recomputed on every render - and a keystroke in the board search box is a render. The needle is
  // lowercased once here rather than inside the predicate, where it ran once per card per pass.
  const needle = q.trim().toLowerCase();
  const match = useCallback(
    (c: CardT) => {
      if (needle && !`${c.title} ${c.description ?? ""}`.toLowerCase().includes(needle)) return false;
      if (mine && (!c.assignee || idOf(c.assignee) !== meId)) return false;
      if (reported && (!c.reporter || idOf(c.reporter) !== meId)) return false;
      if (assignees.size && !assignees.has(c.assignee ? idOf(c.assignee) : NONE)) return false;
      if (priorities.size && !priorities.has(c.priority)) return false;
      if (labels.size && !(c.labels ?? []).some((k) => labels.has(k))) return false;
      if (departments.size && !departments.has(c.department ? idOf(c.department) : NONE)) return false;
      return true;
    },
    [needle, mine, reported, assignees, priorities, labels, departments, meId],
  );
  return {
    q, setQ, mine, setMine, reported, setReported, assignees, priorities, labels, departments, active, clear, match, effDept,
    toggleAssignee: (k: string) => setAssignees((s) => toggleSet(s, k)),
    togglePriority: (k: string) => setPriorities((s) => toggleSet(s, k)),
    toggleLabel: (k: string) => setLabels((s) => toggleSet(s, k)),
    toggleDepartment: (k: string) => setDepartments((s) => toggleSet(s, k)),
  };
}
type CardFilter = ReturnType<typeof useCardFilter>;

// The board toolbar: search + assignee/priority/label filters + "My tasks". Options come from the cards present.
function BoardToolbar({ filter, board, cards, empName, deptName }: { filter: CardFilter; board: Board; cards: CardT[]; empName: (ref?: string) => string; deptName: (ref?: string) => string }) {
  const shown = useMemo(() => cards.filter(filter.match).length, [cards, filter]);
  const assigneeOpts = useMemo(() => {
    const ids = new Set<string>();
    let hasUnassigned = false;
    for (const c of cards) { if (c.assignee) ids.add(idOf(c.assignee)); else hasUnassigned = true; }
    const list = [...ids].map((id) => ({ id, name: empName(`employees/${id}`) }));
    return { list, hasUnassigned };
  }, [cards, empName]);
  // Departments present among the cards' EFFECTIVE dept (override ?? board). Only worth showing when >1 (a
  // single-department board adds no signal). NONE = no department at all.
  const deptOpts = useMemo(() => {
    const ids = new Set<string>();
    let hasNone = false;
    for (const c of cards) { const d = filter.effDept(c); if (d === NONE) hasNone = true; else ids.add(d); }
    return { list: [...ids].map((id) => ({ id, name: deptName(`departments/${id}`) })), hasNone };
  }, [cards, deptName, filter]);
  const labelByKey = new Map(board.labels.map((l) => [l.key, l]));
  // One-click assignee filter: the busiest assignees as a compact avatar row (full list stays in the popover).
  const avatarStrip = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cards) if (c.assignee && !c.deliver_time) counts.set(idOf(c.assignee), (counts.get(idOf(c.assignee)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ id, n, name: empName(`employees/${id}`) }));
  }, [cards, empName]);

  const FilterPopover = ({ label, count, children }: { label: string; count: number; children: ReactNode }) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={count ? "secondary" : "outline"} size="sm" className="h-8">{label}{count ? ` · ${count}` : ""}</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">{children}</PopoverContent>
    </Popover>
  );
  const Row = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
      <Checkbox checked={on} className="pointer-events-none" /> {children}
    </button>
  );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={filter.q} onChange={(e) => filter.setQ(e.target.value)} placeholder="Search tasks…" className="h-8 w-52 pl-7" />
      </div>
      {avatarStrip.length > 1 && (
        <div className="flex items-center -space-x-1.5">
          {avatarStrip.map((a) => (
            <Tooltip key={a.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => filter.toggleAssignee(a.id)}
                  aria-pressed={filter.assignees.has(a.id)}
                  className={cn("rounded-full transition-transform hover:z-10 hover:-translate-y-0.5", filter.assignees.has(a.id) && "z-10 ring-2 ring-primary")}
                >
                  <PhotoAvatar employeeId={a.id} name={a.name} className="h-7 w-7 border-2 border-background text-[10px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{a.name} · {a.n} open task{a.n === 1 ? "" : "s"}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
      <FilterPopover label="Assignee" count={filter.assignees.size}>
        {assigneeOpts.hasUnassigned && <Row on={filter.assignees.has(NONE)} onClick={() => filter.toggleAssignee(NONE)}>Unassigned</Row>}
        {assigneeOpts.list.map((a) => (
          <Row key={a.id} on={filter.assignees.has(a.id)} onClick={() => filter.toggleAssignee(a.id)}>
            <PhotoAvatar employeeId={a.id} name={a.name} className="h-5 w-5 text-[9px]" /> <span className="truncate">{a.name}</span>
          </Row>
        ))}
      </FilterPopover>
      <FilterPopover label="Priority" count={filter.priorities.size}>
        {PRIORITIES.map((p) => (
          <Row key={p} on={filter.priorities.has(p)} onClick={() => filter.togglePriority(p)}>
            <PriorityIcon p={p} /> <span className="capitalize">{p}</span>
          </Row>
        ))}
      </FilterPopover>
      {board.labels.length > 0 && (
        <FilterPopover label="Labels" count={filter.labels.size}>
          {board.labels.map((l) => (
            <Row key={l.key} on={filter.labels.has(l.key)} onClick={() => filter.toggleLabel(l.key)}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: labelByKey.get(l.key)?.color ?? "#64748b" }} /> {l.label}
            </Row>
          ))}
        </FilterPopover>
      )}
      {(deptOpts.list.length + (deptOpts.hasNone ? 1 : 0)) > 1 && (
        <FilterPopover label="Department" count={filter.departments.size}>
          {deptOpts.list.map((d) => (
            <Row key={d.id} on={filter.departments.has(d.id)} onClick={() => filter.toggleDepartment(d.id)}>
              <span className="truncate">{d.name}</span>
            </Row>
          ))}
          {deptOpts.hasNone && <Row on={filter.departments.has(NONE)} onClick={() => filter.toggleDepartment(NONE)}>No department</Row>}
        </FilterPopover>
      )}
      <Button variant={filter.mine ? "secondary" : "outline"} size="sm" className="h-8" onClick={() => filter.setMine(!filter.mine)}>My tasks</Button>
      <Button variant={filter.reported ? "secondary" : "outline"} size="sm" className="h-8" title="Tasks you filed, whoever is doing them" onClick={() => filter.setReported(!filter.reported)}>I reported</Button>
      {filter.active && (
        <>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={filter.clear}><X className="h-3.5 w-3.5" /> Clear</Button>
          <span className="text-xs text-muted-foreground">{shown} of {cards.length} task{cards.length === 1 ? "" : "s"}</span>
        </>
      )}
    </div>
  );
}

// Namespaced to the caller, like every other per-person key. Under a shared key B landed on the board A was
// last looking at (degraded to the first board by `valid()`, but still not theirs).
const LAST_BOARD_KEY = () => userKey("boards:last");
const CARD_FETCH_CAP = 500; // follow the cards cursor up to here; past it the TruncationNotice takes over

export default function Boards({ me, openId }: { me: Me; openId?: string }) {
  // `all: true`: every consumer on this page treats `boards` as the complete catalogue - the switcher below,
  // `valid()`, and the `boards.find` that resolves the selection - so one page of them is not a short list, it
  // is a wrong answer. A deep link to a board past the window resolved to `null` and silently dropped the
  // reader on somebody else's board with the URL still naming theirs. The residual ALL_CAP is admitted by the
  // TruncationNotice below.
  const { rows: boards, state, error, reload, hasMore: boardsHasMore } = useCollection<Board>("boards", { all: true });
  // Shared cache with the view below (no extra read) — used only to map a deep-linked card id to its board.
  const { rows: navCards, hasMore: cardsHasMore, loadMore: loadMoreCards } = useCollection<CardT>("cards");
  const route = useRoute();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newBoard, setNewBoard] = useState(false);
  const [tab, setTab] = useState("board");

  // The server caps a list page at 100 rows; boards are the likeliest collection to exceed it. Follow the
  // cursor (one page per response, the store dedups in-flight) until the board data is complete or the cap is
  // hit - reads stay proportional to actual board size and only happen while this page is open.
  useEffect(() => {
    if (cardsHasMore && navCards.length < CARD_FETCH_CAP) void loadMoreCards();
  }, [cardsHasMore, navCards.length, loadMoreCards]);

  // Which board to show: `?board=` in the URL (shareable deep link) > last viewed (localStorage) > first.
  // Falls back to the first board whenever the current choice stops being valid (deleted, access lost).
  useEffect(() => {
    if (!boards.length) { setSelectedId(null); return; }
    const valid = (id: string | null | undefined) => (id && boards.some((b) => idOf(b.path) === id) ? id : null);
    const fromUrl = valid(route.query.board);
    if (fromUrl && fromUrl !== selectedId) { setSelectedId(fromUrl); return; }
    if (valid(selectedId)) return;
    // "Not in the rows we hold" is only "deleted, access lost" once the rows ARE the collection. While the
    // walk is still short of it, a requested board that has not arrived keeps its place instead of being
    // replaced by somebody else's board under a URL that still names theirs.
    if (boardsHasMore && (route.query.board || selectedId)) {
      if (route.query.board && route.query.board !== selectedId) setSelectedId(route.query.board);
      return;
    }
    const lastKey = LAST_BOARD_KEY();
    // The id here is a SELECTION, not a label: it picks which board to show and never reaches the screen, so
    // the "a ref reads as a word" rule is not the one that applies.
    // eslint-disable-next-line no-restricted-syntax
    setSelectedId(fromUrl ?? valid(lastKey ? readLocal(lastKey) : null) ?? idOf(boards[0]!.path));
  }, [boards, selectedId, route.query.board, boardsHasMore]);

  // Remember the selection and keep the URL shareable. Written in place rather than pushed: which board is on
  // screen is view state, not a step the reader took, so it has no business spending a back press - and the
  // unsaved-changes guard ignores query-only changes either way.
  function selectBoard(id: string) {
    setSelectedId(id);
    const lastKey = LAST_BOARD_KEY();
    if (lastKey) writeLocal(lastKey, id);
    setQueryParam("board", id, { replace: true });
  }

  // Deep link `/boards/<cardId>` (from the activity feed): select that card's board so the view can open it.
  useEffect(() => {
    if (!openId) return;
    const c = navCards.find((x) => idOf(x.path) === openId);
    if (c?.board) setSelectedId(idOf(c.board));
  }, [openId, navCards]);

  const board = boards.find((b) => idOf(b.path) === selectedId) ?? null;

  const newBtn = (
    <AccessAction collection="boards" create label="Create a board">
      <Button onClick={() => setNewBoard(true)}><Plus className="h-4 w-4" /> New board</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader
        title="Boards"
        description="Track your team's work as it moves from to-do to done. Progress rolls up to goals."
        actions={
          <div className="flex items-center gap-2">
            {boards.length > 0 && (
              <Select value={selectedId ?? undefined} onValueChange={selectBoard}>
                <SelectTrigger className="w-56"><SelectValue placeholder="Pick a board" /></SelectTrigger>
                <SelectContent>
                  {boards.map((b) => <SelectItem key={b.path} value={idOf(b.path)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {board && <AccessTarget target={{ collection: "boards", objectPath: board.path, can: board.access?.can, label: "Manage board access" }} />}
            {newBtn}
          </div>
        }
      />

      <TruncationNotice collection={["boards", "cards"]} what="boards and cards" className="mb-3" />
      <DataState state={state} error={error} onRetry={reload}>
        {boards.length === 0 ? (
          <EmptyState icon={KanbanSquare} title="No boards yet" description="Create a board to start tracking work with columns, WIP limits and swimlanes." action={newBtn} />
        ) : (
          <>
            {/* Only reachable while the boards walk is still short of the collection and the requested board
                has not arrived yet - the case `valid()` used to answer by showing a different board. */}
            {!board && <PageSkeleton />}
            {board && (
              <Tabs value={tab} onValueChange={setTab}>
                <div className="flex items-center justify-between gap-2">
                  <TabsList>
                    <TabsTrigger value="board"><KanbanSquare className="mr-1.5 h-4 w-4" /> Board</TabsTrigger>
                    <TabsTrigger value="list"><ListIcon className="mr-1.5 h-4 w-4" /> List</TabsTrigger>
                    <TabsTrigger value="analytics"><BarChart3 className="mr-1.5 h-4 w-4" /> Analytics</TabsTrigger>
                  </TabsList>
                  <SettingsButton me={me} settingKey="board-config" objectPath={board.path} can={board.access?.can} />
                </div>
                <TabsContent value="board">
                  {board.mode === "scrum" ? <ScrumView key={board.path} board={board} me={me} openId={openId} /> : <BoardView key={board.path} board={board} me={me} openId={openId} />}
                </TabsContent>
                <TabsContent value="list"><BoardListTab key={board.path} board={board} me={me} /></TabsContent>
                {/* The flow numbers are read off delivered cards, so each one can hand the reader the cards
                    themselves - the List tab is where they can be sorted and filtered. */}
                <TabsContent value="analytics"><AnalyticsTab board={board} onOpenCards={() => setTab("list")} /></TabsContent>
              </Tabs>
            )}
          </>
        )}
      </DataState>

      {newBoard && <NewBoardDialog existing={boards} onClose={() => setNewBoard(false)} onSaved={(id) => { setSelectedId(id); reload(); }} />}
    </div>
  );
}

// ---- Board view: columns x swimlanes, native HTML5 drag-and-drop, WIP + policy on the header ----------------

function BoardView({ board, me, openId }: { board: Board; me: Me; openId?: string }) {
  const { rows: allCards, setRows, reload } = useCollection<CardT>("cards");
  const { toast } = useToast();
  const boardId = idOf(board.path);
  const [addTo, setAddTo] = useState<string | null>(null); // column key for the full "add card" dialog
  const [quick, setQuick] = useState<string | null>(null); // column key with the inline title composer open
  // "+ New → Create a task" quick action: open the full composer on this board's first column.
  useIntent("new-card", () => { const k = board.columns[0]?.key; if (k) setAddTo(k); });
  const dragId = useRef<string | null>(null);
  const { ref: fillRef, height: fillH } = useFillHeight();
  const pendingRank = useRef<number | null>(null); // rank computed from the hovered gap, for precise insertion
  const [overCell, setOverCell] = useState<string | null>(null); // `${col}::${lane}` currently hovered while dragging
  const [lineAt, setLineAt] = useState<string | null>(null); // `${cardPath}:t|b` — where to draw the insertion line
  // Catch up on what teammates moved while this tab was in the background (throttled; no polling).
  useRefetchOnFocus(reload);
  // Folded-away columns (per board, sticky). A collapsed column stays a drop target (drop = append).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    return new Set(readLocalJson<string[]>(`boards:collapsed:${boardId}`, []));
  });
  // The write is OUTSIDE the updater: an updater must be pure, React re-runs it whenever it likes, and
  // StrictMode (web/src/main.tsx) deliberately invokes it twice - so the localStorage write happened twice per
  // click. Derived from the current state rather than from `prev`, which is the same value here (one toggle per
  // click, and React has already flushed the previous one).
  const toggleCollapse = (k: string) => {
    const n = toggleSet(collapsed, k);
    setCollapsed(n);
    writeLocalJson(`boards:collapsed:${boardId}`, [...n]);
  };

  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  const { editing, openCard, closeCard } = useOpenCard(openId, cards);
  // The three REFERENCE lists a board draws labels from, read only once the cards prove they are needed. A
  // grid whose cards carry no goal never names a goal, so the goals list is not worth a page of rows; the same
  // holds for assignees and departments. The card composer is the exception - it must offer everyone, every
  // goal and every department regardless of what this board currently uses - so an open dialog pulls them in.
  const composing = !!addTo || !!editing;
  // `all` once the read is enabled: these rows name assignees, fill the picker and feed the card composer's
  // @-mention menu, and each of those is wrong rather than short when the directory runs past one page.
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: composing || board.swimlane_mode === "assignee" || cards.some((c) => c.assignee) });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: composing || board.swimlane_mode === "goal" || cards.some((c) => c.goal) });
  const { rows: departments } = useCollection<Department>("departments", { enabled: composing || board.swimlane_mode === "department" || cards.some((c) => c.department), all: true });
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Department" : "");
  }, [departments]);
  const assigneeOf = (c: CardT) => (c.assignee ? { id: idOf(c.assignee), name: empName(c.assignee) } : null);
  const goalTitle = useMemo(() => {
    const m = new Map(goals.map((g) => [idOf(g.path), g.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Goal" : "");
  }, [goals]);
  const cardById = useMemo(() => new Map(cards.map((c) => [idOf(c.path), c])), [cards]);
  const blockerKeyOf = (c: CardT) => (c.blocked_by ? (cardById.get(idOf(c.blocked_by)) && taskKey(cardById.get(idOf(c.blocked_by))!)) || undefined : undefined);

  const cols = board.columns;
  const countByCol = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.column_key, (m.get(c.column_key) ?? 0) + 1);
    return m;
  }, [cards]);

  // Swimlanes: derive the lane set + a card's lane key from the board's mode. `useCallback` because the lane
  // memo below calls it - its identity moves with the board's swimlane mode, which is the only thing it reads.
  const laneKeyOf = useCallback((c: CardT): string => {
    switch (board.swimlane_mode) {
      case "assignee": return c.assignee ? idOf(c.assignee) : NONE;
      case "goal": return c.goal ? idOf(c.goal) : NONE;
      case "priority": return c.priority || NONE;
      case "department": return c.department ? idOf(c.department) : NONE;
      case "custom": return c.swimlane_key || NONE;
      default: return "";
    }
  }, [board.swimlane_mode]);
  const noneLabel = board.swimlane_mode === "assignee" ? "Unassigned" : board.swimlane_mode === "goal" ? "No goal" : board.swimlane_mode === "department" ? "No department" : board.swimlane_mode === "custom" ? (board.no_lane_label || "Ungrouped") : "None";
  const lanes = useMemo((): { key: string; label: string }[] => {
    if (board.swimlane_mode === "none") return [{ key: "", label: "" }];
    if (board.swimlane_mode === "custom") return [...board.swimlanes, { key: NONE, label: noneLabel }];
    // priority: fixed lane set in severity order (a card always has a priority, so no catch-all).
    if (board.swimlane_mode === "priority") return PRIORITY_LANES;
    // assignee / goal / department: lanes present among the cards, plus a catch-all.
    const seen = new Map<string, string>();
    const nameOf = (c: CardT) => board.swimlane_mode === "assignee" ? empName(c.assignee) : board.swimlane_mode === "department" ? deptName(c.department) : goalTitle(c.goal);
    for (const c of cards) {
      const k = laneKeyOf(c);
      if (seen.has(k)) continue;
      seen.set(k, k === NONE ? noneLabel : nameOf(c));
    }
    if (!seen.has(NONE)) seen.set(NONE, noneLabel);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [board, cards, empName, goalTitle, deptName, noneLabel, laneKeyOf]);

  const filter = useCardFilter(me.employee_id, `boards:filter:${boardId}`);
  const visible = useMemo(() => cards.filter(filter.match), [cards, filter.match]);

  // EVERY CELL IN ONE PASS. `cardsIn` used to re-filter and re-sort the whole visible set on each call, and it
  // is called `columns × lanes` times to decide which lanes render and `columns × visibleLanes` times again to
  // render them - so a 6-column board with swimlanes by assignee across a 12-person team was ~156 filter-plus-
  // sort passes over every card on the board, per render, and a keystroke in the search box is a render. One
  // bucketing pass plus one sort per non-empty cell gives the same answer.
  const cells = useMemo(() => {
    const byColumn = new Map<string, Map<string, CardT[]>>();
    const laneless = board.swimlane_mode === "none";
    for (const c of visible) {
      const lanes = byColumn.get(c.column_key) ?? byColumn.set(c.column_key, new Map()).get(c.column_key)!;
      const lane = laneless ? "" : laneKeyOf(c);
      (lanes.get(lane) ?? lanes.set(lane, []).get(lane)!).push(c);
    }
    for (const lanes of byColumn.values()) for (const list of lanes.values()) list.sort(byRank);
    return byColumn;
  }, [visible, board.swimlane_mode, laneKeyOf]);
  // One shared empty array, so a cell with no cards keeps a stable identity across renders.
  const EMPTY_CELL = useMemo<CardT[]>(() => [], []);
  const cardsIn = (colKey: string, laneKey: string) =>
    cells.get(colKey)?.get(board.swimlane_mode === "none" ? "" : laneKey) ?? EMPTY_CELL;

  // Apply the board's swimlane display prefs: optionally drop lanes with no cards under the current
  // filter. Never applies in "none" mode (single implicit lane).
  const laneHasCards = (laneKey: string) => board.columns.some((col) => cardsIn(col.key, laneKey).length > 0);
  const visibleLanes = board.swimlane_mode === "none" ? lanes : lanes.filter((l) => {
    if (board.hide_empty_lanes && !laneHasCards(l.key)) return false;
    return true;
  });

  // WHAT ‹ › AND j/k WALK: the tasks on screen, in the order they are drawn - column by column, lane by lane,
  // by rank. The dialog was handed every card on the board instead, unfiltered and in whatever order the read
  // returned, under a comment claiming it was "already filtered and in the order it draws". So with "My
  // tasks" on, `j` stepped to a task that was not on the board in front of the reader, and the "3 of 48"
  // beside it counted a set nothing had drawn. Cheap: these are the buckets `cells` already sorted.
  const screenQueue = cols.flatMap((col) => visibleLanes.flatMap((lane) => cardsIn(col.key, lane.key)));

  // Where a card would actually land if dropped in cell (colKey, laneKey): within a column any lane is allowed,
  // but a cross-column drop keeps the card's own lane unless the board opts into swimlane change. Used for both
  // the drop and the hover highlight so the outline always shows the true destination cell.
  function dropLane(card: CardT, colKey: string, laneKey: string) {
    if (card.column_key !== colKey && !board.reassign_lane_on_move) return laneKeyOf(card);
    return laneKey;
  }
  // The cell that would actually receive the currently-dragged card if dropped over (colKey, laneKey).
  function hoverCell(colKey: string, laneKey: string) {
    const card = dragId.current ? cards.find((c) => idOf(c.path) === dragId.current) : null;
    return `${colKey}::${card ? dropLane(card, colKey, laneKey) : laneKey}`;
  }

  // `laneKeyIn === null` = keep the card's own lane (drops on a collapsed column, which has no lane cells).
  async function onDrop(colKey: string, laneKeyIn: string | null, explicitRank?: number) {
    const id = dragId.current;
    dragId.current = null;
    if (!id) return;
    const card = cards.find((c) => idOf(c.path) === id);
    if (!card) return;
    const laneKey = dropLane(card, colKey, laneKeyIn ?? laneKeyOf(card));
    const laneChanged = board.swimlane_mode !== "none" && laneKeyOf(card) !== laneKey;
    const sameCell = card.column_key === colKey && !laneChanged;
    if (sameCell && explicitRank == null) return; // dropped back on its own cell with no position → no-op
    // Precise insertion rank if a gap was hovered; else append to the end of the destination cell.
    const dest = cardsIn(colKey, laneKey);
    const rank = explicitRank ?? (dest.length ? Math.max(...dest.map((c) => c.rank ?? 0)) : 0) + RANK_STEP;
    // Every swimlane maps to a real card field, so crossing lanes reassigns it: custom → swimlane_key,
    // assignee → assignee, goal → goal. Derived lanes (assignee/goal) hold the bare id; refs go over the wire as paths.
    const laneVal = laneKey === NONE ? null : laneKey;
    const move: Record<string, unknown> = { to_column: colKey, rank };
    const patch: Partial<CardT> = { column_key: colKey, rank };
    if (laneChanged) {
      if (board.swimlane_mode === "custom") { move.to_swimlane = laneVal; patch.swimlane_key = laneVal ?? undefined; }
      else if (board.swimlane_mode === "assignee") { move.to_assignee = laneVal ? `employees/${laneVal}` : null; patch.assignee = laneVal ? `employees/${laneVal}` : undefined; }
      else if (board.swimlane_mode === "goal") { move.to_goal = laneVal ? `goals/${laneVal}` : null; patch.goal = laneVal ? `goals/${laneVal}` : undefined; }
      else if (board.swimlane_mode === "priority" && laneVal) { move.to_priority = laneVal; patch.priority = laneVal as CardT["priority"]; }
      else if (board.swimlane_mode === "department") { move.to_department = laneVal ? `departments/${laneVal}` : null; patch.department = laneVal ? `departments/${laneVal}` : undefined; }
    }
    // Optimistic move, then the row the server actually wrote.
    //
    // TAKE THE RETURNED CARD. The optimistic patch carries the changed fields only, so the row in the store
    // keeps the PRE-WRITE etag, and nothing corrects it until the invalidation refetch lands - a full round
    // trip. Inside that window a second write on the same card sends the stale etag and the server refuses it,
    // so nudging a card into a column and then adjusting its position in that column - an ordinary kanban
    // gesture - produced "Couldn't move - etag mismatch" and a card snapping back. The dialog's verbs already
    // do this (see the note on `act`/`submit` below); the board's own writes were not in that pass. The
    // response is also authoritative about `rank`, which the server may have adjusted.
    setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, ...patch } : c)));
    try {
      const res = await invoke<CardT>(`cards/${id}`, "move", card.etag, move);
      setRows((prev) => prev.map((c) => (c.path === res.path ? res : c)));
    } catch (e) {
      reload();
      toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Menu-driven equivalents of drag/dialog edits, so cards are workable without a mouse drag (touch included).
  async function menuMove(card: CardT, toCol: string) {
    const dest = cardsIn(toCol, laneKeyOf(card));
    const rank = (dest.length ? Math.max(...dest.map((c) => c.rank ?? 0)) : 0) + RANK_STEP;
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, column_key: toCol, rank } : c)));
    // The returned row replaces the optimistic one, so its etag is current for the next write (see moveCard).
    try { const res = await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, { to_column: toCol, rank }); setRows((prev) => prev.map((c) => (c.path === res.path ? res : c))); }
    catch (e) { reload(); toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
  }
  async function menuPatch(card: CardT, body: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...body } : c)));
    try { const res = await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); setRows((prev) => prev.map((c) => (c.path === res.path ? res : c))); }
    catch (e) { reload(); toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }
  const tileMenu = (c: CardT) => (
    <CardActionsMenu
      card={c}
      meId={me.employee_id}
      columns={board.columns}
      onMove={(k) => void menuMove(c, k)}
      onAssignMe={() => void menuPatch(c, { assignee: `employees/${me.employee_id}` })}
      onPriority={(p) => void menuPatch(c, { priority: p })}
    />
  );

  return (
    <TooltipProvider delayDuration={150}>
      <BoardToolbar filter={filter} board={board} cards={cards} empName={empName} deptName={deptName} />

      {/* Swipe-a-column-at-a-time on a phone. Without snapping, dragging a board sideways leaves you parked
          between two columns reading half of each; with it, every swipe settles on a column edge. Snapping is
          switched off from `sm` up, where several columns are on screen at once and free scrolling is right. */}
      <div
        ref={fillRef}
        style={{ height: fillH }}
        className="scroll-shadow-x flex snap-x snap-mandatory items-stretch gap-3 overflow-x-auto sm:snap-none"
      >
        {cols.map((col) => {
          const count = countByCol.get(col.key) ?? 0;
          const perAssignee = col.limitScope === "assignee";
          const overWip = col.wipLimit != null && !perAssignee && count > col.wipLimit;
          const atWip = col.wipLimit != null && !perAssignee && count >= col.wipLimit;
          // Per-assignee WIP: surface WHO is over (board-wide limits already color the count badge).
          const wipOffenders = perAssignee && col.wipLimit != null
            ? (() => {
                const byAssignee = new Map<string, number>();
                for (const c of cards) if (c.column_key === col.key && c.assignee) { const a = idOf(c.assignee); byAssignee.set(a, (byAssignee.get(a) ?? 0) + 1); }
                return [...byAssignee.entries()].filter(([, n]) => n > col.wipLimit!);
              })()
            : [];
          if (collapsed.has(col.key)) {
            return (
              <div
                key={col.key}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverCell(`${col.key}::__collapsed`); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCell((p) => (p === `${col.key}::__collapsed` ? null : p)); }}
                onDrop={(e) => { e.preventDefault(); setOverCell(null); setLineAt(null); void onDrop(col.key, null); }}
                className={cn("flex min-h-0 w-10 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/20 transition-colors", overCell === `${col.key}::__collapsed` && "bg-primary/10 outline-dashed outline-1 outline-primary/40")}
              >
                <button type="button" onClick={() => toggleCollapse(col.key)} className="flex h-full w-full flex-col items-center gap-2 py-2 hover:bg-accent/40" title={`Expand ${col.label}`}>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  <Badge variant={overWip ? "destructive" : "secondary"}>{count}</Badge>
                  <span className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">{col.label}</span>
                </button>
              </div>
            );
          }
          return (
            // 86vw on a phone: the column all but fills the screen, with a sliver of the next one showing so
            // it is obvious the board continues. A fixed 288px column on a 390px screen reads as a mistake.
            // Named group: the column's heading is a plain span inside its header row, so without a name on
            // the column itself the board reads as one undifferentiated pile of cards with nothing saying
            // which column any of them is in.
            <div key={col.key} role="group" aria-label={col.label} className="flex min-h-0 w-[86vw] max-w-[20rem] shrink-0 snap-start flex-col overflow-hidden rounded-lg border bg-muted/20 sm:w-72 sm:max-w-none">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-sm font-medium">{col.label}</span>
                  {/* tapToOpen: these three say the only thing that says it - what the flag means, and the
                      column's written policy. The triggers do nothing else, so the tap is free to explain. */}
                  {col.commitment && <Tooltip tapToOpen><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-primary" /></TooltipTrigger><TooltipContent>Commitment point — lead time starts here</TooltipContent></Tooltip>}
                  {col.delivery && <Tooltip tapToOpen><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-success" /></TooltipTrigger><TooltipContent>Delivery point — work is done here</TooltipContent></Tooltip>}
                  {col.policy && <Tooltip tapToOpen><TooltipTrigger asChild><span className="cursor-help text-xs text-muted-foreground">ⓘ</span></TooltipTrigger><TooltipContent className="max-w-xs">{col.policy}</TooltipContent></Tooltip>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {wipOffenders.map(([id, n]) => (
                    // tapToOpen: a ringed avatar is the whole warning; who it is and why it is ringed is here.
                    <Tooltip key={id} tapToOpen>
                      <TooltipTrigger asChild>
                        <span className="rounded-full ring-2 ring-destructive"><PhotoAvatar employeeId={id} name={empName(`employees/${id}`)} className="h-5 w-5 text-[9px]" /></span>
                      </TooltipTrigger>
                      <TooltipContent>{empName(`employees/${id}`)}: {n} here — over the {col.wipLimit}-per-person limit</TooltipContent>
                    </Tooltip>
                  ))}
                  <Badge variant={overWip ? "destructive" : "secondary"} className={atWip && !overWip ? "border-warning text-warning" : ""} title={perAssignee && col.wipLimit != null ? `Max ${col.wipLimit} per assignee` : undefined}>
                    {count}{col.wipLimit != null ? (perAssignee ? ` (≤${col.wipLimit}/ea)` : ` / ${col.wipLimit}`) : ""}
                  </Badge>
                  <AccessAction collection="cards" create label="Add a task">
                    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={`Add a task to ${col.label}`} className="h-6 w-6 text-muted-foreground coarse:h-9 coarse:w-9" onClick={() => setQuick((k) => (k === col.key ? null : col.key))}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add task</TooltipContent></Tooltip>
                  </AccessAction>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={`Collapse ${col.label}`} className="h-6 w-6 text-muted-foreground coarse:h-9 coarse:w-9" onClick={() => toggleCollapse(col.key)}><ChevronLeft className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Collapse</TooltipContent></Tooltip>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                {quick === col.key && <QuickAddCard board={board} column={col.key} onClose={() => setQuick(null)} onCreated={reload} />}
                {visibleLanes.map((lane) => {
                  const items = cardsIn(col.key, lane.key);
                  const cellId = `${col.key}::${lane.key}`;
                  return (
                    <div
                      key={lane.key}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; pendingRank.current = null; setOverCell(hoverCell(col.key, lane.key)); setLineAt(null); }}
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCell((p) => (p === hoverCell(col.key, lane.key) ? null : p)); }}
                      onDrop={(e) => { e.preventDefault(); const r = pendingRank.current ?? undefined; pendingRank.current = null; setOverCell(null); setLineAt(null); void onDrop(col.key, lane.key, r); }}
                      className={`flex flex-1 flex-col gap-2 rounded-md p-1 transition-colors min-h-[44px] ${overCell === cellId ? "bg-primary/10 outline-dashed outline-1 outline-primary/40" : ""}`}
                    >
                      {board.swimlane_mode !== "none" && (
                        <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {lane.label}
                          {items.length > 0 && <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">{items.length}</span>}
                        </div>
                      )}
                      {items.map((c, idx) => (
                        <div
                          key={c.path}
                          className="relative"
                          onDragOver={(e) => {
                            e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
                            const target = hoverCell(col.key, lane.key);
                            // If the drop would land in a different lane than this card's (locked cross-column move),
                            // don't draw a between-cards insertion line — just highlight the true destination cell.
                            if (target !== cellId) { pendingRank.current = null; setLineAt(null); setOverCell(target); return; }
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const before = e.clientY - rect.top < rect.height / 2;
                            pendingRank.current = rankAt(items, before ? idx : idx + 1);
                            setLineAt(`${c.path}:${before ? "t" : "b"}`);
                            setOverCell(cellId);
                          }}
                        >
                          <span className={`pointer-events-none absolute inset-x-1 -top-1 z-10 h-0.5 rounded bg-primary ${lineAt === `${c.path}:t` ? "" : "hidden"}`} />
                          <CardTile card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => openCard(c)} />
                          <span className={`pointer-events-none absolute inset-x-1 -bottom-1 z-10 h-0.5 rounded bg-primary ${lineAt === `${c.path}:b` ? "" : "hidden"}`} />
                        </div>
                      ))}
                      {items.length === 0 && board.swimlane_mode !== "none" && <p className="px-1 text-[11px] text-muted-foreground/60">—</p>}
                      {items.length === 0 && board.swimlane_mode === "none" && quick !== col.key && (
                        <p className="m-auto py-6 text-center text-xs text-muted-foreground/50">No tasks — drag one here</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* `boardCards` and `meId` on the CREATE path too. Without the first, the duplicate-title warning and
          the WIP note - both written for the moment work is filed, and the second of which early-returns on an
          empty list - could never render on the one dialog they were for. Without the second, "Me" was missing
          from the Assignee row exactly where somebody files work they are about to pick up. */}
      {addTo && <CardDialog board={board} column={addTo} employees={employees} goals={goals} departments={departments} boardCards={cards} meId={me.employee_id} onClose={() => setAddTo(null)} onSaved={() => { setAddTo(null); reload(); }} />}
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} queue={screenQueue} meId={me.employee_id} onOpenCard={openCard} onClose={closeCard} onSaved={() => { closeCard(); reload(); }} />}
    </TooltipProvider>
  );
}

const STALE_AFTER_DAYS = 7; // aging signal: card untouched this long (and not delivered) gets a quiet dot

function CardTile({ card, assignee, catalog, goalName, blockerKey, deptLabel, menu, onDragStart, onClick }: { card: CardT; assignee: { id: string; name: string } | null; catalog: BoardLabel[]; goalName?: string; blockerKey?: string; deptLabel?: string; menu?: ReactNode; onDragStart: () => void; onClick: () => void }) {
  // Due chip: red when overdue, amber when due within 3 days, quiet otherwise. Hidden once delivered.
  //
  // DAYS, NOT INSTANTS. `due_date` is a date-only value, so `new Date(due_date)` is that day at UTC midnight,
  // and comparing it against the current instant asks "is it past the START of the due day" - true for all but
  // the first moments of the day itself. In IST a card due TODAY went red at 05:30 local, with a tooltip
  // reading "Overdue - was due <today>", and `dueSoon` could never fire for it either because the delta was
  // already negative. Goals asks the same question correctly (`g.due_date < todayStr()`), so the two surfaces
  // a person tracks their own work on disagreed about the same column.
  const dueYmd = card.due_date && !card.deliver_time ? card.due_date.slice(0, 10) : null;
  const due = dueYmd ? new Date(`${dueYmd}T00:00:00Z`) : null;
  const overdue = !!dueYmd && dueYmd < todayStr();
  const dueSoon = !!dueYmd && !overdue && daysBetweenYmd(todayStr(), dueYmd) <= 3;
  const ageDays = card.update_time ? Math.floor((Date.now() - new Date(card.update_time).getTime()) / 86400e3) : 0;
  const stale = ageDays >= STALE_AFTER_DAYS && !card.deliver_time;
  return (
    // Opening a card is the board's primary action and was pointer-only: the tile was a plain draggable div,
    // so a keyboard could not reach a single card on the board. `role="button"` + a tab stop + Enter/Space
    // gives it the same route the drag has always had a menu path for.
    //
    // THE MENU IS A SIBLING OF THAT BUTTON, NOT A CHILD. ARIA makes a button's children presentational
    // (WAI-ARIA 1.2 §5.2.7): their roles are dropped from the accessibility tree and their content is
    // flattened into the button's name. Nested, the tile's actions menu - the keyboard and touch path to move,
    // assign, block and delete a card, i.e. exactly what making the tile focusable was for - stopped being a
    // control at all. Lifting it one level out fixes that without changing a pixel or a pointer behaviour.
    <div className="group relative">
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={`Open ${card.title}`}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.path); onDragStart(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onClick={onClick}
      className="relative cursor-grab overflow-hidden rounded-lg border bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      {card.blocked && <span className="absolute inset-y-0 left-0 w-1 bg-destructive" aria-hidden />}
      {card.labels?.length ? <div className="mb-1.5 flex flex-wrap gap-1"><LabelChips keys={card.labels} catalog={catalog} max={3} /></div> : null}
      <p className="text-sm font-medium leading-snug">{card.title}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">{taskKey(card)}</span>
        {stale && <Tooltip><TooltipTrigger asChild><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" /></TooltipTrigger><TooltipContent>No activity for {ageDays} days</TooltipContent></Tooltip>}
        <Tooltip><TooltipTrigger asChild><span><PriorityIcon p={card.priority} /></span></TooltipTrigger><TooltipContent className="capitalize">{card.priority} priority</TooltipContent></Tooltip>
        {card.size != null && <span className="rounded bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{card.size}</span>}
        {(card.todo_total ?? 0) > 0 && <Tooltip><TooltipTrigger asChild><span className={cn("inline-flex items-center gap-0.5 rounded px-1.5 text-[10px] font-medium tabular-nums", card.todo_done === card.todo_total ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")}><ListChecks className="h-3 w-3" />{card.todo_done}/{card.todo_total}</span></TooltipTrigger><TooltipContent>Checklist: {card.todo_done}/{card.todo_total} done</TooltipContent></Tooltip>}
        {card.goal && <Tooltip><TooltipTrigger asChild><Target className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger><TooltipContent>{goalName ? `Goal: ${goalName}` : "Linked to a goal"}</TooltipContent></Tooltip>}
        {deptLabel && <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"><Building2 className="h-3 w-3" />{deptLabel}</span></TooltipTrigger><TooltipContent>Department: {deptLabel}</TooltipContent></Tooltip>}
        {card.blocked && (
          blockerKey
            ? <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-destructive"><Ban className="h-3 w-3" />{blockerKey}</span>
            : <Ban className="h-3.5 w-3.5 text-destructive" />
        )}
        {due && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("inline-flex items-center gap-0.5 text-[10px] font-medium", overdue ? "text-destructive" : dueSoon ? "text-warning" : "text-muted-foreground")}>
                {/* Rendered in UTC because that is the timezone the value is anchored at: a date-only day
                    formatted through the viewer's local clock names the PREVIOUS day west of UTC. */}
                <CalendarDays className="h-3 w-3" />{due.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{overdue ? "Overdue — was due" : "Due"} {due.toLocaleDateString(undefined, { timeZone: "UTC" })}</TooltipContent>
          </Tooltip>
        )}
        {card.description && <Tooltip><TooltipTrigger asChild><AlignLeft className="h-3 w-3 text-muted-foreground/70" /></TooltipTrigger><TooltipContent>Has a description</TooltipContent></Tooltip>}
        {(card.documents?.length ?? 0) > 0 && <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground"><FileText className="h-3 w-3" />{card.documents!.length}</span></TooltipTrigger><TooltipContent>{card.documents!.length} linked document{card.documents!.length === 1 ? "" : "s"}</TooltipContent></Tooltip>}
        <span className="ml-auto">
          {assignee ? (
            <Tooltip><TooltipTrigger asChild><span><PhotoAvatar employeeId={assignee.id} name={assignee.name} className="h-6 w-6 text-[10px]" /></span></TooltipTrigger><TooltipContent>{assignee.name}</TooltipContent></Tooltip>
          ) : (
            <span className="block h-6 w-6 rounded-full border border-dashed border-muted-foreground/40" title="Unassigned" />
          )}
        </span>
      </div>
    </div>
      {/* Outside the tile's own button, above it in the stack: its controls keep their roles (see the note
          above), and sitting in the wrapper rather than the tile is what lets them do that. */}
      <div className="absolute right-1 top-1 z-10 flex items-center">
        {menu}
        <AccessTarget target={{ collection: "cards", objectPath: card.path, can: card.access?.can, label: "Manage task access" }} />
      </div>
    </div>
  );
}

// "..." on every tile: the no-drag path for the common one-off actions (and the ONLY move path on touch, where
// HTML5 drag-and-drop does not fire). Entries are gated on the card's `access.can`; with nothing allowed the
// button doesn't render at all. Hidden until hover on fine pointers, always visible on coarse ones.
function CardActionsMenu({ card, meId, columns, sprintExtras, onMove, onAssignMe, onPriority }: {
  card: CardT;
  meId?: string | null;
  columns: BoardColumn[];
  sprintExtras?: ReactNode; // scrum-only entries (move to sprint / send to backlog), pre-gated by the caller
  onMove: (colKey: string) => void;
  onAssignMe: () => void;
  onPriority: (p: CardT["priority"]) => void;
}) {
  const can = card.access?.can ?? [];
  const canMove = can.includes("move");
  const canEdit = can.includes("update");
  const showAssignMe = canEdit && !!meId && (!card.assignee || idOf(card.assignee) !== meId);
  if (!canEdit && !(canMove && (columns.length > 0 || sprintExtras))) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Task actions"
          // The touch case is handled centrally now (index.css forces every `group-hover:opacity-100` control
          // visible on a coarse pointer), so this no longer needs its own media query.
          className="h-6 w-6 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {canMove && columns.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {columns.filter((c) => c.key !== card.column_key).map((c) => (
                <DropdownMenuItem key={c.key} onClick={() => onMove(c.key)}>{c.label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {canMove && sprintExtras}
        {showAssignMe && <DropdownMenuItem className="gap-2" onClick={onAssignMe}><UserRound className="h-4 w-4" /> Assign to me</DropdownMenuItem>}
        {canEdit && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {PRIORITIES.map((p) => (
                <DropdownMenuItem key={p} disabled={p === card.priority} onClick={() => onPriority(p)} className="gap-2 capitalize">
                  <PriorityIcon p={p} /> {p}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Trello-style inline composer: type a title, Enter adds the card right into the column (server defaults fill
// the rest); stays open so several cards can be added in a row. Esc or ✕ closes. The full dialog remains the
// path for anything richer (open the card after, or use "+ New → Create a task").
function QuickAddCard({ board, column, onClose, onCreated }: { board: Board; column: string; onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  async function add() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await create<CardT>("cards", { board: board.path, column_key: column, title: t });
      setTitle("");
      onCreated();
    } catch (e) {
      toast({ title: "Couldn't add", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border bg-card p-2 shadow-sm">
      <Textarea
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); }
          if (e.key === "Escape") onClose();
        }}
        rows={2}
        placeholder="What needs doing?"
        className="min-h-0 resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0"
      />
      <div className="mt-1.5 flex items-center gap-1">
        <Button size="sm" className="h-7" onClick={add} loading={busy} disabled={!title.trim()}>Add</Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        <span className="ml-auto text-[10px] text-muted-foreground">Enter to add</span>
      </div>
    </div>
  );
}

// ---- Create / edit a card -----------------------------------------------------------------------------------

function CardDialog({ board, card, column, employees, goals, departments, boardCards = [], queue: queueIn, onOpenCard, meId, onClose, onSaved }: {
  board: Board;
  card?: CardT;
  column?: string;
  employees: Employee[];
  goals: Goal[];
  departments: Department[];
  /** Every task on this board: what the duplicate guard, the WIP note and the blocker pickers ask about. */
  boardCards?: CardT[];
  /** The tasks ON SCREEN, in the order the view draws them - what ‹ › and j/k walk. Distinct from
   *  `boardCards` on purpose: a filtered board draws a handful of a hundred, and stepping has to follow the
   *  handful. Falls back to the whole board for a view that has no order of its own to hand over. */
  queue?: CardT[];
  onOpenCard?: (c: CardT) => void;
  /** The caller, for "assign to me". */
  meId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const editing = !!card;
  // Named off the employee list the dialog already holds for its pickers - no read for one line of text.
  const reporterName = useMemo(() => {
    const id = card?.reporter ? idOf(card.reporter) : "";
    const e = id ? employees.find((x) => idOf(x.path) === id) : undefined;
    return e ? `${e.first_name} ${e.last_name}` : "Someone";
  }, [card?.reporter, employees]);
  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [priority, setPriority] = useState<CardT["priority"]>(card?.priority ?? "medium");
  const [assignee, setAssignee] = useState(card?.assignee ? idOf(card.assignee) : "");
  // New card: "" -> defer to the org default. Existing card: its dept, or NO_DEPT if it explicitly has none.
  const [department, setDepartment] = useState(card ? (card.department ? idOf(card.department) : NO_DEPT) : "");
  const [goal, setGoal] = useState(card?.goal ? idOf(card.goal) : "");
  const [swimlane, setSwimlane] = useState(card?.swimlane_key ?? "");
  const [size, setSize] = useState(card?.size != null ? String(card.size) : "");
  const [due, setDue] = useState(card?.due_date ?? "");
  // Repeating work. "" is a one-off, which is what a card is unless somebody says otherwise.
  const [cadence, setCadence] = useState<string>(card?.cadence ?? "");
  // Both arrive on the item Get, so they start unknown rather than at zero: "nobody is watching" and "this
  // answer did not carry it" are different statements.
  const [follow, setFollow] = useState<{ watching: boolean; count: number }>({ watching: false, count: 0 });
  const [hours, setHours] = useState<number | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [blockedBy, setBlockedBy] = useState(card?.blocked_by ? idOf(card.blocked_by) : "");
  // The block/unblock verbs' own view of the card: `card` is the snapshot `useOpenCard` took when the dialog
  // opened and never resyncs, so - same reason `curColumn` exists for `move` below - acting on it has to
  // update the picture here, not read the stale prop back.
  const [blockedView, setBlockedView] = useState({ blocked: card?.blocked ?? false, blockedBy: card?.blocked_by, reason: card?.block_reason });
  const [busy, setBusy] = useState(false);
  // Concurrency token, kept fresh: checklist/comment verbs touch the card's update_time, bumping its etag, so the
  // held prop etag goes stale mid-dialog. Refresh from every response that returns the full card, or save 409s.
  const [etag, setEtag] = useState(card?.etag);
  const [comments, setComments] = useState<CardComment[]>(card?.comments ?? []);
  const [commentText, setCommentText] = useState("");
  const [todos, setTodos] = useState<CardTodo[]>(card?.todos ?? []);
  const [newTodo, setNewTodo] = useState("");
  const [initialTodos, setInitialTodos] = useState<string[]>([]); // staged checklist for a NEW card (no id yet)
  // Keyed by row identity, not position: these rows are removable in place, and an index key hands the removed
  // row's DOM node (its hover state, its focus) to whichever row slides up into that slot.
  const initialTodoKeys = useRowKeys(initialTodos);
  // Predefined checklist templates (shared catalog); the picker only shows those the caller can read.
  const { rows: checklists } = useCollection<TicketChecklist>("ticket-checklists", { all: true });
  const [labels, setLabels] = useState<string[]>(card?.labels ?? []);
  // Linked documents: org-document ids (link-only). Fetched lazily - the list loads only while a dialog is
  // open, and only for callers who can read org-documents at all (useCollection's capability gate).
  const [docs, setDocs] = useState<string[]>((card?.documents ?? []).map((p) => idOf(p)));
  const { rows: orgDocs } = useCollection<Wire<"org-document">>("org-documents");
  const docTitle = useMemo(() => {
    const m = new Map(orgDocs.map((d) => [idOf(d.path), d.display_name || d.file_name || "Document"]));
    return (id: string) => m.get(id) ?? "Document";
  }, [orgDocs]);
  const [curColumn, setCurColumn] = useState(card?.column_key ?? column ?? board.columns[0]?.key ?? "");
  // The server's version of this card after a lost save race, so the reader can see what they are about to
  // overwrite instead of guessing.
  const [conflict, setConflict] = useState<CardT | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null); // id of the checklist item being turned into its own task
  const canEdit = !editing || (card!.access?.can ?? []).includes("update");
  const descRef = useRef<HTMLTextAreaElement>(null); // the formatting bar edits this textarea's source
  // A task's description is read far more often than it is rewritten, so an editor opens it RENDERED and steps
  // into the source only when they mean to change it - the markup ("**blocked** on ~~QA~~") is for writing, not
  // for reading. A task with no description yet has nothing to read, so that one opens in the editor.
  const [descEdit, setDescEdit] = useState(!(card?.description ?? "").trim());
  // Switching INTO the editor puts the caret at the end of the text, so the switch lands where writing
  // continues. Only on a switch: on a new task the dialog opens in the editor already, and focus there belongs
  // to the title (the field that has to be filled in), not to the description.
  const descSwitched = useRef(false);
  useEffect(() => {
    if (!descEdit || !descSwitched.current) return;
    const el = descRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [descEdit]);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ value: commentText, onChange: setCommentText, textareaRef: commentRef, employees });

  // The saved-on-Save half of the dialog, as one value: what the discard guard compares and what a new task's
  // draft stashes. Deliberately excludes the checklist, comments, status and block state - those are verbs that
  // already took effect, so counting them as unsaved edits would prompt to "discard" work that is on the server.
  const form = useMemo(
    () => ({ title, description, priority, assignee, department, goal, swimlane, size, due, labels, docs, initialTodos }),
    [title, description, priority, assignee, department, goal, swimlane, size, due, labels, docs, initialTodos],
  );
  function applyForm(f: typeof form) {
    setTitle(f.title); setDescription(f.description); setPriority(f.priority); setAssignee(f.assignee);
    setDepartment(f.department); setGoal(f.goal); setSwimlane(f.swimlane); setSize(f.size); setDue(f.due);
    setLabels(f.labels ?? []); setDocs(f.docs ?? []); setInitialTodos(f.initialTodos ?? []);
  }
  const blank = { title: "", description: "", priority: "medium" as CardT["priority"], assignee: "", department: "", goal: "", swimlane: "", size: "", due: "", labels: [], docs: [], initialTodos: [] };

  // Unsaved field edits, against the values this dialog opened with. Only used to gate walking to the next
  // task: the dialog is remounted per card, so a step sideways would take the edits with it.
  const opened = useRef(JSON.stringify(form));
  const dirty = JSON.stringify(form) !== opened.current;

  // Triage without closing. The queue is whatever the view handed over - already filtered and in the order it
  // draws - so "next" here means the next task on screen, not the next row in some other ordering.
  const queue = useMemo(() => (queueIn ?? boardCards).filter((c) => !c.delete_time), [queueIn, boardCards]);
  const qIndex = card ? queue.findIndex((c) => idOf(c.path) === idOf(card.path)) : -1;
  const step = (delta: number) => {
    const next = queue[qIndex + delta];
    if (next && onOpenCard) onOpenCard(next);
  };
  const canStep = (delta: number) => !!onOpenCard && qIndex >= 0 && !!queue[qIndex + delta] && !dirty;

  // j / k walk the queue, the way every issue tracker does. Ignored while a field has focus, so typing "j" in
  // a title stays a letter.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Deliberately re-bound each render: the handler closes over the queue position and the dirty flag, and a
    // stale copy of either would step to the wrong task or step away from unsaved edits.
  });

  function copyLink() {
    if (!card) return;
    navigator.clipboard.writeText(recordUrl("boards", idOf(card.path))).then(
      () => toast({ title: "Link copied", description: `Anyone who can see ${taskKey(card)} can open it.` }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  const colLabel = (key?: string) => board.columns.find((c) => c.key === key)?.label ?? key ?? "the first column";

  // What the other party actually changed, named in the reader's words. Compared against the version this
  // dialog opened with, not against the form - "you both edited the title" is the useful sentence.
  const conflictFields = useMemo(() => {
    if (!conflict || !card) return [];
    const pairs: [string, unknown, unknown][] = [
      ["the title", conflict.title, card.title],
      ["the description", conflict.description ?? "", card.description ?? ""],
      ["the status", conflict.column_key, card.column_key],
      ["the assignee", conflict.assignee ?? "", card.assignee ?? ""],
      ["the priority", conflict.priority, card.priority],
      ["the due date", conflict.due_date ?? "", card.due_date ?? ""],
      ["the points", conflict.size ?? "", card.size ?? ""],
      ["the labels", (conflict.labels ?? []).join(","), (card.labels ?? []).join(",")],
    ];
    return pairs.filter(([, next, prev]) => next !== prev).map(([label]) => label);
  }, [conflict, card]);

  // Duplicate guard: the same title already on this board. A warning, never a block - two tasks can legitimately
  // share a name, but far more often it means somebody is filing work that already exists.
  const dupCard = useMemo(() => {
    const t = title.trim().toLowerCase();
    if (t.length < 3) return null;
    const selfId = card ? idOf(card.path) : "";
    return boardCards.find((c) => !c.delete_time && idOf(c.path) !== selfId && (c.title ?? "").trim().toLowerCase() === t) ?? null;
  }, [boardCards, title, card]);

  // WIP consequence, shown before the column fills rather than after: what this task's column already holds
  // against the limit configured for it (column-wide or per assignee).
  const wipNote = useMemo(() => {
    if (!boardCards.length) return null;
    const col = board.columns.find((c) => c.key === curColumn);
    if (!col || col.wipLimit == null) return null;
    const selfId = card ? idOf(card.path) : "";
    const inCol = boardCards.filter((c) => !c.delete_time && c.column_key === curColumn && idOf(c.path) !== selfId);
    if (col.limitScope === "assignee") {
      if (!assignee) return null;
      const held = inCol.filter((c) => c.assignee && idOf(c.assignee) === assignee).length;
      return held + 1 > col.wipLimit ? `${col.label} already holds ${held} of this assignee's tasks - the limit is ${col.wipLimit} each.` : null;
    }
    return inCol.length + 1 > col.wipLimit ? `${col.label} already holds ${inCol.length} tasks - its WIP limit is ${col.wipLimit}.` : null;
  }, [boardCards, board.columns, curColumn, assignee, card]);

  // Comments arrive only on the item Get (not the list), so load them when opening an existing card.
  useEffect(() => {
    if (!editing) return;
    let live = true;
    get<CardT>(`cards/${idOf(card!.path)}`)
      .then((c) => {
        if (!live) return;
        setComments(c.comments ?? []);
        setTodos(c.todos ?? []);
        // Watchers and booked hours ride the item Get for the same reason the comments do: neither belongs on
        // a board tile, and neither is worth a read per card on a list.
        setFollow({ watching: !!c.watching, count: c.watcher_count ?? 0 });
        setHours(c.logged_hours ?? null);
        setEtag(c.etag);
      })
      .catch(() => { /* keep what we have */ });
    return () => { live = false; };
  }, [editing, card]);

  // Follow this task without being the one doing it: column moves, comments and blocks in both directions.
  async function toggleWatch() {
    setBusy(true);
    try {
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, follow.watching ? "unwatch" : "watch");
      setFollow({ watching: !!res.watching, count: res.watcher_count ?? 0 });
      setEtag(res.etag);
    } catch (e) {
      toast({ title: "Couldn't change that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // Checklist mutation: invoke a todo verb, refresh the list from the response.
  async function todoAct(verb: "addTodos" | "toggleTodo" | "removeTodo" | "promoteTodo", body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, verb, undefined, body);
      setTodos(res.todos ?? []);
      setEtag(res.etag);
    } catch (e) {
      toast({ title: "Couldn't update the checklist", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  const todoDone = todos.filter((t) => t.done).length;

  // The checklist item that turned out to be real work. One server call does the whole swap - files the card
  // on THIS board with this task's assignee, department and sprint, and ticks the item - so the board and the
  // checklist can never end up both claiming the same outstanding work.
  async function promoteTodo(todo: { id: string; text: string }) {
    const ok = await confirm({
      title: "Make this its own task?",
      description: `“${todo.text}” is filed on ${board.name}, in ${board.columns[0]?.label ?? "the first column"}, keeping this task's assignee. The checklist item is ticked and points at the new task.`,
      confirmLabel: "Make it a task",
    });
    if (!ok) return;
    setPromoting(todo.id);
    try {
      // No `onSaved`: promoting is something you do while looking at the task, and its close+reload would kick
      // the editor out from under whoever just pressed it (the note on `act` below). `invoke` invalidates the
      // cards cache, so the board behind the dialog already shows the new task.
      await todoAct("promoteTodo", { todo: todo.id });
      toast({ title: "Made it its own task", description: `Filed on ${board.name}. The checklist item now points at it.`, variant: "success" });
    } finally {
      setPromoting(null);
    }
  }

  const commenterName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (cm: CardComment) => (cm.author ? m.get(idOf(cm.author)) ?? "Someone" : cm.author_email ?? "Someone");
  }, [employees]);

  async function addComment() {
    if (!commentText.trim()) return;
    setBusy(true);
    try {
      // The box holds display text; mentions go back to their stored form on the way out (lib/mentionText.ts).
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, "comment", undefined, { body: mentions.toWire(commentText.trim()) });
      setComments(res.comments ?? []);
      setEtag(res.etag);
      setCommentText("");
    } catch (e) {
      toast({ title: "Couldn't comment", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const empOptions = employees.map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}` }));
  const goalOptions = goals.map((g) => ({ value: idOf(g.path), label: g.title }));
  // NO_DEPT = explicitly "no department" (sends null); "" = leave to the org default (omit the key on create).
  const deptOptions = [{ value: NO_DEPT, label: "No department" }, ...departments.map((d) => ({ value: idOf(d.path), label: d.display_name }))];

  // Throws to fail: WriteDialog owns the busy state and pins the message inside the form.
  async function save() {
    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      priority,
      assignee: assignee ? `employees/${assignee}` : "",
      goal: goal ? `goals/${goal}` : "",
      labels,
      documents: docs.map((id) => `org-documents/${id}`),
      size: size ? Number(size) : null,
      cadence: cadence || null,
      // `format: date`, and "" is not a date - an undated card leaves it out.
      ...(due ? { due_date: due } : {}),
      ...(board.swimlane_mode === "custom" ? { swimlane_key: swimlane } : {}),
    };
    // "" = untouched new card -> omit so the server applies the org default. Otherwise send the choice, and
    // send a CLEARED reference as "" rather than null: the contract types it as a string (see api.ts, "No
    // nulls on the wire"), so a null is refused by the proxy with a 422 the worker never sees.
    if (department !== "") body.department = department === NO_DEPT ? "" : `departments/${department}`;
    try {
      if (editing) {
        const saved = await patch<CardT>(`cards/${idOf(card!.path)}`, body, etag);
        // Same reason as act(): a second Save from a dialog left open would otherwise send the etag from
        // before the first one.
        setEtag(saved.etag);
        setConflict(null); // the save went through; whatever the banner was showing is now the past
      } else {
        await create<CardT>("cards", { board: board.path, column_key: column, ...body, ...(initialTodos.length ? { initial_todos: initialTodos } : {}) });
      }
    } catch (e) {
      // Lost race: somebody saved this task while it was open here. Take their version's etag so the next
      // press goes through, and say what happened - the raw "etag mismatch" told nobody anything, and the
      // edits in the form are still worth keeping.
      if (isConflict(e) && editing) {
        const fresh = await get<CardT>(`cards/${idOf(card!.path)}`).catch(() => null);
        if (fresh) { setEtag(fresh.etag); setConflict(fresh); }
        throw new Error("Somebody else changed this task while you had it open. What they changed is listed below - press Save again to overwrite it.");
      }
      throw e;
    }
    toast({ title: editing ? "Task saved" : "Task added", variant: "success" });
  }

  // Only block/unblock reach here. Neither closes the dialog: blocking a task is something you do WHILE
  // looking at it, same as checking off a todo, and `onSaved`'s close+reload silently kicked the editor out
  // from under whoever just clicked Block - reproduced as `cardBlocking.spec.ts` losing the dialog before it
  // could read "Blocked" back. `invoke` already invalidates the cards cache (see `moveStatus` below) so the
  // board and every OTHER open card see the change; this one updates `blockedView` directly since its own
  // `card` prop is the snapshot `useOpenCard` took on open and never refreshes.
  async function act(verb: "block" | "unblock", body?: Record<string, unknown>) {
    setBusy(true);
    try {
      // Take the etag the write just produced. Every verb here bumps the card's updated_at, which IS the etag,
      // so dropping the response left this dialog holding a stale one - and the next Save reported a conflict
      // with "somebody else" who was in fact the same person, one click earlier. todoAct and addComment
      // already did this; act and submit did not.
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, verb, etag, body);
      setEtag(res.etag);
      setBlockedView({ blocked: res.blocked, blockedBy: res.blocked_by, reason: res.block_reason });
      // Either verb clears the staged picker: after Block it has been applied and there is nothing left to
      // stage; after Unblock the OLD selection would otherwise sit behind the reopened picker, so the trigger
      // reads back the last task blocked-by rather than its "Blocked by a task…" placeholder.
      setBlockedBy("");
      setBlockReason("");
      toast({ title: "Done", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    const ok = await confirm({ title: `Delete ${taskKey(card!)}?`, description: `"${card!.title}" and its comments are removed from view (soft delete). Restorable by an admin.`, destructive: true, confirmLabel: "Delete task" });
    if (!ok) return;
    setBusy(true);
    try { await remove(`cards/${idOf(card!.path)}`, etag); toast({ title: "Task deleted" }); onSaved(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

  // Change status (column) via the move verb without closing; invoke() invalidates the cards cache so the board
  // updates live behind the dialog. Applied on pick, so it comes with an undo: a mis-tapped status is one
  // wrong list away, and hunting the board for the task you just moved is worse than the mistake.
  async function moveStatus(toCol: string, undoing = false) {
    const from = curColumn;
    setBusy(true);
    try {
      // The etag goes OUT and the new one comes back, the rule `act` above states and every sibling write in
      // this dialog follows. Without it this move was unguarded in both directions: it silently overwrote a
      // concurrent move that a drag on the board (which does pass `card.etag`) would have refused, and it
      // left this dialog holding a pre-move etag - so the next Save reported a conflict with "somebody else"
      // who was in fact the same person, seconds earlier, with a diff banner showing their own change.
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, "move", etag, { to_column: toCol });
      setEtag(res.etag);
      setCurColumn(toCol);
      toast({
        title: undoing ? `Back in ${colLabel(toCol)}` : `Moved to ${colLabel(toCol)}`,
        ...(undoing || !from ? {} : { action: { label: "Undo", onClick: () => void moveStatus(from, true) }, duration: 8000 }),
      });
    } catch (e) {
      // A genuine lost race says so, and hands over the version that won, rather than moving the card anyway
      // or leaving the reader to decode "etag mismatch". Same recovery the Save path already has.
      if (isConflict(e)) {
        const fresh = await get<CardT>(`cards/${idOf(card!.path)}`).catch(() => null);
        if (fresh) { setEtag(fresh.etag); setConflict(fresh); if (fresh.column_key) setCurColumn(fresh.column_key); }
        toast({ title: "Somebody else moved this task", description: "It is now shown where they put it - move it again if you still want to.", variant: "destructive" });
        return;
      }
      toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const can = card?.access?.can ?? [];
  // Ticking a checklist item is its own verb; the boxes still RENDER without it (see the checklist below), so
  // this is the one place a permission legitimately reaches a `disabled`.
  const canTickTodos = can.includes("toggleTodo");
  return (
    <>
    <WriteDialog
      open
      onClose={onClose}
      className="max-w-2xl lg:max-w-3xl"
      title={
        <span className="flex items-center gap-2 pr-8">
          {/* The key is the thing people quote to each other, so it is also the copy-link button. */}
          {editing && (
            <button type="button" onClick={copyLink} title="Copy a link to this task" className="inline-flex items-center gap-1 rounded font-mono text-xs text-muted-foreground transition-colors hover:text-foreground">
              {taskKey(card!)} <Link2 className="h-3 w-3" />
            </button>
          )}
          <span>{editing ? "Task" : "New task"}</span>
          {/* Walk the queue the view handed over, so a triage pass is one dialog instead of twelve. */}
          {editing && queue.length > 1 && qIndex >= 0 && (
            <span className="ml-auto flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous task" title={dirty ? "Save or discard your changes first" : "Previous task (k)"}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{qIndex + 1}/{queue.length}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next task" title={dirty ? "Save or discard your changes first" : "Next task (j)"}><ChevronRight className="h-4 w-4" /></Button>
            </span>
          )}
        </span>
      }
      /* The dialog mixes two clocks: the verbs below (status, checklist, comments, block) hit the server as they
         are used, while the fields save together. Saying so is the difference between "did that stick?" and not. */
      description={editing
        ? "Status, checklist, comments and blockers apply as you use them. The fields save together."
        : `Lands in ${colLabel(column)} on ${board.name}. Whoever you assign gets a notification.`}
      collection="cards"
      objectPath={card?.path}
      guardLabel="task"
      form={form}
      draftKey={editing ? undefined : `card:${idOf(board.path)}:${column ?? ""}`}
      applyDraft={applyForm}
      onStartOver={editing ? undefined : () => applyForm(blank)}
      submitLabel={editing ? "Save changes" : "Add task"}
      canSubmit={!!title.trim() && canEdit}
      whyNot={!canEdit ? "You don't have access to change this task." : "Give the task a title."}
      onSubmit={save}
      onSaved={onSaved}
      cancelLabel={editing ? "Close" : "Cancel"}
      submitAccess={(b) => (editing ? <AccessAction label="Edit task" can={can}>{b}</AccessAction> : <AccessAction create label="Create a task">{b}</AccessAction>)}
      footerStart={editing ? (
        <AccessAction label="Delete task" verb="delete" can={can}>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={del} loading={busy}><Trash2 className="h-4 w-4" /> Delete</Button>
        </AccessAction>
      ) : undefined}
    >
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" disabled={!canEdit} autoFocus={!editing} />
        </Field>
        {dupCard && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{taskKey(dupCard)} on this board already has this title, in {colLabel(dupCard.column_key)}. Add it anyway if it really is separate work.</span>
          </p>
        )}
        {conflict && conflictFields.length > 0 && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Somebody else changed {conflictFields.join(", ")} since you opened this. Save again to overwrite their version, or close without saving to keep it.</span>
          </p>
        )}
        {/* Markdown-lite source in a plain textarea (same contract as board posts): the bar transforms the
            text, storage is exactly what's shown, and richToPlain-free rendering via <RichText>. Nobody is shown
            markup they didn't ask for: a reader who can't edit gets the rendered description rather than a
            disabled box of it, and an editor gets the same rendering until they switch into the editor. */}
        <Field
          label="Description"
          /* The view switch rides the label row, where it reads as part of the field's heading and doesn't push
             the fields below it down. Editors only: a reader who can't edit has nothing to switch to. */
          action={canEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => { descSwitched.current = true; setDescEdit((v) => !v); }}
            >
              {descEdit ? <><Eye className="h-3.5 w-3.5" /> Preview</> : <><Pencil className="h-3.5 w-3.5" /> Edit</>}
            </Button>
          ) : undefined}
        >
          {canEdit ? (
            descEdit ? (
              <div>
                {/* Above the toolbar, not inside it: the toolbar edits the SOURCE in place (bold, strike)
                    while this replaces the whole field, and they should not read as the same kind of act.
                    Only while editing - the rendered view is for reading, and a card with a description
                    already written offers "Improve" here rather than a second way to overwrite it. */}
                <div className="mb-2 flex justify-end">
                  <DraftButton
                    collection="cards"
                    kind="task"
                    existing={description}
                    hint="e.g. the export button times out on big date ranges, needs to stream instead"
                    onDraft={setDescription}
                  />
                </div>
                <RichTextToolbar textareaRef={descRef} value={description} onChange={setDescription} />
                <Textarea ref={descRef} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="rounded-t-none" />
              </div>
            ) : (
              /* The rendered description doubles as the way into the editor: clicking the words you want to
                 change is what a reader reaches for before hunting for a control. Keyboard reaches it the same
                 way, and the Edit control in the label row says so for anyone who doesn't guess. */
              <div
                role="button"
                tabIndex={0}
                title="Click to edit"
                onClick={() => { descSwitched.current = true; setDescEdit(true); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); descSwitched.current = true; setDescEdit(true); } }}
                className="min-h-[5.5rem] cursor-text rounded-md border bg-background px-3 py-2 text-left transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {description.trim()
                  ? <RichText source={description} className="space-y-1.5 text-sm" />
                  : <span className="text-sm text-muted-foreground">No description yet.</span>}
              </div>
            )
          ) : description ? (
            <RichText source={description} className="space-y-1.5 text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </Field>
        {/* Following, and what the task has cost so far. Both are about a saved task, so neither appears while
            one is being written. */}
        {editing && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5">
            <AccessAction verb={follow.watching ? "unwatch" : "watch"} can={can} label="Follow this task">
              <Button variant={follow.watching ? "secondary" : "outline"} size="sm" className="h-7 text-xs" disabled={busy} onClick={toggleWatch}>
                <Eye className="h-3.5 w-3.5" /> {follow.watching ? "Watching" : "Watch"}
              </Button>
            </AccessAction>
            <span className="text-xs text-muted-foreground">
              {follow.count > 0
                ? `${follow.count} ${follow.count === 1 ? "person is" : "people are"} following moves, comments and blocks`
                : "Nobody is following this yet"}
            </span>
            {/* Approved timesheet hours booked against this task. Absent when none are - which is not zero. */}
            {hours != null && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title="Approved timesheet hours booked against this task">
                <History className="h-3.5 w-3.5" /> {hours}h logged
              </span>
            )}
          </div>
        )}
        {/* Who filed it, and when. A sentence rather than a field: it is not editable, and putting it in the
            grid among the pickers would suggest it is. Only shown where it says something the other people on
            the card do not - filing your own task is the assignee line already. */}
        {editing && card!.reporter && idOf(card!.reporter) !== idOf(card!.assignee ?? "") && (
          <p className="text-xs text-muted-foreground">
            Reported by <span className="font-medium text-foreground">{reporterName}</span>
            {card!.create_time ? ` · ${new Date(card!.create_time).toLocaleDateString()}` : ""}
          </p>
        )}
        {/* Two-column field grid from `sm` up, one column on a phone - a pair of comboboxes side by side on a
            390px screen leaves neither readable. When an odd number of fields is visible (Status is edit-only;
            Labels/Swimlane are board-conditional), the lone trailing field spans both columns so no half-width
            orphan is left. */}
        <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 sm:[&>*:last-child:nth-child(odd)]:col-span-2">
          {/* Workflow + owner */}
          {editing && (
            <Field label="Status">
              {/* Which column the task sits in is a fact worth reading even for someone who cannot move it, so
                  this one keeps its icon and its disabled state instead of disappearing. */}
              <AccessAction verb="move" can={can} manageOnly label="Who can move tasks">
                <Select value={curColumn} onValueChange={moveStatus} disabled={busy || !(card!.access?.can ?? []).includes("move")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{board.columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </AccessAction>
            </Field>
          )}
          {/* Every field below is disabled for a reader without `update`: Title, Due and Points already were,
              so the rest looked editable right up to a Save they could never press. */}
          <Field label="Assignee">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1"><Combobox value={assignee} onValueChange={setAssignee} options={empOptions} placeholder="Unassigned" disabled={!canEdit} /></div>
              {/* One tap for the overwhelmingly common case, which the board tile menu already had and the
                  dialog - where people actually are when they decide to pick it up - did not. */}
              {canEdit && meId && assignee !== meId && (
                <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 px-2 text-xs" onClick={() => setAssignee(meId)} title="Assign this task to me">
                  <UserRound className="h-3.5 w-3.5" /> Me
                </Button>
              )}
            </div>
          </Field>
          <Field label="Department">
            <Combobox value={department} onValueChange={setDepartment} options={deptOptions} placeholder="Org default department" disabled={!canEdit} />
          </Field>
          {/* Only on an existing card: the suggestion comes from this card's own place in the index, and a
              card being created is not in it yet. Filing help for a NEW card would have to embed the text on
              the fly, which is a neuron per keystroke-pause and a different feature. */}
          {editing && card && (
            <div className="sm:col-span-2">
              <CardTriageCard
                cardId={idOf(card.path)}
                can={card.access?.can}
                onUsePriority={(p: string) => setPriority(p as CardT["priority"])}
                // Null: this dialog cannot step sideways. It is remounted per card and guards unsaved edits
                // (`dirty`), so following a neighbour from here would either lose what somebody typed or
                // prompt them mid-suggestion. Neighbour titles render as text, which is enough to recognise
                // the duplicate and go and find it.
                onOpenCard={null}
              />
            </div>
          )}
          {/* Urgency + deadline */}
          <Field label="Priority">
            <Select value={priority} onValueChange={(v) => setPriority(v as CardT["priority"])} disabled={!canEdit}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {/* Date and size both get one-tap answers: on a phone, a date picker and a number spinner are the
              two slowest controls in the dialog, and the values people pick are almost always these. */}
          <Field label="Due date">
            <div className="space-y-1.5">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={!canEdit} />
              {canEdit && (
                <div className="flex flex-wrap gap-1">
                  {DUE_PRESETS.map((p) => (
                    <Chip key={p.label} active={due === p.value()} onClick={() => setDue(p.value())}>{p.label}</Chip>
                  ))}
                  {due && <Chip onClick={() => setDue("")}>Clear</Chip>}
                </div>
              )}
            </div>
          </Field>
          {/* Repeating work: the chore that comes back. Files the NEXT one when this is delivered, so a task
              running late is chased rather than duplicated on top of itself. */}
          <Field label="Repeats" info="Delivering this task files the next one, due a cadence later, with the same checklist. The linked goal and sprint are not carried over.">
            <Select value={cadence || NO_CADENCE} onValueChange={(v) => setCadence(v === NO_CADENCE ? "" : v)} disabled={!canEdit}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CADENCE}>Doesn't repeat</SelectItem>
                {CADENCES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {/* Estimate + tags */}
          <Field label="Points" info={board.mode === "scrum" ? "Story points. What the sprint burndown and the velocity chart are measured in." : "Rough size, for the analytics tab. Not a schedule."}>
            <div className="space-y-1.5">
              <Input type="number" min="0" value={size} onChange={(e) => setSize(e.target.value)} disabled={!canEdit} />
              {canEdit && (
                <div className="flex flex-wrap gap-1">
                  {POINT_PRESETS.map((p) => (
                    <Chip key={p} active={size === String(p)} onClick={() => setSize(String(p))}>{p}</Chip>
                  ))}
                  {size && <Chip onClick={() => setSize("")}>Clear</Chip>}
                </div>
              )}
            </div>
          </Field>
          {board.labels.length > 0 && (
            <Field label="Labels">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 w-full justify-start font-normal" disabled={!canEdit}>
                    {labels.length ? <span className="flex flex-wrap gap-1"><LabelChips keys={labels} catalog={board.labels} max={4} /></span> : <span className="text-muted-foreground">None</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1">
                  {board.labels.map((l) => (
                    <button key={l.key} type="button" onClick={() => setLabels((s) => (s.includes(l.key) ? s.filter((x) => x !== l.key) : [...s, l.key]))} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                      <Checkbox checked={labels.includes(l.key)} className="pointer-events-none" />
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color ?? "#64748b" }} /> {l.label}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </Field>
          )}
          {/* Linkage */}
          <Field label="Linked goal">
            <Combobox value={goal} onValueChange={setGoal} options={goalOptions} placeholder="No goal" disabled={!canEdit} />
          </Field>
          {board.swimlane_mode === "custom" && (
            <Field label="Swimlane">
              <Select value={swimlane || NONE} onValueChange={(v) => setSwimlane(v === NONE ? "" : v)} disabled={!canEdit}>
                <SelectTrigger><SelectValue placeholder={board.no_lane_label || "Ungrouped"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{board.no_lane_label || "Ungrouped"}</SelectItem>
                  {board.swimlanes.map((l) => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>

        {wipNote && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{wipNote} Finishing something there beats starting this.</span>
          </p>
        )}

        {/* Linked documents: references into the org library (specs, policies) - the card owns no files.
            Saved with the card (part of the PATCH/create body), like every other field. */}
        {(docs.length > 0 || (canEdit && orgDocs.length > 0)) && (
          <div className="space-y-2 border-t pt-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <FileText className="h-4 w-4" /> Linked documents
              {docs.length > 0 && <span className="text-xs font-normal text-muted-foreground">{docs.length}</span>}
            </p>
            {docs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {docs.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 py-1 pl-2 pr-1 text-sm">
                    <a href={`/${resourceRoute("org-documents", `org-documents/${id}`) ?? "documents"}`} className="inline-flex items-center gap-1 hover:underline">
                      {docTitle(id)} <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                    {canEdit && (
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setDocs((s) => s.filter((x) => x !== id))} aria-label="Unlink">
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {canEdit && (
              <Combobox
                value=""
                onValueChange={(v) => { if (v) setDocs((s) => (s.includes(v) ? s : [...s, v])); }}
                options={orgDocs.filter((d) => !docs.includes(idOf(d.path))).map((d) => ({ value: idOf(d.path), label: d.display_name || d.file_name || "Document" }))}
                placeholder="Link a document…"
              />
            )}
          </div>
        )}

        {editing && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ListChecks className="h-4 w-4" /> Checklist
                {todos.length > 0 && <span className="text-xs font-normal text-muted-foreground">{todoDone}/{todos.length} done</span>}
              </p>
              {can.includes("addTodos") && checklists.length > 0 && (
                <Select value="" disabled={busy} onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl?.items?.length) void todoAct("addTodos", { texts: cl.items }); }}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Apply template…" /></SelectTrigger>
                  <SelectContent>{checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </div>
            {todos.length > 0 && (
              <div className="space-y-1.5">
                {todos.map((t) => (
                  <div key={t.id} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                    {/* Read-only for a reader who cannot tick: the box is the item's STATE, so it stays on
                        screen showing what is done rather than vanishing with the ability to change it. */}
                    <Checkbox checked={t.done} disabled={busy || !canTickTodos} onCheckedChange={(v) => todoAct("toggleTodo", { todo: t.id, done: !!v })} />
                    <span className={cn("flex-1", t.done && "text-muted-foreground line-through")}>{t.text}</span>
                    {!t.done && (
                      <AccessAction verb="promoteTodo" can={can} label="Make this its own task">
                        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" loading={promoting === t.id} disabled={busy} onClick={() => promoteTodo(t)} aria-label="Make this its own task" title="Too big for a tick-box: make it its own task">
                          <SquareKanban className="h-3.5 w-3.5" />
                        </Button>
                      </AccessAction>
                    )}
                    {can.includes("removeTodo") && <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" disabled={busy} onClick={() => todoAct("removeTodo", { todo: t.id })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </div>
                ))}
              </div>
            )}
            {can.includes("addTodos") && (
              <div className="flex items-center gap-2">
                {/* Enter always stops here: unswallowed it reaches the dialog's Enter-submits handler and saves
                    the whole task while the reader is still building its checklist. */}
                <Input className="h-8" placeholder="Add a checklist item…" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => { if (e.key !== "Enter") return; e.preventDefault(); if (newTodo.trim()) { void todoAct("addTodos", { texts: [newTodo.trim()] }); setNewTodo(""); } }} />
                <Button size="sm" variant="outline" loading={busy} disabled={!newTodo.trim()} onClick={() => { const v = newTodo.trim(); if (v) { void todoAct("addTodos", { texts: [v] }); setNewTodo(""); } }}><Plus className="h-4 w-4" /> Add</Button>
              </div>
            )}
          </div>
        )}

        {!editing && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ListChecks className="h-4 w-4" /> Checklist
                {initialTodos.length > 0 && <span className="text-xs font-normal text-muted-foreground">{initialTodos.length} item{initialTodos.length === 1 ? "" : "s"}</span>}
              </p>
              <div className="flex items-center gap-2">
                {/* Beside the template picker, because it answers the same question - "what are the steps?" -
                    from the task itself rather than from a catalogue. APPENDS rather than replaces, so a
                    template already applied survives, and every suggested line is removable like any other
                    item: the model stages the list, the person keeps or drops each one. */}
                <DraftButton
                  collection="cards"
                  kind="task-checklist"
                  label="Suggest steps"
                  existing={description}
                  existingIsContext
                  hint="e.g. what finishing this task involves"
                  onDraft={(text) => setInitialTodos((s) => [...s, ...toChecklistItems(text)])}
                />
                {checklists.length > 0 && (
                  <Select value="" onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl?.items?.length) setInitialTodos((s) => [...s, ...cl.items]); }}>
                    <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Apply template…" /></SelectTrigger>
                    <SelectContent>{checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            </div>
            {initialTodos.length > 0 && (
              <div className="space-y-1.5">
                {initialTodos.map((t, i) => (
                  <div key={initialTodoKeys[i]} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                    <span className="flex-1">{t}</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" onClick={() => setInitialTodos((s) => s.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input className="h-8" placeholder="Add a checklist item…" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => { if (e.key !== "Enter") return; e.preventDefault(); if (newTodo.trim()) { setInitialTodos((s) => [...s, newTodo.trim()]); setNewTodo(""); } }} />
              <Button size="sm" variant="outline" disabled={!newTodo.trim()} onClick={() => { const v = newTodo.trim(); if (v) { setInitialTodos((s) => [...s, v]); setNewTodo(""); } }}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          </div>
        )}

        {editing && (
          <div className="space-y-2 border-t pt-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <MessageSquare className="h-4 w-4" /> Comments
              {comments.length > 0 && <span className="text-xs font-normal text-muted-foreground">{comments.length}</span>}
            </p>
            {/* A thread reads as a conversation or it doesn't get read: who said it (face), when in words, and
                the same markdown-lite the description gets - including @mention chips. */}
            {comments.length > 0 ? (
              <ul className="max-h-56 space-y-2 overflow-y-auto">
                {comments.map((cm, i) => (
                  <li key={i} className="flex gap-2">
                    {cm.author
                      ? <PhotoAvatar employeeId={idOf(cm.author)} name={commenterName(cm)} className="mt-0.5 h-7 w-7 shrink-0 text-[10px]" />
                      : <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">{initials(commenterName(cm))}</span>}
                    <div className="min-w-0 flex-1 rounded-md bg-muted/40 p-2 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium">{commenterName(cm)}</span>
                        {cm.create_time && <span className="text-[11px] text-muted-foreground" title={new Date(cm.create_time).toLocaleString()}>{timeAgo(cm.create_time)}</span>}
                      </div>
                      <RichText source={cm.body ?? ""} className="space-y-1.5 leading-snug" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">No comments yet.</p>}
            {can.includes("comment") && (
              <div className="flex items-start gap-2">
                {/* Cmd/Ctrl+Enter posts the comment. Without this it reaches the dialog and saves the task
                    instead, which is never what someone mid-sentence in a comment box meant. `@` offers the
                    directory, and the mention menu gets first refusal on the keys it uses. */}
                <div className="relative flex-1">
                  <Textarea
                    ref={commentRef}
                    value={commentText}
                    onChange={(e) => { setCommentText(e.target.value); mentions.sync(); }}
                    rows={2}
                    placeholder="Add a comment… @ to mention, Ctrl+Enter to post"
                    onKeyUp={mentions.sync}
                    onClick={mentions.sync}
                    onKeyDown={(e) => {
                      if (mentions.onKeyDown(e)) return;
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void addComment(); }
                    }}
                  />
                  {mentions.menu}
                </div>
                <AccessAction verb="comment" can={can} label="Who can comment"><Button size="sm" onClick={addComment} loading={busy} disabled={!commentText.trim()}>Comment</Button></AccessAction>
              </div>
            )}
          </div>
        )}


        {editing && (
          <div className="space-y-2 border-t pt-3">
            {blockedView.blocked ? (
              <div className="flex flex-wrap items-center gap-2">
                {(() => {
                  const blocker = blockedView.blockedBy ? boardCards.find((x) => idOf(x.path) === idOf(blockedView.blockedBy!)) : undefined;
                  return (
                    <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
                      <Ban className="h-4 w-4" /> Blocked
                      {blocker && onOpenCard && (
                        <>by <button type="button" className="font-medium underline hover:no-underline" onClick={() => onOpenCard(blocker)}>{taskKey(blocker)} {blocker.title}</button></>
                      )}
                      {blockedView.reason && <span className="text-muted-foreground">— {blockedView.reason}</span>}
                    </span>
                  );
                })()}
                <AccessAction verb="unblock" can={can} label="Who can unblock"><Button size="sm" variant="outline" onClick={() => act("unblock")} loading={busy}>Unblock</Button></AccessAction>
              </div>
            ) : (
              can.includes("block") && (
                <div className="flex items-center gap-2">
                  <div className="flex-1"><Combobox value={blockedBy} onValueChange={setBlockedBy} options={boardCards.filter((x) => idOf(x.path) !== idOf(card!.path)).map((x) => ({ value: idOf(x.path), label: `${taskKey(x)} ${x.title}` }))} placeholder="Blocked by a task…" /></div>
                  <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Note (optional)…" className="flex-1" />
                  <AccessAction verb="block" can={can} label="Who can block"><Button variant="outline" className="shrink-0" onClick={() => act("block", { blocked_by: blockedBy ? `cards/${blockedBy}` : undefined, reason: blockReason || undefined })} loading={busy} disabled={!blockedBy && !blockReason}><Ban className="h-3.5 w-3.5" /> Block</Button></AccessAction>
                </div>
              )
            )}
            {(() => {
              // The reverse edge: cards waiting on THIS one. Computed from the already-loaded board cards.
              const blocks = boardCards.filter((x) => x.blocked_by && idOf(x.blocked_by) === idOf(card!.path) && !x.delete_time);
              if (!blocks.length) return null;
              return (
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                  <Ban className="h-4 w-4" /> Blocks
                  {blocks.map((b) => onOpenCard
                    ? <button key={b.path} type="button" className="font-medium text-foreground underline hover:no-underline" onClick={() => onOpenCard(b)}>{taskKey(b)} {b.title}</button>
                    : <span key={b.path} className="font-medium text-foreground">{taskKey(b)} {b.title}</span>)}
                </p>
              );
            })()}
          </div>
        )}

        {/* Activity as a disclosure in the dialog, like every other detail dialog in the app - it used to open
            a SECOND dialog on top of this one. Still lazy: the audit query runs on the first click, not on open. */}
        {editing && <ActivitySection resource={card!.path} className="border-t pt-3" />}
    </WriteDialog>
    </>
  );
}

// ---- New board --------------------------------------------------------------------------------------------

// The key a board's tasks will carry, worked out before it is created rather than discovered afterwards.
// Mirrors normalizePrefix/derivePrefix in src/domain/boards.ts - the server still decides, this only shows it.
function previewPrefix(name: string, prefix: string): string {
  const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const typed = normalize(prefix);
  if (typed) return typed;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const base = initials.length >= 2 ? initials : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3);
  return normalize(base) || "TASK";
}

const BLANK_BOARD = { mode: "kanban" as BoardMode, name: "", prefix: "", description: "", copyFrom: "" };

function NewBoardDialog({ existing, onClose, onSaved }: { existing: Board[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState(BLANK_BOARD);
  const set = (patch: Partial<typeof BLANK_BOARD>) => setForm((f) => ({ ...f, ...patch }));

  const dupName = useMemo(() => {
    const n = form.name.trim().toLowerCase();
    return n ? existing.find((b) => !b.delete_time && b.name.trim().toLowerCase() === n) ?? null : null;
  }, [existing, form.name]);

  // The board being copied from, when one is picked: a team that already runs a board wants THAT shape - its
  // columns, WIP limits, policies, labels and swimlanes - not the default flow plus twenty minutes in Configure.
  const source = form.copyFrom ? existing.find((b) => b.path === form.copyFrom) ?? null : null;

  async function save() {
    const prefix = previewPrefix(form.name, form.prefix);
    const b = await create<Board>("boards", {
      name: form.name.trim(),
      description: form.description.trim(),
      mode: source ? source.mode : form.mode,
      ...(form.prefix.trim() ? { task_prefix: prefix } : {}),
      // Structure only. Cards, sprints and who the board is shared with are deliberately not copied: the first
      // is somebody else's work, and the last would hand a new team an access list nobody asked for.
      ...(source ? { columns: source.columns, labels: source.labels, swimlane_mode: source.swimlane_mode, swimlanes: source.swimlanes } : {}),
    });
    toast({ title: "Board created", variant: "success" });
    onSaved(idOf(b.path));
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="New board"
      description="A board is one team's work, as columns it moves across. Only you can see it until you share it."
      collection="boards"
      guardLabel="board"
      form={form}
      submitLabel="Create board"
      canSubmit={!!form.name.trim()}
      whyNot="Give the board a name."
      onSubmit={save}
      submitAccess={(b) => <AccessAction collection="boards" create label="Create a board">{b}</AccessAction>}
    >
      {existing.length > 0 && (
        <Field label="Start from" hint={source ? `Copies ${source.columns.length} columns with their WIP limits and policies, plus ${source.labels.length} labels. No cards.` : "The standard flow, which you can reshape afterwards."}>
          <Combobox
            value={form.copyFrom}
            onValueChange={(v) => set({ copyFrom: v })}
            options={[{ value: "", label: "The default flow" }, ...existing.filter((b) => !b.delete_time).map((b) => ({ value: b.path, label: `${b.name} (copy its setup)` }))]}
            placeholder="The default flow"
          />
        </Field>
      )}
      <Field label="Method" hint={source ? `Follows ${source.name}: ${source.mode === "scrum" ? "sprints" : "continuous flow"}.` : form.mode === "scrum" ? "Time-boxed sprints: a product backlog, a sprint board, burndown and velocity." : "Continuous flow: cards move when they're ready, with WIP limits holding the pace."}>
        <Select value={source ? source.mode : form.mode} onValueChange={(v) => set({ mode: v as BoardMode })} disabled={!!source}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="kanban">Kanban (continuous flow)</SelectItem>
            <SelectItem value="scrum">Scrum (sprints)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Name"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Platform team" autoFocus /></Field>
      {dupName && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>A board called “{dupName.name}” already exists. Two boards with one name are hard to tell apart in the picker.</span>
        </p>
      )}
      <Field
        label="Task key prefix"
        hint={form.name.trim() ? `Tasks will be keyed ${previewPrefix(form.name, form.prefix)}-1, ${previewPrefix(form.name, form.prefix)}-2, …` : "For task keys like MS-12. Blank auto-derives from the name."}
      >
        <Input value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="auto (e.g. MS)" className="w-40 uppercase" maxLength={6} />
      </Field>
      <Field label="Description (optional)"><Textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder="What this board covers, so the right work lands on it." /></Field>
      <p className="text-xs text-muted-foreground">
        {source
          ? `Starts as a copy of ${source.name}'s board setup, with no cards on it. Reshape it with Configure.`
          : form.mode === "scrum"
            ? "Starts with a to do → in progress → review → done sprint flow, with the product backlog alongside it. Reshape it with Configure."
            : "Starts with a standard backlog → ready → in progress → review → done flow. Reshape it with Configure."}
      </p>
    </WriteDialog>
  );
}


// ---- Analytics: cumulative flow diagram + lead/cycle time + throughput --------------------------------------

// The categorical palette this board's flow bands used to keep to itself now lives in lib/chartTheme.ts, where
// every chart in the app draws from it - a column called "In review" is the same hue here as anywhere else.

function AnalyticsTab({ board, onOpenCards }: { board: Board; onOpenCards?: () => void }) {
  const { toast } = useToast();
  const [days, setDays] = useState(30);
  const [metrics, setMetrics] = useState<BoardMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // `days` rides the query string (the metrics verb reads it there); invoke() itself has no params arg.
    invoke<BoardMetrics>(`boards/${idOf(board.path)}`, `metrics?days=${days}`, undefined)
      .then((m) => { if (live) setMetrics(m); })
      .catch((e) => toast({ title: "Couldn't load analytics", description: (e as Error).message, variant: "destructive" }))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.path, days]);

  // Four figures over two charts - the shape the analytics tab settles into.
  if (loading && !metrics) return <div className="space-y-5"><StatsSkeleton count={4} /><Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (!metrics) return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Lead time (p50)" value={`${metrics.lead_time.p50}d`} icon={Flag} hint={`p85 ${metrics.lead_time.p85}d`} tone="primary" onClick={onOpenCards} />
        <StatCard label="Cycle time (p50)" value={`${metrics.cycle_time.p50}d`} icon={BarChart3} hint={`p85 ${metrics.cycle_time.p85}d`} tone="primary" onClick={onOpenCards} />
        <StatCard label="Throughput" value={`${metrics.throughput.per_week}/wk`} icon={KanbanSquare} hint={`${metrics.throughput.delivered} in ${days}d`} tone="success" onClick={onOpenCards} />
        <StatCard label="Avg cycle time" value={`${metrics.cycle_time.avg}d`} icon={BarChart3} hint={`over ${metrics.cycle_time.count} cards`} tone="muted" onClick={onOpenCards} />
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Cumulative flow</h4>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="14">14 days</SelectItem>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <CfdChart metrics={metrics} />
      </div>
    </div>
  );
}

// Cumulative flow: one area band per board column, stacked in board order, over the chosen window. The
// stacking is arithmetic (lib/chartTheme.ts#stackSeries) because a band's top edge is the running total; the
// drawing, the axis, the tooltip and the legend belong to the shared Chart primitive.
function CfdChart({ metrics }: { metrics: BoardMetrics }) {
  const { cfd, columns } = metrics;
  // Drawn back-to-front: the last dataset frappe paints sits on top, and a stacked area reads correctly only
  // when the tallest (fullest) band is painted first.
  const stacked = useMemo(() => stackSeries(columns.map((c) => cfd.map((d) => d.counts[c.key] ?? 0))), [cfd, columns]);
  return (
    <Chart
      type="line"
      height={260}
      labels={cfd.map((d) => d.date.slice(5))}
      datasets={columns.map((c, i) => ({ name: c.label, values: stacked[i] ?? [] })).reverse()}
      areaFill
      hideDots
      ariaLabel="Cumulative flow: how many tasks sat in each column on each day"
      emptyText="No flow data yet - create and move some tasks."
      // Deliberately not a filter. A point here is a COUNT on a past day, not a set of cards: the board
      // holds where tasks are now, and there is no list of "the cards that were in Doing three Tuesdays
      // ago" for a press to open. See `everyChart.spec.ts`'s exemption list.
    />
  );
}

// ---- List view: the board's tasks as a flat DataTable ------------------------------------------------------
// Everything DataTable brings comes free: sort, per-column filters, column chooser, CSV/Excel export, saved
// views, URL state, mobile cards, and cursor-following "Load more". Row click opens the same task dialog.

function BoardListTab({ board, me }: { board: Board; me: Me }) {
  const { rows: allCards, reload, hasMore, loadMore } = useCollection<CardT>("cards");
  const { toast } = useToast();
  const boardId = idOf(board.path);
  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  const { editing, openCard, closeCard } = useOpenCard(undefined, cards);
  // What ‹ › and j/k walk in the dialog: the rows the TABLE is showing, in the order it sorted them. The
  // filtering and the sort live inside DataTable, so the page cannot work this out for itself - it is handed
  // over. Without it the dialog stepped through every card on the board, in read order, while the table in
  // front of the reader showed eight of them sorted by due date.
  const [tableRows, setTableRows] = useState<CardT[]>([]);
  // The list shows one name column (Assignee); goals and departments are the task dialog's pickers, so they
  // are read when a row is actually opened. Same rule as the board grid.
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: !!editing || cards.some((c) => c.assignee) });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: !!editing });
  const { rows: departments } = useCollection<Department>("departments", { enabled: !!editing, all: true });
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);
  const colLabel = useMemo(() => new Map(board.columns.map((c) => [c.key, c.label])), [board.columns]);

  // WHOSE WORK. The board grid has a filter for this; the list did not, so "what am I on" meant typing your
  // own name into a column filter. "Nobody" matches the column's own word for an empty assignee rather than a
  // blank, because that is what the accessor puts in the cell and what the filter therefore compares.
  const cardScopes = scopesOf(
    mineScope("mine", "Assigned to me", "assigned_to_me", !!me.employee_id, {
      count: cards.filter((c) => c.assignee && idOf(c.assignee) === me.employee_id).length,
    }),
    valueScope("unassigned", "Nobody on them", "assignee", "Unassigned", {
      count: cards.filter((c) => !c.assignee).length,
    }),
    allScope("Everything", cards.length),
  );

  const columns: Column<CardT>[] = useMemo(() => [
    { id: "key", header: "Key", accessor: (c) => taskKey(c), cell: (c) => <span className="font-mono text-xs text-muted-foreground">{taskKey(c)}</span>, mobilePriority: 2 },
    { id: "title", header: "Title", accessor: (c) => c.title, mobilePriority: 1 },
    // Grouping the list by status is the board's own shape, in a surface you can sort and total; by
    // assignee it is a workload sheet. Both are a click apart from here.
    { id: "status", header: "Status", accessor: (c) => colLabel.get(c.column_key) ?? c.column_key, filter: "select", groupBy: true, mobilePriority: 3 },
    { id: "assignee", header: "Assignee", accessor: (c) => (c.assignee ? empName(c.assignee) : "Unassigned"), filter: "select", groupBy: true, mobilePriority: 4 },
    // Hidden by default: it is the column you go looking for ("what did I file", "everything Ops raised"),
    // not one the table needs to be wider for by default.
    { id: "reporter", header: "Reporter", accessor: (c) => (c.reporter ? empName(c.reporter) : ""), filter: "select", groupBy: true, defaultHidden: true },
    { id: "priority", header: "Priority", accessor: (c) => c.priority, filter: "select", groupBy: true, cell: (c) => <span className="flex items-center gap-1 capitalize"><PriorityIcon p={c.priority} /> {c.priority}</span> },
    // Points total under the column, and per fold when the list is grouped: the sprint arithmetic nobody
    // should be doing in their head.
    { id: "points", header: "Points", accessor: (c) => c.size ?? null, align: "right", filter: "number", aggregate: "sum" },
    { id: "due", header: "Due", accessor: (c) => c.due_date ?? null, filter: "date", dateHint: "future" },
    { id: "labels", header: "Labels", accessor: (c) => (c.labels ?? []).map((k) => board.labels.find((l) => l.key === k)?.label ?? k).join(", "), cell: (c) => <span className="flex flex-wrap gap-1"><LabelChips keys={c.labels} catalog={board.labels} max={3} /></span>, defaultHidden: board.labels.length === 0 },
    { id: "blocked", header: "Blocked", accessor: (c) => (c.blocked ? "Blocked" : ""), filter: "select", cell: (c) => (c.blocked ? <span className="inline-flex items-center gap-1 text-destructive"><Ban className="h-3.5 w-3.5" /> Blocked</span> : null), defaultHidden: true },
    { id: "updated", header: "Updated", accessor: (c) => c.update_time ?? "", filter: "date", dateHint: "past", cell: (c) => (c.update_time ? new Date(c.update_time).toLocaleDateString() : ""), defaultHidden: true },
    // What the "Assigned to me" chip filters on, answered from the assignee's id: the names in the column
    // beside it arrive with the directory, and a scope that waited for them would read as off until it did.
    mineColumn<CardT>("assigned_to_me", "Assigned to me", (c) => !!c.assignee && !!me.employee_id && idOf(c.assignee) === me.employee_id),
    {
      // How long since anything happened to this card. A board hides this completely: a card that moved
      // yesterday and one that has sat in the same column for three weeks look identical, and ageing work in
      // progress is the thing a board exists to expose.
      // How long the card has sat in THE COLUMN IT IS IN, from the stamp the move itself writes
      // (`column_since_time`), not from the last edit. The difference is the whole point: retitling a card
      // that has been in review for three weeks does not make it fresh, and `update_time` said it did.
      //
      // The same threshold as the board's own ageing dot (STALE_AFTER_DAYS), so the list and the board cannot
      // disagree about which cards have gone quiet. `max` in the footer: the worst one is what a stand-up
      // asks about, and a total of everybody's waiting days means nothing.
      id: "idle", header: "In column", align: "right", filter: "number", aggregate: "max", formatTotal: fmtDaysCount, defaultHidden: true,
      accessor: (c) => daysSince(c.column_since_time ?? c.create_time),
      cell: (c) => {
        const d = daysSince(c.column_since_time ?? c.create_time);
        if (d == null) return <span className="text-muted-foreground">-</span>;
        return <span className={cn("tabular-nums text-xs", d >= STALE_AFTER_DAYS ? "font-medium text-warning" : "text-muted-foreground")}>{d}d</span>;
      },
    },
    {
      // Start to delivery, in days, on the cards that finished. The board can draw a cumulative flow but
      // cannot answer "how long does one of these take" per assignee or per label - which is the question
      // asked before every commitment. Averaged, and only over delivered work, so it is about things that
      // finished rather than about the backlog dragging the figure.
      id: "cycle", header: "Cycle", align: "right", filter: "number", aggregate: "avg", formatTotal: fmtDaysCount, defaultHidden: true,
      accessor: (c) => {
        if (!c.deliver_time) return null;
        const from = c.start_time ?? c.create_time;
        if (!from) return null;
        const days = Math.round(((Date.parse(c.deliver_time) - Date.parse(from)) / 86_400_000) * 10) / 10;
        return Number.isFinite(days) && days >= 0 ? days : null;
      },
    },
  ], [colLabel, empName, board.labels, me.employee_id]);

  // What a backlog is asked about when it stops being a wall of cards: what has gone past its date, what
  // nobody owns, and what is stuck behind something else.
  const cardInsights = (cs: CardT[]): TableInsight[] => {
    const out: TableInsight[] = [];
    const today = todayStr();
    const overdue = cs.filter((c) => c.due_date && c.due_date < today);
    if (overdue.length > 0) {
      out.push({ id: "overdue", label: `${overdue.length} past their due date`, tone: "destructive", filters: { due: "past" }, sort: "due.asc" });
    }
    const unassigned = cs.filter((c) => !c.assignee);
    if (unassigned.length > 0) {
      out.push({ id: "unassigned", label: `${unassigned.length} unassigned`, tone: "warning", filters: { assignee: "Unassigned" } });
    }
    const blocked = cs.filter((c) => c.blocked);
    if (blocked.length > 0) {
      out.push({ id: "blocked", label: `${blocked.length} blocked`, tone: "destructive", hint: "Waiting on something else before they can move.", filters: { blocked: "Blocked" } });
    }
    // Nothing has happened to these in weeks. Not blocked, not overdue, just quietly not moving - which is
    // what most of a stalled board actually consists of.
    const idle = cs.filter((c) => (daysSince(c.column_since_time ?? c.create_time) ?? 0) >= STALE_AFTER_DAYS);
    if (idle.length > 0) {
      out.push({
        id: "idle",
        label: `${idle.length} stuck for ${STALE_AFTER_DAYS} days`,
        tone: "warning",
        hint: "In the same column that long. Close them, move them, or say what they are waiting for.",
        filters: { idle: `>=${STALE_AFTER_DAYS}` },
        sort: "idle.desc",
      });
    }
    // Unestimated cards drop out of every forecast this board draws, silently, so a sprint that looks half
    // sized is often fully sized with half of it uncounted.
    if (cs.some((c) => c.size != null)) {
      const unsized = cs.filter((c) => c.size == null);
      if (unsized.length > 0) {
        out.push({
          id: "unsized",
          label: `${unsized.length} with no points`,
          hint: "This board estimates, and these are left out of every total and chart it draws.",
          filters: { points: BLANK },
        });
      }
    }
    return out;
  };

  // Bulk actions on the list, because the board is a drag surface and re-assigning a departing person's
  // twelve tasks there is twelve drags. Every one of these is an existing per-card verb applied across the
  // selection, so nothing here can do something a single task could not.
  const bulkActions: BulkAction<CardT>[] = useMemo(() => {
    const needs = (verb: string, why: string) => (sel: CardT[]) => (sel.every((c) => (c.access?.can ?? []).includes(verb)) ? null : why);
    const firstColumn = board.columns[0];
    const lastColumn = board.columns[board.columns.length - 1];
    return [
      // Two ends of the workflow rather than every column: a bulk bar with eight destinations on it is a menu,
      // and the two moves people actually make in bulk are "pull this batch in" and "these are done".
      ...(firstColumn && lastColumn && firstColumn.key !== lastColumn.key
        ? [
          {
            label: `Move to ${lastColumn.label}`,
            icon: <ChevronsUp className="h-4 w-4" />,
            confirm: { title: `Move the selected tasks to ${lastColumn.label}?`, description: "WIP limits still apply, so a task the column has no room for is left where it is and reported." },
            disabled: needs("move", "Only tasks you may move"),
            run: async (sel: CardT[]) => {
              const r = await bulkInvoke("cards", "move", sel, { to_column: lastColumn.key });
              toast(bulkSummary("Moved", r));
              reload();
              return r.failedRows; // only what failed stays selected, so the retry acts on exactly those
            },
          },
          {
            label: `Move to ${firstColumn.label}`,
            icon: <ChevronDown className="h-4 w-4" />,
            confirm: { title: `Move the selected tasks back to ${firstColumn.label}?` },
            disabled: needs("move", "Only tasks you may move"),
            run: async (sel: CardT[]) => {
              const r = await bulkInvoke("cards", "move", sel, { to_column: firstColumn.key });
              toast(bulkSummary("Moved", r));
              reload();
              return r.failedRows;
            },
          },
        ]
        : []),
      {
        label: "Assign to me",
        icon: <UserRound className="h-4 w-4" />,
        disabled: (sel: CardT[]) => (!me.employee_id ? "Your login has no employee record" : needs("assign", "Only tasks you may assign")(sel)),
        run: async (sel: CardT[]) => {
          const r = await bulkInvoke("cards", "assign", sel, { assignee: `employees/${me.employee_id}` });
          toast(bulkSummary("Assigned", r));
          reload();
          return r.failedRows;
        },
      },
      {
        label: "Unassign",
        icon: <X className="h-4 w-4" />,
        confirm: { title: "Take the selected tasks off their assignees?" },
        disabled: needs("assign", "Only tasks you may assign"),
        run: async (sel: CardT[]) => {
          // "" rather than null: a cleared reference goes over the wire as an empty string (api.ts).
          const r = await bulkInvoke("cards", "assign", sel, { assignee: "" });
          toast(bulkSummary("Unassigned", r));
          reload();
          return r.failedRows;
        },
      },
      {
        label: "Mark urgent",
        icon: <Flag className="h-4 w-4" />,
        disabled: needs("prioritize", "Only tasks you may prioritize"),
        run: async (sel: CardT[]) => {
          const r = await bulkInvoke("cards", "prioritize", sel, { priority: "urgent" });
          toast(bulkSummary("Prioritized", r));
          reload();
          return r.failedRows;
        },
      },
      {
        label: "Watch",
        icon: <Eye className="h-4 w-4" />,
        disabled: needs("watch", "Only tasks you may follow"),
        run: async (sel: CardT[]) => {
          const r = await bulkInvoke("cards", "watch", sel);
          toast(bulkSummary("Now following", r));
          return r.failedRows;
        },
      },
    ];
  }, [board.columns, me.employee_id, reload, toast]);

  return (
    <TooltipProvider delayDuration={150}>
      <DataTable
        columns={columns}
        insights={cardInsights}
        scopes={cardScopes}
        rows={cards}
        getRowId={(c) => c.path}
        onRowClick={openCard}
        onVisibleRows={setTableRows}
        tableId="board-list"
        accessCollection="cards"
        accessTargetOf={(c) => ({ objectPath: c.path, can: c.access?.can, label: "Manage task access" })}
        hasMore={hasMore}
        onLoadMore={loadMore}
        bulkActions={bulkActions}
        emptyTitle="No tasks on this board"
        emptyDescription="Tasks you add on the Board tab show up here as a sortable, exportable list."
      />
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} queue={tableRows} meId={me.employee_id} onOpenCard={openCard} onClose={closeCard} onSaved={() => { closeCard(); reload(); }} />}
    </TooltipProvider>
  );
}

// ---- Scrum view: product backlog + the sprint board + burndown/velocity ------------------------------------

function ScrumView({ board, me, openId }: { board: Board; me: Me; openId?: string }) {
  const { rows: allCards, setRows, reload } = useCollection<CardT>("cards");
  const { rows: allSprints, reload: reloadSprints } = useCollection<Sprint>("sprints");
  const { toast } = useToast();
  const confirm = useConfirm();
  const boardId = idOf(board.path);
  const dragId = useRef<string | null>(null);
  const { ref: fillRef, height: fillH } = useFillHeight();
  const [overZone, setOverZone] = useState<string | null>(null);
  const pendingRank = useRef<number | null>(null); // backlog insertion rank from the hovered gap
  const [lineAt, setLineAt] = useState<string | null>(null); // `${cardPath}:t|b` — backlog insertion line
  useRefetchOnFocus(() => { reload(); reloadSprints(); });
  const [addBacklog, setAddBacklog] = useState(false);
  const [quickBacklog, setQuickBacklog] = useState(false); // inline title composer on the backlog column
  // "+ New → Create a task" quick action: open the backlog composer (scrum boards).
  useIntent("new-card", () => setAddBacklog(true));
  const [newSprint, setNewSprint] = useState(false);
  const [busy, setBusy] = useState(false);

  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  const { editing, openCard, closeCard } = useOpenCard(openId, cards);
  // Reference lists on the same rule as the board grid: read when the cards or the composer actually need them.
  const composing = addBacklog || !!editing;
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: composing || cards.some((c) => c.assignee) });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: composing || cards.some((c) => c.goal) });
  const { rows: departments } = useCollection<Department>("departments", { enabled: composing || cards.some((c) => c.department), all: true });
  const sprints = useMemo(
    () => allSprints.filter((s) => s.board && idOf(s.board) === boardId && !s.delete_time).sort((a, b) => (a.create_time ?? "").localeCompare(b.create_time ?? "")),
    [allSprints, boardId],
  );
  const active = sprints.find((s) => s.state === "active");
  const [selId, setSelId] = useState<string | null>(null);
  useEffect(() => {
    if (!sprints.length) { setSelId(null); return; }
    const def = active ? idOf(active.path) : idOf(sprints[sprints.length - 1]!.path);
    if (!selId || !sprints.some((s) => idOf(s.path) === selId)) setSelId(def);
  }, [sprints, active, selId]);
  const sprint = sprints.find((s) => idOf(s.path) === selId) ?? null;

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Department" : "");
  }, [departments]);
  const assigneeOf = (c: CardT) => (c.assignee ? { id: idOf(c.assignee), name: empName(c.assignee) } : null);
  const goalTitle = useMemo(() => {
    const m = new Map(goals.map((g) => [idOf(g.path), g.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Goal" : "");
  }, [goals]);
  const cardById = useMemo(() => new Map(cards.map((c) => [idOf(c.path), c])), [cards]);
  const blockerKeyOf = (c: CardT) => (c.blocked_by ? (cardById.get(idOf(c.blocked_by)) && taskKey(cardById.get(idOf(c.blocked_by))!)) || undefined : undefined);

  const filter = useCardFilter(me.employee_id, `boards:filter:${boardId}`);
  const backlog = useMemo(() => cards.filter((c) => !c.sprint).sort(byRank), [cards]);
  const sprintCards = useMemo(() => (sprint ? cards.filter((c) => c.sprint && idOf(c.sprint) === idOf(sprint.path)) : []), [cards, sprint]);
  const pts = (list: CardT[]) => list.reduce((s, c) => s + (c.size ?? 0), 0);
  // The backlog then each sprint column, filtered and ranked exactly as they are drawn below - see the note on
  // the board grid's own `screenQueue`. The dialog used to step through every card on the board.
  const matchCard = filter.match;
  const screenQueue = useMemo(
    () => [
      ...backlog.filter(matchCard),
      ...board.columns.flatMap((col) => sprintCards.filter((c) => c.column_key === col.key && matchCard(c)).sort(byRank)),
    ],
    [backlog, sprintCards, board.columns, matchCard],
  );

  async function dropOnColumn(colKey: string) {
    const id = dragId.current; dragId.current = null; setOverZone(null);
    if (!id || !sprint) return;
    const card = cards.find((c) => idOf(c.path) === id);
    if (!card) return;
    const inSprint = !!card.sprint && idOf(card.sprint) === idOf(sprint.path);
    if (inSprint && card.column_key === colKey) return;
    const dest = sprintCards.filter((c) => c.column_key === colKey);
    const rank = (dest.length ? Math.max(...dest.map((c) => c.rank ?? 0)) : 0) + RANK_STEP;
    setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, sprint: sprint.path, column_key: colKey, rank } : c)));
    try {
      // One atomic op: the move verb also reassigns the sprint (no separate PATCH, one event). The returned
      // row goes back into the store so the next drag holds a current etag (see moveCard on the board).
      const res = await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: colKey, rank, ...(inSprint ? {} : { to_sprint: sprint.path }) });
      setRows((prev) => prev.map((c) => (c.path === res.path ? res : c)));
    } catch (e) {
      reload();
      toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Drop on the backlog: leave the sprint (if any) AND land at the hovered position - backlog order IS the
  // plan, so reordering within the backlog is the same drop with a rank from the gap under the cursor.
  async function dropOnBacklog(rank?: number) {
    const id = dragId.current; dragId.current = null; setOverZone(null);
    if (!id) return;
    const card = cards.find((c) => idOf(c.path) === id);
    if (!card) return;
    if (!card.sprint && rank == null) return; // already in the backlog, dropped on no particular gap
    setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, sprint: undefined, ...(rank != null ? { rank } : {}) } : c)));
    try {
      const res = await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: card.column_key, to_sprint: null, ...(rank != null ? { rank } : {}) });
      setRows((prev) => prev.map((c) => (c.path === res.path ? res : c)));
    } catch (e) {
      reload();
      toast({ title: "Couldn't move to backlog", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Menu-driven moves (the touch path). `menuAct` = move verb with optimistic apply; `menuPatch` = field edit.
  async function menuAct(card: CardT, body: Record<string, unknown>, optimistic: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...optimistic } : c)));
    try { const res = await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, body); setRows((prev) => prev.map((c) => (c.path === res.path ? res : c))); }
    catch (e) { reload(); toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
  }
  async function menuPatch(card: CardT, body: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...body } : c)));
    try { const res = await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); setRows((prev) => prev.map((c) => (c.path === res.path ? res : c))); }
    catch (e) { reload(); toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }
  const tileMenu = (c: CardT) => {
    const inBacklog = !c.sprint;
    const appendRank = (dest: CardT[]) => (dest.length ? Math.max(...dest.map((x) => x.rank ?? 0)) : 0) + RANK_STEP;
    return (
      <CardActionsMenu
        card={c}
        meId={me.employee_id}
        columns={inBacklog ? [] : board.columns} // a backlog card has no visible column to move within
        onMove={(k) => {
          const container = cards.filter((x) => x.sprint && c.sprint && idOf(x.sprint!) === idOf(c.sprint!));
          const rank = appendRank(container.filter((x) => x.column_key === k));
          void menuAct(c, { to_column: k, rank }, { column_key: k, rank });
        }}
        onAssignMe={() => void menuPatch(c, { assignee: `employees/${me.employee_id}` })}
        onPriority={(p) => void menuPatch(c, { priority: p })}
        sprintExtras={
          inBacklog
            ? (sprint && sprint.state !== "completed" ? (
                <DropdownMenuItem onClick={() => {
                  const rank = appendRank(sprintCards.filter((x) => x.column_key === c.column_key));
                  void menuAct(c, { to_column: c.column_key, rank, to_sprint: sprint.path }, { sprint: sprint.path, rank });
                }}>Move to {sprint.name}</DropdownMenuItem>
              ) : undefined)
            : <DropdownMenuItem onClick={() => void menuAct(c, { to_column: c.column_key, to_sprint: null }, { sprint: undefined })}>Send to backlog</DropdownMenuItem>
        }
      />
    );
  };

  async function sprintAct(verb: "activate" | "complete") {
    if (!sprint) return;
    if (verb === "complete") {
      const ok = await confirm({ title: `Complete ${sprint.name}?`, description: "Unfinished (undelivered) tasks return to the product backlog.", confirmLabel: "Complete sprint" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await invoke(`sprints/${idOf(sprint.path)}`, verb, sprint.etag);
      toast({ title: verb === "activate" ? "Sprint started" : "Sprint completed", variant: "success" });
      reloadSprints(); reload();
    } catch (e) {
      toast({ title: "Couldn't update sprint", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const canA = (sprint?.access?.can ?? []);
  const zoneCls = (id: string) => `flex flex-col gap-2 rounded-md p-1 transition-colors flex-1 min-h-0 overflow-y-auto ${overZone === id ? "bg-primary/10 outline-dashed outline-1 outline-primary/40" : ""}`;

  return (
    <TooltipProvider delayDuration={150}>
      {/* Sprint bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {sprints.length > 0 && (
          <Select value={selId ?? undefined} onValueChange={setSelId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Pick a sprint" /></SelectTrigger>
            <SelectContent>
              {sprints.map((s) => <SelectItem key={s.path} value={idOf(s.path)}>{s.name} · {s.state}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {sprint && <Badge variant={sprint.state === "active" ? "default" : sprint.state === "completed" ? "secondary" : "outline"}>{sprint.state}</Badge>}
        {sprint?.state === "planning" && canA.includes("activate") && <AccessAction collection="sprints" objectPath={sprint.path} verb="activate" can={canA} label="Who can start sprints"><Button size="sm" onClick={() => sprintAct("activate")} loading={busy}>Start sprint</Button></AccessAction>}
        {sprint?.state === "active" && canA.includes("complete") && <AccessAction collection="sprints" objectPath={sprint.path} verb="complete" can={canA} label="Who can complete sprints"><Button size="sm" variant="outline" onClick={() => sprintAct("complete")} loading={busy}>Complete sprint</Button></AccessAction>}
        <AccessAction collection="sprints" create label="Create a sprint">
          <Button size="sm" variant="outline" onClick={() => setNewSprint(true)}><Plus className="h-4 w-4" /> New sprint</Button>
        </AccessAction>
      </div>
      {sprint && (() => {
        const total = pts(sprintCards);
        const done = pts(sprintCards.filter((c) => c.deliver_time));
        // Days remaining, counting the end date itself as a working day. Only meaningful mid-sprint.
        // A calendar-day difference on the ORG's clock, like the card due dates above: building an instant at
        // the VIEWER's end-of-day and differencing it against `Date.now()` gives a different countdown per
        // viewer, and a different one again from the due-date column in this same file.
        const daysLeft = sprint.state === "active" && sprint.end_date
          ? daysBetweenYmd(todayStr(), sprint.end_date.slice(0, 10))
          : null;
        return (
          <p className="mb-3 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            {sprint.goal && <span className="font-medium text-foreground">{sprint.goal} ·</span>}
            {sprint.start_date && <span>{sprint.start_date}{sprint.end_date ? ` → ${sprint.end_date}` : ""} ·</span>}
            <span>{total > 0 ? `${done}/${total} pts done` : "no points estimated"}</span>
            {daysLeft != null && (
              <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", daysLeft < 0 ? "bg-destructive/10 text-destructive" : daysLeft <= 1 ? "bg-warning/10 text-warning" : "bg-muted")}>
                {daysLeft < 0 ? "past end date" : daysLeft === 0 ? "ends today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
              </span>
            )}
          </p>
        );
      })()}

      <BoardToolbar filter={filter} board={board} cards={cards} empName={empName} deptName={deptName} />

      {/* Swipe-a-column-at-a-time on a phone. Without snapping, dragging a board sideways leaves you parked
          between two columns reading half of each; with it, every swipe settles on a column edge. Snapping is
          switched off from `sm` up, where several columns are on screen at once and free scrolling is right. */}
      <div
        ref={fillRef}
        style={{ height: fillH }}
        className="scroll-shadow-x flex snap-x snap-mandatory items-stretch gap-3 overflow-x-auto sm:snap-none"
      >
        {/* Product backlog */}
        <div
          className="flex min-h-0 w-[86vw] max-w-[20rem] shrink-0 snap-start flex-col overflow-hidden rounded-lg border bg-muted/20 sm:w-72 sm:max-w-none"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; pendingRank.current = null; setOverZone("backlog"); setLineAt(null); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOverZone((p) => (p === "backlog" ? null : p)); setLineAt(null); } }}
          onDrop={(e) => { e.preventDefault(); const r = pendingRank.current ?? undefined; pendingRank.current = null; setLineAt(null); void dropOnBacklog(r); }}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium">Backlog</span>
              <Badge variant="secondary">{backlog.length}</Badge>
            </div>
            <AccessAction collection="cards" create label="Add a task">
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label="Add a task to the backlog" className="h-6 w-6 text-muted-foreground coarse:h-9 coarse:w-9" onClick={() => setQuickBacklog((v) => !v)}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add task</TooltipContent></Tooltip>
            </AccessAction>
          </div>
          <div className={zoneCls("backlog")}>
            {quickBacklog && <QuickAddCard board={board} column={board.columns[0]?.key ?? ""} onClose={() => setQuickBacklog(false)} onCreated={reload} />}
            {(() => {
              const items = backlog.filter(filter.match);
              return items.map((c, idx) => (
                <div
                  key={c.path}
                  className="relative"
                  onDragOver={(e) => {
                    // Insertion line + rank from the hovered gap - backlog order is the plan, position matters.
                    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const before = e.clientY - rect.top < rect.height / 2;
                    pendingRank.current = rankAt(items, before ? idx : idx + 1);
                    setLineAt(`${c.path}:${before ? "t" : "b"}`);
                    setOverZone("backlog");
                  }}
                >
                  <span className={`pointer-events-none absolute inset-x-1 -top-1 z-10 h-0.5 rounded bg-primary ${lineAt === `${c.path}:t` ? "" : "hidden"}`} />
                  <CardTile card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => openCard(c)} />
                  <span className={`pointer-events-none absolute inset-x-1 -bottom-1 z-10 h-0.5 rounded bg-primary ${lineAt === `${c.path}:b` ? "" : "hidden"}`} />
                </div>
              ));
            })()}
          </div>
        </div>

        {/* The selected sprint's board */}
        {sprint ? (
          board.columns.map((col) => {
            const items = sprintCards.filter((c) => c.column_key === col.key && filter.match(c)).sort(byRank);
            const zid = `col:${col.key}`;
            return (
              // 86vw on a phone: the column all but fills the screen, with a sliver of the next one showing so
            // it is obvious the board continues. A fixed 288px column on a 390px screen reads as a mistake.
            // Named group: the column's heading is a plain span inside its header row, so without a name on
            // the column itself the board reads as one undifferentiated pile of cards with nothing saying
            // which column any of them is in.
            <div key={col.key} role="group" aria-label={col.label} className="flex min-h-0 w-[86vw] max-w-[20rem] shrink-0 snap-start flex-col overflow-hidden rounded-lg border bg-muted/20 sm:w-72 sm:max-w-none">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{col.label}</span>
                    {col.commitment && <Tooltip tapToOpen><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-primary" /></TooltipTrigger><TooltipContent>Commitment point — lead time starts here</TooltipContent></Tooltip>}
                    {col.delivery && <Tooltip tapToOpen><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-success" /></TooltipTrigger><TooltipContent>Delivery point — work is done here</TooltipContent></Tooltip>}
                    {col.policy && <Tooltip tapToOpen><TooltipTrigger asChild><span className="cursor-help text-xs text-muted-foreground">ⓘ</span></TooltipTrigger><TooltipContent className="max-w-xs">{col.policy}</TooltipContent></Tooltip>}
                  </div>
                  {(() => {
                    const perAssignee = col.limitScope === "assignee";
                    // The column's REAL load, not the filtered view of it. A WIP limit is a statement about
                    // the work in the column, and counting `items` made it move with the board's own filter -
                    // so turning on "My tasks" took a column from 6/5 to 1/5 and the warning with it. The
                    // kanban grid counts the column itself; this one did not.
                    const held = sprintCards.filter((c) => c.column_key === col.key).length;
                    const atWip = col.wipLimit != null && !perAssignee && held >= col.wipLimit;
                    // Over the limit is its own state, as it is on the kanban grid - at the limit is a warning
                    // not to start another, past it is a breach, and scrum drew both the same.
                    const overWip = col.wipLimit != null && !perAssignee && held > col.wipLimit;
                    const offenders = perAssignee && col.wipLimit != null
                      ? (() => {
                          const byAssignee = new Map<string, number>();
                          for (const c of sprintCards) if (c.column_key === col.key && c.assignee) { const a = idOf(c.assignee); byAssignee.set(a, (byAssignee.get(a) ?? 0) + 1); }
                          return [...byAssignee.entries()].filter(([, n]) => n > col.wipLimit!);
                        })()
                      : [];
                    return (
                      <div className="flex shrink-0 items-center gap-1">
                        {offenders.map(([id, n]) => (
                          <Tooltip key={id}>
                            <TooltipTrigger asChild>
                              <span className="rounded-full ring-2 ring-destructive"><PhotoAvatar employeeId={id} name={empName(`employees/${id}`)} className="h-5 w-5 text-[9px]" /></span>
                            </TooltipTrigger>
                            <TooltipContent>{empName(`employees/${id}`)}: {n} here — over the {col.wipLimit}-per-person limit</TooltipContent>
                          </Tooltip>
                        ))}
                        <Badge variant={overWip ? "destructive" : "secondary"} className={atWip && !overWip ? "border-warning text-warning" : ""} title={perAssignee && col.wipLimit != null ? `Max ${col.wipLimit} per assignee` : undefined}>
                          {held}{col.wipLimit != null ? (perAssignee ? ` (≤${col.wipLimit}/ea)` : ` / ${col.wipLimit}`) : ""}
                        </Badge>
                      </div>
                    );
                  })()}
                </div>
                <div
                  className={zoneCls(zid)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverZone(zid); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverZone((p) => (p === zid ? null : p)); }}
                  onDrop={(e) => { e.preventDefault(); void dropOnColumn(col.key); }}
                >
                  {items.map((c) => (
                    <CardTile key={c.path} card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => openCard(c)} />
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
            No sprint selected. Create a sprint, then drag backlog tasks into it and start it.
          </div>
        )}
      </div>

      {/* Charts */}
      {sprint && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4">
            <h4 className="mb-3 text-sm font-semibold">Burndown — {sprint.name}</h4>
            <BurndownChart sprint={sprint} cards={sprintCards} />
          </div>
          <div className="rounded-lg border p-4">
            <h4 className="mb-3 text-sm font-semibold">Velocity</h4>
            <VelocityChart sprints={sprints} cards={cards} selectedId={selId} onPick={setSelId} />
          </div>
        </div>
      )}

      {newSprint && <NewSprintDialog board={board} sprints={sprints} cards={cards} onClose={() => setNewSprint(false)} onSaved={(id) => { setSelId(id); reloadSprints(); }} />}
      {/* `boardCards` and `meId` on the create path for the reason the kanban grid gives: the duplicate-title
          warning, the WIP note and the "Me" shortcut are all for the moment a task is filed. */}
      {addBacklog && <CardDialog board={board} column={board.columns[0]?.key} employees={employees} goals={goals} departments={departments} boardCards={cards} meId={me.employee_id} onClose={() => setAddBacklog(false)} onSaved={() => { setAddBacklog(false); reload(); }} />}
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} queue={screenQueue} meId={me.employee_id} onOpenCard={openCard} onClose={closeCard} onSaved={() => { closeCard(); reload(); }} />}
    </TooltipProvider>
  );
}

// Working days inclusive of both ends, Mon-Fri. Holidays are a separate collection and deliberately not
// consulted here: this is the length of the box, not a capacity promise.
//
// Walks DAY STRINGS (lib/orgDay), not Date objects stepped by 86400e3. The old loop parsed local midnight and
// added a fixed day in milliseconds, which is only a calendar day until a DST boundary falls inside the span -
// and then the hour it shifts by either repeats a date or skips one, silently changing the count.
function workingDays(start: string, end: string): number {
  let n = 0;
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) {
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// The next "Sprint N" for a board, so nobody has to scroll the picker to find out where the numbering got to.
function nextSprintName(sprints: Sprint[]): string {
  const highest = sprints.reduce((max, s) => {
    const m = /(\d+)\s*$/.exec(s.name ?? "");
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `Sprint ${highest + 1}`;
}

function NewSprintDialog({ board, sprints, cards, onClose, onSaved }: { board: Board; sprints: Sprint[]; cards: CardT[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { toast } = useToast();
  // Pre-filled with the obvious sprint: the next number, starting today, two weeks long. The discard guard
  // snapshots this as the baseline, so a dialog opened and closed untouched still closes silently.
  const [form, setForm] = useState(() => {
    // Two weeks means fourteen days. It used to mean thirteen: `addDays` parsed local midnight and serialized
    // UTC, so in IST the end date came back one short of what the +13 asked for.
    const start = todayStr();
    return { name: nextSprintName(sprints), goal: "", start, end: addDaysYmd(start, 13) };
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const badRange = !!form.start && !!form.end && form.end < form.start;
  const span = !badRange && form.start && form.end
    ? { days: daysBetweenYmd(form.start, form.end) + 1, working: workingDays(form.start, form.end) }
    : null;

  // What this board has actually delivered, so the box is planned against evidence rather than optimism. Same
  // measure as the velocity chart: points on cards that reached the delivery column inside that sprint.
  const velocity = useMemo(() => {
    const done = sprints.filter((s) => s.state === "completed").slice(-3);
    return done.map((s) => ({
      name: s.name,
      points: cards.filter((c) => c.sprint && idOf(c.sprint) === idOf(s.path) && c.deliver_time).reduce((sum, c) => sum + (c.size ?? 0), 0),
    }));
  }, [sprints, cards]);
  const avgVelocity = velocity.length ? Math.round(velocity.reduce((s, v) => s + v.points, 0) / velocity.length) : null;

  // A sprint overlapping a live one is usually a mistyped date, not a plan - the board can only run one at a time.
  const clash = useMemo(() => {
    if (badRange || !form.start || !form.end) return null;
    return sprints.find((s) => s.state !== "completed" && !s.delete_time && s.start_date && s.end_date && s.start_date <= form.end && s.end_date >= form.start) ?? null;
  }, [sprints, form.start, form.end, badRange]);

  async function save() {
    const s = await create<Sprint>("sprints", {
      board: board.path,
      name: form.name.trim(),
      goal: form.goal.trim(),
      // `format: date` fields, and "" is not a date - an undated sprint leaves them out.
      ...(form.start ? { start_date: form.start } : {}),
      ...(form.end ? { end_date: form.end } : {}),
    });
    toast({ title: "Sprint created", variant: "success" });
    onSaved(idOf(s.path));
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="New sprint"
      description="Created in planning: pull backlog items in first, then press Start sprint to begin the box and the burndown."
      collection="sprints"
      guardLabel="sprint"
      form={form}
      submitLabel="Create sprint"
      canSubmit={!!form.name.trim() && !badRange}
      whyNot={!form.name.trim() ? "Give the sprint a name." : "The sprint ends before it starts."}
      onSubmit={save}
      submitAccess={(b) => <AccessAction collection="sprints" create label="Create a sprint">{b}</AccessAction>}
    >
      <Field label="Name"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Sprint 12" autoFocus /></Field>
      <Field label="Sprint goal (optional)" hint="Shown above the sprint board, so the team can tell whether a task belongs in this box.">
        <Textarea value={form.goal} onChange={(e) => set({ goal: e.target.value })} rows={2} placeholder="What this sprint aims to achieve." />
      </Field>
      <FieldRow>
        <Field label="Start date"><Input type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} /></Field>
        <Field label="End date" eager error={badRange ? "The end date is before the start date." : undefined}>
          <Input type="date" value={form.end} min={form.start || undefined} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </FieldRow>
      {span && <p className="text-xs text-muted-foreground">{span.days} days, {span.working} working.</p>}
      {avgVelocity != null && (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          The last {velocity.length === 1 ? "sprint" : `${velocity.length} sprints`} delivered {velocity.map((v) => v.points).join(", ")} points
          {velocity.length > 1 ? ` (about ${avgVelocity} a sprint)` : ""}. Pull in around that much, not everything on the backlog.
        </p>
      )}
      {clash && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{clash.name} ({clash.state}) already covers {clash.start_date} to {clash.end_date}. A board runs one sprint at a time.</span>
        </p>
      )}
    </WriteDialog>
  );
}

// Sprint burndown: remaining story points per day vs the ideal straight line. Theme-aware inline SVG.
function BurndownChart({ sprint, cards }: { sprint: Sprint; cards: CardT[] }) {
  if (!sprint.start_date || !sprint.end_date) return <p className="py-6 text-center text-sm text-muted-foreground">Set the sprint's start &amp; end dates to see the burndown.</p>;
  const total = cards.reduce((s, c) => s + (c.size ?? 0), 0);
  if (total === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Estimate tasks (size in points) to see the burndown.</p>;
  const DAY = 86_400_000;
  const start = new Date(sprint.start_date + "T00:00:00Z").getTime();
  const end = new Date(sprint.end_date + "T00:00:00Z").getTime();
  const days = Math.max(1, Math.round((end - start) / DAY));
  const actual = [];
  for (let i = 0; i <= days; i++) {
    const dayEnd = start + i * DAY + DAY - 1;
    const delivered = cards.reduce((s, c) => s + (c.deliver_time && new Date(c.deliver_time).getTime() <= dayEnd ? (c.size ?? 0) : 0), 0);
    actual.push(total - delivered);
  }
  // The actual line stops at today: a burndown that carries on past the present is a forecast pretending to
  // be a record. The ideal line runs the whole sprint, because that IS the plan.
  const todayIdx = Math.max(0, Math.min(days, Math.floor((Date.now() - start) / DAY)));
  const labels = Array.from({ length: days + 1 }, (_, i) => new Date(start + i * DAY).toISOString().slice(5, 10));
  return (
    <Chart
      type="line"
      height={200}
      labels={labels}
      datasets={[
        { name: "Remaining", values: actual.slice(0, todayIdx + 1) },
        { name: "Ideal", values: labels.map((_, i) => Math.round((total * (days - i)) / days)) },
      ]}
      format={(v) => `${v} pts`}
      hideDots
      ariaLabel="Sprint burndown: story points still to deliver on each day, against the ideal line"
      // Deliberately not a filter, for the reason the CFD gives: a point is the points still open on a past
      // day, which is a number and not a set of cards anything can be narrowed to.
    />
  );
}

// Velocity: story points delivered per completed sprint (bars).
function VelocityChart({ sprints, cards, selectedId, onPick }: {
  sprints: Sprint[];
  cards: CardT[];
  /** The sprint the view is on, so its bar stays lit. */
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const done = sprints.filter((s) => s.state === "completed");
  // DELIVERED points, which is what the series is called and what the planning dialog's "the last 3 sprints
  // delivered …" line counts. This summed every point still attached to the sprint, so a task that sat in the
  // box unfinished was counted as velocity - and the same board quoted two different numbers for the same
  // sprint, one here and one in New sprint.
  const data = done.map((s) => ({ name: s.name, points: cards.filter((c) => c.sprint && idOf(c.sprint) === idOf(s.path) && c.deliver_time).reduce((x, c) => x + (c.size ?? 0), 0) }));
  // The average is the point of a velocity chart - it is what the next sprint gets planned against - so it
  // rides along as a marker rather than being left for the reader to eyeball across the bars.
  const avg = data.length ? Math.round(data.reduce((s, d) => s + d.points, 0) / data.length) : 0;
  return (
    <Chart
      type="bar"
      height={200}
      labels={data.map((d) => d.name)}
      datasets={[{ name: "Delivered", values: data.map((d) => d.points) }]}
      markers={avg > 0 ? [{ label: `Average ${avg}`, value: avg }] : undefined}
      format={(v) => `${v} pts`}
      ariaLabel="Story points delivered in each completed sprint"
      emptyText="Complete a sprint to start tracking velocity."
      // A bar is a whole sprint, so pressing one opens it: the board above and the burndown beside this
      // chart both re-read against the sprint that was picked. "Why was that one slow" is the question this
      // chart provokes, and it was the one thing it could not answer.
      onSelect={(i) => { const s = done[i]; if (s) onPick(idOf(s.path)); }}
      selected={selectedId && done.findIndex((s) => idOf(s.path) === selectedId) >= 0 ? done.findIndex((s) => idOf(s.path) === selectedId) : null}
    />
  );
}
