import { useMemo, useState } from "react";
import { PiggyBank, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { idOf, formatMoney } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { ExpenseBudget, ExpenseCategory, Department, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { department: "", category: "", period_type: "monthly", period_key: "", amount: "" };

export default function ExpenseBudgets({ openId }: { me?: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<ExpenseBudget>("expense-budgets", { showDeleted: true });
  const { rows: categories } = useCollection<ExpenseCategory>("expense-categories");
  const { rows: departments } = useCollection<Department>("departments");
  useDeepOpen(openId, rows, openEdit);
  const { org } = useOrg();
  const { toast } = useToast();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("expense-budgets", "budget", reload);
  const writable = usePermission("expense-budgets.write");
  const canPurge = usePermission("expense-budgets.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseBudget | null>(null);
  const [form, setForm] = useState(EMPTY);

  const catName = useMemo(() => { const m = new Map(categories.map((c) => [idOf(c.path), c.display_name])); return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "All categories"); }, [categories]);
  const deptName = useMemo(() => { const m = new Map(departments.map((d) => [idOf(d.path), d.display_name])); return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "Org-wide"); }, [departments]);

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(b: ExpenseBudget) {
    setEditing(b);
    setForm({
      department: b.department ? `departments/${idOf(b.department)}` : "",
      category: b.category ? `expense-categories/${idOf(b.category)}` : "",
      period_type: b.period_type, period_key: b.period_key, amount: String(b.amount ?? ""),
    });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const body = {
        department: form.department || null, category: form.category || null,
        period_type: form.period_type, period_key: form.period_key.trim(), amount: Number(form.amount),
      };
      if (editing) {
        await patch("expense-budgets/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Budget updated", variant: "success" });
      } else {
        await create("expense-budgets", body);
        toast({ title: "Budget created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save budget", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<ExpenseBudget>[] = [
    { id: "scope", header: "Scope", accessor: (b) => `${catName(b.category)} ${deptName(b.department)}`, cell: (b) => (
      <span className="font-medium">{catName(b.category)}<span className="text-muted-foreground"> · {deptName(b.department)}</span></span>
    ) },
    { id: "period", header: "Period", accessor: (b) => b.period_key, cell: (b) => <span>{b.period_key} <span className="text-xs text-muted-foreground">({b.period_type})</span></span> },
    { id: "amount", header: "Budget", align: "right", accessor: (b) => b.amount, cell: (b) => <span className="tabular-nums">{money(b.amount)}</span> },
    { id: "spent", header: "Spent", align: "right", accessor: (b) => b.spent ?? 0, cell: (b) => <span className="tabular-nums">{money(b.spent ?? 0)}</span> },
    { id: "util", header: "Utilization", accessor: (b) => b.utilization ?? 0, cell: (b) => {
      const pct = Math.round((b.utilization ?? 0) * 100);
      const over = pct >= 100;
      return (
        <div className="flex items-center gap-2">
          <div className="h-2 w-24 overflow-hidden rounded bg-muted"><div className={`h-full ${over ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
          <span className={`text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`}>{pct}%</span>
        </div>
      );
    } },
    ...metaColumns<ExpenseBudget>(),
    { id: "actions", header: "", sortable: false, filter: "none", align: "right", cell: (b) => <SoftDeleteRowActions row={b} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} /> },
  ];

  const createBtn = writable && (
    <AccessAction collection="expense-budgets" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> New budget</Button></AccessAction>
  );

  return (
    <div>
      <PageHeader accessCollection="expense-budgets" title="Budgets" description="Spend caps per category, department and period. Spend is derived from approved and paid expenses." actions={createBtn} />
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={PiggyBank} title="No budgets" description="Set a budget to track spend against a cap." action={createBtn} />
        ) : (
          <DataTable
            columns={columns}
            tableId="expense-budgets"
            rows={rows}
            getRowId={(b) => b.path}
            rowClassName={(b) => (b.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No budgets match"
            accessCollection="expense-budgets"
            accessTargetOf={(b) => ({ objectPath: b.path, label: `${catName(b.category)} ${b.period_key}`, can: b.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.period_key.trim() && Number(form.amount) > 0) submit(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit budget" : "New budget"}</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <FieldRow>
              <Field label="Category">
                <Select value={form.category || "all"} onValueChange={(v) => setForm({ ...form, category: v === "all" ? "" : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.filter((c) => !c.disabled).map((c) => <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>{c.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Cost centre">
                <Select value={form.department || "org"} onValueChange={(v) => setForm({ ...form, department: v === "org" ? "" : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">Org-wide</SelectItem>
                    {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Period type">
                <Select value={form.period_type} onValueChange={(v) => setForm({ ...form, period_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Period key" hint="e.g. 2026-07, 2026-Q3, or 2026">
                <Input value={form.period_key} onChange={(e) => setForm({ ...form, period_key: e.target.value })} placeholder="2026-07" />
              </Field>
            </FieldRow>
            <Field label="Budget amount" error={form.amount !== "" && Number(form.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
              <Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.period_key.trim() || Number(form.amount) <= 0}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
