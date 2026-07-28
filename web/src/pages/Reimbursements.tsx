import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Ban, Paperclip, Download, Wallet } from "lucide-react";
import { create, get, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, Reimbursement, ReimbursementCategory, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Field, FieldRow } from "@/components/common/Field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const upper = (s?: string) => (s ?? "").toUpperCase();
const sum = (rs: Reimbursement[]) => rs.reduce((n, r) => n + (r.amount || 0), 0);
const pad = (n: number) => String(n).padStart(2, "0");
// Local-time today, for prefilling "Date incurred" (toISOString would shift across midnight in non-UTC zones).
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const EMPTY = { category: "", amount: "", incurred_on: "", description: "" };

export default function Reimbursements({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Reimbursement>("reimbursements");
  const { rows: categories } = useCollection<ReimbursementCategory>("reimbursement-categories");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const canDecide = usePermission("reimbursements.approve");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  function openCreate() {
    setForm({ ...EMPTY, incurred_on: todayStr() });
    setFile(null);
    setOpen(true);
  }
  // Global "New reimbursement" quick action opens the claim dialog on arrival.
  useIntent("new-reimbursement", openCreate);
  // Payout mode drives whether a manual "Mark paid" action is offered (separate) or payout is automatic (payroll).
  const [payoutMode, setPayoutMode] = useState<"payroll" | "separate">("payroll");
  useEffect(() => {
    get<{ value?: { payout_mode?: string } }>("settings/reimbursements")
      .then((s) => { if (s.value?.payout_mode === "separate") setPayoutMode("separate"); })
      .catch(() => {});
  }, []);
  // Hidden file input for attaching/replacing a receipt on an existing claim.
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<Reimbursement | null>(null);

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [idOf(c.path), c.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [categories]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  const yearStart = `${new Date().toISOString().slice(0, 4)}-01-01`;
  const isOwn = (r: Reimbursement) => !!(r.employee && me.employee_id && idOf(r.employee) === me.employee_id);
  const isPending = (r: Reimbursement) => upper(r.state) === "PENDING";

  const myAll = useMemo(() => rows.filter(isOwn), [rows, me.employee_id]);
  const pending = myAll.filter(isPending);
  const approvedUnpaid = myAll.filter((r) => upper(r.state) === "APPROVED");
  const paidThisYear = myAll.filter((r) => upper(r.state) === "PAID" && (r.paid_time ?? "") >= yearStart);

  const selectedCat = categories.find((c) => c.path && form.category && idOf(c.path) === idOf(form.category));
  const receiptRequired = !!selectedCat?.requires_receipt;

  async function submit() {
    setBusy(true);
    try {
      const claim = await create<Reimbursement>("reimbursements", {
        category: form.category || null,
        amount: Number(form.amount),
        incurred_on: form.incurred_on || null,
        description: form.description || null,
      });
      if (file) await upload(`reimbursements/${idOf(claim.path)}`, file);
      toast({ title: "Claim submitted", variant: "success" });
      setForm(EMPTY);
      setFile(null);
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't submit", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function action(r: Reimbursement, verb: "approve" | "reject" | "cancel" | "pay") {
    const done = { approve: "Claim approved", reject: "Claim rejected", cancel: "Claim cancelled", pay: "Claim marked paid" };
    try {
      await invoke("reimbursements/" + idOf(r.path), verb, r.etag);
      toast({ title: done[verb], variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the claim", description: (e as Error).message, variant: "destructive" });
    }
  }

  function pickReceipt(r: Reimbursement) {
    uploadTarget.current = r;
    fileRef.current?.click();
  }
  async function onReceiptPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const r = uploadTarget.current;
    e.target.value = ""; // allow re-picking the same file
    if (!f || !r) return;
    try {
      await upload(`reimbursements/${idOf(r.path)}`, f);
      toast({ title: "Receipt attached", variant: "success" });
      reload();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  }
  const getReceipt = (r: Reimbursement) => download("reimbursements/" + idOf(r.path), `receipt-${idOf(r.path)}`);

  // ---- columns -------------------------------------------------------------
  const empCol: Column<Reimbursement> = { id: "employee", header: "Employee", accessor: (r) => empName(r.employee), cell: (r) => <span className="font-medium">{empName(r.employee)}</span> };
  const baseCols: Column<Reimbursement>[] = [
    { id: "category", header: "Category", filter: "select", accessor: (r) => catName(r.category) },
    { id: "amount", header: "Amount", align: "right", accessor: (r) => r.amount, cell: (r) => <span className="tabular-nums">{money(r.amount)}</span> },
    { id: "incurred", header: "Incurred", accessor: (r) => r.incurred_on ?? "", cell: (r) => (r.incurred_on ? formatDate(r.incurred_on) : "-") },
    // PAID is the terminal happy state - show it green and say how/when the money went out (payroll run sets paid_run).
    { id: "state", header: "Status", filter: "select", accessor: (r) => r.state, cell: (r) => upper(r.state) === "PAID" ? (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="success">Paid</Badge>
        <span className="text-xs text-muted-foreground">{r.paid_run ? "via payroll" : ""}{r.paid_time ? `${r.paid_run ? " · " : ""}${formatDate(r.paid_time)}` : ""}</span>
      </span>
    ) : <StatusBadge state={r.state} /> },
    { id: "receipt", header: "Receipt", sortable: false, filter: "none", accessor: (r) => (r.has_receipt ? "yes" : ""), cell: (r) => (r.has_receipt ? (
      <Button size="sm" variant="ghost" onClick={() => getReceipt(r)}><Download className="h-4 w-4" /> Receipt</Button>
    ) : <span className="text-muted-foreground">-</span>) },
    { id: "description", header: "Description", defaultHidden: true, accessor: (r) => r.description ?? "", cell: (r) => r.description || "-" },
  ];

  const ownActions: Column<Reimbursement> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => (
      <div className="flex justify-end gap-1">
        {isPending(r) && (
          <Button size="sm" variant="ghost" onClick={() => pickReceipt(r)}><Paperclip className="h-4 w-4" /> {r.has_receipt ? "Replace" : "Receipt"}</Button>
        )}
        {isPending(r) && (
          <AccessAction collection="reimbursements" objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={r.path} />
      </div>
    ),
  };
  // Separate payout mode: approvers mark an APPROVED claim paid out-of-band (payroll mode does it automatically).
  const payCol: Column<Reimbursement> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) =>
      payoutMode === "separate" && upper(r.state) === "APPROVED" ? (
        <AccessAction collection="reimbursements" objectPath={r.path} verb="pay" can={r.access?.can} label="Mark paid">
          <Button size="sm" variant="success" onClick={() => action(r, "pay")}><Wallet className="h-4 w-4" /> Mark paid</Button>
        </AccessAction>
      ) : null,
  };

  const activityCol: Column<Reimbursement> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (r) => <RowActivityButton resource={r.path} /> };
  const mineCols = [...baseCols, ...metaColumns<Reimbursement>(), ownActions];
  // Approvers see everyone's decided claims in History (with the employee), plus a Mark-paid action in separate mode.
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, ...metaColumns<Reimbursement>(), payCol, activityCol] : [...baseCols, ...metaColumns<Reimbursement>(), activityCol]);

  const requestBtn = (
    <AccessAction collection="reimbursements" create label="New claim">
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New claim</Button>
    </AccessAction>
  );

  const renderTable = (search: RequestsHistorySearch, data: Reimbursement[], columns: Column<Reimbursement>[], tableId: string, emptyTitle: string, emptyDescription?: string) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      rows={data}
      search={search}
      getRowId={(r) => r.path}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      accessCollection="reimbursements"
      accessTargetOf={(r) => ({ objectPath: r.path, label: `Claim ${money(r.amount)}`, can: r.access?.can })}
    />
  );

  return (
    <div>
      <PageHeader title="Reimbursements" actions={<>{requestBtn}<PageSettings me={me} host="reimbursements" /></>} />

      <input ref={fileRef} type="file" className="hidden" onChange={onReceiptPicked} />

      {state === "ready" && myAll.length > 0 && (
        <SummaryStrip
          items={[
            { label: "Pending", value: money(sum(pending)), hint: `${pending.length} claim${pending.length === 1 ? "" : "s"}`, tone: pending.length ? "warning" : "muted" },
            { label: "Approved, awaiting payout", value: money(sum(approvedUnpaid)), hint: approvedUnpaid.length ? `${approvedUnpaid.length} claim${approvedUnpaid.length === 1 ? "" : "s"}${payoutMode === "payroll" ? " · paid via payroll" : ""}` : "all settled", tone: approvedUnpaid.length ? "default" : "muted" },
            { label: "Paid this year", value: money(sum(paidThisYear)), hint: `${paidThisYear.length} claim${paidThisYear.length === 1 ? "" : "s"}`, tone: "success" },
          ]}
        />
      )}

      <RequestsHistoryTabs
        collection="reimbursements"
        rows={rows}
        state={state}
        error={error}
        reload={reload}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        accessLabel="Reimbursements"
        render={(items, mode, search) =>
          mode === "requests"
            ? renderTable(search, items, mineCols, "reimb-active", "No pending claims", "Your pending claims (which you can still cancel) appear here. File a claim to get started.")
            : renderTable(search, items, historyCols, "reimb-history", "No decided claims", "Approved, paid, rejected, or cancelled claims appear here.")
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New reimbursement claim</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => { e.preventDefault(); if (form.amount && Number(form.amount) > 0 && !(receiptRequired && !file) && !(form.incurred_on && form.incurred_on > todayStr()) && !busy) submit(); }}
          >
          <FieldRow>
            <Field label="Category">
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {categories.filter((c) => !c.disabled).map((c) => (
                    <SelectItem key={c.path} value={`reimbursement-categories/${idOf(c.path)}`}>
                      {c.display_name}{c.requires_receipt ? <span className="text-muted-foreground"> · receipt required</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Amount" error={form.amount !== "" && Number(form.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
              <Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} autoFocus />
            </Field>
          </FieldRow>
          <Field label="Date incurred" error={form.incurred_on && form.incurred_on > todayStr() ? "That's in the future - expenses are claimed after they're incurred." : undefined}>
            <Input type="date" max={todayStr()} value={form.incurred_on} onChange={(e) => setForm({ ...form, incurred_on: e.target.value })} />
          </Field>
          <Field label="Description (optional)">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label={receiptRequired ? "Receipt" : "Receipt (optional)"} hint={receiptRequired && !file ? "This category requires a receipt - attach one to submit." : receiptRequired ? "This category requires a receipt." : undefined}>
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!form.amount || Number(form.amount) <= 0 || (receiptRequired && !file) || !!(form.incurred_on && form.incurred_on > todayStr())}>
              Submit claim
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
