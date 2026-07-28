import { useMemo, useState } from "react";
import { Plus, Check, X, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, LeaveType, LeaveBalance, LeaveEncashment, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { withNewBadge } from "@/components/common/NewBadge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Field } from "@/components/common/Field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const COL = "leave-encashments";
const upper = (s?: string) => (s ?? "").toUpperCase();
const sum = (rs: LeaveEncashment[]) => rs.reduce((n, r) => n + (r.amount || 0), 0);
const EMPTY = { employee: "", leave_type: "", days: "" };

export default function LeaveEncashments({ embedded }: { me?: Me; embedded?: boolean }) {
  const { rows, state, error, reload } = useCollection<LeaveEncashment>(COL);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const canCreate = usePermission(`${COL}.write`);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);
  const ltName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [leaveTypes]);

  const encashableTypes = useMemo(() => leaveTypes.filter((t) => t.encashable && !t.delete_time && !t.disabled), [leaveTypes]);
  const balanceFor = (empRef: string, typeRef: string): number => {
    const b = balances.find((x) => x.employee && x.leave_type && idOf(x.employee) === idOf(empRef) && idOf(x.leave_type) === idOf(typeRef));
    return b?.balance_days ?? 0;
  };
  // Current balance for the selected (employee, leave type) - shown as guidance in the dialog.
  const selectedBalance = form.employee && form.leave_type ? balanceFor(form.employee, form.leave_type) : null;
  const selectedType = form.leave_type ? encashableTypes.find((t) => idOf(t.path) === idOf(form.leave_type)) : undefined;

  const yearStart = `${new Date().getFullYear()}-01-01`;

  // Eligibility guardrails, surfaced BEFORE submitting: the type's retained minimum and yearly cap
  // bound how many days can actually be encashed right now.
  const encashedThisYear = useMemo(() => {
    if (!form.employee || !form.leave_type) return 0;
    return rows
      .filter((r) => r.employee && r.leave_type && idOf(r.employee) === idOf(form.employee) && idOf(r.leave_type) === idOf(form.leave_type))
      .filter((r) => ["PENDING", "APPROVED", "PAID"].includes(upper(r.state)) && (r.create_time ?? "") >= yearStart)
      .reduce((n, r) => n + (r.days || 0), 0);
  }, [rows, form.employee, form.leave_type, yearStart]);
  const retained = selectedType?.min_balance_retained_days ?? 0;
  const yearCap = selectedType?.encashment_cap_days_per_year ?? null;
  const capLeft = yearCap != null ? Math.max(0, yearCap - encashedThisYear) : null;
  const maxEncashable = selectedBalance == null ? null : Math.max(0, Math.min(selectedBalance - retained, capLeft ?? Infinity));

  // Most recent known day-rate for the selected employee (from any prior encashment) - estimate only;
  // the server computes the real rate from current salary.
  const lastRate = useMemo(() => {
    if (!form.employee) return null;
    const prior = rows
      .filter((r) => r.employee && idOf(r.employee) === idOf(form.employee) && r.rate_per_day != null)
      .sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
    return prior[0]?.rate_per_day ?? null;
  }, [rows, form.employee]);

  const daysNum = Number(form.days);
  const canSubmit = !!form.employee && !!form.leave_type && !!form.days && daysNum > 0 && (maxEncashable == null || daysNum <= maxEncashable);
  const isPending = (r: LeaveEncashment) => upper(r.state) === "PENDING";
  const pending = useMemo(() => rows.filter(isPending), [rows]);
  const decided = useMemo(() => rows.filter((r) => !isPending(r)), [rows]);
  const approvedUnpaid = rows.filter((r) => upper(r.state) === "APPROVED");
  const paidThisYear = rows.filter((r) => upper(r.state) === "PAID" && (r.paid_time ?? "") >= yearStart);

  async function submit() {
    setBusy(true);
    try {
      await create<LeaveEncashment>(COL, {
        employee: `employees/${idOf(form.employee)}`,
        leave_type: `leave-types/${idOf(form.leave_type)}`,
        days: Number(form.days),
      });
      toast({ title: "Encashment requested", variant: "success" });
      setForm(EMPTY);
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't request encashment", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function action(r: LeaveEncashment, verb: "approve" | "reject" | "cancel") {
    const past = { approve: "approved", reject: "rejected", cancel: "cancelled" }[verb];
    try {
      await invoke(`${COL}/${idOf(r.path)}`, verb, r.etag);
      toast({ title: `Encashment ${past}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: `Couldn't ${verb} encashment`, description: (e as Error).message, variant: "destructive" });
    }
  }

  // ---- columns -------------------------------------------------------------
  const empCol: Column<LeaveEncashment> = { id: "employee", header: "Employee", accessor: (r) => empName(r.employee), cell: (r) => <span className="font-medium">{empName(r.employee)}</span> };
  const baseCols: Column<LeaveEncashment>[] = [
    { id: "leave_type", header: "Leave type", filter: "select", accessor: (r) => ltName(r.leave_type) },
    { id: "days", header: "Days", align: "right", accessor: (r) => r.days, cell: (r) => <span className="tabular-nums">{r.days}</span> },
    { id: "rate", header: "Rate/day", align: "right", defaultHidden: true, accessor: (r) => r.rate_per_day ?? 0, cell: (r) => <span className="tabular-nums">{r.rate_per_day != null ? money(r.rate_per_day) : "-"}</span> },
    { id: "amount", header: "Amount", align: "right", accessor: (r) => r.amount ?? 0, cell: (r) => <span className="tabular-nums">{r.amount != null ? money(r.amount) : "-"}</span> },
    { id: "state", header: "Status", filter: "select", accessor: (r) => r.state, cell: (r) => <StatusBadge state={r.state} /> },
  ];

  const decideCol: Column<LeaveEncashment> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => {
      const ref = { collection: COL, objectPath: r.path, can: r.access?.can };
      return (
        <div className="flex justify-end gap-2">
          <AccessAction {...ref} verb="approve" label="Approve">
            <Button size="sm" variant="success" onClick={() => action(r, "approve")}><Check className="h-4 w-4" /> Approve</Button>
          </AccessAction>
          <AccessAction {...ref} verb="reject" label="Reject">
            <Button size="sm" variant="outline" onClick={() => action(r, "reject")}><X className="h-4 w-4" /> Reject</Button>
          </AccessAction>
          <AccessAction {...ref} verb="cancel" label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        </div>
      );
    },
  };
  // History: an approved-but-unpaid row can still be cancelled (credits the days back); paid rows are final.
  const historyActions: Column<LeaveEncashment> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) =>
      upper(r.state) === "APPROVED" ? (
        <AccessAction collection={COL} objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
          <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
        </AccessAction>
      ) : null,
  };

  const pendingCols = [empCol, ...baseCols, decideCol];
  const historyCols = withNewBadge([empCol, ...baseCols, ...metaColumns<LeaveEncashment>(), historyActions]);

  const newBtn = canCreate && (
    <AccessAction collection={COL} create label="New encashment">
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New encashment</Button>
    </AccessAction>
  );

  const renderTable = (data: LeaveEncashment[], columns: Column<LeaveEncashment>[], tableId: string, emptyTitle: string, emptyDescription?: string) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      rows={data}
      getRowId={(r) => r.path}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      accessCollection={COL}
      accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${r.days}d`, can: r.access?.can })}
    />
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Convert accrued leave into a cash payout.</p>
          {newBtn}
        </div>
      ) : (
        <PageHeader
          title="Leave Encashments"
          description="Convert accrued leave into a cash payout."
          actions={newBtn}
        />
      )}

      {rows.length > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <Stat label="Pending" value={money(sum(pending))} sub={`${pending.length} request${pending.length === 1 ? "" : "s"}`} />
          <Stat label="Approved (awaiting payout)" value={money(sum(approvedUnpaid))} sub={`${approvedUnpaid.length} request${approvedUnpaid.length === 1 ? "" : "s"}`} />
          <Stat label="Paid this year" value={money(sum(paidThisYear))} sub={`${paidThisYear.length} request${paidThisYear.length === 1 ? "" : "s"}`} accent />
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        <Tabs defaultValue="pending">
          <TabsList>
            {/* pending/history are scope filters of leave-encashments; key on Pending, per-row keys in tables. */}
            <AccessTab value="pending" target={{ collection: "leave-encashments", label: "Leave encashments" }}>Pending{pending.length ? ` (${pending.length})` : ""}</AccessTab>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="pending">
            {renderTable(pending, pendingCols, "encash-pending", "Nothing pending", "Approve, reject or cancel pending encashment requests here.")}
          </TabsContent>
          <TabsContent value="history">
            {renderTable(decided, historyCols, "encash-history", "No decided encashments", "Approved, paid, rejected or cancelled requests appear here.")}
          </TabsContent>
        </Tabs>
      </DataState>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setForm(EMPTY); }}>
        <DialogContent onEnterSubmit={() => { if (!busy && canSubmit) submit(); }}>
          <DialogHeader>
            <DialogTitle>New leave encashment</DialogTitle>
          </DialogHeader>
          <Field label="Employee">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Select…"
              searchPlaceholder="Search employees…"
              options={employees.filter((e) => !e.delete_time).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <Field label="Leave type" hint={encashableTypes.length === 0 ? "No leave types are marked encashable yet (set this in Leave Types)." : undefined}>
            <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {encashableTypes.map((t) => {
                  const bal = form.employee ? balanceFor(form.employee, t.path) : null;
                  return (
                    <SelectItem key={t.path} value={`leave-types/${idOf(t.path)}`} disabled={bal != null && bal <= 0}>
                      {t.display_name}{bal != null ? (bal > 0 ? ` · ${bal} day${bal === 1 ? "" : "s"}` : " - no balance") : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Days to encash"
            hint={
              selectedBalance != null && maxEncashable != null
                ? [
                    `Balance: ${selectedBalance} day${selectedBalance === 1 ? "" : "s"}`,
                    ...(retained > 0 ? [`policy keeps ${retained} unencashed`] : []),
                    ...(capLeft != null ? [`${capLeft} of the ${yearCap}/year cap left`] : []),
                    ...(retained > 0 || capLeft != null ? [`max now: ${maxEncashable}`] : []),
                  ].join(" · ")
                : undefined
            }
            error={
              form.days !== "" && daysNum <= 0
                ? "Enter a number of days greater than 0."
                : form.days !== "" && maxEncashable != null && daysNum > maxEncashable
                  ? maxEncashable <= 0
                    ? "Nothing can be encashed for this leave type right now."
                    : `Only ${maxEncashable} day${maxEncashable === 1 ? "" : "s"} can be encashed.`
                  : undefined
            }
          >
            <Input type="number" min={0} step="0.5" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
          </Field>
          <p className="text-sm text-muted-foreground">
            {lastRate != null && canSubmit ? (
              <>Estimated payout: <span className="font-medium text-foreground">{money(daysNum * lastRate)}</span> at the last known rate of {money(lastRate)}/day. The final amount uses the employee's current salary.</>
            ) : (
              <>The payout amount is computed from the employee's daily salary rate when the request is created.</>
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); setForm(EMPTY); }}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!canSubmit}>
              Request encashment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-primary" : ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </Card>
  );
}
