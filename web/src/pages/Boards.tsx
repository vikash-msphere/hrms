import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KanbanSquare, Plus, BarChart3, Ban, X, ChevronUp, ChevronDown, ChevronsUp, ChevronLeft, ChevronRight,
  AlertTriangle, Trash2, Flag, Target, Search, Tag, Info, MessageSquare, CalendarDays, History, Building2, ListChecks, AlignLeft,
  MoreHorizontal, List as ListIcon, UserRound, FileText, ExternalLink,
} from "lucide-react";
import { create, get, invoke, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useRoute, setQueryParam } from "@/router";
import { DataTable, type Column } from "@/components/common/DataTable";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import { idOf, cn } from "@/lib/utils";
import { useCanSeeActivity } from "@/lib/perm";
import type { Me, Board, BoardMode, Card as CardT, CardComment, CardTodo, TicketChecklist, BoardColumn, WipScope, SwimlaneMode, Employee, Goal, Department, BoardMetrics, Sprint } from "@/types";
import type { Wire } from "@/wire";
import { resourceRoute } from "@/lib/resourceRoute";
import { PageHeader } from "@/components/common/PageHeader";
import { SettingsButton } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { useIntent } from "@/lib/intent";
import { Field } from "@/components/common/Field";
import { StatCard } from "@/components/common/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import type { Label as BoardLabel } from "@/types";
import { RichTextToolbar } from "@/components/common/RichTextToolbar";
import { RichText } from "@/lib/richText";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessTarget } from "@/components/access/AccessTarget";
import { ActivityFeed } from "@/components/common/ActivityFeed";
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
    const recompute = () => setHeight(Math.max(240, window.innerHeight - el.getBoundingClientRect().top - 16));
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);
  return { ref, height };
}

const NONE = "__none"; // lane key for cards with no assignee/goal/class/swimlane
const PRIORITY_LANES = [ // fixed swimlanes for swimlane_mode = "priority", severity high→low
  { key: "urgent", label: "Urgent" }, { key: "high", label: "High" }, { key: "medium", label: "Medium" }, { key: "low", label: "Low" },
];
const NO_DEPT = "__nodept"; // CardDialog: explicit "no department" (distinct from "" = use the org default)
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
type SavedFilter = { assignees?: string[]; priorities?: string[]; labels?: string[]; departments?: string[]; mine?: boolean };
function useCardFilter(meId?: string | null, storageKey?: string) {
  const [saved] = useState((): SavedFilter => {
    if (!storageKey) return {};
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as SavedFilter; } catch { return {}; }
  });
  const [q, setQ] = useState("");
  const [assignees, setAssignees] = useState<Set<string>>(new Set(saved.assignees));
  const [priorities, setPriorities] = useState<Set<string>>(new Set(saved.priorities));
  const [labels, setLabels] = useState<Set<string>>(new Set(saved.labels));
  const [departments, setDepartments] = useState<Set<string>>(new Set(saved.departments));
  const [mine, setMine] = useState(!!saved.mine);
  const active = !!q || assignees.size > 0 || priorities.size > 0 || labels.size > 0 || departments.size > 0 || mine;
  const clear = () => { setQ(""); setAssignees(new Set()); setPriorities(new Set()); setLabels(new Set()); setDepartments(new Set()); setMine(false); };
  useEffect(() => {
    if (!storageKey) return;
    if (assignees.size || priorities.size || labels.size || departments.size || mine) {
      localStorage.setItem(storageKey, JSON.stringify({ assignees: [...assignees], priorities: [...priorities], labels: [...labels], departments: [...departments], mine } satisfies SavedFilter));
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [assignees, priorities, labels, departments, mine, storageKey]);
  const effDept = (c: CardT) => (c.department ? idOf(c.department) : NONE);
  const match = (c: CardT) => {
    if (q && !`${c.title} ${c.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (mine && (!c.assignee || idOf(c.assignee) !== meId)) return false;
    if (assignees.size && !assignees.has(c.assignee ? idOf(c.assignee) : NONE)) return false;
    if (priorities.size && !priorities.has(c.priority)) return false;
    if (labels.size && !(c.labels ?? []).some((k) => labels.has(k))) return false;
    if (departments.size && !departments.has(effDept(c))) return false;
    return true;
  };
  return {
    q, setQ, mine, setMine, assignees, priorities, labels, departments, active, clear, match, effDept,
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
        <Input value={filter.q} onChange={(e) => filter.setQ(e.target.value)} placeholder="Search tasks…" className="h-8 w-52 pl-7" />
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
      {filter.active && (
        <>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={filter.clear}><X className="h-3.5 w-3.5" /> Clear</Button>
          <span className="text-xs text-muted-foreground">{shown} of {cards.length} task{cards.length === 1 ? "" : "s"}</span>
        </>
      )}
    </div>
  );
}

const LAST_BOARD_KEY = "boards:last";
const CARD_FETCH_CAP = 500; // follow the cards cursor up to here; past it the TruncationNotice takes over

export default function Boards({ me, openId }: { me: Me; openId?: string }) {
  const { rows: boards, state, error, reload } = useCollection<Board>("boards");
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
    setSelectedId(fromUrl ?? valid(localStorage.getItem(LAST_BOARD_KEY)) ?? idOf(boards[0]!.path));
  }, [boards, selectedId, route.query.board]);

  // Remember the selection and keep the URL shareable. Query-only hash writes don't add history entries here
  // (setQueryParam preserves the path), and the unsaved-changes guard ignores them.
  function selectBoard(id: string) {
    setSelectedId(id);
    localStorage.setItem(LAST_BOARD_KEY, id);
    setQueryParam("board", id);
  }

  // Deep link `#/boards/<cardId>` (from the activity feed): select that card's board so the view can open it.
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

      <TruncationNotice collection="cards" what="cards" className="mb-3" />
      <DataState state={state} error={error} onRetry={reload}>
        {boards.length === 0 ? (
          <EmptyState icon={KanbanSquare} title="No boards yet" description="Create a board to start tracking work with columns, WIP limits and swimlanes." action={newBtn} />
        ) : (
          <>
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
                <TabsContent value="list"><BoardListTab key={board.path} board={board} /></TabsContent>
                <TabsContent value="analytics"><AnalyticsTab board={board} /></TabsContent>
              </Tabs>
            )}
          </>
        )}
      </DataState>

      {newBoard && <NewBoardDialog onClose={() => setNewBoard(false)} onSaved={(id) => { setNewBoard(false); setSelectedId(id); reload(); }} />}
    </div>
  );
}

