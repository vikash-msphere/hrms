import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, UserCheck, Undo2 } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, idOf } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { Asset, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

const CATEGORIES = ["Laptop", "Phone", "Monitor", "Peripheral", "Furniture", "Other"];
const STATUSES: { value: Asset["status"]; label: string }[] = [
  { value: "in_stock", label: "In stock" },
  { value: "assigned", label: "Assigned" },
  { value: "repair", label: "In repair" },
  { value: "retired", label: "Retired" },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
const STATUS_TONE: Record<Asset["status"], string> = {
  in_stock: "bg-muted text-muted-foreground",
  assigned: "bg-primary/10 text-primary",
  repair: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  retired: "bg-destructive/10 text-destructive",
};

const EMPTY = { asset_tag: "", name: "", category: "", serial_number: "", status: "in_stock" as Asset["status"], assigned_to: "", assigned_on: "", purchase_date: "", notes: "" };
type Form = typeof EMPTY;

export default function Assets({ me: _me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Asset>("assets");
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  // Inventory summary across the assets the caller can see (server-scoped).
  const summary = useMemo(() => ({
    total: rows.length,
    assigned: rows.filter((a) => a.status === "assigned").length,
    inStock: rows.filter((a) => a.status === "in_stock").length,
    repair: rows.filter((a) => a.status === "repair").length,
  }), [rows]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  function openEdit(a: Asset) {
    setEditing(a);
    setForm({
      asset_tag: a.asset_tag ?? "",
      name: a.name ?? "",
      category: a.category ?? "",
      serial_number: a.serial_number ?? "",
      status: a.status,
      assigned_to: a.assigned_to ?? "",
      assigned_on: a.assigned_on ?? "",
      purchase_date: a.purchase_date ?? "",
      notes: a.notes ?? "",
    });
    setOpen(true);
  }

  // Changing the assignee nudges the status (assigned <-> in stock); the user can still override it (e.g. repair).
  function setAssignee(v: string) {
    setForm((f) => ({ ...f, assigned_to: v, status: v ? (f.status === "in_stock" ? "assigned" : f.status) : (f.status === "assigned" ? "in_stock" : f.status) }));
  }

  async function save() {
    setBusy(true);
    try {
      const body = {
        asset_tag: form.asset_tag.trim() || null,
        name: form.name.trim(),
        category: form.category.trim() || null,
        serial_number: form.serial_number.trim() || null,
        status: form.status,
        assigned_to: form.assigned_to || null,
        assigned_on: form.assigned_to ? (form.assigned_on || null) : null,
        purchase_date: form.purchase_date || null,
        notes: form.notes.trim() || null,
      };
      if (editing) await patch(editing.path, body, editing.etag);
      else await create("assets", body);
      toast({ title: editing ? "Asset updated" : "Asset added", variant: "success" });
      setOpen(false);
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save asset", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const [returning, setReturning] = useState<string | null>(null);
  async function returnToStock(a: Asset) {
    setReturning(a.path);
    try {
      await patch(a.path, { assigned_to: null, status: "in_stock" }, a.etag);
      toast({ title: "Returned to stock", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't return asset", description: (e as Error).message });
    } finally {
      setReturning(null);
    }
  }

  // Assets hard-delete (no soft-delete/restore on this collection), so always confirm.
  async function del(a: Asset) {
    const ok = await confirm({
      title: "Remove this asset?",
      description: `"${a.name}" is permanently deleted - there is no undo.${a.assigned_to ? ` It is currently assigned to ${empName(a.assigned_to)}.` : ""}`,
      destructive: true,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await remove(a.path, a.etag);
      toast({ title: "Asset removed", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove asset", description: (e as Error).message });
    }
  }

  const columns: Column<Asset>[] = [
    { id: "asset_tag", header: "Tag", accessor: (r) => r.asset_tag ?? "", cell: (r) => <span className="font-mono text-xs">{r.asset_tag || "-"}</span> },
    { id: "name", header: "Name", accessor: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span> },
    { id: "category", header: "Category", filter: "select", accessor: (r) => r.category ?? "-" },
    { id: "serial", header: "Serial", defaultHidden: true, accessor: (r) => r.serial_number ?? "", cell: (r) => r.serial_number || "-" },
    { id: "status", header: "Status", filter: "select", accessor: (r) => STATUS_LABEL[r.status] ?? r.status, cell: (r) => (
      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[r.status])}>{STATUS_LABEL[r.status] ?? r.status}</span>
    ) },
    { id: "assigned_to", header: "Assigned to", filter: "select", accessor: (r) => (r.assigned_to ? empName(r.assigned_to) : ""), cell: (r) => (r.assigned_to ? empName(r.assigned_to) : <span className="text-muted-foreground">-</span>) },
    { id: "assigned_on", header: "Assigned", defaultHidden: true, accessor: (r) => r.assigned_on ?? "", cell: (r) => (r.assigned_on ? formatDate(r.assigned_on) : "-") },
    { id: "purchase_date", header: "Purchased", defaultHidden: true, accessor: (r) => r.purchase_date ?? "", cell: (r) => (r.purchase_date ? formatDate(r.purchase_date) : "-") },
    ...metaColumns<Asset>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          {r.assigned_to && (
            <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} label="Return to stock">
              <Button size="sm" variant="ghost" loading={returning === r.path} onClick={() => returnToStock(r)}><Undo2 className="h-4 w-4" /> Return</Button>
            </AccessAction>
          )}
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} label="Edit asset">
            <Button size="sm" variant="ghost" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
          </AccessAction>
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} label="Remove asset">
            <Button size="sm" variant="ghost" onClick={() => del(r)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
          </AccessAction>
        </div>
      ),
    },
  ];

  const addBtn = (
    <AccessAction collection="assets" create label="Add asset">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add asset</Button>
    </AccessAction>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Assets" description="Company asset inventory. Assign items to employees." accessCollection="assets" actions={addBtn} />
      {rows.length > 0 && (
        <SummaryStrip
          items={[
            { label: "Total", value: summary.total, tone: "muted" },
            { label: "Assigned", value: summary.assigned, tone: summary.assigned > 0 ? "primary" : "muted" },
            { label: "In stock", value: summary.inStock, tone: "default" },
            { label: "In repair", value: summary.repair, tone: summary.repair > 0 ? "warning" : "muted" },
          ]}
        />
      )}
      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          tableId="assets"
          title={<span className="flex items-center gap-2 text-sm text-muted-foreground"><UserCheck className="h-4 w-4" /> {rows.filter((r) => r.assigned_to).length} of {rows.length} assigned</span>}
          columns={columns}
          rows={rows}
          getRowId={(r) => r.path}
          accessCollection="assets"
          accessTargetOf={(r) => ({ collection: "assets", objectPath: r.path, label: r.name, can: r.access?.can })}
          emptyTitle="No assets yet"
          emptyDescription="Add laptops, phones and other company assets to track who holds what."
        />
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" onEnterSubmit={() => { if (!busy && form.name.trim()) save(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit asset" : "Add asset"}</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Asset tag" hint="Your internal label."><Input value={form.asset_tag} onChange={(e) => setForm({ ...form, asset_tag: e.target.value })} placeholder="e.g. LAP-014" /></Field>
            <Field label="Category">
              <Input list="asset-categories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Laptop" />
              <datalist id="asset-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
          </div>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='e.g. MacBook Pro 14"' autoFocus /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Serial number"><Input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} /></Field>
            <Field label="Purchase date"><Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Assigned to">
              <Combobox
                value={form.assigned_to || "none"}
                onValueChange={(v) => setAssignee(v === "none" ? "" : v)}
                placeholder="Unassigned"
                searchPlaceholder="Search employees…"
                options={[{ value: "none", label: "Unassigned (in stock)" }, ...employees.map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
              />
            </Field>
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Asset["status"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          {form.assigned_to && (
            <Field label="Assigned on" hint="Defaults to today."><Input type="date" value={form.assigned_on} onChange={(e) => setForm({ ...form, assigned_on: e.target.value })} /></Field>
          )}
          <Field label="Notes (optional)"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!form.name.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
