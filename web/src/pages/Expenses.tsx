import { useMemo, useRef, useState } from "react";
import { Plus, Ban, Paperclip, Download, Wallet, Check, X, Send, Repeat, Zap } from "lucide-react";
import { create, patch, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Expense, Vendor, ExpenseCategory, ExpenseBudget, Employee, Department, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Field, FieldRow } from "@/components/common/Field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { vendor: "", category: "", department: "", amount: "", tax_amount: "", incurred_on: "", description: "", reimbursable: false, recurring: false, recurrence_rule: "monthly", next_occurrence_on: "" };
const up = (s?: string) => (s ?? "").toUpperCase();
const todayStr = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const sum = (rs: Expense[]) => rs.reduce((n, r) => n + (r.amount || 0), 0);

export default function Expenses({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Expense>("expenses");
  // Server-side search across the whole collection - a list page caps at 100 rows, so filtering the cached
  // rows could never reach a record past the first page. Below two characters it stays off.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  const { rows: searchRows, hasMore: searchHasMore } = useCollection<Expense>("expenses", { q: debouncedQ, enabled: searching });
  const { rows: categories } = useCollection<ExpenseCategory>("expense-categories");
  const { rows: vendors } = useCollection<Vendor>("vendors"); // empty for callers without vendors.read (403 isolated)
  const { rows: budgets } = useCollection<ExpenseBudget>("expense-budgets"); // finance-only; empty otherwise
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { org } = useOrg();
  const { toast } = useToast();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  const canApprove = usePermission("expenses.approve");
  const canPay = usePermission("expenses.pay");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [submitNow, setSubmitNow] = useState(true);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, incurred_on: todayStr() });
    setFile(null);
    setSubmitNow(true);
    setOpen(true);
  }
  function openEdit(r: Expense) {
    setEditing(r);
    setForm({
      vendor: r.vendor ? `vendors/${idOf(r.vendor)}` : "",
      category: r.category ? `expense-categories/${idOf(r.category)}` : "",
      department: r.department ? `departments/${idOf(r.department)}` : "",
      amount: String(r.amount ?? ""),
      tax_amount: r.tax_amount ? String(r.tax_amount) : "",
      incurred_on: r.incurred_on ?? "",
      description: r.description ?? "",
      reimbursable: !!r.reimbursable,
      recurring: !!r.recurring,
      recurrence_rule: r.recurrence_rule ?? "monthly",
      next_occurrence_on: r.next_occurrence_on ?? "",
    });
    setFile(null);
    setSubmitNow(false);
    setOpen(true);
  }
  useIntent("new-expense", openCreate);

  // Quick add: a stripped path for small expenses (snacks, meals, cabs) - amount + optional category/note,
  // submitted straight away. No vendor/tax/invoice/recurring. Details can be filled in later via Edit.
  const [quickOpen, setQuickOpen] = useState(false);
  const [quick, setQuick] = useState({ amount: "", category: "", description: "" });
  const [quickBusy, setQuickBusy] = useState(false);
  function openQuick() { setQuick({ amount: "", category: "", description: "" }); setQuickOpen(true); }
  useIntent("quick-expense", openQuick);
  async function quickSubmit() {
    setQuickBusy(true);
    try {
      const row = await create<Expense>("expenses", {
        category: quick.category || null,
        amount: Number(quick.amount),
        incurred_on: todayStr(),
        description: quick.description || null,
      });
      await invoke("expenses/" + idOf(row.path), "submit", row.etag);
      toast({ title: "Expense added", variant: "success" });
      setQuickOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't add expense", description: (e as Error).message, variant: "destructive" });
    } finally {
      setQuickBusy(false);
    }
  }

  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<Expense | null>(null);

  const nameOf = (list: { path: string; display_name?: string; first_name?: string; last_name?: string }[]) => {
    const m = new Map(list.map((x) => [idOf(x.path), x.display_name ?? `${x.first_name ?? ""} ${x.last_name ?? ""}`.trim()]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  };
  const catName = useMemo(() => nameOf(categories as any), [categories]);
  const vendorName = useMemo(() => nameOf(vendors as any), [vendors]);
  const deptName = useMemo(() => nameOf(departments as any), [departments]);
  const empName = useMemo(() => nameOf(employees as any), [employees]);

  const selectedCat = categories.find((c) => form.category && idOf(c.path) === idOf(form.category));
  const invoiceRequired = !!selectedCat?.requires_receipt && !form.recurring;

  // Summary buckets (over the rows the caller can see).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const inState = (s: string) => rows.filter((r) => up(r.state) === s);
  const pending = inState("SUBMITTED");
  const approvedUnpaid = rows.filter((r) => up(r.state) === "APPROVED" && !r.reimbursable);
  const paidThisMonth = rows.filter((r) => up(r.state) === "PAID" && r.paid_time && new Date(r.paid_time).getTime() >= monthStart);

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        vendor: form.vendor || null,
        category: form.category || null,
        department: form.department || null,
        amount: Number(form.amount),
        tax_amount: form.tax_amount ? Number(form.tax_amount) : 0,
        incurred_on: form.incurred_on || null,
        description: form.description || null,
        reimbursable: form.reimbursable,
        recurring: form.recurring,
        recurrence_rule: form.recurring ? form.recurrence_rule : null,
        next_occurrence_on: form.recurring ? form.next_occurrence_on || null : null,
      };
      if (editing) {
        await patch("expenses/" + idOf(editing.path), body, editing.etag);
        if (file) await upload(`expenses/${idOf(editing.path)}`, file);
        toast({ title: "Expense updated", variant: "success" });
      } else {
        const row = await create<Expense>("expenses", body);
        if (file) await upload(`expenses/${idOf(row.path)}`, file);
        if (submitNow && !form.recurring) await invoke("expenses/" + idOf(row.path), "submit", row.etag);
        toast({ title: form.recurring ? "Recurring expense created" : submitNow ? "Expense submitted" : "Draft saved", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save expense", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function action(r: Expense, verb: string, body?: Record<string, unknown>) {
    const label: Record<string, string> = { submit: "Submitted", approve: "Approved", reject: "Rejected", cancel: "Cancelled", pay: "Marked paid" };
    try {
      await invoke("expenses/" + idOf(r.path), verb, r.etag, body);
      toast({ title: label[verb] ?? "Updated", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update expense", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Pay dialog (method + reference) for a non-reimbursable approved expense.
  const [payFor, setPayFor] = useState<Expense | null>(null);
  const [payForm, setPayForm] = useState({ payment_method: "bank", payment_ref: "" });
  async function confirmPay() {
    if (!payFor) return;
    await action(payFor, "pay", { payment_method: payForm.payment_method, payment_ref: payForm.payment_ref || null });
    setPayFor(null);
    setPayForm({ payment_method: "bank", payment_ref: "" });
  }

  function pickInvoice(r: Expense) { uploadTarget.current = r; fileRef.current?.click(); }
  async function onInvoicePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const r = uploadTarget.current;
    e.target.value = "";
    if (!f || !r) return;
    try {
      await upload(`expenses/${idOf(r.path)}`, f);
      toast({ title: "Invoice attached", variant: "success" });
      reload();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  }
  const getInvoice = (r: Expense) => download("expenses/" + idOf(r.path), `invoice-${idOf(r.path)}`);

  const columns: Column<Expense>[] = [
    { id: "payee", header: "Vendor / payee", accessor: (r) => (r.vendor ? vendorName(r.vendor) : empName(r.employee)), cell: (r) => (
      <span className="font-medium">{r.vendor ? vendorName(r.vendor) : empName(r.employee)}{r.recurring ? <Repeat className="ml-1 inline h-3.5 w-3.5 text-muted-foreground" /> : null}</span>
    ) },
    { id: "category", header: "Category", accessor: (r) => catName(r.category) },
    { id: "department", header: "Cost centre", accessor: (r) => deptName(r.department), defaultHidden: true },
    { id: "amount", header: "Amount", align: "right", accessor: (r) => r.amount, cell: (r) => <span className="tabular-nums">{money(r.amount)}</span> },
    { id: "incurred", header: "Incurred", accessor: (r) => r.incurred_on ?? "", cell: (r) => (r.incurred_on ? formatDate(r.incurred_on) : "-") },
    { id: "state", header: "Status", filter: "select", accessor: (r) => up(r.state), cell: (r) => up(r.state) === "APPROVED" && r.reimbursable
      ? <span className="inline-flex items-center gap-1.5"><Badge variant="secondary">Approved</Badge><span className="text-xs text-muted-foreground">via payroll</span></span>
      : up(r.state) === "PAID"
        ? <span className="inline-flex items-center gap-1.5"><Badge variant="success">Paid</Badge>{r.paid_time ? <span className="text-xs text-muted-foreground">{formatDate(r.paid_time)}</span> : null}</span>
        : <StatusBadge state={r.state} /> },
    { id: "invoice", header: "Invoice", sortable: false, filter: "none", accessor: (r) => (r.has_invoice ? "yes" : ""), cell: (r) => (r.has_invoice
      ? <Button size="sm" variant="ghost" onClick={() => getInvoice(r)}><Download className="h-4 w-4" /> Invoice</Button>
      : <span className="text-muted-foreground">-</span>) },
    { id: "description", header: "Description", defaultHidden: true, accessor: (r) => r.description ?? "", cell: (r) => r.description || "-" },
    ...metaColumns<Expense>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => {
        const s = up(r.state);
        const mine = r.employee && me.employee_id && idOf(r.employee) === me.employee_id;
        return (
          <div className="flex justify-end gap-1">
            {s === "DRAFT" && (mine || canApprove) && (
              <>
                <AccessAction collection="expenses" objectPath={r.path} verb="submit" can={r.access?.can} label="Submit">
                  <Button size="sm" variant="ghost" onClick={() => action(r, "submit")}><Send className="h-4 w-4" /> Submit</Button>
                </AccessAction>
                <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>Edit</Button>
              </>
            )}
            {(s === "DRAFT" || s === "SUBMITTED") && (
              <Button size="sm" variant="ghost" onClick={() => pickInvoice(r)}><Paperclip className="h-4 w-4" /> {r.has_invoice ? "Replace" : "Invoice"}</Button>
            )}
            {s === "SUBMITTED" && (
              <>
                <AccessAction collection="expenses" objectPath={r.path} verb="approve" can={r.access?.can} label="Approve">
                  <Button size="sm" variant="ghost" onClick={() => action(r, "approve")}><Check className="h-4 w-4" /> Approve</Button>
                </AccessAction>
                <AccessAction collection="expenses" objectPath={r.path} verb="reject" can={r.access?.can} label="Reject">
                  <Button size="sm" variant="ghost" onClick={() => action(r, "reject")}><X className="h-4 w-4" /> Reject</Button>
                </AccessAction>
              </>
            )}
            {(s === "DRAFT" || s === "SUBMITTED") && (mine || canApprove) && (
              <AccessAction collection="expenses" objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
                <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
              </AccessAction>
            )}
            {s === "APPROVED" && !r.reimbursable && canPay && (
              <AccessAction collection="expenses" objectPath={r.path} verb="pay" can={r.access?.can} label="Mark paid">
                <Button size="sm" variant="success" onClick={() => setPayFor(r)}><Wallet className="h-4 w-4" /> Mark paid</Button>
              </AccessAction>
            )}
            <RowActivityButton resource={r.path} />
          </div>
        );
      },
    },
  ];

  // Budget utilization (finance view; empty for others).
  const activeBudgets = budgets.filter((b) => (b.utilization ?? 0) > 0 || (b.spent ?? 0) > 0);

  return (
    <div>
      <input ref={fileRef} type="file" className="hidden" onChange={onInvoicePicked} />
      <PageHeader
        accessCollection="expenses"
        title="Expenses"
        description="Track, approve and pay operational and office expenses."
        actions={<>
          <AccessAction collection="expenses" create label="Quick add"><Button variant="outline" onClick={openQuick}><Zap className="h-4 w-4" /> Quick add</Button></AccessAction>
          <AccessAction collection="expenses" create label="New expense"><Button onClick={openCreate}><Plus className="h-4 w-4" /> New expense</Button></AccessAction>
          <PageSettings me={me} host="expenses" />
        </>}
      />

      {state === "ready" && rows.length > 0 && (
        <SummaryStrip
          items={[
            { label: "Pending approval", value: money(sum(pending)), hint: `${pending.length} expense${pending.length === 1 ? "" : "s"}`, tone: pending.length ? "warning" : "muted" },
            { label: "Approved, awaiting payment", value: money(sum(approvedUnpaid)), hint: approvedUnpaid.length ? `${approvedUnpaid.length} to pay` : "all settled", tone: approvedUnpaid.length ? "default" : "muted" },
            { label: "Paid this month", value: money(sum(paidThisMonth)), hint: `${paidThisMonth.length} expense${paidThisMonth.length === 1 ? "" : "s"}`, tone: "success" },
          ]}
        />
      )}

      {activeBudgets.length > 0 && (
        <Card className="mb-4">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm font-medium">Budget utilization</p>
            {activeBudgets.map((b) => {
              const pct = Math.round((b.utilization ?? 0) * 100);
              const over = pct >= 100;
              return (
                <div key={b.path} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{b.category ? catName(b.category) : "All categories"}{b.department ? ` · ${deptName(b.department)}` : ""} <span className="text-muted-foreground">({b.period_key})</span></span>
                    <span className="tabular-nums text-muted-foreground">{money(b.spent ?? 0)} / {money(b.amount)}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className={`h-full ${over ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            illustration="expenses"
            icon={Wallet}
            title="No expenses yet"
            description="Record an operational or office expense to get started."
            action={<AccessAction collection="expenses" create label="New expense"><Button onClick={openCreate}><Plus className="h-4 w-4" /> New expense</Button></AccessAction>}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="expenses"
            rows={searching ? searchRows : rows}
            search={{ value: search, onChange: setSearch, placeholder: "Search all records…" }}
            hasMore={searching ? searchHasMore : undefined}
            getRowId={(r) => r.path}
            emptyTitle="No expenses match"
            accessCollection="expenses"
            accessTargetOf={(r) => ({ objectPath: r.path, label: `${money(r.amount)}`, can: r.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit expense" : "New expense"}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => { e.preventDefault(); if (form.amount && Number(form.amount) > 0 && !(invoiceRequired && !file && !editing) && !busy) save(); }}
          >
            <FieldRow>
              <Field label="Category">
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => !c.disabled).map((c) => (
                      <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>
                        {c.display_name}{c.requires_receipt ? <span className="text-muted-foreground"> · invoice required</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Amount" error={form.amount !== "" && Number(form.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
                <Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} autoFocus />
              </Field>
            </FieldRow>
            <FieldRow>
              {vendors.length > 0 && (
                <Field label="Vendor (optional)">
                  <Select value={form.vendor} onValueChange={(v) => setForm({ ...form, vendor: v })}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      {vendors.filter((v) => !v.disabled).map((v) => (
                        <SelectItem key={v.path} value={`vendors/${idOf(v.path)}`}>{v.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="Cost centre (optional)">
                <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Tax / GST (optional)">
                <Input type="number" min={0} step="0.01" value={form.tax_amount} onChange={(e) => setForm({ ...form, tax_amount: e.target.value })} />
              </Field>
              <Field label="Date incurred" error={form.incurred_on && form.incurred_on > todayStr() ? "That's in the future." : undefined}>
                <Input type="date" max={todayStr()} value={form.incurred_on} onChange={(e) => setForm({ ...form, incurred_on: e.target.value })} />
              </Field>
            </FieldRow>
            <Field label="Description (optional)">
              <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox id="reimbursable" checked={form.reimbursable} onCheckedChange={(v) => setForm({ ...form, reimbursable: v === true })} />
              <Label htmlFor="reimbursable">An employee fronted this (reimburse via payroll on approval)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="recurring" checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: v === true })} />
              <Label htmlFor="recurring">Recurring expense (auto-generated on a schedule)</Label>
            </div>
            {form.recurring && (
              <FieldRow>
                <Field label="Repeats">
                  <Select value={form.recurrence_rule} onValueChange={(v) => setForm({ ...form, recurrence_rule: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Next occurrence">
                  <Input type="date" value={form.next_occurrence_on} onChange={(e) => setForm({ ...form, next_occurrence_on: e.target.value })} />
                </Field>
              </FieldRow>
            )}
            <Field label={invoiceRequired ? "Invoice" : "Invoice (optional)"} hint={invoiceRequired && !file && !editing ? "This category requires an invoice." : undefined}>
              <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            {!editing && !form.recurring && (
              <div className="flex items-center gap-2">
                <Checkbox id="submitNow" checked={submitNow} onCheckedChange={(v) => setSubmitNow(v === true)} />
                <Label htmlFor="submitNow">Submit for approval now</Label>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!form.amount || Number(form.amount) <= 0 || (invoiceRequired && !file && !editing) || (form.recurring && !form.next_occurrence_on) || !!(form.incurred_on && form.incurred_on > todayStr())}>
                {editing ? "Save changes" : form.recurring ? "Create schedule" : submitNow ? "Submit" : "Save draft"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Quick add expense</DialogTitle></DialogHeader>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (quick.amount && Number(quick.amount) > 0 && !quickBusy) quickSubmit(); }}>
            <FieldRow>
              <Field label="Amount" error={quick.amount !== "" && Number(quick.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
                <Input type="number" min={0} step="0.01" value={quick.amount} onChange={(e) => setQuick({ ...quick, amount: e.target.value })} autoFocus />
              </Field>
              <Field label="Category (optional)">
                <Select value={quick.category} onValueChange={(v) => setQuick({ ...quick, category: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => !c.disabled).map((c) => (
                      <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>{c.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            <Field label="What for? (optional)">
              <Input value={quick.description} onChange={(e) => setQuick({ ...quick, description: e.target.value })} placeholder="e.g. Team lunch, cab, snacks" />
            </Field>
            <p className="text-xs text-muted-foreground">Dated today and submitted for approval. Use New expense for vendor, cost centre, tax or invoice details.</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setQuickOpen(false)}>Cancel</Button>
              <Button type="submit" loading={quickBusy} disabled={!quick.amount || Number(quick.amount) <= 0}>Add expense</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark expense paid</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <Field label="Payment method">
              <Select value={payForm.payment_method} onValueChange={(v) => setPayForm({ ...payForm, payment_method: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["bank", "card", "cash", "upi", "cheque"].map((m) => <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Payment reference (optional)">
              <Input value={payForm.payment_ref} onChange={(e) => setPayForm({ ...payForm, payment_ref: e.target.value })} placeholder="e.g. UTR / cheque no." />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>Cancel</Button>
            <Button variant="success" onClick={confirmPay}>Mark paid</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