// ---- Board view: columns x swimlanes, native HTML5 drag-and-drop, WIP + policy on the header ----------------

function BoardView({ board, me, openId }: { board: Board; me: Me; openId?: string }) {
  const { rows: allCards, setRows, reload } = useCollection<CardT>("cards");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: goals } = useCollection<Goal>("goals");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const boardId = idOf(board.path);
  const [editing, setEditing] = useState<CardT | null>(null);
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
    try { return new Set(JSON.parse(localStorage.getItem(`boards:collapsed:${boardId}`) ?? "[]") as string[]); } catch { return new Set(); }
  });
  const toggleCollapse = (k: string) => setCollapsed((s) => {
    const n = toggleSet(s, k);
    localStorage.setItem(`boards:collapsed:${boardId}`, JSON.stringify([...n]));
    return n;
  });

  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  useDeepOpen(openId, cards, setEditing);
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

  // Swimlanes: derive the lane set + a card's lane key from the board's mode.
  const laneKeyOf = (c: CardT): string => {
    switch (board.swimlane_mode) {
      case "assignee": return c.assignee ? idOf(c.assignee) : NONE;
      case "goal": return c.goal ? idOf(c.goal) : NONE;
      case "priority": return c.priority || NONE;
      case "department": return c.department ? idOf(c.department) : NONE;
      case "custom": return c.swimlane_key || NONE;
      default: return "";
    }
  };
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
  }, [board, cards, empName, goalTitle, deptName, noneLabel]);

  const filter = useCardFilter(me.employee_id, `boards:filter:${boardId}`);
  const visible = cards.filter(filter.match);
  const cardsIn = (colKey: string, laneKey: string) =>
    visible
      .filter((c) => c.column_key === colKey && (board.swimlane_mode === "none" || laneKeyOf(c) === laneKey))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  // Apply the board's swimlane display prefs: optionally drop lanes with no cards under the current
  // filter. Never applies in "none" mode (single implicit lane).
  const laneHasCards = (laneKey: string) => board.columns.some((col) => cardsIn(col.key, laneKey).length > 0);
  const visibleLanes = board.swimlane_mode === "none" ? lanes : lanes.filter((l) => {
    if (board.hide_empty_lanes && !laneHasCards(l.key)) return false;
    return true;
  });

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
    // Optimistic move.
    setRows((prev) => prev.map((c) => (idOf(c.path) === id ? { ...c, ...patch } : c)));
    try {
      await invoke<CardT>(`cards/${id}`, "move", card.etag, move);
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
    try { await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, { to_column: toCol, rank }); }
    catch (e) { reload(); toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
  }
  async function menuPatch(card: CardT, body: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...body } : c)));
    try { await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); }
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

      <div ref={fillRef} style={{ height: fillH }} className="flex items-stretch gap-3 overflow-x-auto">
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
            <div key={col.key} className="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-sm font-medium">{col.label}</span>
                  {col.commitment && <Tooltip><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-primary" /></TooltipTrigger><TooltipContent>Commitment point — lead time starts here</TooltipContent></Tooltip>}
                  {col.delivery && <Tooltip><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-success" /></TooltipTrigger><TooltipContent>Delivery point — work is done here</TooltipContent></Tooltip>}
                  {col.policy && <Tooltip><TooltipTrigger asChild><span className="cursor-help text-xs text-muted-foreground">ⓘ</span></TooltipTrigger><TooltipContent className="max-w-xs">{col.policy}</TooltipContent></Tooltip>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {wipOffenders.map(([id, n]) => (
                    <Tooltip key={id}>
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
                    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => setQuick((k) => (k === col.key ? null : col.key))}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add task</TooltipContent></Tooltip>
                  </AccessAction>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => toggleCollapse(col.key)}><ChevronLeft className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Collapse</TooltipContent></Tooltip>
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
                          <CardTile card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => setEditing(c)} />
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

      {addTo && <CardDialog board={board} column={addTo} employees={employees} goals={goals} departments={departments} onClose={() => setAddTo(null)} onSaved={() => { setAddTo(null); reload(); }} />}
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} onOpenCard={(c) => setEditing(c)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </TooltipProvider>
  );
}

const STALE_AFTER_DAYS = 7; // aging signal: card untouched this long (and not delivered) gets a quiet dot

function CardTile({ card, assignee, catalog, goalName, blockerKey, deptLabel, menu, onDragStart, onClick }: { card: CardT; assignee: { id: string; name: string } | null; catalog: BoardLabel[]; goalName?: string; blockerKey?: string; deptLabel?: string; menu?: ReactNode; onDragStart: () => void; onClick: () => void }) {
  // Due chip: red when overdue, amber when due within 3 days, quiet otherwise. Hidden once delivered.
  const due = card.due_date && !card.deliver_time ? new Date(card.due_date) : null;
  const overdue = !!due && due < new Date();
  const dueSoon = !!due && !overdue && due.getTime() - Date.now() < 3 * 86400e3;
  const ageDays = card.update_time ? Math.floor((Date.now() - new Date(card.update_time).getTime()) / 86400e3) : 0;
  const stale = ageDays >= STALE_AFTER_DAYS && !card.deliver_time;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.path); onDragStart(); }}
      onClick={onClick}
      className="group relative cursor-grab overflow-hidden rounded-lg border bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      {card.blocked && <span className="absolute inset-y-0 left-0 w-1 bg-destructive" aria-hidden />}
      <div className="absolute right-1 top-1 z-10 flex items-center" onClick={(e) => e.stopPropagation()}>
        {menu}
        <AccessTarget target={{ collection: "cards", objectPath: card.path, can: card.access?.can, label: "Manage task access" }} />
      </div>
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
                <CalendarDays className="h-3 w-3" />{due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{overdue ? "Overdue — was due" : "Due"} {due.toLocaleDateString()}</TooltipContent>
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
          className="h-6 w-6 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
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

function CardDialog({ board, card, column, employees, goals, departments, boardCards = [], onOpenCard, onClose, onSaved }: {
  board: Board;
  card?: CardT;
  column?: string;
  employees: Employee[];
  goals: Goal[];
  departments: Department[];
  boardCards?: CardT[];
  onOpenCard?: (c: CardT) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const editing = !!card;
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
  const [blockReason, setBlockReason] = useState("");
  const [blockedBy, setBlockedBy] = useState(card?.blocked_by ? idOf(card.blocked_by) : "");
  const [busy, setBusy] = useState(false);
  // Concurrency token, kept fresh: checklist/comment verbs touch the card's update_time, bumping its etag, so the
  // held prop etag goes stale mid-dialog. Refresh from every response that returns the full card, or save 409s.
  const [etag, setEtag] = useState(card?.etag);
  const [comments, setComments] = useState<CardComment[]>(card?.comments ?? []);
  const [commentText, setCommentText] = useState("");
  const [todos, setTodos] = useState<CardTodo[]>(card?.todos ?? []);
  const [newTodo, setNewTodo] = useState("");
  const [initialTodos, setInitialTodos] = useState<string[]>([]); // staged checklist for a NEW card (no id yet)
  // Predefined checklist templates (shared catalog); the picker only shows those the caller can read.
  const { rows: checklists } = useCollection<TicketChecklist>("ticket-checklists");
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
  const [showActivity, setShowActivity] = useState(false);
  const canCardActivity = useCanSeeActivity("cards"); // gates the card Activity affordance (server ANDs with card read)
  const canEdit = !editing || (card!.access?.can ?? []).includes("update");
  const descRef = useRef<HTMLTextAreaElement>(null); // the formatting bar edits this textarea's source

  // Comments arrive only on the item Get (not the list), so load them when opening an existing card.
  useEffect(() => {
    if (!editing) return;
    let live = true;
    get<CardT>(`cards/${idOf(card!.path)}`).then((c) => { if (live) { setComments(c.comments ?? []); setTodos(c.todos ?? []); setEtag(c.etag); } }).catch(() => { /* keep what we have */ });
    return () => { live = false; };
  }, [editing, card]);

  // Checklist mutation: invoke a todo verb, refresh the list from the response.
  async function todoAct(verb: "addTodos" | "toggleTodo" | "removeTodo", body: Record<string, unknown>) {
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

  const commenterName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (cm: CardComment) => (cm.author ? m.get(idOf(cm.author)) ?? "Someone" : cm.author_email ?? "Someone");
  }, [employees]);

  async function addComment() {
    if (!commentText.trim()) return;
    setBusy(true);
    try {
      const res = await invoke<CardT>(`cards/${idOf(card!.path)}`, "comment", undefined, { body: commentText.trim() });
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

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || null,
      priority,
      assignee: assignee ? `employees/${assignee}` : null,
      goal: goal ? `goals/${goal}` : null,
      labels,
      documents: docs.map((id) => `org-documents/${id}`),
      size: size ? Number(size) : null,
      due_date: due || null,
      ...(board.swimlane_mode === "custom" ? { swimlane_key: swimlane || null } : {}),
    };
    // "" = untouched new card -> omit so the server applies the org default. Otherwise send the choice.
    if (department !== "") body.department = department === NO_DEPT ? null : `departments/${department}`;
    try {
      if (editing) await patch<CardT>(`cards/${idOf(card!.path)}`, body, etag);
      else await create<CardT>("cards", { board: board.path, column_key: column, ...body, ...(initialTodos.length ? { initial_todos: initialTodos } : {}) });
      toast({ title: editing ? "Task saved" : "Task added", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function act(verb: string, body?: Record<string, unknown>) {
    setBusy(true);
    try {
      await invoke(`cards/${idOf(card!.path)}`, verb, etag, body);
      toast({ title: "Done", variant: "success" });
      onSaved();
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
  // updates live behind the dialog.
  async function moveStatus(toCol: string) {
    setBusy(true);
    try { await invoke(`cards/${idOf(card!.path)}`, "move", undefined, { to_column: toCol }); setCurColumn(toCol); }
    catch (e) { toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

  const can = card?.access?.can ?? [];
  return (
    <>
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <AccessScope collection="cards" objectPath={card?.path}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing && <span className="font-mono text-xs text-muted-foreground">{taskKey(card!)}</span>}
            <span>{editing ? "Task" : "New task"}</span>
          </DialogTitle>
        </DialogHeader>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" disabled={!canEdit} />
        </Field>
        {/* Markdown-lite source in a plain textarea (same contract as board posts): the bar transforms the
            text, storage is exactly what's shown, and richToPlain-free rendering via <RichText>. Readers who
            can't edit get the rendered description, not a disabled box of markup. */}
        <Field label="Description">
          {canEdit ? (
            <div>
              <RichTextToolbar textareaRef={descRef} value={description} onChange={setDescription} />
              <Textarea ref={descRef} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="rounded-t-none" />
            </div>
          ) : description ? (
            <RichText source={description} className="space-y-1.5 text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </Field>
        {/* Two-column field grid. When an odd number of fields is visible (Status is edit-only; Labels/Swimlane
            are board-conditional), the lone trailing field spans both columns so no half-width orphan is left. */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 [&>*:last-child:nth-child(odd)]:col-span-2">
          {/* Workflow + owner */}
          {editing && (
            <Field label="Status">
              <AccessAction verb="move" label="Who can move tasks">
                <Select value={curColumn} onValueChange={moveStatus} disabled={busy || !(card!.access?.can ?? []).includes("move")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{board.columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </AccessAction>
            </Field>
          )}
          <Field label="Assignee">
            <Combobox value={assignee} onValueChange={setAssignee} options={empOptions} placeholder="Unassigned" />
          </Field>
          <Field label="Department">
            <Combobox value={department} onValueChange={setDepartment} options={deptOptions} placeholder="Org default department" />
          </Field>
          {/* Urgency + deadline */}
          <Field label="Priority">
            <Select value={priority} onValueChange={(v) => setPriority(v as CardT["priority"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={!canEdit} />
          </Field>
          {/* Estimate + tags */}
          <Field label="Points">
            <Input type="number" value={size} onChange={(e) => setSize(e.target.value)} disabled={!canEdit} />
          </Field>
          {board.labels.length > 0 && (
            <Field label="Labels">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 w-full justify-start font-normal">
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
            <Combobox value={goal} onValueChange={setGoal} options={goalOptions} placeholder="No goal" />
          </Field>
          {board.swimlane_mode === "custom" && (
            <Field label="Swimlane">
              <Select value={swimlane || NONE} onValueChange={(v) => setSwimlane(v === NONE ? "" : v)}>
                <SelectTrigger><SelectValue placeholder={board.no_lane_label || "Ungrouped"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{board.no_lane_label || "Ungrouped"}</SelectItem>
                  {board.swimlanes.map((l) => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>

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
                    <a href={`#/${resourceRoute("org-documents", `org-documents/${id}`) ?? "documents"}`} className="inline-flex items-center gap-1 hover:underline">
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
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ListChecks className="h-4 w-4" /> Checklist
                {todos.length > 0 && <span className="text-xs font-normal text-muted-foreground">{todoDone}/{todos.length} done</span>}
              </p>
              {can.includes("addTodos") && checklists.length > 0 && (
                <Select value="" disabled={busy} onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl?.items?.length) todoAct("addTodos", { texts: cl.items }); }}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Apply template…" /></SelectTrigger>
                  <SelectContent>{checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </div>
            {todos.length > 0 && (
              <div className="space-y-1.5">
                {todos.map((t) => (
                  <div key={t.id} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                    <Checkbox checked={t.done} disabled={busy || !can.includes("toggleTodo")} onCheckedChange={(v) => todoAct("toggleTodo", { todo: t.id, done: !!v })} />
                    <span className={cn("flex-1", t.done && "text-muted-foreground line-through")}>{t.text}</span>
                    {can.includes("removeTodo") && <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" disabled={busy} onClick={() => todoAct("removeTodo", { todo: t.id })} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </div>
                ))}
              </div>
            )}
            {can.includes("addTodos") && (
              <div className="flex items-center gap-2">
                <Input className="h-8" placeholder="Add a checklist item…" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newTodo.trim()) { e.preventDefault(); todoAct("addTodos", { texts: [newTodo.trim()] }); setNewTodo(""); } }} />
                <Button size="sm" variant="outline" loading={busy} disabled={!newTodo.trim()} onClick={() => { const v = newTodo.trim(); if (v) { todoAct("addTodos", { texts: [v] }); setNewTodo(""); } }}><Plus className="h-4 w-4" /> Add</Button>
              </div>
            )}
          </div>
        )}

        {!editing && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ListChecks className="h-4 w-4" /> Checklist
                {initialTodos.length > 0 && <span className="text-xs font-normal text-muted-foreground">{initialTodos.length} item{initialTodos.length === 1 ? "" : "s"}</span>}
              </p>
              {checklists.length > 0 && (
                <Select value="" onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl?.items?.length) setInitialTodos((s) => [...s, ...cl.items]); }}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Apply template…" /></SelectTrigger>
                  <SelectContent>{checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </div>
            {initialTodos.length > 0 && (
              <div className="space-y-1.5">
                {initialTodos.map((t, i) => (
                  <div key={i} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                    <span className="flex-1">{t}</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => setInitialTodos((s) => s.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input className="h-8" placeholder="Add a checklist item…" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newTodo.trim()) { e.preventDefault(); setInitialTodos((s) => [...s, newTodo.trim()]); setNewTodo(""); } }} />
              <Button size="sm" variant="outline" disabled={!newTodo.trim()} onClick={() => { const v = newTodo.trim(); if (v) { setInitialTodos((s) => [...s, v]); setNewTodo(""); } }}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          </div>
        )}

        {editing && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">Comments</p>
            {comments.length > 0 ? (
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {comments.map((cm, i) => (
                  <li key={i} className="rounded-md bg-muted/40 p-2 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium">{commenterName(cm)}</span>
                      {cm.create_time && <span className="text-[11px] text-muted-foreground">{new Date(cm.create_time).toLocaleString()}</span>}
                    </div>
                    <p className="whitespace-pre-wrap leading-snug">{cm.body}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">No comments yet.</p>}
            {can.includes("comment") && (
              <div className="flex items-start gap-2">
                <Textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} rows={2} placeholder="Add a comment…" className="flex-1" />
                <AccessAction verb="comment" label="Who can comment"><Button size="sm" onClick={addComment} loading={busy} disabled={!commentText.trim()}>Comment</Button></AccessAction>
              </div>
            )}
          </div>
        )}


        {editing && (
          <div className="space-y-2 border-t pt-3">
            {card!.blocked ? (
              <div className="flex flex-wrap items-center gap-2">
                {(() => {
                  const blocker = card!.blocked_by ? boardCards.find((x) => idOf(x.path) === idOf(card!.blocked_by!)) : undefined;
                  return (
                    <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
                      <Ban className="h-4 w-4" /> Blocked
                      {blocker && onOpenCard && (
                        <>by <button type="button" className="font-medium underline hover:no-underline" onClick={() => onOpenCard(blocker)}>{taskKey(blocker)} {blocker.title}</button></>
                      )}
                      {card!.block_reason && <span className="text-muted-foreground">— {card!.block_reason}</span>}
                    </span>
                  );
                })()}
                {can.includes("unblock") && <AccessAction verb="unblock" label="Who can unblock"><Button size="sm" variant="outline" onClick={() => act("unblock")} loading={busy}>Unblock</Button></AccessAction>}
              </div>
            ) : (
              can.includes("block") && (
                <div className="flex items-center gap-2">
                  <div className="flex-1"><Combobox value={blockedBy} onValueChange={setBlockedBy} options={boardCards.filter((x) => idOf(x.path) !== idOf(card!.path)).map((x) => ({ value: idOf(x.path), label: `${taskKey(x)} ${x.title}` }))} placeholder="Blocked by a task…" /></div>
                  <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Note (optional)…" className="flex-1" />
                  <AccessAction verb="block" label="Who can block"><Button variant="outline" className="shrink-0" onClick={() => act("block", { blocked_by: blockedBy ? `cards/${blockedBy}` : undefined, reason: blockReason || undefined })} loading={busy} disabled={!blockedBy && !blockReason}><Ban className="h-3.5 w-3.5" /> Block</Button></AccessAction>
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

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-1">
            {editing && canCardActivity && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowActivity(true)}><History className="h-4 w-4" /> Activity</Button>}
            {editing && (
              <AccessAction label="Delete task" can={can}>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={del} loading={busy} disabled={!can.includes("delete")}><Trash2 className="h-4 w-4" /> Delete</Button>
              </AccessAction>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {editing
              ? <AccessAction label="Edit task" can={can}><Button onClick={save} loading={busy} disabled={!title.trim() || !canEdit}>Save</Button></AccessAction>
              : <AccessAction create label="Create a task"><Button onClick={save} loading={busy} disabled={!title.trim()}>Add task</Button></AccessAction>}
          </div>
        </DialogFooter>
        </AccessScope>
      </DialogContent>
    </Dialog>
    {editing && showActivity && (
      <Dialog open onOpenChange={(o) => !o && setShowActivity(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><History className="h-4 w-4" /> Activity · {taskKey(card!)}</DialogTitle></DialogHeader>
          <ActivityFeed resource={card!.path} />
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}

// ---- New board --------------------------------------------------------------------------------------------

function NewBoardDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prefix, setPrefix] = useState("");
  const [mode, setMode] = useState<BoardMode>("kanban");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    const cleanPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    try {
      const b = await create<Board>("boards", { name: name.trim(), description: description.trim() || null, mode, ...(cleanPrefix ? { task_prefix: cleanPrefix } : {}) });
      toast({ title: "Board created", variant: "success" });
      onSaved(idOf(b.path));
    } catch (e) {
      toast({ title: "Couldn't create", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && name.trim()) save(); }}>
        <DialogHeader><DialogTitle>New board</DialogTitle></DialogHeader>
        <Field label="Method" hint="Kanban = continuous flow. Scrum = time-boxed sprints (backlog, sprint board, burndown & velocity).">
          <Select value={mode} onValueChange={(v) => setMode(v as BoardMode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="kanban">Kanban (continuous flow)</SelectItem>
              <SelectItem value="scrum">Scrum (sprints)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Platform team" /></Field>
        <Field label="Task key prefix" hint="For task keys like MS-12. Blank auto-derives from the name.">
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="auto (e.g. MS)" className="w-40 uppercase" maxLength={6} />
        </Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        <p className="text-xs text-muted-foreground">Starts with a standard backlog → ready → in progress → review → done flow. Reshape it with Configure.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>Create board</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ---- Analytics: cumulative flow diagram + lead/cycle time + throughput --------------------------------------

const SERIES = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"]; // validated categorical order
const SERIES_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

function AnalyticsTab({ board }: { board: Board }) {
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

  if (loading && !metrics) return <p className="py-10 text-center text-sm text-muted-foreground">Loading analytics…</p>;
  if (!metrics) return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Lead time (p50)" value={`${metrics.lead_time.p50}d`} icon={Flag} hint={`p85 ${metrics.lead_time.p85}d · ${metrics.lead_time.count} delivered`} tone="primary" />
        <StatCard label="Cycle time (p50)" value={`${metrics.cycle_time.p50}d`} icon={BarChart3} hint={`p85 ${metrics.cycle_time.p85}d`} tone="primary" />
        <StatCard label="Throughput" value={`${metrics.throughput.per_week}/wk`} icon={KanbanSquare} hint={`${metrics.throughput.delivered} in ${days}d`} tone="success" />
        <StatCard label="Avg cycle time" value={`${metrics.cycle_time.avg}d`} icon={BarChart3} tone="muted" />
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

// Stacked-area cumulative flow diagram. Columns are stacked in board order (delivery on top), each a fixed
// categorical hue. Theme-aware via a scoped style block; a legend names every band (identity never color-alone).
function CfdChart({ metrics }: { metrics: BoardMetrics }) {
  const W = 720, H = 260, PAD_L = 36, PAD_B = 28, PAD_T = 8, PAD_R = 8;
  const { cfd, columns } = metrics;
  const [hover, setHover] = useState<number | null>(null);
  if (cfd.length === 0 || columns.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No flow data yet — create and move some tasks.</p>;

  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxTotal = Math.max(1, ...cfd.map((d) => columns.reduce((s, c) => s + (d.counts[c.key] ?? 0), 0)));
  const x = (i: number) => PAD_L + (cfd.length === 1 ? plotW / 2 : (i / (cfd.length - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / maxTotal) * plotH;

  // Build stacked bands bottom-up (first column at the bottom).
  const bands = columns.map((col, ci) => {
    const pts = cfd.map((d, i) => {
      const below = columns.slice(0, ci).reduce((s, c) => s + (d.counts[c.key] ?? 0), 0);
      const top = below + (d.counts[col.key] ?? 0);
      return { i, below, top };
    });
    const topLine = pts.map((p) => `${x(p.i)},${y(p.top)}`).join(" ");
    const botLine = pts.slice().reverse().map((p) => `${x(p.i)},${y(p.below)}`).join(" ");
    return { key: col.key, label: col.label, ci, poly: `${topLine} ${botLine}` };
  });

  const yTicks = [0, Math.ceil(maxTotal / 2), maxTotal];
  const xTickIdx = cfd.length <= 1 ? [0] : [0, Math.floor((cfd.length - 1) / 2), cfd.length - 1];
  const hoverDay = hover != null ? cfd[hover] : null;

  return (
    <div className="cfd-viz">
      <style>{`
        .cfd-viz { --ink:#52514e; --grid:#e6e6e3; ${SERIES.map((c, i) => `--s${i}:${c};`).join("")} }
        .dark .cfd-viz, :root[data-theme="dark"] .cfd-viz { --ink:#c3c2b7; --grid:#333330; ${SERIES_DARK.map((c, i) => `--s${i}:${c};`).join("")} }
        @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cfd-viz { --ink:#c3c2b7; --grid:#333330; ${SERIES_DARK.map((c, i) => `--s${i}:${c};`).join("")} } }
      `}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative flow diagram"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD_L) / plotW) * (cfd.length - 1));
          setHover(Math.max(0, Math.min(cfd.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--ink)">{t}</text>
          </g>
        ))}
        {bands.map((b) => (
          <polygon key={b.key} points={b.poly} fill={`var(--s${b.ci % 8})`} stroke="var(--grid)" strokeWidth={0.5} opacity={0.9} />
        ))}
        {xTickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--ink)">{cfd[i]!.date.slice(5)}</text>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--ink)" strokeWidth={1} strokeDasharray="3 3" />}
      </svg>

      {hoverDay && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{hoverDay.date}</span>
          {columns.map((c) => ` · ${c.label} ${hoverDay.counts[c.key] ?? 0}`).join("")}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {columns.map((c, i) => (
          <span key={c.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--s${i % 8})` }} /> {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- List view: the board's tasks as a flat DataTable ------------------------------------------------------
// Everything DataTable brings comes free: sort, per-column filters, column chooser, CSV/Excel export, saved
// views, URL state, mobile cards, and cursor-following "Load more". Row click opens the same task dialog.

function BoardListTab({ board }: { board: Board }) {
  const { rows: allCards, reload, hasMore, loadMore } = useCollection<CardT>("cards");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: goals } = useCollection<Goal>("goals");
  const { rows: departments } = useCollection<Department>("departments");
  const boardId = idOf(board.path);
  const [editing, setEditing] = useState<CardT | null>(null);
  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);
  const colLabel = useMemo(() => new Map(board.columns.map((c) => [c.key, c.label])), [board.columns]);

  const columns: Column<CardT>[] = useMemo(() => [
    { id: "key", header: "Key", accessor: (c) => taskKey(c), cell: (c) => <span className="font-mono text-xs text-muted-foreground">{taskKey(c)}</span>, mobilePriority: 2 },
    { id: "title", header: "Title", accessor: (c) => c.title, mobilePriority: 1 },
    { id: "status", header: "Status", accessor: (c) => colLabel.get(c.column_key) ?? c.column_key, filter: "select", mobilePriority: 3 },
    { id: "assignee", header: "Assignee", accessor: (c) => (c.assignee ? empName(c.assignee) : "Unassigned"), filter: "select", mobilePriority: 4 },
    { id: "priority", header: "Priority", accessor: (c) => c.priority, filter: "select", cell: (c) => <span className="flex items-center gap-1 capitalize"><PriorityIcon p={c.priority} /> {c.priority}</span> },
    { id: "points", header: "Points", accessor: (c) => c.size ?? null, align: "right", filter: "none" },
    { id: "due", header: "Due", accessor: (c) => c.due_date ?? null, filter: "none" },
    { id: "labels", header: "Labels", accessor: (c) => (c.labels ?? []).map((k) => board.labels.find((l) => l.key === k)?.label ?? k).join(", "), cell: (c) => <span className="flex flex-wrap gap-1"><LabelChips keys={c.labels} catalog={board.labels} max={3} /></span>, defaultHidden: board.labels.length === 0 },
    { id: "blocked", header: "Blocked", accessor: (c) => (c.blocked ? "Blocked" : ""), filter: "select", cell: (c) => (c.blocked ? <span className="inline-flex items-center gap-1 text-destructive"><Ban className="h-3.5 w-3.5" /> Blocked</span> : null), defaultHidden: true },
    { id: "updated", header: "Updated", accessor: (c) => c.update_time ?? "", cell: (c) => (c.update_time ? new Date(c.update_time).toLocaleDateString() : ""), defaultHidden: true },
  ], [colLabel, empName, board.labels]);

  return (
    <TooltipProvider delayDuration={150}>
      <DataTable
        columns={columns}
        rows={cards}
        getRowId={(c) => c.path}
        onRowClick={setEditing}
        tableId="board-list"
        accessCollection="cards"
        accessTargetOf={(c) => ({ objectPath: c.path, can: c.access?.can, label: "Manage task access" })}
        hasMore={hasMore}
        onLoadMore={loadMore}
        emptyTitle="No tasks on this board"
        emptyDescription="Tasks you add on the Board tab show up here as a sortable, exportable list."
      />
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} onOpenCard={(c) => setEditing(c)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </TooltipProvider>
  );
}

// ---- Scrum view: product backlog + the sprint board + burndown/velocity ------------------------------------

function ScrumView({ board, me, openId }: { board: Board; me: Me; openId?: string }) {
  const { rows: allCards, setRows, reload } = useCollection<CardT>("cards");
  const { rows: allSprints, reload: reloadSprints } = useCollection<Sprint>("sprints");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: goals } = useCollection<Goal>("goals");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const confirm = useConfirm();
  const boardId = idOf(board.path);
  const dragId = useRef<string | null>(null);
  const { ref: fillRef, height: fillH } = useFillHeight();
  const [overZone, setOverZone] = useState<string | null>(null);
  const pendingRank = useRef<number | null>(null); // backlog insertion rank from the hovered gap
  const [lineAt, setLineAt] = useState<string | null>(null); // `${cardPath}:t|b` — backlog insertion line
  const [editing, setEditing] = useState<CardT | null>(null);
  useRefetchOnFocus(() => { reload(); reloadSprints(); });
  const [addBacklog, setAddBacklog] = useState(false);
  const [quickBacklog, setQuickBacklog] = useState(false); // inline title composer on the backlog column
  // "+ New → Create a task" quick action: open the backlog composer (scrum boards).
  useIntent("new-card", () => setAddBacklog(true));
  const [newSprint, setNewSprint] = useState(false);
  const [busy, setBusy] = useState(false);

  const cards = useMemo(() => allCards.filter((c) => c.board && idOf(c.board) === boardId && !c.delete_time), [allCards, boardId]);
  useDeepOpen(openId, cards, setEditing);
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
  const backlog = useMemo(() => cards.filter((c) => !c.sprint).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)), [cards]);
  const sprintCards = useMemo(() => (sprint ? cards.filter((c) => c.sprint && idOf(c.sprint) === idOf(sprint.path)) : []), [cards, sprint]);
  const pts = (list: CardT[]) => list.reduce((s, c) => s + (c.size ?? 0), 0);

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
      // One atomic op: the move verb also reassigns the sprint (no separate PATCH, one event).
      await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: colKey, rank, ...(inSprint ? {} : { to_sprint: sprint.path }) });
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
      await invoke<CardT>(`cards/${id}`, "move", card.etag, { to_column: card.column_key, to_sprint: null, ...(rank != null ? { rank } : {}) });
    } catch (e) {
      reload();
      toast({ title: "Couldn't move to backlog", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Menu-driven moves (the touch path). `menuAct` = move verb with optimistic apply; `menuPatch` = field edit.
  async function menuAct(card: CardT, body: Record<string, unknown>, optimistic: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...optimistic } : c)));
    try { await invoke<CardT>(`cards/${idOf(card.path)}`, "move", card.etag, body); }
    catch (e) { reload(); toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" }); }
  }
  async function menuPatch(card: CardT, body: Partial<CardT>) {
    setRows((prev) => prev.map((c) => (c.path === card.path ? { ...c, ...body } : c)));
    try { await patch<CardT>(`cards/${idOf(card.path)}`, body as Record<string, unknown>, card.etag); }
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
        const daysLeft = sprint.state === "active" && sprint.end_date
          ? Math.floor((new Date(sprint.end_date + "T23:59:59").getTime() - Date.now()) / 86400e3)
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

      <div ref={fillRef} style={{ height: fillH }} className="flex items-stretch gap-3 overflow-x-auto">
        {/* Product backlog */}
        <div
          className="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/20"
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
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => setQuickBacklog((v) => !v)}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add task</TooltipContent></Tooltip>
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
                  <CardTile card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => setEditing(c)} />
                  <span className={`pointer-events-none absolute inset-x-1 -bottom-1 z-10 h-0.5 rounded bg-primary ${lineAt === `${c.path}:b` ? "" : "hidden"}`} />
                </div>
              ));
            })()}
          </div>
        </div>

        {/* The selected sprint's board */}
        {sprint ? (
          board.columns.map((col) => {
            const items = sprintCards.filter((c) => c.column_key === col.key && filter.match(c)).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
            const zid = `col:${col.key}`;
            return (
              <div key={col.key} className="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{col.label}</span>
                    {col.commitment && <Tooltip><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-primary" /></TooltipTrigger><TooltipContent>Commitment point — lead time starts here</TooltipContent></Tooltip>}
                    {col.delivery && <Tooltip><TooltipTrigger asChild><Flag className="h-3.5 w-3.5 text-success" /></TooltipTrigger><TooltipContent>Delivery point — work is done here</TooltipContent></Tooltip>}
                    {col.policy && <Tooltip><TooltipTrigger asChild><span className="cursor-help text-xs text-muted-foreground">ⓘ</span></TooltipTrigger><TooltipContent className="max-w-xs">{col.policy}</TooltipContent></Tooltip>}
                  </div>
                  {(() => {
                    const perAssignee = col.limitScope === "assignee";
                    const atWip = col.wipLimit != null && !perAssignee && items.length >= col.wipLimit;
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
                        <Badge variant="secondary" className={atWip ? "border-warning text-warning" : ""} title={perAssignee && col.wipLimit != null ? `Max ${col.wipLimit} per assignee` : undefined}>
                          {items.length}{col.wipLimit != null ? (perAssignee ? ` (≤${col.wipLimit}/ea)` : ` / ${col.wipLimit}`) : ""}
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
                    <CardTile key={c.path} card={c} assignee={assigneeOf(c)} catalog={board.labels} goalName={c.goal ? goalTitle(c.goal) : undefined} blockerKey={blockerKeyOf(c)} deptLabel={c.department ? deptName(c.department) : undefined} menu={tileMenu(c)} onDragStart={() => { dragId.current = idOf(c.path); }} onClick={() => setEditing(c)} />
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
            <VelocityChart sprints={sprints} cards={cards} />
          </div>
        </div>
      )}

      {newSprint && <NewSprintDialog board={board} onClose={() => setNewSprint(false)} onSaved={(id) => { setNewSprint(false); setSelId(id); reloadSprints(); }} />}
      {addBacklog && <CardDialog board={board} column={board.columns[0]?.key} employees={employees} goals={goals} departments={departments} onClose={() => setAddBacklog(false)} onSaved={() => { setAddBacklog(false); reload(); }} />}
      {editing && <CardDialog key={editing.path} board={board} card={editing} employees={employees} goals={goals} departments={departments} boardCards={cards} onOpenCard={(c) => setEditing(c)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </TooltipProvider>
  );
}

function NewSprintDialog({ board, onClose, onSaved }: { board: Board; onClose: () => void; onSaved: (id: string) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const s = await create<Sprint>("sprints", { board: board.path, name: name.trim(), goal: goal.trim() || null, start_date: start || null, end_date: end || null });
      toast({ title: "Sprint created", variant: "success" });
      onSaved(idOf(s.path));
    } catch (e) {
      toast({ title: "Couldn't create", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && name.trim()) save(); }}>
        <DialogHeader><DialogTitle>New sprint</DialogTitle></DialogHeader>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sprint 12" /></Field>
        <Field label="Sprint goal"><Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="What this sprint aims to achieve." /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End date"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>Create sprint</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const W = 340, H = 180, PL = 28, PB = 20, PT = 8, PR = 8;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const now = Date.now();
  const x = (i: number) => PL + (i / days) * plotW;
  const y = (v: number) => PT + plotH - (v / total) * plotH;
  const ideal = `${x(0)},${y(total)} ${x(days)},${y(0)}`;
  // Only draw the actual line up to today (don't project the future).
  const todayIdx = Math.max(0, Math.min(days, Math.floor((now - start) / DAY)));
  const actualLine = actual.slice(0, todayIdx + 1).map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <div className="viz-b">
      <style>{`.viz-b{--ink:#52514e;--grid:#e6e6e3;--a:#2a78d6;--i:#94a3b8}.dark .viz-b,:root[data-theme="dark"] .viz-b{--ink:#c3c2b7;--grid:#333330;--a:#3987e5;--i:#64748b}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .viz-b{--ink:#c3c2b7;--grid:#333330;--a:#3987e5;--i:#64748b}}`}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sprint burndown">
        <line x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} stroke="var(--grid)" />
        <line x1={PL} x2={W - PR} y1={y(total)} y2={y(total)} stroke="var(--grid)" />
        <text x={PL - 5} y={y(total) + 3} textAnchor="end" fontSize={9} fill="var(--ink)">{total}</text>
        <text x={PL - 5} y={y(0) + 3} textAnchor="end" fontSize={9} fill="var(--ink)">0</text>
        <polyline points={ideal} fill="none" stroke="var(--i)" strokeWidth={1.5} strokeDasharray="4 3" />
        <polyline points={actualLine} fill="none" stroke="var(--a)" strokeWidth={2} />
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: "var(--a)" }} /> Remaining</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 border-t border-dashed" style={{ borderColor: "var(--i)" }} /> Ideal</span>
      </div>
    </div>
  );
}

// Velocity: story points delivered per completed sprint (bars).
function VelocityChart({ sprints, cards }: { sprints: Sprint[]; cards: CardT[] }) {
  const done = sprints.filter((s) => s.state === "completed");
  const data = done.map((s) => ({ name: s.name, points: cards.filter((c) => c.sprint && idOf(c.sprint) === idOf(s.path)).reduce((x, c) => x + (c.size ?? 0), 0) }));
  if (data.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Complete a sprint to start tracking velocity.</p>;
  const max = Math.max(1, ...data.map((d) => d.points));
  return (
    <div className="viz-v">
      <style>{`.viz-v{--bar:#1baf7a;--ink:#52514e}.dark .viz-v,:root[data-theme="dark"] .viz-v{--bar:#199e70;--ink:#c3c2b7}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .viz-v{--bar:#199e70;--ink:#c3c2b7}}`}</style>
      <div className="flex h-[180px] items-end gap-2">
        {data.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-muted-foreground">{d.points}</span>
            <div className="w-full rounded-t" style={{ height: `${(d.points / max) * 140}px`, background: "var(--bar)", minHeight: 2 }} />
            <span className="w-full truncate text-center text-[10px] text-muted-foreground" title={d.name}>{d.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
