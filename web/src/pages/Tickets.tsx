import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Play, Check, X, Ban, RotateCcw, Send, LifeBuoy, MessageSquare, ListChecks, Trash2, AlertCircle, Users } from "lucide-react";
import { create, get, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { useIntent } from "@/lib/intent";
import { cn, formatDate, humanize, idOf } from "@/lib/utils";
import type { Employee, Department, Ticket, TicketCategory, TicketChecklist, Me } from "@/types";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const upper = (s?: string) => (s ?? "").toUpperCase();
const TERMINAL = new Set(["CLOSED", "CANCELLED"]);
// "Updated since you last opened it" is tracked client-side (localStorage): map of ticket path -> the
// update_time you last saw, plus a _baseline stamped on first visit so old history doesn't all light up.
const SEEN_KEY = "tickets-last-seen";
const loadSeen = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
};
// Comment/date stamps in the thread need the time of day - several replies can land on the same date.
const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-";
const isActive = (t: Ticket) => !TERMINAL.has(upper(t.state));
const EMPTY = { category: "", department: "", subject: "", description: "", priority: "medium", todos: [] as string[] };

// Priority chip tones (low/medium/high) for a quick visual scan.
const PRIORITY_TONE: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};
function PriorityBadge({ value }: { value?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_TONE[value ?? "medium"] ?? PRIORITY_TONE.medium}`}>{humanize(value ?? "medium")}</span>;
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
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();

  const [categories, setCategories] = useState<TicketCategory[]>([]);
  useEffect(() => {
    get<{ value?: { categories?: TicketCategory[] } }>("settings/ticket-categories")
      .then((s) => setCategories(s.value?.categories ?? []))
      .catch(() => setCategories([]));
  }, []);
  // Predefined checklists the caller can see (the collection list is scoped by the access middleware, so the
  // pickers only ever show checklists this user has been granted read on).
  const { rows: checklists } = useCollection<TicketChecklist>("ticket-checklists");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<Ticket | null>(null); // the ticket open in the detail drawer

  // Last-seen tracking for the "updated" dot on rows (see SEEN_KEY above).
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    const s = loadSeen();
    if (!s._baseline) {
      s._baseline = new Date().toISOString();
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* private mode */ }
    }
    return s;
  });
  const markSeen = useCallback((t: Ticket) => {
    const at = t.update_time ?? new Date().toISOString();
    setSeen((prev) => {
      if ((prev[t.path] ?? "") >= at) return prev;
      const next = { ...prev, [t.path]: at };
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const isUpdated = (t: Ticket) => !!t.update_time && t.update_time > (seen[t.path] ?? seen._baseline ?? "");
  const openTicket = (t: Ticket) => { setActive(t); markSeen(t); };
  useDeepOpen(openId, rows, openTicket);
  // Global "Raise a support ticket" quick action opens the new-ticket dialog on arrival.
  useIntent("new-ticket", () => { if (me.employee_id) setOpen(true); });

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.name]));
    return (key?: string) => (key ? m.get(key) ?? key : "-");
  }, [categories]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "Unassigned");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [departments]);

  const isRequester = (t: Ticket) => !!(t.employee && me.employee_id && idOf(t.employee) === me.employee_id);
  const isAssignee = (t: Ticket) => !!(t.assignee && me.employee_id && idOf(t.assignee) === me.employee_id);

  const mine = useMemo(() => source.filter(isRequester).sort(byUrgency), [source, me.employee_id]);
  const assigned = useMemo(() => source.filter(isAssignee).sort(byUrgency), [source, me.employee_id]);
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
  }), [rows, me.employee_id]);
  const assignedOpen = useMemo(() => assigned.filter(isActive), [assigned]);
  const mineOpen = useMemo(() => mine.filter(isActive), [mine]);
  const teamOpen = useMemo(() => team.filter(isActive), [team]);
  const [ticketTab, setTicketTab] = useState(assignedOpen.length ? "assigned" : "mine");
  // Viewing a tab clears its "new" badge and advances the reference the next visit measures from.
  useEffect(() => { markTabSeen(`tickets:${ticketTab}`); }, [ticketTab]);

  async function submit() {
    setBusy(true);
    try {
      const initial_todos = form.todos.map((s) => s.trim()).filter(Boolean);
      await create<Ticket>("tickets", {
        category: form.category,
        subject: form.subject,
        description: form.description || null,
        priority: form.priority,
        ...(form.department ? { department: form.department } : {}), // omit -> server derives from the category
        ...(initial_todos.length ? { initial_todos } : {}),
      });
      toast({ title: "Ticket raised", variant: "success" });
      setForm(EMPTY);
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't raise ticket", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

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
    { id: "state", header: "Status", filter: "select", accessor: (t) => t.state, cell: (t) => <StatusBadge state={t.state} /> },
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

  // Bulk state transitions for the servicing queues (assigned/team/all): resolve a batch of worked tickets,
  // close a batch of resolved ones. Enabled only when EVERY selected row supports the verb, so the action's
  // scope is never a surprise; per-row ACLs still enforce server-side.
  const ticketBulkActions: BulkAction<Ticket>[] = [
    {
      label: "Resolve",
      icon: <Check className="h-4 w-4" />,
      confirm: { title: "Resolve the selected tickets?", description: "Requesters confirm-and-close (or reopen) from their side." },
      disabled: (sel) =>
        sel.every((t) => (t.access?.can ?? []).includes("resolve") && ["OPEN", "IN_PROGRESS"].includes(upper(t.state)))
          ? null
          : "Only open or in-progress tickets you may resolve",
      run: async (sel) => {
        const r = await bulkInvoke("tickets", "resolve", sel);
        toast(bulkSummary("Resolved", r));
        reload();
        if (r.failed > 0) throw new Error("partial"); // keep the failed rows selected for a retry
      },
    },
    {
      label: "Close",
      icon: <X className="h-4 w-4" />,
      confirm: { title: "Close the selected tickets?" },
      disabled: (sel) =>
        sel.every((t) => (t.access?.can ?? []).includes("close") && upper(t.state) === "RESOLVED")
          ? null
          : "Only resolved tickets you may close",
      run: async (sel) => {
        const r = await bulkInvoke("tickets", "close", sel);
        toast(bulkSummary("Closed", r));
        reload();
        if (r.failed > 0) throw new Error("partial");
      },
    },
  ];

  const renderTable = (data: Ticket[], columns: Column<Ticket>[], tableId: string, emptyTitle: string, emptyDescription?: string, withBulk?: boolean) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      rows={data}
      search={{ value: search, onChange: setSearch, placeholder: "Search all tickets…" }}
      hasMore={searching ? searchHasMore : undefined}
      onLoadMore={searching ? loadMoreSearch : loadMore}
      getRowId={(t) => t.path}
      onRowClick={(t) => openTicket(t)}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
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
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              {
                label: "Waiting on me", value: needsAction.length, icon: AlertCircle,
                tone: needsAction.length ? "warning" : "success",
                hint: needsAction.length ? "next step is yours" : "nothing needs you",
              },
              { label: "My open tickets", value: mineOpen.length, icon: LifeBuoy, hint: "raised by you" },
              ...(hasTeam ? [{ label: "Team queue", value: teamOpen.length, icon: Users, hint: "open in your categories" }] : []),
              { label: "Total visible", value: rows.length, tone: "muted" as const },
            ]}
          />
        )}
        {/* Land assignees on their queue when something is open there; everyone else starts on their own tickets. */}
        <Tabs value={ticketTab} onValueChange={setTicketTab}>
          <TabsList>
            <TabsTrigger value="mine">My tickets{mine.length ? ` (${mine.length})` : ""}</TabsTrigger>
            <TabsTrigger value="assigned">Assigned to me{assigned.length ? ` (${assigned.length})` : ""}<ActivityBadge count={ticketTab === "assigned" ? 0 : activity["tickets:assigned"] ?? 0} /></TabsTrigger>
            {hasTeam && <TabsTrigger value="team">My team{team.length ? ` (${team.length})` : ""}<ActivityBadge count={ticketTab === "team" ? 0 : activity["tickets:team"] ?? 0} /></TabsTrigger>}
            {/* mine/assigned/team are scope filters of the same collection; the collection-level access key
                rides on "All" (the whole collection), with per-row keys inside each table. */}
            <AccessTab value="all" target={{ collection: "tickets", label: "Support tickets" }}>All<ActivityBadge count={ticketTab === "all" ? 0 : activity["tickets:all"] ?? 0} /></AccessTab>
          </TabsList>
          <TabsContent value="mine">
            {mine.length === 0
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

      <NewTicketDialog open={open} onOpenChange={setOpen} form={form} setForm={setForm} categories={categories} departments={departments} checklists={checklists} busy={busy} onSubmit={submit} />

      <TicketDetail
        ticket={active}
        onClose={() => setActive(null)}
        employees={employees}
        departments={departments}
        checklists={checklists}
        catName={catName}
        empName={empName}
        deptName={deptName}
        canModify={(t) => !TERMINAL.has(upper(t.state))}
        onChanged={(t) => { setActive(t); reload(); }}
        toast={toast}
      />
    </div>
  );
}

function NewTicketDialog({ open, onOpenChange, form, setForm, categories, departments, checklists, busy, onSubmit }: {
  open: boolean; onOpenChange: (v: boolean) => void; form: typeof EMPTY; setForm: (f: typeof EMPTY) => void;
  categories: TicketCategory[]; departments: Department[]; checklists: TicketChecklist[]; busy: boolean; onSubmit: () => void;
}) {
  const [item, setItem] = useState("");
  useEffect(() => { if (!open) setItem(""); }, [open]);
  const addItem = () => { const v = item.trim(); if (!v) return; setForm({ ...form, todos: [...form.todos, v] }); setItem(""); };
  const removeItem = (i: number) => setForm({ ...form, todos: form.todos.filter((_, j) => j !== i) });
  const applyChecklist = (path: string) => {
    const cl = checklists.find((c) => c.path === path);
    if (cl) setForm({ ...form, todos: [...form.todos, ...cl.items] });
  };
  // The selected category's default servicing department; shown as the "Auto" option's label so the picker
  // is a pure override (leave it on Auto and the server derives from the category).
  const catDept = departments.find((d) => `departments/${idOf(d.path)}` === categories.find((c) => c.key === form.category)?.department);
  const valid = !!form.category && !!form.subject.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onEnterSubmit={() => { if (valid && !busy) onSubmit(); }}>
        <DialogHeader><DialogTitle>New support ticket</DialogTitle></DialogHeader>
        <Field label="Subject"><Input autoFocus placeholder="What do you need help with?" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <FieldRow>
          <Field label="Category" hint={categories.length === 0 ? "No categories are configured yet. Ask an admin to add them in Settings." : "Determines who the ticket is assigned to."}>
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

        {/* Optional checklist to seed on the new ticket: pick a template and/or add custom items. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-sm font-medium"><ListChecks className="h-4 w-4" /> Checklist <span className="font-normal text-muted-foreground">(optional)</span></label>
            {checklists.length > 0 && (
              <Select value="" onValueChange={applyChecklist}>
                <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder="Add from checklist…" /></SelectTrigger>
                <SelectContent>
                  {checklists.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
          {form.todos.length > 0 && (
            <div className="space-y-1.5">
              {form.todos.map((it, i) => (
                <div key={i} className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm">
                  <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{it}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => removeItem(i)} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input className="h-8" placeholder="Add a checklist item…" value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} />
            <Button type="button" size="sm" variant="outline" disabled={!item.trim()} onClick={addItem}><Plus className="h-4 w-4" /> Add</Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={busy} disabled={!valid} onClick={onSubmit}>Raise ticket</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Per-verb toast copy: `ok` omitted where the change is already visible in place (thread/checklist), so
// routine edits don't spam toasts; failures always name the action that failed.
const VERB_MSG: Record<string, { ok?: string; fail: string }> = {
  start: { ok: "Ticket started", fail: "Couldn't start the ticket" },
  resolve: { ok: "Ticket resolved", fail: "Couldn't resolve the ticket" },
  close: { ok: "Ticket closed", fail: "Couldn't close the ticket" },
  reopen: { ok: "Ticket reopened", fail: "Couldn't reopen the ticket" },
  cancel: { ok: "Ticket cancelled", fail: "Couldn't cancel the ticket" },
  assign: { ok: "Reassigned", fail: "Couldn't reassign the ticket" },
  route: { ok: "Department updated", fail: "Couldn't route the ticket" },
  prioritize: { ok: "Priority updated", fail: "Couldn't change the priority" },
  comment: { fail: "Couldn't send your reply" },
  addTodos: { fail: "Couldn't add to the checklist" },
  toggleTodo: { fail: "Couldn't update the checklist" },
  removeTodo: { fail: "Couldn't remove the item" },
};

// The ticket drawer: full details + the comment thread + actions (state transitions, reassign, priority, reply).
function TicketDetail({ ticket, onClose, employees, departments, checklists, catName, empName, deptName, canModify, onChanged, toast }: {
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
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const confirm = useConfirm();
  const [full, setFull] = useState<Ticket | null>(null); // ticket + comments + checklist (from Get)
  const [reply, setReply] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // the verb in flight, so only its button spins
  const threadRef = useRef<HTMLDivElement>(null);

  // Fetch the full ticket (with its comment thread + checklist) whenever a row is opened.
  useEffect(() => {
    if (!ticket) { setFull(null); return; }
    setReply("");
    setNewTodo("");
    get<Ticket>(`tickets/${idOf(ticket.path)}`).then(setFull).catch(() => setFull(ticket));
  }, [ticket?.path]);

  // Keep the thread pinned to the latest reply (new replies append at the bottom of a scrolling region).
  const commentCount = full?.comments?.length ?? 0;
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [full?.path, commentCount]);

  const t = full ?? ticket;
  if (!t) return null;
  const can = t.access?.can ?? [];
  const stateU = upper(t.state);
  const modifiable = canModify(t);
  const todos = t.todos ?? [];
  const doneCount = todos.filter((x) => x.done).length;

  async function act(verb: string, body?: Record<string, unknown>, okOverride?: string): Promise<boolean> {
    setBusy(verb);
    try {
      const updated = await invoke<Ticket>(`tickets/${idOf(t!.path)}`, verb, t!.etag, body);
      setFull(updated);
      onChanged(updated);
      const ok = okOverride ?? VERB_MSG[verb]?.ok;
      if (ok) toast({ title: ok, variant: "success" });
      return true;
    } catch (e) {
      toast({ title: VERB_MSG[verb]?.fail ?? "Couldn't update the ticket", description: (e as Error).message, variant: "destructive" });
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

  // State-machine buttons available from the current state (each still gated by access via AccessAction).
  const transitions: { verb: string; label: string; icon: typeof Play; show: boolean; variant?: "success" | "outline" }[] = [
    { verb: "start", label: "Start", icon: Play, show: stateU === "OPEN" },
    { verb: "resolve", label: "Resolve", icon: Check, show: stateU === "OPEN" || stateU === "IN_PROGRESS", variant: "success" },
    { verb: "close", label: "Close", icon: X, show: stateU === "RESOLVED" },
    { verb: "reopen", label: "Reopen", icon: RotateCcw, show: stateU === "RESOLVED" || stateU === "CLOSED", variant: "outline" },
    { verb: "cancel", label: "Cancel", icon: Ban, show: stateU === "OPEN" || stateU === "IN_PROGRESS", variant: "outline" },
  ];
  const runTransition = async (verb: string) => {
    // Cancelling is the one irreversible transition (no reopen from CANCELLED), so it alone confirms.
    if (verb === "cancel" && !(await confirm({
      title: "Cancel this ticket?",
      description: "A cancelled ticket is final. It can't be reopened - you'd have to raise a new one.",
      confirmLabel: "Cancel ticket",
      cancelLabel: "Keep it",
      destructive: true,
    }))) return;
    act(verb);
  };

  return (
    <Dialog open={!!ticket} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <LifeBuoy className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{t.subject}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge state={t.state} />
          <PriorityBadge value={t.priority} />
          <Badge variant="secondary">{catName(t.category)}</Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div><dt className="text-muted-foreground">Requester</dt><dd>{empName(t.employee)}</dd></div>
          <div><dt className="text-muted-foreground">Assignee</dt><dd>{empName(t.assignee)}</dd></div>
          <div><dt className="text-muted-foreground">Department</dt><dd>{deptName(t.department)}</dd></div>
          {t.create_time && <div><dt className="text-muted-foreground">Raised</dt><dd>{formatDate(t.create_time)}</dd></div>}
          {t.update_time && <div><dt className="text-muted-foreground">Last activity</dt><dd>{fmtDateTime(t.update_time)}</dd></div>}
        </dl>

        {t.description && <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{t.description}</p>}

        {/* Actions: reassign + priority (when modifiable), then the state-machine buttons. */}
        {modifiable && (
          <FieldRow>
            <Field label="Assignee">
              <AccessAction collection="tickets" objectPath={t.path} verb="assign" can={can} label="Reassign">
                <Combobox
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
            <Field label="Department">
              <AccessAction collection="tickets" objectPath={t.path} verb="route" can={can} label="Route to a department">
                <Combobox
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
            <Field label="Priority">
              <AccessAction collection="tickets" objectPath={t.path} verb="prioritize" can={can} label="Change priority">
                <Select value={t.priority} disabled={!!busy} onValueChange={(v) => act("prioritize", { priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
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

        <div className="flex flex-wrap gap-2">
          {transitions.filter((x) => x.show).map((x) => (
            <AccessAction key={x.verb} collection="tickets" objectPath={t.path} verb={x.verb} can={can} label={x.label}>
              <Button size="sm" variant={x.variant ?? "default"} loading={busy === x.verb} disabled={!!busy && busy !== x.verb} onClick={() => runTransition(x.verb)}>
                <x.icon className="h-4 w-4" /> {x.label}
              </Button>
            </AccessAction>
          ))}
        </div>

        {/* Checklist / todo list. Items can be added one-off or copied in from a predefined checklist (the
            picker only lists checklists this user can read). */}
        <div className="space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
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
                <Select value="" disabled={!!busy} onValueChange={(v) => { const cl = checklists.find((c) => c.path === v); if (cl) act("addTodos", { texts: cl.items }, "Checklist added"); }}>
                  <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder="Add from checklist…" /></SelectTrigger>
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
                  <AccessAction collection="tickets" objectPath={t.path} verb="removeTodo" can={can} label="Remove item">
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" disabled={!!busy} onClick={() => act("removeTodo", { todo: todo.id })} aria-label="Remove">
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
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTodoItem(); } }}
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
          <div ref={threadRef} className="max-h-56 space-y-2 overflow-y-auto">
            {(t.comments ?? []).length === 0 && <p className="text-sm text-muted-foreground">No replies yet. Updates and questions land here.</p>}
            {(t.comments ?? []).map((c, i) => (
              <div key={i} className="rounded-lg border bg-muted/20 p-2.5 text-sm">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{c.author ? empName(c.author) : c.author_email ?? "Unknown"}</span>
                  <span>{fmtDateTime(c.create_time)}</span>
                </div>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </div>
            ))}
          </div>
          <AccessAction collection="tickets" objectPath={t.path} verb="comment" can={can} label="Reply">
            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                placeholder="Write a reply… (Ctrl+Enter to send)"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); } }}
              />
              <Button size="sm" loading={busy === "comment"} disabled={!!busy || !reply.trim()} onClick={sendReply}>
                <Send className="h-4 w-4" /> Send
              </Button>
            </div>
          </AccessAction>
        </div>

        <ActivitySection resource={t.path} className="border-t pt-3" />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
