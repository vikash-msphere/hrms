import { useMemo, useRef, useState } from "react";
import { CalendarCheck, Plus, Check, Copy, Link2, Pencil, Trash2, RotateCcw, ShieldX, AlertCircle, Repeat, ChevronLeft, ChevronRight, CalendarRange } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import type { ComplianceEvent, ComplianceRule, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { topSlices } from "@/lib/chartTheme";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ProofField, fileProof } from "@/components/common/ProofField";
import { useConfirm } from "@/components/common/confirm";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { setRouteRecord, recordUrl } from "@/router";
import { nextDueDates } from "@/lib/complianceRecurrence";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

// Local calendar date - toISOString() would report yesterday until UTC rolls over, mis-bucketing due/overdue.
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FREQS = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual", label: "Annual" },
];
const freqLabel = (f: string) => FREQS.find((x) => x.value === f)?.label ?? f;
const NONE = "__none__";
const EMPTY = { title: "", category: "", frequency: "monthly", due_date: "", period_label: "", status: "pending", filed_date: "", reference: "", assignee: NONE, notes: "", document: "" };
const EMPTY_RULE = { title: "", category: "", frequency: "monthly", due_day: "15", anchor_month: "4", assignee: NONE, notes: "", active: true };

function advance(dateStr: string, freq: string): string {
  const d = new Date((dateStr || todayStr()) + "T00:00:00Z");
  if (freq === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (freq === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function StatusBadge({ c }: { c: ComplianceEvent }) {
  if (c.status === "filed") return <Badge variant="success" className="gap-1"><Check className="h-3 w-3" /> Filed{c.filed_date ? ` ${formatDate(c.filed_date)}` : ""}</Badge>;
  if (c.status === "waived") return <Badge variant="muted">Waived</Badge>;
  if (c.overdue) return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> Overdue</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

function scheduleLabel(r: ComplianceRule): string {
  const day = `day ${r.due_day}`;
  if (r.frequency === "monthly") return `Monthly · ${day}`;
  const mon = r.anchor_month ? MONTHS[r.anchor_month - 1] : "?";
  if (r.frequency === "quarterly") return `Quarterly · ${day}, from ${mon}`;
  return `Annual · ${r.due_day} ${mon}`;
}

export default function Compliance({ me, openId }: { me: Me; openId?: string }) {
  const [view, setView] = useState<"calendar" | "month" | "recurring">("calendar");
  const { rows, state, error, reload } = useCollection<ComplianceEvent>("compliance-events", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: rules, state: ruleState, error: ruleError, reload: reloadRules } = useCollection<ComplianceRule>("compliance-rules", { showDeleted: true });
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const sd = useSoftDelete("compliance-events", "compliance event", reload);
  const sdRule = useSoftDelete("compliance-rules", "compliance rule", reloadRules);
  const writable = usePermission("compliance-events.write");
  const canPurge = usePermission("compliance-events.admin");
  const ruleWritable = usePermission("compliance-rules.write");
  const ruleCanPurge = usePermission("compliance-rules.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ComplianceEvent | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ComplianceRule | null>(null);
  const [ruleForm, setRuleForm] = useState(EMPTY_RULE);
  // The challan/receipt staged for upload on save (the linked one lives in `form.document`).
  const [proof, setProof] = useState<File | null>(null);
  const confirm = useConfirm();

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    // `null` as well as undefined: an unassigned row carries the field as null, and both mean "nobody".
    return (p?: string | null) => (p ? m.get(idOf(p)) ?? idOf(p) : "");
  }, [employees]);

  // "Mine" and "due this week" are the two questions a filer actually opens this page with, so they are
  // metrics rather than something to reconstruct out of the due-date column.
  const isMine = (c: ComplianceEvent) => !!me.employee_id && !!c.assignee && idOf(c.assignee) === me.employee_id;
  const isDueSoon = (c: ComplianceEvent) => {
    if (c.status !== "pending" || c.overdue) return false;
    const days = (Date.parse(`${c.due_date.slice(0, 10)}T00:00:00`) - Date.now()) / 86400000;
    return days <= 7;
  };
  const stats = useMemo(() => {
    const live = rows.filter((c) => !c.delete_time);
    return {
      overdue: live.filter((c) => c.overdue).length,
      pending: live.filter((c) => c.status === "pending" && !c.overdue).length,
      filed: live.filter((c) => c.status === "filed").length,
      dueSoon: live.filter(isDueSoon).length,
      mine: live.filter((c) => isMine(c) && c.status === "pending").length,
      unassigned: live.filter((c) => c.status === "pending" && !c.assignee).length,
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // The load ahead. Six months rather than twelve: a filing calendar is planned a quarter or two out, and a
  // year of mostly-empty columns squeezes the months that matter into nothing.
  const complianceCharts = useMemo(() => {
    const live = rows.filter((c) => !c.delete_time && c.due_date);
    const now = new Date();
    const keys = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    const inMonth = (c: ComplianceEvent, k: string) => c.due_date.slice(0, 7) === k;
    return {
      total: live.length,
      months: {
        labels: keys.map((k) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })),
        filed: keys.map((k) => live.filter((c) => inMonth(c, k) && c.status === "filed").length),
        pending: keys.map((k) => live.filter((c) => inMonth(c, k) && c.status !== "filed" && c.status !== "waived").length),
      },
      categories: topSlices(live.filter((c) => c.status !== "filed" && c.status !== "waived"), (c) => c.category || "Uncategorised", () => 1, 7),
    };
  }, [rows]);

  const kf = useKpiFocus<ComplianceEvent, "overdue" | "upcoming" | "filed" | "dueSoon" | "mine" | "unassigned">({
    overdue: { label: "overdue filings", match: (c) => !!c.overdue },
    upcoming: { label: "upcoming filings", match: (c) => c.status === "pending" && !c.overdue },
    filed: { label: "filed items", match: (c) => c.status === "filed" },
    dueSoon: { label: "filings due this week", match: isDueSoon },
    mine: { label: "filings assigned to you", match: (c) => isMine(c) && c.status === "pending" },
    unassigned: { label: "unassigned filings", match: (c) => c.status === "pending" && !c.assignee },
  });
  const shownEvents = useMemo(() => kf.apply(rows), [rows, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Occurrence (event) handlers ──
  function openCreate(dueDate = todayStr()) { setEditing(null); setForm({ ...EMPTY, due_date: dueDate }); setProof(null); setOpen(true); }
  function openEdit(c: ComplianceEvent) {
    setEditing(c);
    setForm({
      title: c.title, category: c.category ?? "", frequency: c.frequency, due_date: c.due_date,
      period_label: c.period_label ?? "", status: c.status, filed_date: c.filed_date ?? "",
      reference: c.reference ?? "", assignee: c.assignee ? `employees/${idOf(c.assignee)}` : NONE, notes: c.notes ?? "",
      document: c.document ?? "",
    });
    setProof(null);
    setOpen(true);
    // Put the open item in the hash so a due date can be pasted to whoever has to file it. `useDeepOpen`
    // above was already reading this - nothing wrote it.
    setRouteRecord(idOf(c.path));
  }
  function closeEvent() { setOpen(false); setRouteRecord(null); }
  function copyLink(c: ComplianceEvent) {
    navigator.clipboard.writeText(recordUrl("compliance", idOf(c.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this item can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }
  function eventBody(document: string) {
    return {
      title: form.title.trim(), category: form.category.trim(), frequency: form.frequency,
      due_date: form.due_date, period_label: form.period_label.trim(), status: form.status,
      // `format: date`, and "" is not a date - an unfiled item leaves it out.
      ...(form.status === "filed" && form.filed_date ? { filed_date: form.filed_date } : {}),
      reference: form.reference.trim(), assignee: form.assignee === NONE ? "" : form.assignee, notes: form.notes.trim(),
      document,
    };
  }
  // Throws to fail: the dialog keeps the form and shows the message inside it.
  async function submit() {
    // The challan goes onto the document shelf first; the filing then links it. Uploading before the write
    // means a failed save leaves a stray document, which is the harmless direction - the alternative loses the
    // receipt someone just attached.
    const document = proof
      ? await fileProof({ file: proof, title: `${form.title.trim()}${form.period_label.trim() ? ` - ${form.period_label.trim()}` : ""} (proof)` })
      : form.document;
    if (editing) { await patch("compliance-events/" + idOf(editing.path), eventBody(document), editing.etag); toast({ title: "Compliance item updated", variant: "success" }); }
    else { await create("compliance-events", eventBody(document)); toast({ title: "Compliance item added", variant: "success" }); }
    setProof(null);
    setRouteRecord(null);
    reload();
  }
  async function markFiled(c: ComplianceEvent) {
    try { await patch("compliance-events/" + idOf(c.path), { status: "filed" }, c.etag); toast({ title: "Marked filed", description: c.title, variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }
  // Dragging an item onto another day in the month view: the same field the dialog edits, one gesture. Asked
  // first, because a due date is a deadline somebody else may be working to.
  async function moveDue(c: ComplianceEvent, dueDate: string) {
    if (c.due_date.slice(0, 10) === dueDate) return;
    const ok = await confirm({
      title: "Move this deadline?",
      description: `"${c.title}" moves from ${formatDate(c.due_date)} to ${formatDate(dueDate)}.`,
      confirmLabel: "Move it",
    });
    if (!ok) return;
    try { await patch("compliance-events/" + idOf(c.path), { due_date: dueDate }, c.etag); toast({ title: "Due date moved", description: formatDate(dueDate), variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't move it", description: (e as Error).message, variant: "destructive" }); }
  }
  async function duplicateNext(c: ComplianceEvent) {
    try {
      await create("compliance-events", { title: c.title, category: c.category ?? null, frequency: c.frequency, due_date: advance(c.due_date, c.frequency), period_label: null, status: "pending", assignee: c.assignee ?? null, notes: c.notes ?? null });
      toast({ title: "Duplicated to next period", description: `Due ${formatDate(advance(c.due_date, c.frequency))}`, variant: "success" }); reload();
    } catch (e) { toast({ title: "Couldn't duplicate", description: (e as Error).message, variant: "destructive" }); }
  }

  // ── Recurring rule handlers ──
  function openCreateRule() { setEditingRule(null); setRuleForm(EMPTY_RULE); setRuleOpen(true); }
  function openEditRule(r: ComplianceRule) {
    setEditingRule(r);
    setRuleForm({ title: r.title, category: r.category ?? "", frequency: r.frequency, due_day: String(r.due_day), anchor_month: String(r.anchor_month ?? 4), assignee: r.assignee ? `employees/${idOf(r.assignee)}` : NONE, notes: r.notes ?? "", active: r.active });
    setRuleOpen(true);
  }
  function ruleBody() {
    return {
      title: ruleForm.title.trim(), category: ruleForm.category.trim() || null, frequency: ruleForm.frequency,
      due_day: Number(ruleForm.due_day) || 1, anchor_month: ruleForm.frequency === "monthly" ? null : Number(ruleForm.anchor_month) || 1,
      assignee: ruleForm.assignee === NONE ? null : ruleForm.assignee, notes: ruleForm.notes.trim() || null, active: ruleForm.active,
    };
  }
  async function submitRule() {
    if (editingRule) { await patch("compliance-rules/" + idOf(editingRule.path), ruleBody(), editingRule.etag); toast({ title: "Rule updated", description: "Upcoming occurrences refreshed.", variant: "success" }); }
    else { await create("compliance-rules", ruleBody()); toast({ title: "Recurring rule added", description: "Occurrences generated for the next 12 months.", variant: "success" }); }
    reloadRules();
    reload();
  }

  // ── what the two forms are about to do ──
  // A statutory due date is only meaningful as a distance from today: "15 Sep" says nothing, "in 3 days" is
  // the difference between filing and a penalty.
  const dueHint = (() => {
    if (!form.due_date) return undefined;
    const days = Math.round((Date.parse(`${form.due_date}T00:00:00`) - Date.parse(`${todayStr()}T00:00:00`)) / 86400000);
    if (Number.isNaN(days)) return undefined;
    if (form.status !== "pending") return undefined;
    if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} overdue.`;
    if (days === 0) return "Due today.";
    return `Due in ${days} ${days === 1 ? "day" : "days"}.`;
  })();
  // The same obligation filed twice for the same period is two filings to reconcile. Warn, never block.
  const eventClash = useMemo(() => {
    const t = form.title.trim().toLowerCase();
    if (!t || !form.due_date) return null;
    return rows.find((c) => !c.delete_time && c.path !== editing?.path && c.title.trim().toLowerCase() === t && c.due_date.slice(0, 10) === form.due_date) ?? null;
  }, [rows, form.title, form.due_date, editing?.path]);
  const eventCanSubmit = !!form.title.trim() && !!form.due_date;
  const eventWhyNot = !form.title.trim() ? "Name the obligation." : "Give it a due date.";

  const dueDayNum = Number(ruleForm.due_day);
  const dueDayBad = ruleForm.due_day === "" || !Number.isFinite(dueDayNum) || dueDayNum < 1 || dueDayNum > 31;
  const ruleCanSubmit = !!ruleForm.title.trim() && !dueDayBad;
  const ruleWhyNot = !ruleForm.title.trim() ? "Name the obligation." : "The due day must be between 1 and 31.";
  // What this schedule actually produces. A rule is written once and then generates filings for a year, so it
  // has to show its next few dates before it is saved - "quarterly, day 15, from April" is not readable.
  const rulePreview = useMemo(
    () => (dueDayBad ? [] : nextDueDates({ frequency: ruleForm.frequency as "monthly" | "quarterly" | "annual", dueDay: dueDayNum, anchorMonth: Number(ruleForm.anchor_month) || 1 }, 3)),
    [ruleForm.frequency, dueDayNum, ruleForm.anchor_month, dueDayBad],
  );

  const eventColumns: Column<ComplianceEvent>[] = [
    {
      id: "title", header: "Obligation", accessor: (c) => c.title,
      cell: (c) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium">{c.title}{c.rule && <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Recurring" />}</p>
          {c.period_label && <p className="truncate text-xs text-muted-foreground">{c.period_label}</p>}
        </div>
      ),
    },
    { id: "category", header: "Authority", filter: "select", accessor: (c) => c.category ?? "", cell: (c) => c.category || <span className="text-muted-foreground">-</span> },
    { id: "frequency", header: "Frequency", filter: "select", accessor: (c) => freqLabel(c.frequency), cell: (c) => <Badge variant="secondary">{freqLabel(c.frequency)}</Badge> },
    { id: "due", header: "Due", accessor: (c) => c.due_date, cell: (c) => <span className={c.overdue ? "font-medium text-destructive" : undefined}>{formatDate(c.due_date)}</span> },
    {
      id: "status", header: "Status", filter: "select",
      accessor: (c) => (c.status === "pending" && c.overdue ? "Overdue" : c.status === "filed" ? "Filed" : c.status === "waived" ? "Waived" : "Pending"),
      cell: (c) => <StatusBadge c={c} />,
    },
    { id: "assignee", header: "Owner", defaultHidden: true, accessor: (c) => empName(c.assignee), cell: (c) => empName(c.assignee) || <span className="text-muted-foreground">-</span> },
    { id: "reference", header: "Reference", defaultHidden: true, accessor: (c) => c.reference ?? "", cell: (c) => c.reference || "-" },
    stateColumn<ComplianceEvent>(),
    ...metaColumns<ComplianceEvent>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (c) => {
        const items: RowAction[] = [];
        if (c.delete_time) {
          if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sd.restore(c), verb: "restore" });
          if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sd.permanentlyDelete(c), destructive: true, verb: "delete" });
        } else if (writable) {
          if (c.status === "pending") items.push({ label: "Mark filed", icon: <Check className="h-4 w-4" />, onClick: () => markFiled(c) });
          items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(c) });
          items.push({ label: "Duplicate to next period", icon: <Copy className="h-4 w-4" />, onClick: () => duplicateNext(c) });
          items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sd.softDelete(c), destructive: true, verb: "delete" });
        }
        return <RowActions actions={items} />;
      },
    },
  ];

  const ruleColumns: Column<ComplianceRule>[] = [
    { id: "title", header: "Obligation", accessor: (r) => r.title, cell: (r) => <span className="font-medium">{r.title}</span> },
    { id: "category", header: "Authority", filter: "select", accessor: (r) => r.category ?? "", cell: (r) => r.category || <span className="text-muted-foreground">-</span> },
    { id: "schedule", header: "Schedule", accessor: (r) => scheduleLabel(r), cell: (r) => <span className="inline-flex items-center gap-1.5"><Repeat className="h-3.5 w-3.5 text-muted-foreground" /> {scheduleLabel(r)}</span> },
    { id: "owner", header: "Owner", accessor: (r) => empName(r.assignee), cell: (r) => empName(r.assignee) || <span className="text-muted-foreground">-</span> },
    { id: "active", header: "State", filter: "select", accessor: (r) => (r.delete_time ? "Deleted" : r.active ? "Active" : "Paused"), cell: (r) => r.delete_time ? <Badge variant="muted">Deleted</Badge> : r.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="warning">Paused</Badge> },
    ...metaColumns<ComplianceRule>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => {
        const items: RowAction[] = [];
        if (r.delete_time) {
          if (ruleWritable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sdRule.restore(r), verb: "restore" });
          if (ruleCanPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sdRule.permanentlyDelete(r), destructive: true, verb: "delete" });
        } else if (ruleWritable) {
          items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEditRule(r) });
          items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sdRule.softDelete(r), destructive: true, verb: "delete" });
        }
        return <RowActions actions={items} />;
      },
    },
  ];

  const addBtn = view === "recurring"
    ? (ruleWritable && <AccessAction collection="compliance-rules" create><Button onClick={openCreateRule}><Plus className="h-4 w-4" /> Add rule</Button></AccessAction>)
    : (writable && <AccessAction collection="compliance-events" create><Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> Add item</Button></AccessAction>);

  return (
    <div>
      <PageHeader
        accessCollection="compliance-events"
        title="Compliance Calendar"
        description="Statutory due dates for PF, ESI, TDS, GST, PT and returns."
        actions={addBtn}
      />

      <div className="mb-4 flex items-center gap-2">
        {(["calendar", "month", "recurring"] as const).map((v) => (
          <Button key={v} variant={view === v ? "default" : "outline"} size="sm" onClick={() => setView(v)}>
            {v === "calendar" ? "List" : v === "month" ? "Month" : "Recurring rules"}
          </Button>
        ))}
      </div>

      {view === "calendar" ? (
        <>
          {/* A filing calendar is read forward: what is coming, and how much of it. The table sorts by date
              and still cannot show that March carries four times February's load - which is the thing that
              decides whether next month needs help. */}
          {state === "ready" && complianceCharts.total > 2 && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <ChartCard title="Filings ahead" description="What falls due in each of the next six months.">
                <Chart
                  type="bar"
                  height={180}
                  labels={complianceCharts.months.labels}
                  datasets={[
                    { name: "Filed", values: complianceCharts.months.filed },
                    { name: "Still to file", values: complianceCharts.months.pending },
                  ]}
                  stacked
                  format={(v) => `${v} filing${v === 1 ? "" : "s"}`}
                  ariaLabel="Compliance filings due in each of the next six months, filed and outstanding"
                />
              </ChartCard>
              <ChartCard title="By obligation" description="Which authority the outstanding work belongs to.">
                <Chart
                  type="donut"
                  height={180}
                  labels={complianceCharts.categories.labels}
                  datasets={[{ name: "Filings", values: complianceCharts.categories.values }]}
                  ariaLabel="Outstanding compliance filings by category"
                  emptyText="Nothing outstanding."
                />
              </ChartCard>
            </div>
          )}

          {/* Every metric narrows the table, so the strip sits directly on top of it - under the charts. */}
          <SummaryStrip
            items={[
              { label: "Overdue", value: stats.overdue, tone: stats.overdue > 0 ? "destructive" : "muted", hint: stats.overdue ? "past due, unfiled" : "nothing late", ...kf.kpi("overdue") },
              { label: "Due this week", value: stats.dueSoon, tone: stats.dueSoon > 0 ? "warning" : "muted", hint: stats.dueSoon ? "next 7 days" : "nothing this week", ...kf.kpi("dueSoon") },
              ...(me.employee_id ? [{ label: "Assigned to you", value: stats.mine, tone: (stats.mine > 0 ? "primary" : "muted") as "primary" | "muted", hint: stats.mine ? "yours to file" : "nothing on you", ...kf.kpi("mine") }] : []),
              { label: "Unassigned", value: stats.unassigned, tone: stats.unassigned > 0 ? "warning" : "muted", hint: stats.unassigned ? "nobody owns these" : "all owned", ...kf.kpi("unassigned") },
              { label: "Upcoming", value: stats.pending, tone: stats.pending > 0 ? "warning" : "muted", hint: "not filed yet", ...kf.kpi("upcoming") },
              { label: "Filed", value: stats.filed, tone: stats.filed > 0 ? "success" : "muted", hint: "done this window", ...kf.kpi("filed") },
            ]}
          />

          <DataState state={state} error={error} onRetry={reload}>
            {rows.length === 0 ? (
              <EmptyState icon={CalendarCheck} title="No compliance items" description="Add statutory due dates, or set up recurring rules to auto-generate them." action={addBtn} />
            ) : (
              <DataTable columns={eventColumns} tableId="compliance-events" rows={shownEvents} getRowId={(c) => c.path} rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)} emptyTitle={kf.activeLabel ? `No ${kf.activeLabel}` : "No items match"} accessCollection="compliance-events" accessTargetOf={(c) => ({ objectPath: c.path, label: c.title, can: c.access?.can })} />
            )}
          </DataState>
        </>
      ) : view === "month" ? (
        <DataState state={state} error={error} onRetry={reload}>
          <MonthView
            events={rows}
            onOpen={(c) => (writable ? openEdit(c) : undefined)}
            onAdd={writable ? (day) => openCreate(day) : undefined}
            onMove={writable ? moveDue : undefined}
          />
        </DataState>
      ) : (
        <DataState state={ruleState} error={ruleError} onRetry={reloadRules}>
          {rules.length === 0 ? (
            <EmptyState icon={Repeat} title="No recurring rules" description="Define a recurring obligation (e.g. PF, monthly, due 15th) and occurrences are generated automatically for the next 12 months and rolled forward over time." action={addBtn} />
          ) : (
            <DataTable columns={ruleColumns} tableId="compliance-rules" rows={rules} getRowId={(r) => r.path} rowClassName={(r) => (r.delete_time ? "opacity-60" : undefined)} emptyTitle="No rules match" accessCollection="compliance-rules" accessTargetOf={(r) => ({ objectPath: r.path, label: r.title, can: r.access?.can })} />
          )}
        </DataState>
      )}

      {/* Occurrence dialog */}
      <WriteDialog
        open={open}
        onClose={closeEvent}
        title={editing ? "Edit compliance item" : "Add compliance item"}
        description="One filing with a deadline. Marking it filed is what clears it from the overdue count - the reference is what proves it."
        collection="compliance-events"
        objectPath={editing?.path}
        guardLabel="compliance item"
        // The staged receipt is part of what a discard would throw away.
        form={{ ...form, proof: proof ? `${proof.name}:${proof.size}` : null }}
        // Only a fresh item gets a draft: a restored draft on an edit would silently overwrite the record's
        // own values (see WriteDialog).
        draftKey={editing ? undefined : "compliance-event"}
        applyDraft={editing ? undefined : (d) => setForm({ ...EMPTY, ...d, proof: undefined } as typeof form)}
        onStartOver={editing ? undefined : () => setForm({ ...EMPTY, due_date: todayStr() })}
        submitLabel={editing ? "Save changes" : "Add item"}
        canSubmit={eventCanSubmit}
        whyNot={eventWhyNot}
        onSubmit={submit}
        footerStart={editing && (
          <Button type="button" variant="ghost" size="sm" onClick={() => copyLink(editing)}>
            <Link2 className="h-4 w-4" /> Copy link
          </Button>
        )}
      >
          <Field label="Obligation"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. PF (EPF) contribution" autoFocus /></Field>
          {eventClash && (
            <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
              "{eventClash.title}" is already on the calendar for {formatDate(eventClash.due_date)}
              {eventClash.status === "filed" ? " and is filed" : eventClash.rule ? " from a recurring rule" : ""} - filing the same period twice is two challans to reconcile.
            </p>
          )}
          <FieldRow>
            <Field label="Authority / area" hint="EPFO, Income Tax, GST, ESIC, PT…"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. EPFO" /></Field>
            <Field label="Frequency">
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{FREQS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Due date" hint={dueHint}><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
            <Field label="Period covered" hint="e.g. Jun 2026, Q1 FY26-27"><Input value={form.period_label} onChange={(e) => setForm({ ...form, period_label: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Status">
              {/* Moving to Filed seeds today's date rather than leaving the reader to type the date they are
                  filing on - and switching back to Pending drops it, so a pending item can't carry one. */}
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v, filed_date: v === "filed" ? (form.filed_date || todayStr()) : "" })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="filed">Filed</SelectItem><SelectItem value="waived">Waived / N/A</SelectItem></SelectContent>
              </Select>
            </Field>
            {form.status === "filed" && (
              <Field
                label="Filed on"
                hint={form.filed_date && form.due_date && form.filed_date > form.due_date ? "After the due date - filed late." : "Defaults to today if blank."}
              >
                <Input type="date" value={form.filed_date} onChange={(e) => setForm({ ...form, filed_date: e.target.value })} />
              </Field>
            )}
            <Field
              label="Reference"
              hint="Challan / acknowledgement no."
              // `eager`: this message is not about what is being typed HERE - it appears because Status was
              // moved to Filed, in another field entirely. Held back until Reference had been focused and left,
              // it stayed invisible to everyone who set the status and pressed save, which is everyone.
              eager
              error={form.status === "filed" && !form.reference.trim() && !form.document && !proof ? "Filed with neither a reference nor a receipt - nothing proves it later." : undefined}
            >
              <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder={form.status === "filed" ? "Challan no." : "Optional"} />
            </Field>
            <Field label="Owner" hint="Who chases this filing.">
              <Select value={form.assignee} onValueChange={(v) => setForm({ ...form, assignee: v })}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>Unassigned</SelectItem>{employees.filter((e) => !e.disabled).map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </FieldRow>
          {/* The receipt itself. A reference number is a claim; this is the thing an auditor asks for. */}
          <ProofField
            label="Proof of filing"
            collection="org-documents"
            hint="The challan, receipt or acknowledgement, filed on the company document shelf."
            documentPath={form.document || null}
            fileName={`${form.title.trim() || "compliance"}${form.period_label.trim() ? ` - ${form.period_label.trim()}` : ""}.pdf`}
            file={proof}
            onFile={setProof}
            onUnlink={() => setForm({ ...form, document: "" })}
            dropHint="PDF or image of the challan / acknowledgement."
          />
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" /></Field>
          {editing?.rule && (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Repeat className="mr-1 inline h-3.5 w-3.5" />
              Generated by a recurring rule. Editing this occurrence changes only this one - change the rule to change the ones ahead.
            </p>
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>

      {/* Recurring rule dialog */}
      <WriteDialog
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        title={editingRule ? "Edit recurring rule" : "Add recurring rule"}
        description={editingRule
          ? "Saving tops up the next 12 months of occurrences. Already-generated dates are never rewritten or removed."
          : "Saving generates the next 12 months of occurrences, and a daily job rolls that window forward."}
        collection="compliance-rules"
        objectPath={editingRule?.path}
        guardLabel="recurring rule"
        form={ruleForm}
        draftKey={editingRule ? undefined : "compliance-rule"}
        applyDraft={editingRule ? undefined : (d) => setRuleForm({ ...EMPTY_RULE, ...d })}
        onStartOver={editingRule ? undefined : () => setRuleForm(EMPTY_RULE)}
        submitLabel={editingRule ? "Save changes" : "Add rule"}
        canSubmit={ruleCanSubmit}
        whyNot={ruleWhyNot}
        onSubmit={submitRule}
      >
          <Field label="Obligation"><Input value={ruleForm.title} onChange={(e) => setRuleForm({ ...ruleForm, title: e.target.value })} placeholder="e.g. PF (EPF) contribution" autoFocus /></Field>
          <FieldRow>
            <Field label="Authority / area"><Input value={ruleForm.category} onChange={(e) => setRuleForm({ ...ruleForm, category: e.target.value })} placeholder="e.g. EPFO" /></Field>
            <Field label="Frequency">
              <Select value={ruleForm.frequency} onValueChange={(v) => setRuleForm({ ...ruleForm, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="annual">Annual</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Due day" hint="Day of month; a short month clamps to its last day." error={ruleForm.due_day !== "" && dueDayBad ? "Day must be 1-31." : undefined}><Input type="number" min={1} max={31} value={ruleForm.due_day} onChange={(e) => setRuleForm({ ...ruleForm, due_day: e.target.value })} /></Field>
            {ruleForm.frequency !== "monthly" && (
              <Field label={ruleForm.frequency === "quarterly" ? "Cycle start month" : "Month"} hint={ruleForm.frequency === "quarterly" ? "Then every 3 months." : undefined}>
                <Select value={ruleForm.anchor_month} onValueChange={(v) => setRuleForm({ ...ruleForm, anchor_month: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Owner" hint="Inherited by every occurrence this rule generates.">
              <Select value={ruleForm.assignee} onValueChange={(v) => setRuleForm({ ...ruleForm, assignee: v })}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>Unassigned</SelectItem>{employees.filter((e) => !e.disabled).map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </FieldRow>
          {/* The schedule read back as dates, so a wrong anchor month is caught here rather than in April. */}
          {rulePreview.length > 0 && (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Repeat className="mr-1 inline h-3.5 w-3.5" />
              {ruleForm.active ? "Next filings: " : "Would generate: "}
              <span className="font-medium text-foreground">{rulePreview.map((d) => formatDate(d)).join(" · ")}</span>
              {ruleForm.frequency === "monthly" ? ", then every month." : ruleForm.frequency === "quarterly" ? ", then every 3 months." : ", then yearly."}
            </p>
          )}
          <Field label="Notes"><Textarea rows={2} value={ruleForm.notes} onChange={(e) => setRuleForm({ ...ruleForm, notes: e.target.value })} placeholder="Optional" /></Field>
          <label className={cn("flex items-start gap-2 rounded-lg border p-3", !ruleForm.active && "opacity-70")}>
            <Checkbox checked={ruleForm.active} onCheckedChange={(v) => setRuleForm({ ...ruleForm, active: v === true })} className="mt-0.5" />
            <span>
              <span className="text-sm font-medium">Active</span>
              <span className="block text-xs text-muted-foreground">
                {ruleForm.active
                  ? "Occurrences keep being generated ahead of time."
                  : "Paused - nothing new is generated. Occurrences already on the calendar stay there."}
              </span>
            </span>
          </label>
          {editingRule && <ActivitySection resource={editingRule.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
  );
}

const DAY_MS = 86400000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
// Colour a due date by its filing status: filed=green, waived=slate, overdue=red, pending=amber.
const statusColor = (c: ComplianceEvent) => (c.status === "filed" ? "#10b981" : c.status === "waived" ? "#94a3b8" : c.overdue ? "#ef4444" : "#f59e0b");

// Month-grid view of compliance items, placed on their due dates and coloured by status. A 42-cell (6-week)
// grid starting on the Sunday on/before the 1st.
//
// The grid is where deadlines are actually read, so it is also where they are set: clicking an empty day opens
// a new item already dated to it, and dragging an item onto another day moves its due date (after asking). It
// used to be a picture of the calendar that could only open what somebody had already typed elsewhere.
function MonthView({ events, onOpen, onAdd, onMove }: {
  events: ComplianceEvent[];
  onOpen: (c: ComplianceEvent) => void;
  onAdd?: (day: string) => void;
  onMove?: (c: ComplianceEvent, day: string) => void;
}) {
  const [cursor, setCursor] = useState(() => monthStart(new Date()));
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dragging = useRef<ComplianceEvent | null>(null);
  const byDay = useMemo(() => {
    const m = new Map<string, ComplianceEvent[]>();
    for (const c of events) {
      if (c.delete_time) continue;
      const k = c.due_date.slice(0, 10);
      const arr = m.get(k);
      if (arr) arr.push(c); else m.set(k, [c]);
    }
    return m;
  }, [events]);
  const gridStart = useMemo(() => new Date(+cursor - cursor.getUTCDay() * DAY_MS), [cursor]);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => new Date(+gridStart + i * DAY_MS)), [gridStart]);
  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const month = cursor.getUTCMonth();
  // Local date for the "today" ring - toISOString() would mark yesterday until UTC rolls over.
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  return (
    <Card>
      <CardContent className="p-0 sm:p-0">
        {/* Month stepper + "Today" + the month name, with a status legend pushed to the far end. The
            legend is already `hidden … sm:flex`, but the stepper group itself still needs room to break
            on the narrowest screens rather than pushing the calendar sideways. */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() - 1, 1)))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => setCursor(monthStart(new Date()))}>Today</Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1)))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-1 flex items-center gap-2 text-base font-semibold"><CalendarRange className="h-4 w-4 text-primary" />{monthLabel}</span>
          {/* Status legend for the coloured due-date dots. */}
          <span className="ml-auto hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
            {([["#f59e0b", "Pending"], ["#ef4444", "Overdue"], ["#10b981", "Filed"], ["#94a3b8", "Waived"]] as const).map(([c, l]) => (
              <span key={l} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} /> {l}</span>
            ))}
          </span>
        </div>
        <div className="grid grid-cols-7 border-b bg-muted/30 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {DOW.map((d) => <div key={d} className="py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const ymd = d.toISOString().slice(0, 10);
            const inMonth = d.getUTCMonth() === month;
            const isToday = ymd === today;
            const items = byDay.get(ymd) ?? [];
            return (
              <div
                key={i}
                onDragOver={onMove ? (e) => { if (dragging.current) { e.preventDefault(); setDragOver(ymd); } } : undefined}
                onDragLeave={onMove ? () => setDragOver((c) => (c === ymd ? null : c)) : undefined}
                onDrop={onMove ? (e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const c = dragging.current;
                  dragging.current = null;
                  if (c) onMove(c, ymd);
                } : undefined}
                className={cn(
                  "group relative min-h-[96px] border-b border-r p-1.5 align-top last:border-r-0",
                  i % 7 === 6 && "border-r-0",
                  !inMonth && "bg-muted/20",
                  dragOver === ymd && "bg-primary/10 ring-1 ring-inset ring-primary",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-sm tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground", !inMonth && "text-muted-foreground/50")}>{d.getUTCDate()}</span>
                  {onAdd && (
                    <button
                      type="button"
                      onClick={() => onAdd(ymd)}
                      title={`Add a filing due ${ymd}`}
                      aria-label={`Add a filing due ${ymd}`}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:flex coarse:h-8 coarse:w-8 coarse:items-center coarse:justify-center coarse:p-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1 space-y-1">
                  {items.slice(0, 3).map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      draggable={!!onMove}
                      onDragStart={onMove ? () => { dragging.current = c; } : undefined}
                      onDragEnd={onMove ? () => { dragging.current = null; setDragOver(null); } : undefined}
                      onClick={() => onOpen(c)}
                      title={`${c.title}${c.category ? ` · ${c.category}` : ""}${onMove ? " - drag to another day to move the deadline" : ""}`}
                      className={cn("flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent", onMove && "cursor-grab active:cursor-grabbing")}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColor(c) }} />
                      <span className="truncate">{c.title}</span>
                    </button>
                  ))}
                  {items.length > 3 && <p className="px-1 text-[11px] text-muted-foreground">+{items.length - 3} more</p>}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
