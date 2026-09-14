import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Check, X, ChevronDown, ChevronLeft, ChevronRight, Send, LifeBuoy, MessageSquare, ListChecks, Trash2, AlertCircle, Users, Link2, SquareKanban, Paperclip, Video, ExternalLink } from "lucide-react";
import { replayUrl, sentryEnabled } from "@/instrument";
import { startRecording } from "@/lib/screenRecording";
import { DEFAULT_TICKET_CATEGORIES } from "../../../src/domain/tickets";
import { create, download, get, invoke, upload } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { useIntent } from "@/lib/intent";
import { cn, formatBytes, formatDate, humanize, idOf, initials } from "@/lib/utils";
import { useRowKeys } from "@/lib/rowKeys";
import { setRouteRecord, recordUrl } from "@/router";
import { timeAgo } from "@/lib/activity";
import { RichText } from "@/lib/richText";
import { isConflict } from "@/lib/formError";
import { useMentions } from "@/components/common/MentionPicker";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { MakeTaskDialog } from "@/components/common/MakeTaskDialog";
import type { Employee, Department, Ticket, TicketCategory, TicketChecklist, Me } from "@/types";
import { seedSeen, saveSeen, type SeenMap } from "@/lib/ticketsSeen";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { DataTable, type BulkAction, type Column } from "@/components/common/DataTable";
import { bulkInvoke, bulkSummary } from "@/lib/bulk";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { topSlices } from "@/lib/chartTheme";
import { useKpiFocus } from "@/lib/kpiFocus";
import { useChartFocus } from "@/lib/chartFocus";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { useConfirm } from "@/components/common/confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { ActivityBadge } from "@/components/common/ActivityBadge";
import { useTabActivity, markTabSeen } from "@/lib/tabActivity";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
import { FormError } from "@/components/common/FormError";
import { describeError } from "@/lib/formError";
import { useToast } from "@/components/ui/use-toast";
import { useTicketWorkflow, ticketStatusMeta, ticketMove, ticketMovesFrom, ticketStatusLabel } from "@/lib/ticketWorkflow";
import { getSetting } from "@/lib/settingsStore";

const upper = (s?: string) => (s ?? "").toUpperCase();
const TERMINAL = new Set(["CLOSED", "CANCELLED"]);
// "Updated since you last opened it" is tracked client-side; the map and its pruning rule live in
// lib/ticketsSeen.ts, which the boot-time sweep also reaches.
// Comment/date stamps in the thread need the time of day - several replies can land on the same date.
const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-";
const isActive = (t: Ticket) => !TERMINAL.has(upper(t.state));
const EMPTY = { category: "", department: "", subject: "", description: "", priority: "medium", todos: [] as string[] };
// Mirrors MAX_TICKET_ATTACHMENTS in src/domain/ticketAttachments.ts: the server is authoritative, this only
// stops the picker offering an eleventh file that would be refused.
const MAX_ATTACHMENTS = 10;

