import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Ban, Paperclip, Download, Wallet, ClipboardCheck } from "lucide-react";
import { navigate, navigateTab } from "@/router";
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
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard, useDialogDraft } from "@/components/common/dialogGuard";
import { DraftNotice } from "@/components/common/DraftNotice";
import { AccessScope } from "@/components/access/AccessScope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { getSetting } from "@/lib/settingsStore";

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
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const canDecide = usePermission("reimbursements.approve");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "claim" });
  // A claim is filled in from a paper receipt, often on a phone, often interrupted. The typed part survives a
  // reload; the attachment can't (a File isn't serializable), which the notice's "start over" makes recoverable.
  const draft = useDialogDraft("reimbursement-claim", open, form, setForm);
  function openCreate() {
    setForm({ ...EMPTY, incurred_on: todayStr() });
    setFile(null);
    setErr(null);
    setOpen(true);
  }
  // Global "New reimbursement" quick action opens the claim dialog on arrival.
  useIntent("new-reimbursement", openCreate);
  // Payout mode drives whether a manual "Mark paid" action is offered (separate) or payout is automatic (payroll).
  const [payoutMode, setPayoutMode] = useState<"payroll" | "separate">("payroll");
  useEffect(() => {
    getSetting<{ payout_mode?: string }>("reimbursements")
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
  // A claim of your own with nothing attached is the one that comes back to you; someone else's pending claim
  // is a decision you owe them. Both are worth a metric of their own.
  const missingReceipt = pending.filter((r) => !r.has_receipt);
  const toDecide = useMemo(() => (canDecide ? rows.filter((r) => isPending(r) && !isOwn(r)) : []), [rows, canDecide, me.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCat = categories.find((c) => c.path && form.category && idOf(c.path) === idOf(form.category));
  const receiptRequired = !!selectedCat?.requires_receipt;

  // The same expense filed twice is the classic claim mistake - a slow submit, a reload, a "did that go
  // through?" - and it's invisible on a list sorted by date. Matched on the trio that identifies an expense.
  const duplicate = useMemo(() => {
    if (!(Number(form.amount) > 0) || !form.incurred_on) return undefined;
    return myAll.find(
      (r) =>
        Math.abs(r.amount - Number(form.amount)) < 0.01 &&
        (r.incurred_on ?? "").slice(0, 10) === form.incurred_on &&
        idOf(r.category ?? "") === idOf(form.category ?? "") &&
        upper(r.state) !== "CANCELLED" &&
        upper(r.state) !== "REJECTED",
    );
  }, [myAll, form.amount, form.incurred_on, form.category]);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const claim = await create<Reimbursement>("reimbursements", {
        category: form.category || null,
        amount: Number(form.amount),
        incurred_on: form.incurred_on || null,
        description: form.description || null,
      });
      if (file) await upload(`reimbursements/${idOf(claim.path)}`, file);
      toast({ title: "Claim submitted", variant: "success" });
      // Filed, so the draft has served its purpose - leaving it would restore a claim that already exists.
      draft.clear();
      guard.markSaved();
      setForm(EMPTY);
      setFile(null);
      setOpen(false);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function action(r: Reimbursement, verb: "approve" | "reject" | "cancel" | "pay") {
    const done = { approve: "Claim approved", reject: "Claim rejected", cancel: "Claim cancelled", pay: "Claim marked paid" };
    if (!(await confirmDecision(confirm, verb, `${empName(r.employee)}'s ${money(r.amount ?? 0)} claim`))) return;
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
      emptyAction={requestBtn}
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
            // Your own claims live in the Requests/History tabs below; other people's pending claims are a
            // decision, which belongs to the Approvals inbox. Each metric opens the one that owns its rows.
            { label: "Pending", value: money(sum(pending)), hint: `${pending.length} claim${pending.length === 1 ? "" : "s"}, cancellable`, tone: pending.length ? "warning" : "muted", onClick: () => navigateTab("reimbursements", "requests") },
            ...(toDecide.length
              ? [{ label: "Awaiting your decision", value: money(sum(toDecide)), icon: ClipboardCheck, tone: "warning" as const, hint: `${toDecide.length} from others`, onClick: () => navigate("approvals") }]
              : []),
            ...(missingReceipt.length
              ? [{ label: "No receipt attached", value: missingReceipt.length, icon: Paperclip, tone: "warning" as const, hint: "attach before deciding", onClick: () => navigateTab("reimbursements", "requests") }]
              : []),
            { label: "Approved, awaiting payout", value: money(sum(approvedUnpaid)), hint: approvedUnpaid.length ? `${approvedUnpaid.length} claim${approvedUnpaid.length === 1 ? "" : "s"}${payoutMode === "payroll" ? " · via payroll" : ""}` : "all settled", tone: approvedUnpaid.length ? "default" : "muted", onClick: () => navigateTab("reimbursements", "history") },
            { label: "Paid this year", value: money(sum(paidThisYear)), hint: `${paidThisYear.length} claim${paidThisYear.length === 1 ? "" : "s"}`, tone: "success", onClick: () => navigateTab("reimbursements", "history") },
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

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody>
          <AccessScope collection="reimbursements">
          <DialogHeader>
            <DialogTitle>New reimbursement claim</DialogTitle>
            <DialogDescription>
              Goes to your manager for approval.{payoutMode === "payroll" ? " Once approved it's paid with your next salary." : " Once approved, finance pays it out separately."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col gap-5"
            onSubmit={(e) => { e.preventDefault(); if (form.amount && Number(form.amount) > 0 && !(receiptRequired && !file) && !(form.incurred_on && form.incurred_on > todayStr()) && !busy) submit(); }}
          >
          <DialogBody>
          <FormError error={err} />
          {draft.restored && <DraftNotice onStartOver={() => { draft.clear(); setForm({ ...EMPTY, incurred_on: todayStr() }); setFile(null); }} />}
          <FieldRow>
            <Field label="Category">
              {categories.filter((c) => !c.disabled).length === 0 ? (
                /* An empty category list is a dead end: the select opens onto nothing and the claim can't be
                   filed. Say who can fix it rather than leaving the form to be stared at. */
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  No claim categories have been set up yet - ask HR or payroll to add one.
                </p>
              ) : (
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
              )}
            </Field>
            <Field label="Amount" error={form.amount !== "" && Number(form.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
              <MoneyInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} min={0} step="0.01" autoFocus />
            </Field>
          </FieldRow>
          <Field label="Date incurred" error={form.incurred_on && form.incurred_on > todayStr() ? "That's in the future - expenses are claimed after they're incurred." : undefined}>
            <Input type="date" max={todayStr()} value={form.incurred_on} onChange={(e) => setForm({ ...form, incurred_on: e.target.value })} />
          </Field>
          <Field label="Description (optional)" hint="What it was for. An approver reading a bare amount usually asks anyway.">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field
            label={receiptRequired ? "Receipt" : "Receipt (optional)"}
            hint={file ? `Attached: ${file.name}` : receiptRequired ? "This category requires a receipt - attach one to submit." : "A photo of the bill is enough."}
          >
            <Input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          {duplicate && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              You already have a claim for {money(duplicate.amount)} in this category on {formatDate(form.incurred_on)}
              {upper(duplicate.state) === "PAID" ? ", already paid" : upper(duplicate.state) === "APPROVED" ? ", approved and awaiting payout" : ", still pending"}. File this only if it's a second, separate expense.
            </p>
          )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!form.amount || Number(form.amount) <= 0 || (receiptRequired && !file) || !!(form.incurred_on && form.incurred_on > todayStr())}>
              Submit claim
            </Button>
          </DialogFooter>
          </form>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
