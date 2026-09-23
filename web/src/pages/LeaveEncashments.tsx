import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Plus, Check, X, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { getSetting } from "@/lib/settingsStore";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, formatMoney, idOf } from "@/lib/utils";
import { thisYearStr } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, LeaveType, LeaveBalance, LeaveEncashment, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { withNewBadge } from "@/components/common/NewBadge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Card } from "@/components/ui/card";
import { StatRow } from "@/components/common/StatRow";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

const COL = "leave-encashments";
const upper = (s?: string) => (s ?? "").toUpperCase();
const sum = (rs: LeaveEncashment[]) => rs.reduce((n, r) => n + (r.amount || 0), 0);
const EMPTY = { employee: "", leave_type: "", days: "" };

export default function LeaveEncashments({ embedded, initialType, meEmployeeId }: { me?: Me; embedded?: boolean; initialType?: string | null; meEmployeeId?: string | null }) {
  const { rows, state, error, reload } = useCollection<LeaveEncashment>(COL);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const canCreate = usePermission(`${COL}.write`);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);

  // THE SELECTED EMPLOYEE'S OWN ROWS, NARROWED SERVER-SIDE (`?employee=`, routes/leaveBalances.ts and
  // routes/leaveEncashments.ts). `leave-balances` holds one row per employee PER LEAVE TYPE and
  // `leave-encashments` is org-wide newest-first, so reading a page of either and matching in the browser
  // answered "what is this person's balance / what have they already encashed this year" with "whatever of the
  // newest hundred rows happens to be theirs" - and both answers gate a money form. Only fetched once somebody
  // is selected, so the page costs nothing extra until the dialog is actually being filled in.
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", {
    enabled: !!form.employee,
    params: { employee: form.employee },
    all: true,
  });
  const { rows: empEncashments } = useCollection<LeaveEncashment>(COL, {
    enabled: !!form.employee,
    params: { employee: form.employee },
    all: true,
  });

  // "Encash days" on a Leaves balance card hands the type over: open the form already pointed at that balance
  // instead of making the caller re-pick the type they just clicked.
  useEffect(() => {
    if (!initialType) return;
    setForm({ ...EMPTY, employee: meEmployeeId ? `employees/${meEmployeeId}` : "", leave_type: initialType });
    setOpen(true);
  }, [initialType, meEmployeeId]);

  // Opening the form with the caller already filled in: self-service is the common case, and re-picking your
  // own name from a directory-wide combobox is pure friction.
  function openCreate() {
    setForm({ ...EMPTY, employee: meEmployeeId ? `employees/${meEmployeeId}` : "" });
    setOpen(true);
  }

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Someone" : "-");
  }, [employees]);
  const ltName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Unknown type" : "-");
  }, [leaveTypes]);

  /** A leave type's yearly accrual, for reading a payout as a share of what the type grants. */
  const ltAccrual = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t.accrual_days_per_year ?? 0]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? 0 : 0);
  }, [leaveTypes]);

  const encashableTypes = useMemo(() => leaveTypes.filter((t) => t.encashable && !t.delete_time && !t.disabled), [leaveTypes]);
  // `null` means "no balance row for this pair", which is NOT the same as a zero balance: an employee who has
  // never accrued this type has no row, and so does one whose row simply has not loaded yet. Asserting 0 for
  // an unknown blocked the form on `maxEncashable` while telling the reader the balance was zero - the
  // posture `capLeft` already takes for its own unknown, two blocks down.
  const balanceFor = (empRef: string, typeRef: string): number | null => {
    const b = balances.find((x) => x.employee && x.leave_type && idOf(x.employee) === idOf(empRef) && idOf(x.leave_type) === idOf(typeRef));
    return b?.balance_days ?? null;
  };
  // Current balance for the selected (employee, leave type) - shown as guidance in the dialog.
  const selectedBalance = form.employee && form.leave_type ? balanceFor(form.employee, form.leave_type) : null;
  const selectedType = form.leave_type ? encashableTypes.find((t) => idOf(t.path) === idOf(form.leave_type)) : undefined;

  // The ORG's year (lib/orgDay): this bounds the year-to-date encashment total a cap is checked against, and
  // the browser's year is a different one for part of every New Year's Day.
  const yearStart = `${thisYearStr()}-01-01`;

  // THE ORG POLICY DECIDES WHICH CAP APPLIES, and it is read here rather than assumed. In cumulative mode
  // there is ONE org cap measured across every leave type (services/leaveEncashments.ts `create`); reading the
  // per-type field there offers a number that ignores every other type's usage, and the create call then
  // fails a `failedPrecondition` the reader was told they were inside. A plain employee may not be able to
  // read the settings row, so the catch leaves the mode unknown - see `capLeft` below.
  const [caps, setCaps] = useState<{ mode: "per_type" | "cumulative"; cumulativeCapDays: number | null } | null>(null);
  useEffect(() => {
    getSetting<{ encashment_mode?: string; encashment_cumulative_cap_days?: number | null }>("leave_caps")
      .then((s) => setCaps({
        mode: s.value?.encashment_mode === "cumulative" ? "cumulative" : "per_type",
        cumulativeCapDays: typeof s.value?.encashment_cumulative_cap_days === "number" ? s.value.encashment_cumulative_cap_days : null,
      }))
      .catch(() => setCaps(null));
  }, []);
  const cumulative = caps?.mode === "cumulative";

  // Eligibility guardrails, surfaced BEFORE submitting: the type's retained minimum and yearly cap
  // bound how many days can actually be encashed right now.
  //
  // APPROVED and PAID only, matching `encashedDaysThisYear` - "days already COMMITTED". Counting PENDING too
  // shrank the remaining cap by days the server has not charged against it, and because the figure gates the
  // button (`canSubmit` below), one un-decided request could leave an employee unable to file a second one the
  // server would have accepted - with `whyNot` silent, because the blocker was inside `canSubmit`.
  // In cumulative mode the running total is across every type, not just the selected one.
  const encashedThisYear = useMemo(() => {
    if (!form.employee || !form.leave_type) return 0;
    return empEncashments
      .filter((r) => r.leave_type && (cumulative || idOf(r.leave_type) === idOf(form.leave_type)))
      .filter((r) => ["APPROVED", "PAID"].includes(upper(r.state)) && (r.create_time ?? "") >= yearStart)
      .reduce((n, r) => n + (r.days || 0), 0);
  }, [empEncashments, form.employee, form.leave_type, yearStart, cumulative]);
  const retained = selectedType?.min_balance_retained_days ?? 0;
  const yearCap = cumulative ? caps?.cumulativeCapDays ?? null : selectedType?.encashment_cap_days_per_year ?? null;
  // Until the policy is known, say nothing about the cap rather than mis-state it - the posture
  // lib/leaveForecast.ts takes for the same choice - and let the server's `failedPrecondition` be the
  // authority, rather than blocking on a number known to be for the wrong policy.
  const capLeft = caps && yearCap != null ? Math.max(0, yearCap - encashedThisYear) : null;
  // An unknown balance drops out of the ceiling the same way an unknown cap does: whatever is still known
  // bounds the form, and if nothing is known the server's `failedPrecondition` decides. Blocking on a balance
  // read as 0 because the row was not loaded refuses a payout the server would have made.
  const maxEncashable =
    selectedBalance == null
      ? capLeft
      : Math.max(0, Math.min(selectedBalance - retained, capLeft ?? Infinity));

  // Most recent known day-rate for the selected employee (from any prior encashment) - estimate only;
  // the server computes the real rate from current salary.
  const lastRate = useMemo(() => {
    if (!form.employee) return null;
    const prior = empEncashments
      .filter((r) => r.rate_per_day != null)
      .sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
    return prior[0]?.rate_per_day ?? null;
  }, [empEncashments, form.employee]);

  const daysNum = Number(form.days);
  const canSubmit = !!form.employee && !!form.leave_type && !!form.days && daysNum > 0 && (maxEncashable == null || daysNum <= maxEncashable);
  const isPending = (r: LeaveEncashment) => upper(r.state) === "PENDING";
  const pending = useMemo(() => rows.filter(isPending), [rows]);
  const decided = useMemo(() => rows.filter((r) => !isPending(r)), [rows]);
  const approvedUnpaid = rows.filter((r) => upper(r.state) === "APPROVED");
  const paidThisYear = rows.filter((r) => upper(r.state) === "PAID" && (r.paid_time ?? "") >= yearStart);

  async function submit() {
    await create<LeaveEncashment>(COL, {
      employee: `employees/${idOf(form.employee)}`,
      leave_type: `leave-types/${idOf(form.leave_type)}`,
      days: Number(form.days),
    });
    toast({ title: "Encashment requested", variant: "success" });
    setForm(EMPTY);
    reload();
  }

  async function action(r: LeaveEncashment, verb: "approve" | "reject" | "cancel") {
    const past = { approve: "approved", reject: "rejected", cancel: "cancelled" }[verb];
    if (!(await confirmDecision(confirm, verb, `${empName(r.employee)}'s encashment of ${r.days} day${r.days === 1 ? "" : "s"}`))) return;
    try {
      await invoke(`${COL}/${idOf(r.path)}`, verb, r.etag);
      toast({ title: `Encashment ${past}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: `Couldn't ${verb} encashment`, description: (e as Error).message, variant: "destructive" });
    }
  }

  // ---- columns -------------------------------------------------------------
  const empCol: Column<LeaveEncashment> = { id: "employee", header: "Employee", filter: "select", groupBy: true, accessor: (r) => empName(r.employee), cell: (r) => <span className="font-medium">{empName(r.employee)}</span> };
  const baseCols: Column<LeaveEncashment>[] = [
    { id: "leave_type", header: "Leave type", filter: "select", groupBy: true, accessor: (r) => ltName(r.leave_type) },
    { id: "days", header: "Days", align: "right", filter: "number", aggregate: "sum", accessor: (r) => r.days, cell: (r) => <span className="tabular-nums">{r.days}</span> },
    { id: "rate", header: "Rate/day", align: "right", defaultHidden: true, filter: "number", formatTotal: (n) => money(n), accessor: (r) => r.rate_per_day ?? 0, cell: (r) => <span className="tabular-nums">{r.rate_per_day != null ? money(r.rate_per_day) : "-"}</span> },
    // The payout this queue commits the company to, under the column.
    { id: "amount", header: "Amount", align: "right", filter: "number", aggregate: "sum", formatTotal: (n) => money(n), accessor: (r) => r.amount ?? 0, cell: (r) => <span className="tabular-nums">{r.amount != null ? money(r.amount) : "-"}</span> },
    { id: "state", header: "Status", filter: "select", groupBy: true, accessor: (r) => r.state, cell: (r) => <StatusBadge state={r.state} /> },
    {
      // Days cashed out against what the type accrues in a year. The point of an encashment policy is that
      // leave is rest first and money second, and "eleven days" means nothing until you know whether the
      // type grants twelve or thirty.
      id: "of_accrual", header: "Of a year", align: "right", defaultHidden: true, filter: "number",
      formatTotal: (n) => `${Math.round(n)}%`,
      accessor: (r) => {
        const accrual = ltAccrual(r.leave_type);
        return accrual ? Math.round((r.days / accrual) * 100) : null;
      },
      bar: (r) => { const accrual = ltAccrual(r.leave_type); return accrual ? r.days / accrual : null; },
      cell: (r) => {
        const accrual = ltAccrual(r.leave_type);
        return accrual ? <span className="tabular-nums">{Math.round((r.days / accrual) * 100)}%</span> : <span className="text-muted-foreground">-</span>;
      },
    },
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
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New encashment</Button>
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
      emptyAction={newBtn}
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

      {/* Three tiles, two across a phone: the third stretches to fill its own row rather than sitting next to
          a hole. */}
      {/* The tiles are money folded over the rows this page holds, which is one server page of an org-wide
          collection - so say so when there are more, the way the tables below do through DataTable. */}
      {rows.length > 0 && <TruncationNotice collection={COL} what="encashments" className="mb-4" />}
      {rows.length > 0 && (
        <StatRow caps={[2, 3]} gap={{ base: "0.75rem" }} className="mb-6">
          <Stat label="Pending" value={money(sum(pending))} sub={`${pending.length} request${pending.length === 1 ? "" : "s"}`} />
          <Stat label="Approved (awaiting payout)" value={money(sum(approvedUnpaid))} sub={`${approvedUnpaid.length} request${approvedUnpaid.length === 1 ? "" : "s"}`} />
          <Stat label="Paid this year" value={money(sum(paidThisYear))} sub={`${paidThisYear.length} request${paidThisYear.length === 1 ? "" : "s"}`} accent />
        </StatRow>
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

      <WriteDialog
        open={open}
        onClose={() => { setOpen(false); setForm(EMPTY); }}
        title="New leave encashment"
        description="Trades accrued leave days for cash on a payroll run. The days leave the balance when the request is approved."
        collection={COL}
        guardLabel="encashment request"
        form={form}
        submitLabel="Request encashment"
        canSubmit={canSubmit}
        whyNot={
          !form.employee ? "Pick whose leave is being encashed." : !form.leave_type ? "Pick which leave type to encash." : !form.days || daysNum <= 0 ? "Enter how many days to encash." : maxEncashable != null && daysNum > maxEncashable ? `At most ${maxEncashable} day${maxEncashable === 1 ? "" : "s"} can be encashed right now.` : undefined
        }
        onSubmit={submit}
      >
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
            htmlFor="encashment-days"
            hint={
              // Says only what is known. With no balance row for this pair the balance line is left out rather
              // than printed as "0 days" - see `balanceFor`.
              (() => {
                const parts = [
                  ...(selectedBalance != null ? [`Balance: ${selectedBalance} day${selectedBalance === 1 ? "" : "s"}`] : []),
                  ...(selectedBalance != null && retained > 0 ? [`policy keeps ${retained} unencashed`] : []),
                  ...(capLeft != null ? [`${capLeft} of the ${yearCap}/year ${cumulative ? "org-wide cap" : "cap"} left`] : []),
                  ...(maxEncashable != null && (selectedBalance == null || retained > 0 || capLeft != null) ? [`max now: ${maxEncashable}`] : []),
                ];
                return parts.length ? parts.join(" · ") : undefined;
              })()
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
            <div className="flex items-center gap-2">
              <Input id="encashment-days" type="number" min={0} step="0.5" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
              {/* "Cash out everything I'm allowed to" is the request people actually make; making them work
                  the retained minimum and the annual cap out by hand invites a rejected request. */}
              {maxEncashable != null && maxEncashable > 0 && (
                <Button type="button" variant="outline" className="shrink-0" onClick={() => setForm({ ...form, days: String(maxEncashable) })}>
                  Max {maxEncashable}
                </Button>
              )}
            </div>
          </Field>
          {/* What the request turns into: cash out, days left behind. The estimate is explicitly an estimate -
              the server prices the days off the employee's current salary when the request lands. */}
          <div className={cn("rounded-lg border p-3", canSubmit ? "bg-muted/40" : "")}>
            {lastRate != null && canSubmit ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm text-muted-foreground">
                  Estimated payout
                  <span className="ml-2 text-xl font-semibold tabular-nums text-foreground">{money(daysNum * lastRate)}</span>
                </span>
                {selectedBalance != null && (
                  <span className="text-sm text-muted-foreground tabular-nums">{Math.round((selectedBalance - daysNum) * 2) / 2} days left after this</span>
                )}
                <span className="w-full text-xs text-muted-foreground">
                  At the last known rate of {money(lastRate)}/day. The final amount uses the employee's current salary.
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">The payout amount is computed from the employee's daily salary rate when the request is created.</p>
            )}
          </div>
      </WriteDialog>
    </div>
  );
}

function Stat({ label, value, sub, accent, style }: { label: string; value: string; sub: string; accent?: boolean; style?: CSSProperties }) {
  return (
    <Card className="p-4" style={style}>
      {/* These carry money, which is the longest thing a tile like this holds: smaller and truncating on a
          phone, where the tile is half the screen wide, with the full figure on tap. */}
      <div className="truncate text-sm text-muted-foreground" title={label}>{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl ${accent ? "text-primary" : ""}`} title={value}>{value}</div>
      <div className="truncate text-xs text-muted-foreground" title={sub}>{sub}</div>
    </Card>
  );
}