// Priority chip tones (low/medium/high) for a quick visual scan.
const PRIORITY_TONE: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};
function PriorityBadge({ value }: { value?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_TONE[value ?? "medium"] ?? PRIORITY_TONE.medium}`}>{humanize(value ?? "medium")}</span>;
}

// Cancelling is the one irreversible move (nothing leads out of CANCELLED), so it alone confirms - wherever
// it is triggered from (the row picker or the drawer's).
const CANCEL_CONFIRM = {
  title: "Cancel this ticket?",
  description: "A cancelled ticket is final. It can't be reopened - you'd have to raise a new one.",
  confirmLabel: "Cancel ticket",
  cancelLabel: "Keep it",
  destructive: true,
};

// The status control: a board-style picker listing every column of the workflow, with the destinations this
// caller can't reach right now spelled out rather than hidden. Picking a status sends the verb that gets
// there ("In progress" -> :start), so nobody has to know the verb vocabulary. Read-only for a caller with no
// moves available (a requester watching their own ticket, or a terminal one) - then it's just the badge.
function TicketStatusMenu({ ticket, busy, onPick, align = "start" }: {
  ticket: Ticket; busy?: boolean; onPick: (to: string) => void; align?: "start" | "end";
}) {
  const stateU = upper(ticket.state);
  const can = ticket.access?.can ?? [];
  // The ORG's workflow, not the seeded default - the server decides every move from `settings/ticket-workflow`,
  // so a menu built from the default offers moves it would refuse and hides any state the org added.
  const workflow = useTicketWorkflow();
  if (!ticketMovesFrom(stateU).some((m) => can.includes(m.verb))) return <StatusBadge state={ticket.state} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <button
          type="button"
          aria-label={`Status: ${ticketStatusLabel(stateU)} - change it`}
          onClick={(e) => e.stopPropagation()} // inside a table row, whose click opens the drawer
          className="inline-flex items-center gap-1 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <StatusBadge state={ticket.state} />
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Move this ticket to</DropdownMenuLabel>
        {workflow.states.map((s) => {
          const meta = ticketStatusMeta(s);
          const current = s === stateU;
          const move = ticketMove(stateU, s);
          const blocked = current ? "Where it is now"
            : !move ? `Not reachable from ${ticketStatusLabel(stateU)}`
            : !can.includes(move.verb) ? "You don't have access to this move"
            : null;
          return (
            <DropdownMenuItem key={s} disabled={!!blocked} className="items-start gap-2" onSelect={() => onPick(s)}>
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", meta.dot)} />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 font-medium">{meta.label}{current && <Check className="h-3.5 w-3.5 text-muted-foreground" />}</span>
                <span className="block text-xs font-normal text-muted-foreground">{blocked ?? meta.hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Default row order: work that's still live first (high priority up top, most recently active first),
// terminal tickets sink to the bottom. Column-header sorting still overrides this.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const byUrgency = (a: Ticket, b: Ticket) => {
  const done = Number(!isActive(a)) - Number(!isActive(b));
  if (done !== 0) return done;
  const pr = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
  if (pr !== 0) return pr;
  return (b.update_time ?? "").localeCompare(a.update_time ?? "");
};

export default function Tickets({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload, loadMore } = useCollection<Ticket>("tickets");
  // Server-side search across the whole collection - a list page caps at 100 rows, so filtering the cached
  // rows could never reach a record past the first page. Below two characters it stays off.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  const { rows: searchRows, hasMore: searchHasMore, loadMore: loadMoreSearch } = useCollection<Ticket>("tickets", { q: debouncedQ, enabled: searching });
  const source = searching ? searchRows : rows;
  // Also the @-mention picker's source (useMentions): on one page you could only mention the first hundred
  // people, and a colleague the menu cannot offer is indistinguishable from one who does not exist.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();

  const [categories, setCategories] = useState<TicketCategory[]>([]);
  useEffect(() => {
    // Falls back to the server's own defaults, not to []: an absent settings row means "not configured yet",
    // and reading it as "no categories" left this dialog with an empty picker and a permanently disabled
    // Raise button, on a Worker that would have accepted any of the default keys.
    getSetting<{ categories?: TicketCategory[] }>("ticket-categories")
      .then((s) => setCategories(s.value?.categories ?? DEFAULT_TICKET_CATEGORIES.categories))
      .catch(() => setCategories(DEFAULT_TICKET_CATEGORIES.categories));
  }, []);
  // Predefined checklists the caller can see (the collection list is scoped by the access middleware, so the
  // pickers only ever show checklists this user has been granted read on).
  const { rows: checklists } = useCollection<TicketChecklist>("ticket-checklists", { all: true });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);

  // Drop a category the org no longer has. The draft this dialog restores (`draftKey="ticket:new"`) outlives
  // the configuration it was written against - a renamed or deleted category, or a reseeded database, leaves
  // a draft naming a key that is gone. The Select renders an unknown value as its PLACEHOLDER, so the field
  // looks unset while `form.category` is truthy: Raise stays enabled and the server refuses the write with
  // "that ticket category is unavailable", pointing at a picker that appears empty already.
  useEffect(() => {
    if (!categories.length) return; // nothing loaded = nothing to validate against
    setForm((f) => (f.category && !categories.some((c) => c.key === f.category) ? { ...f, category: "" } : f));
  }, [categories]);

  // Staged attachments for a ticket that does not exist yet. Files can't live in the form (a draft is JSON),
  // so they sit beside it and are uploaded the moment the ticket has a path.
  const [files, setFiles] = useState<File[]>([]);
  const [active, setActive] = useState<Ticket | null>(null); // the ticket open in the detail drawer

  // Last-seen tracking for the "updated" dot on rows (see lib/ticketsSeen.ts).
  const [seen, setSeen] = useState<SeenMap>(seedSeen);
  const markSeen = useCallback((t: Ticket) => {
    const at = t.update_time ?? new Date().toISOString();
    setSeen((prev) => {
      if ((prev[t.path] ?? "") >= at) return prev;
      const next = { ...prev, [t.path]: at };
      saveSeen(next);
      return next;
    });
  }, []);
  const isUpdated = (t: Ticket) => !!t.update_time && t.update_time > (seen[t.path] ?? seen._baseline ?? "");
  // Opening writes the ticket into the hash path, so what is on screen has a URL to hand to whoever needs to
  // look at it. `useDeepOpen` has always read that route; nothing ever wrote it.
  const openTicket = useCallback((t: Ticket) => { setActive(t); markSeen(t); setRouteRecord(idOf(t.path)); }, [markSeen]);
  const closeTicket = useCallback(() => { setActive(null); setRouteRecord(null); }, []);
  useDeepOpen(openId, rows, openTicket);
  // Global "Raise a support ticket" quick action opens the new-ticket dialog on arrival.
  useIntent("new-ticket", () => { if (me.employee_id) setOpen(true); });

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.name]));
    return (key?: string) => (key ? m.get(key) ?? key : "-");
  }, [categories]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    // Tickets are cross-departmental by nature, so an assignee outside the caller's slice of the directory is
    // ordinary - and reads as a word, never as the raw wire id (lib/utils.ts `personName`).
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Someone" : "Unassigned");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Unknown department" : "-");
  }, [departments]);

  // `useCallback` so the queues below depend on the predicates they filter with, not on a restatement of the
  // one field those predicates read.
  const isRequester = useCallback((t: Ticket) => !!(t.employee && me.employee_id && idOf(t.employee) === me.employee_id), [me.employee_id]);
  const isAssignee = useCallback((t: Ticket) => !!(t.assignee && me.employee_id && idOf(t.assignee) === me.employee_id), [me.employee_id]);

  const mine = useMemo(() => source.filter(isRequester).sort(byUrgency), [source, isRequester]);
  const assigned = useMemo(() => source.filter(isAssignee).sort(byUrgency), [source, isAssignee]);
  // "My team" = the categories I'm the configured assignee or a member of; its queue is every ticket in those
  // categories (category membership is what already gives me visibility into them, via per-ticket sharing).
  const myCategoryKeys = useMemo(() => {
    const keys = new Set<string>();
    if (me.employee_id) {
      for (const c of categories) {
        if ((c.assignee && idOf(c.assignee) === me.employee_id) || (c.members ?? []).some((m) => idOf(m) === me.employee_id)) keys.add(c.key);
      }
    }
    return keys;
  }, [categories, me.employee_id]);
  const team = useMemo(() => source.filter((t) => t.category && myCategoryKeys.has(t.category)).sort(byUrgency), [source, myCategoryKeys]);
  const all = useMemo(() => [...source].sort(byUrgency), [source]);
  const hasTeam = myCategoryKeys.size > 0;

  // "New since last looked" on the incoming-work tabs (assigned to me / my team / all). "My tickets" is your own,
  // so it never badges. Filters run over the shared `tickets` collection; recompute when the identity that the
  // filters close over changes.
  const activity = useTabActivity(
    [
      { key: "tickets:assigned", collection: "tickets", filter: (t) => isAssignee(t) },
      { key: "tickets:team", collection: "tickets", filter: (t) => !!t.category && myCategoryKeys.has(t.category) },
      { key: "tickets:all", collection: "tickets" },
    ],
    [me.employee_id, [...myCategoryKeys].join(",")],
  );

  // "Waiting on me" = tickets whose NEXT step is mine: assigned to me and still being worked
  // (open/in progress), or raised by me and resolved (my confirm-and-close, or reopen).
  const needsAction = useMemo(() => rows.filter((t) => {
    const s = upper(t.state);
    return (isAssignee(t) && (s === "OPEN" || s === "IN_PROGRESS")) || (isRequester(t) && s === "RESOLVED");
  }), [rows, isAssignee, isRequester]);
  const assignedOpen = useMemo(() => assigned.filter(isActive), [assigned]);
  const mineOpen = useMemo(() => mine.filter(isActive), [mine]);
  const teamOpen = useMemo(() => team.filter(isActive), [team]);
  const [ticketTab, setTicketTab] = useState(assignedOpen.length ? "assigned" : "mine");
  // An open ticket in your categories with nobody on it, and an urgent one still unresolved, are the two states
  // a queue owner needs to see without reading every row.
  const unassignedTeam = useMemo(() => teamOpen.filter((t) => !t.assignee), [teamOpen]);
  const urgentOpen = useMemo(() => rows.filter((t) => isActive(t) && t.priority === "high"), [rows]);
  // The two shapes of the visible queue: its states (a whole, divided) and what the open work is about.
  // Both over `rows` - the same tickets the tabs below list, filtered the same way by the server.
  const ticketCharts = useMemo(() => {
    const STATES: { key: string; label: string; color: string }[] = [
      { key: "OPEN", label: "Open", color: "#2a78d6" },
      { key: "IN_PROGRESS", label: "In progress", color: "#eda100" },
      { key: "RESOLVED", label: "Resolved", color: "#1baf7a" },
      { key: "CLOSED", label: "Closed", color: "#8a8a85" },
      { key: "CANCELLED", label: "Cancelled", color: "#e34948" },
    ];
    const counts = STATES.map((s) => ({ ...s, n: rows.filter((t) => upper(t.state) === s.key).length })).filter((s) => s.n > 0);
    return {
      // A state's colour is its meaning here, not its position in a palette: resolved is green wherever it
      // appears in the app, and a chart that recoloured it by index would fight every badge on the page.
      states: { labels: counts.map((s) => s.label), values: counts.map((s) => s.n), colors: counts.map((s) => s.color), keys: counts.map((s) => s.key), names: new Map(counts.map((s) => [s.key, s.label])) },
      categories: topSlices(rows.filter(isActive), (t) => catName(t.category), () => 1, 7),
    };
  }, [rows, catName]);
  // Both charts filter the tables below them. Drawn from `rows` - the whole visible queue - not from the
  // narrowed set, so picking a slice never takes its own slice off the picture.
  const cf = useChartFocus<Ticket, "state" | "category">({
    state: {
      keys: ticketCharts.states.keys,
      label: (k) => ticketCharts.states.names.get(k) ?? k,
      match: (t, k) => upper(t.state) === k,
    },
    category: {
      keys: ticketCharts.categories.keys,
      label: (k) => k,
      match: (t, k) => catName(t.category) === k,
    },
  });
  // A metric narrows whichever tab it lands on, so the number and the list below it always agree.
  const kf = useKpiFocus<Ticket, "needsAction" | "open" | "unassigned" | "urgent">({
    needsAction: { label: "tickets waiting on you", match: (t) => { const s = upper(t.state); return (isAssignee(t) && (s === "OPEN" || s === "IN_PROGRESS")) || (isRequester(t) && s === "RESOLVED"); } },
    open: { label: "open tickets", match: isActive },
    unassigned: { label: "unassigned open tickets", match: (t) => isActive(t) && !t.assignee },
    urgent: { label: "high-priority open tickets", match: (t) => isActive(t) && t.priority === "high" },
  });
  // Clicking a metric picks the tab that owns those rows, then narrows it.
  const tabKpi = (key: "needsAction" | "open" | "unassigned" | "urgent", tab: string) => {
    const base = kf.kpi(key);
    return { ...base, onClick: () => { setTicketTab(tab); base.onClick(); } };
  };
  // Each tab counts THROUGH the active metric, so the number on a tab is what clicking it would show rather
  // than a total the narrowed list below contradicts. A narrowed tab keeps its zero: an absent count would
  // read as "nothing here at all" when the metric is what emptied it.
  const tabCount = (list: Ticket[]) => {
    const n = kf.count(cf.apply(list));
    return n || kf.focus || cf.picked ? ` (${n})` : "";
  };
  // Viewing a tab clears its "new" badge and advances the reference the next visit measures from.
  useEffect(() => { markTabSeen(`tickets:${ticketTab}`); }, [ticketTab]);

  // Throws to fail: WriteDialog owns the busy state, pins the reason inside the form and keeps what was typed.
  async function submit() {
    const initial_todos = form.todos.map((s) => s.trim()).filter(Boolean);
    const raised = await create<Ticket>("tickets", {
      category: form.category,
      subject: form.subject,
      description: form.description,
      priority: form.priority,
      ...(form.department ? { department: form.department } : {}), // omit -> server derives from the category
      ...(initial_todos.length ? { initial_todos } : {}),
    });
    // Files picked before the ticket existed, uploaded now that it does. A failure here throws with the
    // attachment's name in it and leaves the dialog open on a ticket that HAS been raised - so the message
    // says so, rather than implying nothing happened.
    for (const file of files) {
      try {
        await upload<Ticket>(`tickets/${idOf(raised.path)}`, file, { verb: "attach" });
      } catch (e) {
        setForm(EMPTY);
        setFiles([]);
        reload();
        throw new Error(`The ticket was raised, but ${file.name} didn't attach: ${describeError(e)}`);
      }
    }
    toast({ title: "Ticket raised", variant: "success" });
    setForm(EMPTY);
    setFiles([]);
    reload();
  }

  // Status changes straight from a row: same move set as the drawer's picker, so a queue can be worked
  // without opening every ticket. The server re-checks the transition and the access on the verb.
  const [moving, setMoving] = useState<string | null>(null); // the ticket path in flight
  const moveStatus = async (t: Ticket, to: string) => {
    const move = ticketMove(upper(t.state), to);
    if (!move || moving) return;
    if (move.verb === "cancel" && !(await confirm(CANCEL_CONFIRM))) return;
    setMoving(t.path);
    const from = upper(t.state);
    try {
      const updated = await invoke<Ticket>(`tickets/${idOf(t.path)}`, move.verb, t.etag);
      // Undo where the workflow allows it (resolve → reopen, in progress → back to open). Nothing leads out
      // of CANCELLED, so a cancel confirms up front instead and gets no undo here.
      const back = ticketMove(to, from);
      const canUndo = !!back && (updated.access?.can ?? t.access?.can ?? []).includes(back.verb);
      toast({
        title: `Moved to ${ticketStatusLabel(to)}`,
        variant: "success",
        ...(canUndo ? { action: { label: "Undo", onClick: () => void moveStatus(updated, from) }, duration: 8000 } : {}),
      });
      reload();
    } catch (e) {
      toast({ title: VERB_MSG[move.verb]?.fail ?? "Couldn't update the ticket", description: (e as Error).message, variant: "destructive" });
    } finally {
      setMoving(null);
    }
  };

  // ---- columns -------------------------------------------------------------
  const subjectCol: Column<Ticket> = {
    id: "subject", header: "Subject", accessor: (t) => t.subject,
    cell: (t) => (
      <button className="text-left font-medium hover:underline" onClick={() => openTicket(t)}>
        {isUpdated(t) && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-primary align-middle" title="Updated since you last opened it" />}
        {t.subject}
      </button>
    ),
  };
  const cols: Column<Ticket>[] = [
    subjectCol,
    { id: "category", header: "Category", filter: "select", accessor: (t) => catName(t.category) },
    { id: "department", header: "Department", filter: "select", accessor: (t) => deptName(t.department) },
    { id: "requester", header: "Requester", accessor: (t) => empName(t.employee) },
    { id: "assignee", header: "Assignee", accessor: (t) => empName(t.assignee) },
    { id: "priority", header: "Priority", filter: "select", accessor: (t) => t.priority, cell: (t) => <PriorityBadge value={t.priority} /> },
    { id: "state", header: "Status", filter: "select", accessor: (t) => ticketStatusLabel(t.state), cell: (t) => <TicketStatusMenu ticket={t} busy={moving === t.path} onPick={(to) => moveStatus(t, to)} /> },
    {
      id: "checklist", header: "Checklist", accessor: (t) => t.todo_total ?? 0,
      cell: (t) => t.todo_total
        ? <span className={cn("inline-flex items-center gap-1 text-xs", t.todo_done === t.todo_total ? "text-success" : "text-muted-foreground")}><ListChecks className="h-3.5 w-3.5" /> {t.todo_done}/{t.todo_total}</span>
        : <span className="text-muted-foreground">-</span>,
    },
  ];
  const mineCols = [...cols.filter((c) => c.id !== "requester"), ...metaColumns<Ticket>()];
  const allCols = [...cols, ...metaColumns<Ticket>()];

  const newBtn = (
    <AccessAction collection="tickets" create label="New ticket">
      <Button onClick={() => setOpen(true)} disabled={!me.employee_id}><Plus className="h-4 w-4" /> New ticket</Button>
    </AccessAction>
  );

  // Bulk moves for the servicing queues (assigned/team/all): the two batch destinations that actually come up
  // - mark a batch resolved, or close a batch outright. Enabled only when EVERY selected row can make the
  // move, so the action's scope is never a surprise; per-row ACLs still enforce server-side.
  const ticketBulkActions: BulkAction<Ticket>[] = [
    {
      label: "Move to Resolved",
      icon: <Check className="h-4 w-4" />,
      confirm: { title: "Resolve the selected tickets?", description: "Requesters confirm-and-close (or reopen) from their side." },
      disabled: (sel) =>
        sel.every((t) => (t.access?.can ?? []).includes("resolve") && !!ticketMove(upper(t.state), "RESOLVED"))
          ? null
          : "Only open or in-progress tickets you may resolve",
      run: async (sel) => {
        const r = await bulkInvoke("tickets", "resolve", sel);
        toast(bulkSummary("Resolved", r));
        reload();
        // Only the FAILED rows stay selected. Throwing kept them all, and after the reload the resolved ones
        // no longer satisfy this action's own `disabled` guard - so the retry button went grey over a
        // selection the reader then had to unpick by hand.
        return r.failedRows;
      },
    },
    {
      label: "Move to Closed",
      icon: <X className="h-4 w-4" />,
      confirm: { title: "Close the selected tickets?" },
      disabled: (sel) =>
        sel.every((t) => (t.access?.can ?? []).includes("close") && !!ticketMove(upper(t.state), "CLOSED"))
          ? null
          : "Only tickets you may close, that aren't already closed or cancelled",
      run: async (sel) => {
        const r = await bulkInvoke("tickets", "close", sel);
        toast(bulkSummary("Closed", r));
        reload();
        return r.failedRows; // keep only what failed - see the note on "Resolve" above
      },
    },
  ];

  const renderTable = (data: Ticket[], columns: Column<Ticket>[], tableId: string, emptyTitle: string, emptyDescription?: string, withBulk?: boolean) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      // A clicked metric or chart slice narrows whichever tab is showing to the rows it counted.
      rows={cf.apply(kf.apply(data))}
      search={{ value: search, onChange: setSearch, placeholder: "Search all tickets…" }}
      hasMore={searching ? searchHasMore : undefined}
      onLoadMore={searching ? loadMoreSearch : loadMore}
      getRowId={(t) => t.path}
      onRowClick={(t) => openTicket(t)}
      emptyTitle={cf.activeLabel ? `No ${cf.activeLabel} tickets here` : kf.activeLabel ? `No ${kf.activeLabel}` : emptyTitle}
      emptyDescription={cf.activeLabel ? "Press the same slice again, or Show all." : kf.activeLabel ? "Click the metric again to show everything." : emptyDescription}
      accessCollection="tickets"
      accessTargetOf={(t) => ({ objectPath: t.path, label: t.subject, can: t.access?.can })}
      bulkActions={withBulk ? ticketBulkActions : undefined}
    />
  );

  return (
    <div>
      <PageHeader
        title="Support"
        description="Raise a support ticket and follow it through to resolution."
        actions={<>{newBtn}<PageSettings me={me} host="tickets" /></>}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {/* What the desk is carrying, and what it is carrying it for. Two questions the KPI strip cannot
            answer - the strip counts what needs YOU; these say what the whole visible queue looks like. */}
        {state === "ready" && rows.length > 2 && (
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <ChartCard title="Where the queue stands" description="Every ticket you can see, by state.">
              <Chart
                type="donut"
                height={200}
                labels={ticketCharts.states.labels}
                datasets={[{ name: "Tickets", values: ticketCharts.states.values }]}
                colors={ticketCharts.states.colors}
                ariaLabel="Visible tickets by state"
                {...cf.chart("state")}
              />
            </ChartCard>
            <ChartCard title="What people ask for" description="Open tickets by category - where the desk's time goes.">
              <Chart
                type="bar"
                height={200}
                labels={ticketCharts.categories.labels}
                datasets={[{ name: "Open", values: ticketCharts.categories.values }]}
                ariaLabel="Open tickets by category"
                emptyText="Nothing open right now."
                {...cf.chart("category")}
              />
            </ChartCard>
          </div>
        )}
        {/* Every metric here narrows the tables below, so the strip sits against them - under the charts,
            which are only there to be read. */}
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              {
                label: "Waiting on me", value: needsAction.length, icon: AlertCircle,
                tone: needsAction.length ? "warning" : "success",
                hint: needsAction.length ? "next step is yours" : "nothing needs you",
                ...tabKpi("needsAction", "all"),
              },
              { label: "My open tickets", value: mineOpen.length, icon: LifeBuoy, hint: "raised by you", ...tabKpi("open", "mine") },
              ...(hasTeam ? [{ label: "Team queue", value: teamOpen.length, icon: Users, hint: "your categories", ...tabKpi("open", "team") }] : []),
              ...(hasTeam && unassignedTeam.length
                ? [{ label: "Unassigned", value: unassignedTeam.length, icon: Users, tone: "warning" as const, hint: "nobody is on these", ...tabKpi("unassigned", "team") }]
                : []),
              ...(urgentOpen.length
                ? [{ label: "High priority", value: urgentOpen.length, icon: AlertCircle, tone: "destructive" as const, hint: "urgent, still open", ...tabKpi("urgent", "all") }]
                : []),
              { label: "Total visible", value: rows.length, tone: "muted" as const, hint: "open and closed", onClick: () => { kf.setFocus(null); setTicketTab("all"); }, active: kf.focus === null && ticketTab === "all" },
            ]}
          />
        )}

        <ChartFilterNote label={cf.activeLabel} shown={cf.count(rows)} total={rows.length} onClear={cf.clear} />

        {/* Land assignees on their queue when something is open there; everyone else starts on their own tickets. */}
        <Tabs value={ticketTab} onValueChange={setTicketTab}>
          <TabsList>
            <TabsTrigger value="mine">My tickets{tabCount(mine)}</TabsTrigger>
            <TabsTrigger value="assigned">Assigned to me{tabCount(assigned)}<ActivityBadge count={ticketTab === "assigned" ? 0 : activity["tickets:assigned"] ?? 0} /></TabsTrigger>
            {hasTeam && <TabsTrigger value="team">My team{tabCount(team)}<ActivityBadge count={ticketTab === "team" ? 0 : activity["tickets:team"] ?? 0} /></TabsTrigger>}
            {/* mine/assigned/team are scope filters of the same collection; the collection-level access key
                rides on "All" (the whole collection), with per-row keys inside each table. */}
            <AccessTab value="all" target={{ collection: "tickets", label: "Support tickets" }}>All<ActivityBadge count={ticketTab === "all" ? 0 : activity["tickets:all"] ?? 0} /></AccessTab>
          </TabsList>
          <TabsContent value="mine">
            {mine.length === 0 && !kf.focus
              ? <EmptyState icon={LifeBuoy} title="No tickets yet" description="Stuck on IT, payroll, facilities or anything else? Raise a ticket and track it here through to resolution." action={newBtn} />
              : renderTable(mine, mineCols, "tickets-mine", "No tickets match", "Adjust the filters to see your tickets.")}
          </TabsContent>
          <TabsContent value="assigned">
            {renderTable(assigned, allCols, "tickets-assigned", "Nothing assigned to you", "Tickets routed to you appear here.", true)}
          </TabsContent>
          {hasTeam && (
            <TabsContent value="team">
              {renderTable(team, allCols, "tickets-team", "No tickets in your categories", "Tickets in the categories you handle appear here.", true)}
            </TabsContent>
          )}
          <TabsContent value="all">
            {renderTable(all, allCols, "tickets-all", "No tickets", "Tickets you can see appear here.", true)}
          </TabsContent>
        </Tabs>
      </DataState>

      <NewTicketDialog open={open} onOpenChange={setOpen} form={form} setForm={setForm} files={files} setFiles={setFiles} categories={categories} departments={departments} checklists={checklists} myOpen={mineOpen} empName={empName} onSubmit={submit} />

      <TicketDetail
        ticket={active}
        onClose={closeTicket}
        employees={employees}
        departments={departments}
        checklists={checklists}
        catName={catName}
        empName={empName}
        deptName={deptName}
        canModify={(t) => !TERMINAL.has(upper(t.state))}
        onChanged={(t) => { setActive(t); reload(); }}
        /* The queue behind the drawer: the tab that is actually on screen, in the order it is drawn, so
           "next" means the next row the reader can see rather than the next row in some other list. */
        siblings={ticketTab === "mine" ? mine : ticketTab === "assigned" ? assigned : ticketTab === "team" ? team : all}
        onOpen={openTicket}
        toast={toast}
      />
    </div>
  );
}

