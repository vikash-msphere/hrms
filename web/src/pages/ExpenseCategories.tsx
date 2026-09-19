import { useMemo, useRef, useState } from "react";
import { Tag, Plus, TriangleAlert } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { useOrg, currencyDecimals } from "@/lib/org";
import { idOf, formatMoney } from "@/lib/utils";
import type { Expense, ExpenseBudget, ExpenseCategory, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

export default function ExpenseCategories({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<ExpenseCategory>("expense-categories", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("expense-categories", "category", reload);
  const lc = useLifecycle("expense-categories", "category", reload);
  const writable = usePermission("expense-categories.write");
  const canPurge = usePermission("expense-categories.admin");
  const { org: listOrg } = useOrg();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [form, setForm] = useState({ name: "", requiresReceipt: false, glCode: "" });
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "category" });
  const nameRef = useRef<HTMLInputElement>(null);

  // Two categories with the same name split a budget's spend in two and read identically on every picker.
  // Worth saying before it happens - a deliberate near-duplicate ("Travel" / "Travel (intl)") still saves.
  const nameClash = useMemo(() => {
    const n = form.name.trim().toLowerCase();
    if (!n) return null;
    return rows.find((c) => c.path !== editing?.path && !c.delete_time && (c.display_name ?? "").trim().toLowerCase() === n) ?? null;
  }, [rows, form.name, editing?.path]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", requiresReceipt: false, glCode: "" });
    setErr(null);
    setOpen(true);
  }
  function openEdit(c: ExpenseCategory) {
    setEditing(c);
    setForm({ name: c.display_name, requiresReceipt: !!c.requires_receipt, glCode: c.gl_code ?? "" });
    setErr(null);
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = { display_name: form.name, requires_receipt: form.requiresReceipt, gl_code: form.glCode.trim() || null };
      if (editing) {
        await patch("expense-categories/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Category updated", variant: "success" });
      } else {
        await create("expense-categories", body);
        toast({ title: "Category created", variant: "success" });
      }
      // GL codes run in sequence, so the invoice rule carries but the code is cleared rather than duplicated.
      if (again && !editing) {
        const next = { name: "", requiresReceipt: form.requiresReceipt, glCode: "" };
        setForm(next);
        guard.markSaved(next);
        // The just-cleared Name loses focus the instant its own Create button disables with it - see
        // ReimbursementCategories' identical fix.
        nameRef.current?.focus();
      } else {
        guard.markSaved();
        setOpen(false);
      }
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // What each category has actually carried. A catalogue with no volume beside it cannot be pruned or
  // re-mapped: every row looks equally alive, and the category nobody has filed against in a year is
  // indistinguishable from the one taking half the ledger.
  const canExpenses = usePermission("expenses.read");
  const { rows: allExpenses } = useCollection<Expense>("expenses", { enabled: canExpenses });
  const catUse = useMemo(() => {
    const m = new Map<string, { count: number; total: number }>();
    for (const e of allExpenses) {
      if (!e.category || ["CANCELLED", "REJECTED"].includes((e.state ?? "").toUpperCase())) continue;
      const key = idOf(e.category);
      const at = m.get(key) ?? { count: 0, total: 0 };
      at.count += 1;
      at.total += e.amount || 0;
      m.set(key, at);
    }
    return m;
  }, [allExpenses]);
  const listMoney = (n: number) => formatMoney(n, listOrg.default_currency, currencyDecimals(undefined, listOrg));

  const categoryInsights = (cs: ExpenseCategory[]): TableInsight[] => {
    if (!canExpenses) return [];
    const out: TableInsight[] = [];
    const idle = cs.filter((c) => !c.delete_time && !c.disabled && !catUse.has(idOf(c.path)));
    if (idle.length > 0) {
      out.push({
        id: "unused",
        label: `${idle.length} with nothing filed against them`,
        hint: "Nothing loaded uses these. A shorter list is a better-coded one.",
        filters: { claims: "=0" },
      });
    }
    // A category that takes no receipt and carries large claims is a control gap: the money leaves with
    // nothing behind it, and nobody finds out until an audit asks.
    const loose = cs.filter((c) => !c.delete_time && !c.requires_receipt && (catUse.get(idOf(c.path))?.total ?? 0) > 0);
    if (loose.length > 0) {
      out.push({
        id: "no-receipt-policy",
        label: `${loose.length} in use with receipts optional`,
        tone: "warning",
        hint: "Spend is going through these with nothing required behind it.",
        filters: { receipt: "Optional", claims: ">0" },
        sort: "spend.desc",
      });
    }
    return out;
  };

  const columns: Column<ExpenseCategory>[] = [
    { id: "name", header: "Name", accessor: (c) => c.display_name, cell: (c) => <span className="font-medium">{c.display_name}</span> },
    { id: "gl", header: "GL code", accessor: (c) => c.gl_code ?? "", cell: (c) => c.gl_code || <span className="text-muted-foreground">-</span> },
    ...(canExpenses ? [
      { id: "claims", header: "Expenses", align: "right" as const, filter: "number" as const, aggregate: "sum" as const,
        accessor: (c: ExpenseCategory) => catUse.get(idOf(c.path))?.count ?? 0 },
      { id: "spend", header: "Spend", align: "right" as const, filter: "number" as const, aggregate: "sum" as const, formatTotal: listMoney,
        accessor: (c: ExpenseCategory) => catUse.get(idOf(c.path))?.total ?? 0,
        cell: (c: ExpenseCategory) => {
          const total = catUse.get(idOf(c.path))?.total ?? 0;
          return total ? <span className="tabular-nums">{listMoney(total)}</span> : <span className="text-muted-foreground">-</span>;
        } },
    ] : []),
    {
      id: "receipt",
      header: "Receipt",
      filter: "select",
      accessor: (c) => (c.requires_receipt ? "Required" : "Optional"),
      cell: (c) => <Badge variant={c.requires_receipt ? "warning" : "secondary"}>{c.requires_receipt ? "Required" : "Optional"}</Badge>,
    },
    stateColumn<ExpenseCategory>(),
    ...metaColumns<ExpenseCategory>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (c) => <SoftDeleteRowActions row={c} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="expense-categories" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New category</Button>
    </AccessAction>
  );

  return (
    <div>
      {!embedded && (
        <PageHeader accessCollection="expense-categories" title="Expense Categories" description="Define the kinds of operational expense (rent, software, travel…)." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={Tag} title="No categories" description="Create categories like Rent, Utilities or Software." action={createBtn} />
        ) : (
          <DataTable
            columns={columns}
            tableId="expense-categories"
            rows={rows}
            insights={categoryInsights}
            getRowId={(c) => c.path}
            rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No categories match"
            toolbar={embedded ? createBtn : undefined}
            accessCollection="expense-categories"
            accessTargetOf={(c) => ({ objectPath: c.path, label: c.display_name, can: c.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim()) void submit(); }}>
          <AccessScope collection="expense-categories" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
            <DialogDescription>Categories group spend for budgets and reporting, and decide whether an invoice is compulsory.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <Field label="Name">
            <Input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Software & Subscriptions" autoFocus />
          </Field>
          {editing && <CategoryUsage category={editing.path} open={open} />}
          {nameClash && (
            <p className="-mt-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
              "{nameClash.display_name}" already exists{nameClash.gl_code ? ` (GL ${nameClash.gl_code})` : ""} - two categories with one name split their spend across two budgets.
            </p>
          )}
          <Field label="GL code (optional)" hint="Carried onto every expense in this category, so the export lands in the right ledger account.">
            <Input value={form.glCode} onChange={(e) => setForm({ ...form, glCode: e.target.value })} placeholder="e.g. 6020" />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="requiresReceipt" checked={form.requiresReceipt} onCheckedChange={(v) => setForm({ ...form, requiresReceipt: v === true })} />
            <Label htmlFor="requiresReceipt">Require an invoice</Label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">When on, an expense in this category can't be submitted without an invoice.</p>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          {!editing && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={again} onCheckedChange={(v) => setAgain(v === true)} />
              Keep this open to add another
            </label>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : again ? "Create & add another" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- what this category is carrying ---------------------------------------------------------------------
// Renaming a category, flipping its invoice rule or retiring it are all decisions about existing spend, and
// the dialog used to show none of it. Counted from the ledger and the budgets, read only once the dialog is
// open - the page itself never pays for it.
function CategoryUsage({ category, open }: { category: string; open: boolean }) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const { rows: expenses, state, hasMore } = useCollection<Expense>("expenses", { params: { category }, enabled: open });
  const { rows: budgets } = useCollection<ExpenseBudget>("expense-budgets", { enabled: open });
  const caps = budgets.filter((b) => !b.delete_time && b.category && idOf(b.category) === idOf(category));
  if (state !== "ready" || (expenses.length === 0 && caps.length === 0)) return null;
  // Committed spend only, and honest about the page cap: a "+" says the real number is at least this.
  const counted = expenses.filter((e) => ["SUBMITTED", "APPROVED", "PAID"].includes((e.state ?? "").toUpperCase()));
  const more = hasMore ? "+" : "";
  return (
    <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {counted.length > 0
        ? <>Carrying {counted.length}{more} {counted.length === 1 && !hasMore ? "expense" : "expenses"} worth {money(counted.reduce((n, e) => n + (e.amount || 0), 0))}{more}</>
        : <>No committed spend yet</>}
      {caps.length > 0 ? ` · capped by ${caps.length} ${caps.length === 1 ? "budget" : "budgets"}` : " · no budget caps it"}.
      {" "}Renaming keeps all of it; retiring the category only stops new expenses being filed against it.
    </p>
  );
}
