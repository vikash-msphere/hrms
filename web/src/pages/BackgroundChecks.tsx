import { useMemo, useState } from "react";
import { UserCheck, Plus, Check, Pencil, Trash2, RotateCcw, ShieldX, Play, AlertTriangle } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import type { BackgroundCheck, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { Field } from "@/components/common/Field";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { humanize } from "@/lib/utils";

const TYPES = ["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"];
const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "clear", label: "Clear" },
  { value: "discrepancy", label: "Discrepancy" },
  { value: "failed", label: "Failed" },
];
const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;
const NONE = "__none__";
const EMPTY = { employee: "", check_type: "identity", status: "pending", vendor: "", reference_no: "", initiated_date: "", completed_date: "", notes: "" };

function StatusBadge({ s }: { s: string }) {
  if (s === "clear") return <Badge variant="success" className="gap-1"><Check className="h-3 w-3" /> Clear</Badge>;
  if (s === "discrepancy") return <Badge variant="warning">Discrepancy</Badge>;
  if (s === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (s === "in_progress") return <Badge variant="secondary">In progress</Badge>;
  return <Badge variant="muted">Pending</Badge>;
}

export default function BackgroundChecks({ me, openId }: { me: Me; openId?: string }) {
  void me;
  const { rows, state, error, reload } = useCollection<BackgroundCheck>("background-checks", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const sd = useSoftDelete("background-checks", "background check", reload);
  const writable = usePermission("background-checks.write");
  const canPurge = usePermission("background-checks.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BackgroundCheck | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const empById = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const emp = (p?: string) => (p ? empById.get(idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : p ? idOf(p) : ""; };

  const stats = useMemo(() => {
    const live = rows.filter((c) => !c.delete_time);
    return {
      open: live.filter((c) => c.status === "pending" || c.status === "in_progress").length,
      discrepancy: live.filter((c) => c.status === "discrepancy" || c.status === "failed").length,
      clear: live.filter((c) => c.status === "clear").length,
    };
  }, [rows]);

  function openCreate() { setEditing(null); setForm({ ...EMPTY, initiated_date: new Date().toISOString().slice(0, 10) }); setOpen(true); }
  function openEdit(c: BackgroundCheck) {
    setEditing(c);
    setForm({
      employee: c.employee ? `employees/${idOf(c.employee)}` : "", check_type: c.check_type, status: c.status,
      vendor: c.vendor ?? "", reference_no: c.reference_no ?? "", initiated_date: c.initiated_date ?? "",
      completed_date: c.completed_date ?? "", notes: c.notes ?? "",
    });
    setOpen(true);
  }
  function bodyFromForm() {
    return {
      employee: form.employee, check_type: form.check_type, status: form.status,
      vendor: form.vendor.trim() || null, reference_no: form.reference_no.trim() || null,
      initiated_date: form.initiated_date || null, completed_date: form.completed_date || null, notes: form.notes.trim() || null,
    };
  }
  async function submit() {
    setBusy(true);
    try {
      if (editing) { await patch("background-checks/" + idOf(editing.path), bodyFromForm(), editing.etag); toast({ title: "Check updated", variant: "success" }); }
      else { await create("background-checks", bodyFromForm()); toast({ title: "Check added", variant: "success" }); }
      setOpen(false); reload();
    } catch (e) { toast({ title: "Couldn't save check", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  // One validity check shared by the Enter shortcut and the submit button, so they can't disagree.
  const dateConflict = !!form.initiated_date && !!form.completed_date && form.completed_date < form.initiated_date;
  const canSubmit = !!form.employee && !dateConflict;

  async function setStatus(c: BackgroundCheck, status: string) {
    try { await patch("background-checks/" + idOf(c.path), { status }, c.etag); toast({ title: `Marked ${statusLabel(status).toLowerCase()}`, variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }

  const columns: Column<BackgroundCheck>[] = [
    {
      id: "employee", header: "Employee", filter: "select", accessor: (c) => empName(c.employee),
      cell: (c) => {
        const e = emp(c.employee);
        return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={c.employee ? idOf(c.employee) : ""} name={empName(c.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(c.employee)}</span>;
      },
    },
    { id: "check_type", header: "Check", filter: "select", accessor: (c) => humanize(c.check_type), cell: (c) => <span className="inline-flex items-center gap-1.5"><Badge variant="secondary">{humanize(c.check_type)}</Badge>{c.transition && <span className="text-[10px] uppercase tracking-wide text-muted-foreground" title="From onboarding">onboarding</span>}</span> },
    { id: "status", header: "Status", filter: "select", accessor: (c) => statusLabel(c.status), cell: (c) => <StatusBadge s={c.status} /> },
    { id: "vendor", header: "Vendor", accessor: (c) => c.vendor ?? "", cell: (c) => c.vendor || <span className="text-muted-foreground">-</span> },
    {
      id: "initiated", header: "Initiated", accessor: (c) => c.initiated_date ?? "",
      // For open checks show how long they've been sitting - that's the "chase the vendor" signal.
      cell: (c) => {
        if (!c.initiated_date) return <span className="text-muted-foreground">-</span>;
        const isOpen = !c.delete_time && (c.status === "pending" || c.status === "in_progress");
        const age = isOpen ? Math.max(0, Math.floor((Date.now() - new Date(c.initiated_date).getTime()) / 86400000)) : null;
        return (
          <span>
            {formatDate(c.initiated_date)}
            {age != null && age >= 1 && (
              <span className={age > 14 ? "text-xs font-medium text-warning dark:text-warning" : "text-xs text-muted-foreground"} title={age > 14 ? "Open for more than two weeks" : "Days open"}> · {age}d open</span>
            )}
          </span>
        );
      },
    },
    {
      id: "completed", header: "Completed", accessor: (c) => c.completed_date ?? "",
      // Show the turnaround alongside the date - "how long did this check take" without mental math.
      cell: (c) => {
        if (!c.completed_date) return <span className="text-muted-foreground">-</span>;
        const days = c.initiated_date && c.completed_date >= c.initiated_date
          ? Math.round((new Date(c.completed_date).getTime() - new Date(c.initiated_date).getTime()) / 86400000)
          : null;
        return <span>{formatDate(c.completed_date)}{days != null && <span className="text-xs text-muted-foreground" title="Turnaround"> · {days}d</span>}</span>;
      },
    },
    { id: "reference", header: "Reference", defaultHidden: true, accessor: (c) => c.reference_no ?? "", cell: (c) => c.reference_no || "-" },
    stateColumn<BackgroundCheck>(),
    ...metaColumns<BackgroundCheck>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (c) => {
        const items: RowAction[] = [];
        if (c.delete_time) {
          if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sd.restore(c), verb: "restore" });
          if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sd.permanentlyDelete(c), destructive: true, verb: "delete" });
        } else if (writable) {
          // Quick status moves matching the workflow: pending → in progress → clear/discrepancy.
          if (c.status === "pending") items.push({ label: "Mark in progress", icon: <Play className="h-4 w-4" />, onClick: () => setStatus(c, "in_progress") });
          if (c.status !== "clear") items.push({ label: "Mark clear", icon: <Check className="h-4 w-4" />, onClick: () => setStatus(c, "clear") });
          if (c.status === "pending" || c.status === "in_progress") items.push({ label: "Mark discrepancy", icon: <AlertTriangle className="h-4 w-4" />, onClick: () => setStatus(c, "discrepancy") });
          items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(c) });
          items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sd.softDelete(c), destructive: true, verb: "delete" });
        }
        return <RowActions actions={items} />;
      },
    },
  ];

  const addBtn = writable && <AccessAction collection="background-checks" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add check</Button></AccessAction>;

  return (
    <div>
      <PageHeader title="Background Verification" description="Track pre-employment verification checks per employee and their outcomes." actions={addBtn} />

      <SummaryStrip
        items={[
          { label: "Open", value: stats.open, hint: "Pending or in progress", tone: stats.open > 0 ? "warning" : "muted" },
          { label: "Discrepancy / failed", value: stats.discrepancy, tone: stats.discrepancy > 0 ? "destructive" : "muted" },
          { label: "Clear", value: stats.clear, tone: stats.clear > 0 ? "success" : "muted" },
        ]}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={UserCheck} title="No background checks" description="Record verification checks (identity, address, education, employment, criminal) and track each to a clear or discrepancy outcome." action={addBtn} />
        ) : (
          <DataTable columns={columns} tableId="background-checks" rows={rows} getRowId={(c) => c.path} rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)} emptyTitle="No checks match" accessCollection="background-checks" accessTargetOf={(c) => ({ objectPath: c.path, label: `${empName(c.employee)} · ${humanize(c.check_type)}`, can: c.access?.can })} />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && canSubmit) submit(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit background check" : "Add background check"}</DialogTitle></DialogHeader>
          <Field label="Employee">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Select an employee…"
              searchPlaceholder="Search employees…"
              options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Check type">
              <Select value={form.check_type} onValueChange={(v) => setForm({ ...form, check_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Vendor / agency"><Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="Name of the verification agency" /></Field>
            <Field label="Reference no." hint="Vendor case ref."><Input value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Initiated"><Input type="date" value={form.initiated_date} onChange={(e) => setForm({ ...form, initiated_date: e.target.value })} /></Field>
            <Field label="Completed" hint="Auto-set when an outcome is reached." error={dateConflict ? "Completed is before the initiated date." : undefined}><Input type="date" value={form.completed_date} min={form.initiated_date || undefined} onChange={(e) => setForm({ ...form, completed_date: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Findings, discrepancies, follow-ups…" /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!canSubmit}>{editing ? "Save changes" : "Add check"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