function NewTicketDialog({ open, onOpenChange, form, setForm, files, setFiles, categories, departments, checklists, myOpen, empName, onSubmit }: {
  open: boolean; onOpenChange: (v: boolean) => void; form: typeof EMPTY; setForm: (f: typeof EMPTY) => void;
  files: File[]; setFiles: (f: File[]) => void;
  categories: TicketCategory[]; departments: Department[]; checklists: TicketChecklist[];
  /** The caller's own live tickets, for the duplicate warning. */
  myOpen: Ticket[];
  empName: (p?: string) => string;
  onSubmit: () => Promise<void>;
}) {
  const [item, setItem] = useState("");
  useEffect(() => { if (!open) setItem(""); }, [open]);
  const addItem = () => { const v = item.trim(); if (!v) return; setForm({ ...form, todos: [...form.todos, v] }); setItem(""); };
  const removeItem = (i: number) => setForm({ ...form, todos: form.todos.filter((_, j) => j !== i) });
  // Keyed by row identity rather than position: both of these lists are removable in place, and an index key
  // makes React reuse the DOM node for the slot rather than for the row, so the removed row's state (focus, a
  // hover-revealed button, a running transition) is inherited by whatever slides up into it.
  const fileKeys = useRowKeys(files);
  const todoKeys = useRowKeys(form.todos);
  const applyChecklist = (path: string) => {
    const cl = checklists.find((c) => c.path === path);
    if (cl) setForm({ ...form, todos: [...form.todos, ...cl.items] });
  };
  const cat = categories.find((c) => c.key === form.category);
  // The selected category's default servicing department; shown as the "Auto" option's label so the picker
  // is a pure override (leave it on Auto and the server derives from the category).
  const catDept = departments.find((d) => `departments/${idOf(d.path)}` === cat?.department);
  // Who this actually reaches, said before it is raised: the server notifies the category's assignee, its
  // members and the servicing department's managers. "Raise and hope" is the thing being fixed here.
  const routeTo = cat
    ? [cat.assignee ? empName(cat.assignee) : null, (cat.members ?? []).length ? `${(cat.members ?? []).length} more in ${cat.name}` : null, (form.department ? departments.find((d) => `departments/${idOf(d.path)}` === form.department)?.display_name : catDept?.display_name) ?? null]
        .filter(Boolean)
        .join(" · ")
    : "";
  // Duplicate guard: a live ticket of the caller's with the same subject. A warning, never a block - a
  // recurring problem is a legitimate second ticket, a double-tapped Raise button is not.
  const dup = useMemo(() => {
    const s = form.subject.trim().toLowerCase();
    return s.length >= 4 ? myOpen.find((t) => (t.subject ?? "").trim().toLowerCase() === s) ?? null : null;
  }, [myOpen, form.subject]);
  const valid = !!form.category && !!form.subject.trim();
  return (
    <WriteDialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="New support ticket"
      description="Raising it notifies whoever services that category. You'll get a notification on every reply and when it's resolved."
      collection="tickets"
      guardLabel="ticket"
      form={form}
      draftKey="ticket:new"
      applyDraft={(d) => setForm(d)}
      onStartOver={() => setForm(EMPTY)}
      submitLabel="Raise ticket"
      canSubmit={valid}
      whyNot={!form.subject.trim() ? "Say what you need help with." : "Pick a category so it reaches the right team."}
      onSubmit={onSubmit}
      submitAccess={(b) => <AccessAction collection="tickets" create label="Raise a ticket">{b}</AccessAction>}
    >
        <Field label="Subject"><Input autoFocus placeholder="What do you need help with?" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        {dup && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>You already have a ticket with this subject, {ticketStatusLabel(upper(dup.state)).toLowerCase()} since {formatDate(dup.create_time)}. Replying on that one keeps the history together.</span>
          </p>
        )}
        <FieldRow>
          <Field label="Category" hint={categories.length === 0 ? "No categories are configured yet. Ask an admin to add them in Settings." : routeTo ? `Goes to ${routeTo}.` : "Determines who the ticket is assigned to."}>
            <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Servicing department (optional)" hint="Which team handles this. Leave on Auto to use the category's default; ops can re-route later.">
          <Select value={form.department || "auto"} onValueChange={(v) => setForm({ ...form, department: v === "auto" ? "" : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{catDept ? `Auto - ${catDept.display_name}` : "Auto (from category)"}</SelectItem>
              {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Description (optional)">
          <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        {/* A screenshot answers a support ticket faster than three rounds of "what did it say?". Files are held
            here and uploaded the moment the ticket exists. */}
        <Field label="Attachments (optional)" hint={`Screenshots, logs, a PDF. Up to ${MAX_ATTACHMENTS} files.`}>
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={fileKeys[i]} className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            {files.length < MAX_ATTACHMENTS && (
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
                <Paperclip className="h-3.5 w-3.5" /> Attach a file
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const picked = [...(e.target.files ?? [])];
                    setFiles([...files, ...picked].slice(0, MAX_ATTACHMENTS));
                    e.target.value = ""; // so picking the same file again still registers
                  }}
                />
              </label>
            )}
          </div>
        </Field>

        {/* Optional checklist to seed on the new ticket: pick a template and/or add custom items. */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-sm font-medium"><ListChecks className="h-4 w-4" /> Checklist <span className="font-normal text-muted-foreground">(optional)</span></label>
            {checklists.length > 0 && (
              <Select value="" onValueChange={applyChecklist}>
                <SelectTrigger className="h-8 w-40 text-xs sm:w-48"><SelectValue placeholder="Add from checklist…" /></SelectTrigger>
                <SelectContent>
                  {checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
          {form.todos.length > 0 && (
            <div className="space-y-1.5">
              {form.todos.map((it, i) => (
                <div key={todoKeys[i]} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                  <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{it}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" onClick={() => removeItem(i)} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input className="h-8" placeholder="Add a checklist item…" value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} />
            <Button type="button" size="sm" variant="outline" disabled={!item.trim()} onClick={addItem}><Plus className="h-4 w-4" /> Add</Button>
          </div>
        </div>

    </WriteDialog>
  );
}

// Per-verb toast copy: `ok` omitted where the change is already visible in place (thread/checklist, and the
// status picker, which passes its own "Moved to X"), so routine edits don't spam toasts; failures always name
// what failed.
const VERB_MSG: Record<string, { ok?: string; fail: string }> = {
  start: { fail: "Couldn't start the ticket" },
  resolve: { fail: "Couldn't resolve the ticket" },
  close: { fail: "Couldn't close the ticket" },
  reopen: { fail: "Couldn't reopen the ticket" },
  cancel: { fail: "Couldn't cancel the ticket" },
  assign: { ok: "Reassigned", fail: "Couldn't reassign the ticket" },
  route: { ok: "Department updated", fail: "Couldn't route the ticket" },
  prioritize: { ok: "Priority updated", fail: "Couldn't change the priority" },
  comment: { fail: "Couldn't send your reply" },
  addTodos: { fail: "Couldn't add to the checklist" },
  toggleTodo: { fail: "Couldn't update the checklist" },
  removeTodo: { fail: "Couldn't remove the item" },
};

// The ticket drawer: full details + the comment thread + actions (state transitions, reassign, priority, reply).
function TicketDetail({ ticket, onClose, employees, departments, checklists, catName, empName, deptName, canModify, onChanged, siblings, onOpen, toast }: {
  ticket: Ticket | null;
  onClose: () => void;
  employees: Employee[];
  departments: Department[];
  checklists: TicketChecklist[];
  catName: (k?: string) => string;
  empName: (p?: string) => string;
  deptName: (p?: string) => string;
  canModify: (t: Ticket) => boolean;
  onChanged: (t: Ticket) => void;
  /** The queue this ticket was opened from, for walking it without closing. */
  siblings: Ticket[];
  onOpen: (t: Ticket) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const confirm = useConfirm();
  // The org's own workflow - the access affordances below list its verbs, not the seeded default's.
  const workflow = useTicketWorkflow();
  const [full, setFull] = useState<Ticket | null>(null); // ticket + comments + checklist (from Get)
  const [reply, setReply] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // the verb in flight, so only its button spins
  // A failed action stays readable while it is being retried. A toast about a reply that didn't send lands
  // behind the drawer it came from and is gone four seconds later, which is how a lost reply looks like a sent one.
  const [error, setError] = useState<string | null>(null);
  const [promote, setPromote] = useState<string | null>(null); // checklist item being turned into a board task
  const threadRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Fetch the full ticket (with its comment thread + checklist) whenever a row is opened.
  // Keyed on the PATH, deliberately: the row object is replaced wholesale by every list refetch, and
  // re-fetching the open ticket (and clearing the half-typed reply below) each time one lands is not what
  // opening a ticket means. The row itself is still needed as the fallback when the fetch fails, so it is read
  // through a ref - which is what lets the dependency array say exactly what it means and be checkable.
  const ticketPath = ticket?.path;
  const latestTicket = useRef(ticket);
  latestTicket.current = ticket;
  useEffect(() => {
    if (!ticketPath) { setFull(null); return; }
    setReply("");
    setNewTodo("");
    setError(null);
    // A `live` latch, because the drawer is QUEUE-NAVIGABLE and carries no `key`: "next" changes `ticketPath`
    // in place rather than remounting, so three presses on a slow connection is three fetches in flight with
    // nothing to say which belongs to the ticket on screen - and the last to land won.
    //
    // That is not a display swap. `const t = full ?? ticket` is what the whole drawer renders AND ACTS on, so a
    // stale `full` meant replying, changing state, reassigning, adding a to-do or attaching a screen recording
    // was applied to a ticket the reader was not looking at, under the header of the one they were.
    // `App.tsx:522` describes the same failure on the employee profile; `Pipeline`'s ApplicationDrawer is the
    // in-repo implementation of this fix.
    //
    // `setFull(null)` first, so the drawer falls back to the row in hand rather than showing the PREVIOUS
    // ticket's full record for as long as the fetch takes.
    let live = true;
    setFull(null);
    get<Ticket>(`tickets/${idOf(ticketPath)}`)
      .then((t) => { if (live) setFull(t); })
      .catch(() => { if (live) setFull(latestTicket.current ?? null); });
    return () => { live = false; };
  }, [ticketPath]);

  // Keep the thread pinned to the latest reply (new replies append at the bottom of a scrolling region).
  const commentCount = full?.comments?.length ?? 0;
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [full?.path, commentCount]);

  const mentions = useMentions({ value: reply, onChange: setReply, textareaRef: replyRef, employees });

  // Walking the queue: a half-typed reply blocks it rather than being thrown away, since the drawer resets
  // its state for each ticket.
  const qIndex = ticket ? siblings.findIndex((s) => s.path === ticket.path) : -1;
  const stepBlocked = !!reply.trim();
  const canStep = (delta: number) => qIndex >= 0 && !!siblings[qIndex + delta] && !stepBlocked;
  const step = (delta: number) => { const next = siblings[qIndex + delta]; if (next) onOpen(next); };

  // j / k walk the queue, ignored while a field has focus so typing stays typing.
  useEffect(() => {
    if (!ticket) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-bound each render on purpose: the handler closes over the queue position and the reply box's state.
  });

  // Upload / fetch of one attachment. Both go through the ticket's own verbs, so access is the ticket's access
  // and nothing is reachable by URL alone.
  async function attachFile(file: File) {
    setBusy("attach");
    setError(null);
    try {
      const updated = await upload<Ticket>(`tickets/${idOf(t!.path)}`, file, { verb: "attach" });
      setFull(updated);
      onChanged(updated);
    } catch (e) {
      setError(`Couldn't attach ${file.name}: ${describeError(e)}`);
    } finally {
      setBusy(null);
    }
  }
  async function fetchAttachment(key: string, name: string) {
    try {
      await download(`tickets/${idOf(t!.path)}`, name, { verb: "attachment", params: { key } });
    } catch (e) {
      setError(`Couldn't download ${name}: ${describeError(e)}`);
    }
  }

  function copyLink(t: Ticket) {
    navigator.clipboard.writeText(recordUrl("tickets", idOf(t.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this ticket can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  const t = full ?? ticket;
  if (!t) return null;
  const can = t.access?.can ?? [];
  const stateU = upper(t.state);
  const modifiable = canModify(t);
  const todos = t.todos ?? [];
  const doneCount = todos.filter((x) => x.done).length;
  const attachments = t.attachments ?? [];

  async function act(verb: string, body?: Record<string, unknown>, okOverride?: string): Promise<boolean> {
    setBusy(verb);
    setError(null);
    try {
      const updated = await invoke<Ticket>(`tickets/${idOf(t!.path)}`, verb, t!.etag, body);
      setFull(updated);
      onChanged(updated);
      const ok = okOverride ?? VERB_MSG[verb]?.ok;
      if (ok) toast({ title: ok, variant: "success" });
      return true;
    } catch (e) {
      // Lost race: somebody else moved or edited this ticket while the drawer was open. Reload it in place -
      // the etag the next attempt needs comes with it - and say so, rather than surfacing "etag mismatch".
      if (isConflict(e)) {
        const fresh = await get<Ticket>(`tickets/${idOf(t!.path)}`).catch(() => null);
        if (fresh) { setFull(fresh); onChanged(fresh); }
        setError("Somebody else updated this ticket while you had it open. It's been reloaded - try that again.");
        return false;
      }
      setError(`${VERB_MSG[verb]?.fail ?? "Couldn't update the ticket"}: ${describeError(e)}`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const sendReply = async () => {
    if (!reply.trim() || busy) return;
    if (await act("comment", { body: reply.trim() })) setReply("");
  };
  const addTodoItem = async () => {
    if (!newTodo.trim() || busy) return;
    if (await act("addTodos", { texts: [newTodo.trim()] })) setNewTodo("");
  };

  // Moving the ticket along its workflow: the picked status resolves to the verb that reaches it. Where the
  // workflow leads back out again (resolved → reopened, in progress → open), the toast offers the way back.
  const moveTo = async (to: string, undoing = false) => {
    const move = ticketMove(stateU, to);
    if (!move || busy) return;
    if (move.verb === "cancel" && !(await confirm(CANCEL_CONFIRM))) return;
    const from = stateU;
    const back = ticketMove(to, from);
    const undoable = !undoing && !!back && can.includes(back.verb);
    const ok = undoing ? `Back to ${ticketStatusLabel(to)}` : `Moved to ${ticketStatusLabel(to)}`;
    // One toast, not two: with an undo to offer, act() stays quiet and the toast below carries the message.
    if (!(await act(move.verb, undefined, undoable ? undefined : ok))) return;
    if (undoable) {
      toast({
        title: ok,
        variant: "success",
        action: { label: "Undo", onClick: () => void moveTo(from, true) },
        duration: 8000,
      });
    }
  };

  return (
    <Dialog open={!!ticket} onOpenChange={(v) => !v && onClose()}>
      {/* scrollBody: the drawer holds details, a checklist, a thread and an activity feed. Without it the panel
          scrolls as one and the status picker - the thing most opens are for - leaves the screen. */}
      <DialogContent scrollBody className="max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <LifeBuoy className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{t.subject}</span>
            <button type="button" onClick={() => copyLink(t)} title="Copy a link to this ticket" aria-label="Copy a link to this ticket" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
              <Link2 className="h-3.5 w-3.5" />
            </button>
            {/* Walk the queue behind the drawer: working ten tickets should not mean opening ten dialogs. */}
            {siblings.length > 1 && qIndex >= 0 && (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous ticket" title={stepBlocked ? "Send or clear your reply first" : "Previous ticket (k)"}><ChevronLeft className="h-4 w-4" /></Button>
                <span className="tabular-nums">{qIndex + 1}/{siblings.length}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next ticket" title={stepBlocked ? "Send or clear your reply first" : "Next ticket (j)"}><ChevronRight className="h-4 w-4" /></Button>
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {TERMINAL.has(stateU)
              ? `This ticket is ${ticketStatusLabel(stateU).toLowerCase()}. Raise a new one if it comes back.`
              : "Replies notify the requester and the assignee. Moving it to Resolved asks the requester to confirm and close."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        <FormError error={error} />

        {/* Status is the drawer's primary action: pick the column to move to. The per-verb access keys ride
            alongside it (access mode only) so every transition stays manageable now that the buttons are gone. */}
        <div className="flex flex-wrap items-center gap-2">
          <TicketStatusMenu ticket={t} busy={!!busy} onPick={moveTo} />
          <PriorityBadge value={t.priority} />
          <Badge variant="secondary">{catName(t.category)}</Badge>
          {/* One access affordance per DISTINCT verb: a workflow may legitimately author the same verb over
              several from-state rows ("close" from OPEN and from RESOLVED), and the grant is per verb, not per
              row - so listing rows would repeat the same key and give React duplicate children keys. */}
          {[...new Map(workflow.transitions.map((x) => [x.verb, x])).values()].map((x) => (
            <AccessAction key={x.verb} collection="tickets" objectPath={t.path} verb={x.verb} can={can} label={`Move to ${ticketStatusLabel(x.to)}`} />
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div><dt className="text-muted-foreground">Requester</dt><dd>{empName(t.employee)}</dd></div>
          <div><dt className="text-muted-foreground">Assignee</dt><dd>{empName(t.assignee)}</dd></div>
          <div><dt className="text-muted-foreground">Department</dt><dd>{deptName(t.department)}</dd></div>
          {t.create_time && <div><dt className="text-muted-foreground">Raised</dt><dd>{formatDate(t.create_time)}</dd></div>}
          {t.update_time && <div><dt className="text-muted-foreground">Last activity</dt><dd>{fmtDateTime(t.update_time)}</dd></div>}
        </dl>

        {t.description && <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{t.description}</p>}

        {/* The replay the requester chose to attach. An outbound link to the Sentry console, not an embed:
            watching it needs a Sentry login, which is the point - the recording is support tooling, and the
            people who can open it are the people with an account there, not everyone who can read the ticket.
            Without a configured org slug there is no URL to build, so it says the id and stops. */}
        {((t.session_replays ?? []).length > 0 || sentryEnabled) && (
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-sm font-medium">
              <Video className="h-4 w-4" /> Session recordings
              {(t.session_replays ?? []).length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">{(t.session_replays ?? []).length}</span>
              )}
            </h4>
            {(t.session_replays ?? []).map((r) => {
              const url = replayUrl(r.id!);
              return url ? (
                <a
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm hover:bg-accent"
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {r.by ? `Recorded by ${empName(r.by)}` : "Recording"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(r.create_time)}</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </a>
              ) : (
                // No org slug configured, so there is no console URL to build - say the id rather than a dead link.
                <p key={r.id} className="rounded-md border bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">{r.id}</p>
              );
            })}
            {/* "Can you show me that again?" answered in place. The window runs for two minutes with the
                countdown in the top bar, survives navigating away to reproduce the fault, and attaches itself
                when it ends - so the drawer does not have to still be open. */}
            {sentryEnabled && (
              <AccessAction collection="tickets" objectPath={t.path} verb="attachRecording" can={can} label="Add a recording">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5 border-dashed"
                  onClick={() => {
                    // Close the drawer as the window opens. It is a modal covering the whole app, and the
                    // point of the next two minutes is to go and make the fault happen - which cannot be done
                    // with the ticket sitting on top of it. The recording attaches itself when it ends, so
                    // nothing here needs the drawer to still be open.
                    onClose();
                    startRecording({ kind: "ticket", path: t.path, subject: t.subject });
                  }}
                >
                  <Video className="h-3.5 w-3.5" /> Record the problem again
                </Button>
              </AccessAction>
            )}
          </div>
        )}

        {/* Attachments: what the requester was looking at. Downloads go through the verb (never a public URL),
            so the bytes are gated by the same read as the ticket. */}
        {(attachments.length > 0 || can.includes("attach")) && (
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-sm font-medium">
              <Paperclip className="h-4 w-4" /> Attachments
              {attachments.length > 0 && <span className="text-xs font-normal text-muted-foreground">{attachments.length}</span>}
            </h4>
            {attachments.map((a) => (
              <div key={a.key} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => void fetchAttachment(a.key!, a.name ?? "attachment")} title="Download">
                  {a.name}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.size_bytes)}</span>
                {can.includes("detach") && (
                  <AccessAction collection="tickets" objectPath={t.path} verb="detach" can={can} label="Remove an attachment">
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" disabled={!!busy} onClick={() => act("detach", { key: a.key })} aria-label={`Remove ${a.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </AccessAction>
                )}
              </div>
            ))}
            {can.includes("attach") && attachments.length < MAX_ATTACHMENTS && (
              <AccessAction collection="tickets" objectPath={t.path} verb="attach" can={can} label="Attach a file">
                <label className={cn("flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground", busy === "attach" && "pointer-events-none opacity-60")}>
                  <Paperclip className="h-3.5 w-3.5" /> {busy === "attach" ? "Uploading…" : "Attach a file"}
                  <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void attachFile(f); }} />
                </label>
              </AccessAction>
            )}
          </div>
        )}

        {/* Actions: reassign + priority (when modifiable), then the state-machine buttons. */}
        {modifiable && (
          <FieldRow>
            {/* `htmlFor` on each of the three: the control is wrapped in <AccessAction>, so Field cannot see
                it to bind its own label, and without this the label names nothing to a screen reader. */}
            <Field label="Assignee" htmlFor="ticket-assignee">
              <AccessAction collection="tickets" objectPath={t.path} verb="assign" can={can} label="Reassign">
                <Combobox
                  id="ticket-assignee"
                  value={t.assignee ? `employees/${idOf(t.assignee)}` : "none"}
                  onValueChange={(v) => act("assign", { assignee: v === "none" ? null : v })}
                  disabled={!!busy}
                  searchPlaceholder="Search people…"
                  options={[
                    { value: "none", label: "Unassigned" },
                    ...employees.map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` })),
                  ]}
                />
              </AccessAction>
            </Field>
            <Field label="Department" htmlFor="ticket-department">
              <AccessAction collection="tickets" objectPath={t.path} verb="route" can={can} label="Route to a department">
                <Combobox
                  id="ticket-department"
                  value={t.department ? `departments/${idOf(t.department)}` : "none"}
                  onValueChange={(v) => act("route", { department: v === "none" ? null : v })}
                  disabled={!!busy}
                  searchPlaceholder="Search departments…"
                  options={[
                    { value: "none", label: "None" },
                    ...departments.map((d) => ({ value: `departments/${idOf(d.path)}`, label: d.display_name })),
                  ]}
                />
              </AccessAction>
            </Field>
            <Field label="Priority" htmlFor="ticket-priority">
              <AccessAction collection="tickets" objectPath={t.path} verb="prioritize" can={can} label="Change priority">
                <Select value={t.priority} disabled={!!busy} onValueChange={(v) => act("prioritize", { priority: v })}>
                  <SelectTrigger id="ticket-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </AccessAction>
            </Field>
          </FieldRow>
        )}

        {/* Checklist / todo list. Items can be added one-off or copied in from a predefined checklist (the
            picker only lists checklists this user can read). */}
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-1.5 text-sm font-medium">
              <ListChecks className="h-4 w-4" /> Checklist
              {todos.length > 0 && (
                doneCount === todos.length && (stateU === "OPEN" || stateU === "IN_PROGRESS")
                  ? <span className="text-xs font-normal text-success dark:text-success">All {todos.length} done - ready to resolve</span>
                  : <span className="text-xs font-normal text-muted-foreground">{doneCount}/{todos.length} done</span>
              )}
            </h4>
            {checklists.length > 0 && (
              <AccessAction collection="tickets" objectPath={t.path} verb="addTodos" can={can} label="Add from checklist">
                <Select value="" disabled={!!busy} onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl) void act("addTodos", { texts: cl.items }, "Checklist added"); }}>
                  {/* w-48 plus the heading is wider than a phone's content column; the row wraps, and the
                      control still fits a 360px screen on its own line. */}
                  <SelectTrigger className="h-8 w-40 text-xs sm:w-48"><SelectValue placeholder="Add from checklist…" /></SelectTrigger>
                  <SelectContent>
                    {checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </AccessAction>
            )}
          </div>
          {todos.length > 0 && (
            <div className="space-y-1.5">
              {todos.map((todo) => (
                <div key={todo.id} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                  <AccessAction collection="tickets" objectPath={t.path} verb="toggleTodo" can={can} label="Check off">
                    <Checkbox checked={todo.done} disabled={!!busy} onCheckedChange={(v) => act("toggleTodo", { todo: todo.id, done: !!v })} />
                  </AccessAction>
                  <span className={cn("flex-1", todo.done && "text-muted-foreground line-through")}>{todo.text}</span>
                  {!todo.done && (
                    <AccessAction collection="cards" create label="Create a task">
                      <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" onClick={() => setPromote(todo.text ?? "")} aria-label="Make this a board task" title="Bigger than a tick-box: make it a board task">
                        <SquareKanban className="h-3.5 w-3.5" />
                      </Button>
                    </AccessAction>
                  )}
                  <AccessAction collection="tickets" objectPath={t.path} verb="removeTodo" can={can} label="Remove item">
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 coarse:h-9 coarse:w-9" disabled={!!busy} onClick={() => act("removeTodo", { todo: todo.id })} aria-label="Remove">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </AccessAction>
                </div>
              ))}
            </div>
          )}
          <AccessAction collection="tickets" objectPath={t.path} verb="addTodos" can={can} label="Add item">
            <div className="flex items-center gap-2">
              <Input
                className="h-8"
                placeholder="Add a checklist item…"
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTodoItem(); } }}
              />
              <Button size="sm" variant="outline" loading={busy === "addTodos"} disabled={!!busy || !newTodo.trim()} onClick={addTodoItem}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </AccessAction>
        </div>

        {/* Comment thread */}
        <div className="space-y-3 border-t pt-3">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <MessageSquare className="h-4 w-4" /> Replies
            {commentCount > 0 && <span className="text-xs font-normal text-muted-foreground">({commentCount})</span>}
          </h4>
          {/* A support thread is a conversation: who said it, how long ago in words, and the same markdown-lite
              (including @mention chips) the rest of the app renders. */}
          <div ref={threadRef} className="max-h-56 space-y-2 overflow-y-auto">
            {(t.comments ?? []).length === 0 && <p className="text-sm text-muted-foreground">No replies yet. Updates and questions land here.</p>}
            {(t.comments ?? []).map((c, i) => {
              const who = c.author ? empName(c.author) : c.author_email ?? "Unknown";
              return (
                <div key={i} className="flex gap-2">
                  {c.author
                    ? <PhotoAvatar employeeId={idOf(c.author)} name={who} className="mt-0.5 h-7 w-7 shrink-0 text-[10px]" />
                    : <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">{initials(who)}</span>}
                  <div className="min-w-0 flex-1 rounded-lg border bg-muted/20 p-2.5 text-sm">
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{who}</span>
                      <span title={c.create_time ? new Date(c.create_time).toLocaleString() : undefined}>{c.create_time ? timeAgo(c.create_time) : fmtDateTime(c.create_time)}</span>
                    </div>
                    <RichText source={c.body ?? ""} className="space-y-1.5" />
                  </div>
                </div>
              );
            })}
          </div>
          <AccessAction collection="tickets" objectPath={t.path} verb="comment" can={can} label="Reply">
            <div className="flex items-end gap-2">
              <div className="relative flex-1">
                <Textarea
                  ref={replyRef}
                  rows={2}
                  placeholder="Write a reply… @ to mention, Ctrl+Enter to send"
                  value={reply}
                  onChange={(e) => { setReply(e.target.value); mentions.sync(); }}
                  onKeyUp={mentions.sync}
                  onClick={mentions.sync}
                  // The mention menu gets first refusal on the keys it uses; only what it did not take sends.
                  onKeyDown={(e) => {
                    if (mentions.onKeyDown(e)) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendReply(); }
                  }}
                />
                {mentions.menu}
              </div>
              <Button size="sm" loading={busy === "comment"} disabled={!!busy || !reply.trim()} onClick={sendReply}>
                <Send className="h-4 w-4" /> Send
              </Button>
            </div>
          </AccessAction>
        </div>

        <ActivitySection resource={t.path} className="border-t pt-3" />
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
      {/* A checklist item that turned out to be a piece of work gets filed on a board, where it can be
          assigned and prioritised. The item stays on the ticket. */}
      {promote !== null && (
        <MakeTaskDialog
          text={promote}
          source={`From support ticket: ${t.subject}`}
          onClose={() => setPromote(null)}
          onCreated={(c) => toast({ title: `${c.key ?? "Task"} created`, variant: "success" })}
        />
      )}
    </Dialog>
  );
}
