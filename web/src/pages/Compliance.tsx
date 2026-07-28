import { useMemo, useState } from "react";
import { CalendarCheck, Plus, Check, Copy, Pencil, Trash2, RotateCcw, ShieldX, AlertCircle, Repeat, ChevronLeft, ChevronRight, CalendarRange } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import type { ComplianceEvent, ComplianceRule, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
const EMPTY = { title: "", category: "", frequency: "monthly", due_date: "", period_label: "", status: "pending", filed_date: "", reference: "", assignee: NONE, notes: "" };
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
  void me;
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
  const [busy, setBusy] = useState(false);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "");
  }, [employees]);

  const stats = useMemo(() => {
    const live = rows.filter((c) => !c.delete_time);
    return {
      overdue: live.filter((c) => c.overdue).length,
      pending: live.filter((c) => c.status === "pending" && !c.overdue).length,
      filed: live.filter((c) => c.status === "filed").length,
    };
  }, [rows]);

  // ── Occurrence (event) handlers ──
  function openCreate() { setEditing(null); setForm({ ...EMPTY, due_date: todayStr() }); setOpen(true); }
  function openEdit(c: ComplianceEvent) {
    setEditing(c);
    setForm({
      title: c.title, category: c.category ?? "", frequency: c.frequency, due_date: c.due_date,
      period_label: c.period_label ?? "", status: c.status, filed_date: c.filed_date ?? "",
      reference: c.reference ?? "", assignee: c.assignee ? `employees/${idOf(c.assignee)}` : NONE, notes: c.notes ?? "",
    });
    setOpen(true);
  }
  function eventBody() {
    return {
      title: form.title.trim(), category: form.category.trim() || null, frequency: form.frequency,
      due_date: form.due_date, period_label: form.period_label.trim() || null, status: form.status,
      filed_date: form.status === "filed" ? form.filed_date || null : null,
      reference: form.reference.trim() || null, assignee: form.assignee === NONE ? null : form.assignee, notes: form.notes.trim() || null,
    };
  }
  async function submit() {
    setBusy(true);
    try {
      if (editing) { await patch("compliance-events/" + idOf(editing.path), eventBody(), editing.etag); toast({ title: "Compliance item updated", variant: "success" }); }
      else { await create("compliance-events", eventBody()); toast({ title: "Compliance item added", variant: "success" }); }
      setOpen(false); reload();
    } catch (e) { toast({ title: "Couldn't save item", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function markFiled(c: ComplianceEvent) {
    try { await patch("compliance-events/" + idOf(c.path), { status: "filed" }, c.etag); toast({ title: "Marked filed", description: c.title, variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
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
    setBusy(true);
    try {
      if (editingRule) { await patch("compliance-rules/" + idOf(editingRule.path), ruleBody(), editingRule.etag); toast({ title: "Rule updated", description: "Upcoming occurrences refreshed.", variant: "success" }); }
      else { await create("compliance-rules", ruleBody()); toast({ title: "Recurring rule added", description: "Occurrences generated for the next 12 months.", variant: "success" }); }
      setRuleOpen(false); reloadRules(); reload();
    } catch (e) { toast({ title: "Couldn't save rule", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

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
    : (writable && <AccessAction collection="compliance-events" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add item</Button></AccessAction>);

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
          <SummaryStrip
            items={[
              { label: "Overdue", value: stats.overdue, tone: stats.overdue > 0 ? "destructive" : "muted" },
              { label: "Upcoming", value: stats.pending, tone: stats.pending > 0 ? "warning" : "muted" },
              { label: "Filed", value: stats.filed, tone: stats.filed > 0 ? "success" : "muted" },
            ]}
          />
          <DataState state={state} error={error} onRetry={reload}>
            {rows.length === 0 ? (
              <EmptyState icon={CalendarCheck} title="No compliance items" description="Add statutory due dates, or set up recurring rules to auto-generate them." action={addBtn} />
            ) : (
              <DataTable columns={eventColumns} tableId="compliance-events" rows={rows} getRowId={(c) => c.path} rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)} emptyTitle="No items match" accessCollection="compliance-events" accessTargetOf={(c) => ({ objectPath: c.path, label: c.title, can: c.access?.can })} />
            )}
          </DataState>
        </>
      ) : view === "month" ? (
        <DataState state={state} error={error} onRetry={reload}>
          <MonthView events={rows} onOpen={(c) => (writable ? openEdit(c) : undefined)} />
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.title.trim() && form.due_date) submit(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit compliance item" : "Add compliance item"}</DialogTitle></DialogHeader>
          <Field label="Obligation"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. PF (EPF) contribution" autoFocus /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authority / area" hint="EPFO, Income Tax, GST, ESIC, PT…"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. EPFO" /></Field>
            <Field label="Frequency">
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{FREQS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Due date"><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
            <Field label="Period covered" hint="e.g. Jun 2026, Q1 FY26-27"><Input value={form.period_label} onChange={(e) => setForm({ ...form, period_label: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="filed">Filed</SelectItem><SelectItem value="waived">Waived / N/A</SelectItem></SelectContent>
              </Select>
            </Field>
            {form.status === "filed" && <Field label="Filed on" hint="Defaults to today if blank."><Input type="date" value={form.filed_date} onChange={(e) => setForm({ ...form, filed_date: e.target.value })} /></Field>}
            <Field label="Reference" hint="Challan / acknowledgement no."><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Owner">
              <Select value={form.assignee} onValueChange={(v) => setForm({ ...form, assignee: v })}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>Unassigned</SelectItem>{employees.filter((e) => !e.disabled).map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.title.trim() || !form.due_date}>{editing ? "Save changes" : "Add item"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recurring rule dialog */}
      <Dialog open={ruleOpen} onOpenChange={setRuleOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && ruleForm.title.trim() && ruleForm.due_day) submitRule(); }}>
          <DialogHeader><DialogTitle>{editingRule ? "Edit recurring rule" : "Add recurring rule"}</DialogTitle></DialogHeader>
          <Field label="Obligation"><Input value={ruleForm.title} onChange={(e) => setRuleForm({ ...ruleForm, title: e.target.value })} placeholder="e.g. PF (EPF) contribution" autoFocus /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authority / area"><Input value={ruleForm.category} onChange={(e) => setRuleForm({ ...ruleForm, category: e.target.value })} placeholder="e.g. EPFO" /></Field>
            <Field label="Frequency">
              <Select value={ruleForm.frequency} onValueChange={(v) => setRuleForm({ ...ruleForm, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="annual">Annual</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Due day" hint="Day of month (clamped to month length)." error={ruleForm.due_day !== "" && (Number(ruleForm.due_day) < 1 || Number(ruleForm.due_day) > 31) ? "Day must be 1-31." : undefined}><Input type="number" min={1} max={31} value={ruleForm.due_day} onChange={(e) => setRuleForm({ ...ruleForm, due_day: e.target.value })} /></Field>
            {ruleForm.frequency !== "monthly" && (
              <Field label={ruleForm.frequency === "quarterly" ? "Cycle start month" : "Month"} hint={ruleForm.frequency === "quarterly" ? "Then every 3 months." : undefined}>
                <Select value={ruleForm.anchor_month} onValueChange={(v) => setRuleForm({ ...ruleForm, anchor_month: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Owner">
              <Select value={ruleForm.assignee} onValueChange={(v) => setRuleForm({ ...ruleForm, assignee: v })}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>Unassigned</SelectItem>{employees.filter((e) => !e.disabled).map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={ruleForm.notes} onChange={(e) => setRuleForm({ ...ruleForm, notes: e.target.value })} placeholder="Optional" /></Field>
          <label className={cn("flex items-center gap-2 rounded-lg border p-3", !ruleForm.active && "opacity-70")}>
            <Checkbox checked={ruleForm.active} onCheckedChange={(v) => setRuleForm({ ...ruleForm, active: v === true })} />
            <span className="text-sm">Active <span className="text-muted-foreground">- generate upcoming occurrences automatically</span></span>
          </label>
          {editingRule && <ActivitySection resource={editingRule.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleOpen(false)}>Cancel</Button>
            <Button onClick={submitRule} loading={busy} disabled={!ruleForm.title.trim() || !ruleForm.due_day || Number(ruleForm.due_day) < 1 || Number(ruleForm.due_day) > 31}>{editingRule ? "Save changes" : "Add rule"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const DAY_MS = 86400000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
// Colour a due date by its filing status: filed=green, waived=slate, overdue=red, pending=amber.
const statusColor = (c: ComplianceEvent) => (c.status === "filed" ? "#10b981" : c.status === "waived" ? "#94a3b8" : c.overdue ? "#ef4444" : "#f59e0b");

// Month-grid view of compliance items, placed on their due dates and coloured by status. Clicking an item
// opens its editor (when writable). A 42-cell (6-week) grid starting on the Sunday on/before the 1st.
function MonthView({ events, onOpen }: { events: ComplianceEvent[]; onOpen: (c: ComplianceEvent) => void }) {
  const [cursor, setCursor] = useState(() => monthStart(new Date()));
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
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b p-3">
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
              <div key={i} className={cn("min-h-[96px] border-b border-r p-1.5 align-top last:border-r-0", i % 7 === 6 && "border-r-0", !inMonth && "bg-muted/20")}>
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-sm tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground", !inMonth && "text-muted-foreground/50")}>{d.getUTCDate()}</span>
                <div className="mt-1 space-y-1">
                  {items.slice(0, 3).map((c) => (
                    <button key={c.path} type="button" onClick={() => onOpen(c)} title={`${c.title}${c.category ? ` · ${c.category}` : ""}`} className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent">
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
