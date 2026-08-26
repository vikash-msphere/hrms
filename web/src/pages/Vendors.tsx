import { useMemo, useState } from "react";
import { Building2, Plus, TriangleAlert } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { idOf, formatMoney, formatDate } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Vendor, Expense, ExpenseCategory, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { Checkbox } from "@/components/ui/checkbox";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { name: "", contact_email: "", contact_phone: "", tax_id: "", payment_terms: "", bank_details: "", default_category: "", notes: "" };

export default function Vendors({ openId }: { me?: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Vendor>("vendors", { showDeleted: true });
  const { rows: categories } = useCollection<ExpenseCategory>("expense-categories");
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("vendors", "vendor", reload);
  const lc = useLifecycle("vendors", "vendor", reload);
  const writable = usePermission("vendors.write");
  const canPurge = usePermission("vendors.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "vendor" });

  // One vendor entered twice is one vendor's spend reported as two. Warn, never block: "Acme" and "Acme Labs"
  // are different suppliers, and only the person typing knows which case this is.
  const nameClash = useMemo(() => {
    const n = form.name.trim().toLowerCase();
    if (!n) return null;
    return rows.find((v) => v.path !== editing?.path && !v.delete_time && (v.display_name ?? "").trim().toLowerCase() === n) ?? null;
  }, [rows, form.name, editing?.path]);
  const emailBad = form.contact_email.trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.contact_email.trim());

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [idOf(c.path), c.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [categories]);

  function openCreate() { setEditing(null); setForm(EMPTY); setErr(null); setOpen(true); }
  function openEdit(v: Vendor) {
    setEditing(v);
    setErr(null);
    setForm({
      name: v.display_name, contact_email: v.contact_email ?? "", contact_phone: v.contact_phone ?? "",
      tax_id: v.tax_id ?? "", payment_terms: v.payment_terms ?? "", bank_details: v.bank_details ?? "",
      default_category: v.default_category ? `expense-categories/${idOf(v.default_category)}` : "", notes: v.notes ?? "",
    });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        display_name: form.name, contact_email: form.contact_email || null, contact_phone: form.contact_phone || null,
        tax_id: form.tax_id || null, payment_terms: form.payment_terms || null, bank_details: form.bank_details || null,
        default_category: form.default_category || null, notes: form.notes || null,
      };
      if (editing) {
        await patch("vendors/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Vendor updated", variant: "success" });
      } else {
        await create("vendors", body);
        toast({ title: "Vendor created", variant: "success" });
      }
      // Vendors arrive as a list off an invoice pile; payment terms usually repeat across a batch.
      if (again && !editing) {
        const next = { ...EMPTY, payment_terms: form.payment_terms, default_category: form.default_category };
        setForm(next);
        guard.markSaved(next);
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

  const columns: Column<Vendor>[] = [
    { id: "name", header: "Vendor", accessor: (v) => v.display_name, cell: (v) => <span className="font-medium">{v.display_name}</span> },
    { id: "category", header: "Default category", accessor: (v) => catName(v.default_category) },
    { id: "tax", header: "Tax ID", accessor: (v) => v.tax_id ?? "", cell: (v) => v.tax_id || <span className="text-muted-foreground">-</span>, defaultHidden: true },
    { id: "terms", header: "Terms", accessor: (v) => v.payment_terms ?? "", cell: (v) => v.payment_terms || <span className="text-muted-foreground">-</span> },
    { id: "email", header: "Contact", accessor: (v) => v.contact_email ?? "", cell: (v) => v.contact_email || <span className="text-muted-foreground">-</span> },
    stateColumn<Vendor>(),
    ...metaColumns<Vendor>(),
    { id: "actions", header: "", sortable: false, filter: "none", align: "right", cell: (v) => <SoftDeleteRowActions row={v} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} /> },
  ];

  const createBtn = writable && (
    <AccessAction collection="vendors" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> New vendor</Button></AccessAction>
  );

  return (
    <div>
      <PageHeader accessCollection="vendors" title="Vendors" description="The vendors your company pays for operational expenses." actions={createBtn} />
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={Building2} title="No vendors" description="Add vendors like your landlord, cloud provider or suppliers." action={createBtn} />
        ) : (
          <DataTable
            columns={columns}
            tableId="vendors"
            rows={rows}
            getRowId={(v) => v.path}
            rowClassName={(v) => (v.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No vendors match"
            accessCollection="vendors"
            accessTargetOf={(v) => ({ objectPath: v.path, label: v.display_name, can: v.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim() && !emailBad) submit(); }}>
          <AccessScope collection="vendors" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit vendor" : "New vendor"}</DialogTitle>
            <DialogDescription>Everything here is a default an expense can inherit - pick this vendor on an expense and its category and terms come with it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <div className="grid gap-4">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Vendor or supplier name" autoFocus /></Field>
            {editing && <VendorSpend vendor={editing.path} open={open} />}
            {nameClash && (
              <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
                <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
                "{nameClash.display_name}" is already on the list{nameClash.tax_id ? ` (${nameClash.tax_id})` : ""} - filing against two records splits this supplier's spend in the reports.
              </p>
            )}
            <FieldRow>
              <Field label="Contact email" error={emailBad ? "That doesn't look like an email address." : undefined}>
                <Input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} placeholder="accounts@vendor.com" />
              </Field>
              <Field label="Contact phone"><Input type="tel" inputMode="tel" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Tax ID / GSTIN"><Input value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} /></Field>
              <Field label="Payment terms"><Input value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })} placeholder="e.g. Net 30" /></Field>
            </FieldRow>
            <Field label="Default expense category">
              <Select value={form.default_category} onValueChange={(v) => setForm({ ...form, default_category: v })}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {categories.filter((c) => !c.disabled).map((c) => <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>{c.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Bank details"><Textarea rows={2} value={form.bank_details} onChange={(e) => setForm({ ...form, bank_details: e.target.value })} /></Field>
            <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          </div>
          {!editing && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={again} onCheckedChange={(v) => setAgain(v === true)} />
              Keep this open to add another
            </label>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || emailBad}>{editing ? "Save changes" : again ? "Create & add another" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- what this vendor has cost --------------------------------------------------------------------------
// The duplicate warning above can say two records share a name; only the ledger says which one is the live
// supplier and which is the stray to retire. Read once the dialog is open, never by the page.
function VendorSpend({ vendor, open }: { vendor: string; open: boolean }) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const { rows, state, hasMore } = useCollection<Expense>("expenses", { params: { vendor }, enabled: open });
  if (state !== "ready") return null;
  // Committed spend only: a draft or a rejected invoice was never money owed to this vendor.
  const counted = rows.filter((e) => ["SUBMITTED", "APPROVED", "PAID"].includes((e.state ?? "").toUpperCase()));
  if (counted.length === 0) {
    return <p className="-mt-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Nothing has been filed against this vendor yet.</p>;
  }
  const total = counted.reduce((n, e) => n + (e.amount || 0), 0);
  const latest = counted.reduce((d, e) => (e.incurred_on && e.incurred_on > d ? e.incurred_on : d), "");
  const more = hasMore ? "+" : "";
  return (
    <p className="-mt-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {money(total)}{more} across {counted.length}{more} {counted.length === 1 && !hasMore ? "expense" : "expenses"}
      {latest ? ` · last one incurred ${formatDate(latest)}` : ""}.
    </p>
  );
}
