import { useMemo, useState } from "react";
import { Plus, Wallet, TrendingUp, CircleSlash, PiggyBank, Repeat } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import type { Department, PayrollBudget } from "@/types";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { PeriodPicker } from "@/components/common/PeriodPicker";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { periodRange, periodLabel, keyFor, nextKey, phaseOf, paceOf, type PeriodType, type Phase } from "@/lib/budgetPeriod";

/**
 * Salary caps, and what payroll actually paid against them.
 *
 * Salary is the largest line in the company and was the only one with no budget surface: the expenses page
 * could say a cost centre was over on travel while its pay bill went unwatched. This is the same page for the
 * other half of the money, deliberately in the same vocabulary - scope, period, cap, spend, headroom.
 *
 * WHAT SPEND MEANS HERE is the one thing worth reading twice, and the server owns it (services/payrollBudgets):
 * only APPROVED and PUBLISHED runs count, and each line is charged to the department stamped on it when the
 * run was built, not to the employee's department today. So a transfer in March cannot rewrite what February
 * consumed, and a draft somebody is mid-way through rebuilding does not move anybody's budget while they work.
 */
export function PayrollBudgets() {
  // Phase scoping is SERVER-side: a monthly cap per cost centre is hundreds of rows a year and a page holds
  // 100, so filtering the loaded array would answer with page one while reading as the whole collection. The
  // same read carries `summary` over the whole filtered set.
  const [phase, setPhase] = useState<Phase>("current");
  const params = useMemo(() => ({ ...(phase === "all" ? {} : { period: phase }) }), [phase]);
  const { rows, state, error, reload, hasMore, loadMore, meta } = useCollection<PayrollBudget>("payroll-budgets", { params });
  const summary = meta?.summary as { count: number; amount: number; spent: number; over: number } | undefined;
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const money = useMoney();
  const sd = useSoftDelete("payroll-budgets", "budget", reload);
  const writable = usePermission("payroll-budgets.write");
  const canPurge = usePermission("payroll-budgets.admin");
  const now = Date.now();

  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Unknown department" : "Org-wide");
  }, [departments]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayrollBudget | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ department: "", period_type: "monthly" as PeriodType, period_key: keyFor("monthly", new Date()), amount: "", recurring: false });
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "budget" });

  const amountNum = Number(form.amount);
  // A second cap on the same scope and period would make "the budget" ambiguous, and neither figure would be
  // wrong - so it is refused at the form rather than explained afterwards. Checked against the LOADED rows,
  // which is why the message says what it saw: a scope past the page cannot be checked here, and the server
  // is the one that decides.
  const duplicate = useMemo(
    () => rows.some((b) => !b.delete_time && b.path !== editing?.path
      && (b.department ?? "") === form.department && b.period_type === form.period_type && b.period_key === form.period_key),
    [rows, editing, form],
  );
  const valid = amountNum > 0 && !!form.period_key && !duplicate;

  function openCreate() {
    setEditing(null);
    setErr(null);
    setForm({ department: "", period_type: "monthly", period_key: keyFor("monthly", new Date()), amount: "", recurring: false });
    setOpen(true);
  }
  function openEdit(b: PayrollBudget) {
    setEditing(b);
    setErr(null);
    setForm({
      department: b.department ?? "",
      period_type: b.period_type as PeriodType,
      period_key: b.period_key,
      amount: String(b.amount),
      recurring: !!b.recurring,
    });
    setOpen(true);
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        department: form.department || null,
        period_type: form.period_type,
        period_key: form.period_key,
        amount: amountNum,
        recurring: form.recurring,
      };
      if (editing) await patch<PayrollBudget>(editing.path, body, editing.etag);
      else await create<PayrollBudget>("payroll-budgets", body);
      setOpen(false);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Totals come from the SERVER, over the whole filtered set. The fallbacks sum the loaded rows only, which is
  // page one - used when an older response carries no summary, and never in place of one.
  const totals = useMemo(() => {
    const live = rows.filter((b) => !b.delete_time);
    const amount = summary?.amount ?? live.reduce((n, b) => n + (b.amount || 0), 0);
    const spent = summary?.spent ?? live.reduce((n, b) => n + (b.spent ?? 0), 0);
    return {
      count: summary?.count ?? live.length,
      amount,
      spent,
      remaining: amount - spent,
      pct: amount > 0 ? Math.round((spent / amount) * 100) : 0,
      over: summary?.over ?? 0,
    };
  }, [summary, rows]);

  const columns: Column<PayrollBudget>[] = [
    { id: "scope", header: "Cost centre", mobilePriority: 1, filter: "select", groupBy: true,
      accessor: (b) => deptName(b.department), cell: (b) => <span className="font-medium">{deptName(b.department)}</span> },
    { id: "period", header: "Period", mobilePriority: 2, accessor: (b) => periodRange(b.period_type, b.period_key)?.start ?? 0, cell: (b) => {
      const p = paceOf(b, now);
      const ph = phaseOf(b, now);
      return (
        <div className="min-w-0 whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {periodLabel(b.period_type, b.period_key)}
            <span className="text-xs text-muted-foreground">{b.period_type}</span>
            {b.recurring && (
              <TooltipProvider delayDuration={150}>
                {/* tapToOpen: an icon that stands for a sentence, and does nothing when tapped otherwise. */}
                <Tooltip tapToOpen>
                  <TooltipTrigger asChild><span><Repeat className="h-3.5 w-3.5 text-muted-foreground" /></span></TooltipTrigger>
                  <TooltipContent className="font-normal">Repeats: the next period opens automatically at this cap</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          {ph === "current" && p && <div className="text-xs text-muted-foreground">day {p.day} of {p.days}</div>}
          {ph === "upcoming" && <div className="text-xs text-muted-foreground">not started</div>}
        </div>
      );
    } },
    { id: "amount", header: "Budget", align: "right", mobilePriority: 3, filter: "number", accessor: (b) => b.amount, aggregate: "sum", formatTotal: money,
      cell: (b) => <span className="tabular-nums">{money(b.amount)}</span> },
    { id: "spent", header: "Paid", align: "right", filter: "number", accessor: (b) => b.spent ?? 0, aggregate: "sum", formatTotal: money,
      cell: (b) => <span className="tabular-nums">{money(b.spent ?? 0)}</span> },
    // A negative remaining is an overspend, so "< 0" in this column is the overspend list.
    { id: "remaining", header: "Remaining", align: "right", filter: "number", accessor: (b) => b.remaining ?? b.amount - (b.spent ?? 0), aggregate: "sum", formatTotal: money, cell: (b) => {
      const left = b.remaining ?? b.amount - (b.spent ?? 0);
      return <span className={`tabular-nums ${left < 0 ? "text-destructive" : ""}`}>{money(left)}</span>;
    } },
    { id: "util", header: "Utilization", mobilePriority: 4, accessor: (b) => b.utilization ?? 0, filter: "none",
      cell: (b) => <PayBar b={b} now={now} money={money} /> },
    ...metaColumns<PayrollBudget>(),
    { id: "actions", header: "", sortable: false, filter: "none", align: "right", cell: (b) => (
      <SoftDeleteRowActions row={b} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} />
    ) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={phase} onValueChange={(v) => setPhase(v as Phase)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current periods</SelectItem>
            <SelectItem value="upcoming">Upcoming</SelectItem>
            <SelectItem value="past">Past</SelectItem>
            <SelectItem value="all">All periods</SelectItem>
          </SelectContent>
        </Select>
        <AccessAction collection="payroll-budgets" create>
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New budget</Button>
        </AccessAction>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={PiggyBank}
            title="No payroll budgets"
            description="Set a salary cap for a cost centre and a period, and each published run reports against it."
            action={writable ? <Button onClick={openCreate}><Plus className="h-4 w-4" /> New budget</Button> : undefined}
          />
        ) : (
          <>
            <SummaryStrip
              items={[
                { label: "Budgeted", value: money(totals.amount), icon: Wallet, hint: `${totals.count} ${totals.count === 1 ? "cap" : "caps"}` },
                { label: "Paid", value: money(totals.spent), icon: TrendingUp, tone: totals.pct >= 100 ? "destructive" : "default", hint: `${totals.pct}% of budgeted` },
                { label: "Remaining", value: money(totals.remaining), tone: totals.remaining < 0 ? "destructive" : "success", hint: "headroom across the scope" },
                { label: "Over budget", value: totals.over, icon: CircleSlash, tone: totals.over > 0 ? "destructive" : "muted", hint: totals.over > 0 ? "past the cap" : "all within cap" },
              ]}
            />
            {/* The strip's figures are the server's and stay whole; only the rows are paged, which the table
                itself admits and offers to extend. */}
            <DataTable
              tableId="payroll-budgets"
              columns={columns}
              rows={rows}
              hasMore={hasMore}
              onLoadMore={loadMore}
              getRowId={(r) => r.path}
              emptyTitle="No budgets match"
              accessCollection="payroll-budgets"
              accessTargetOf={(r) => ({ objectPath: r.path, label: `Payroll budget (${periodLabel(r.period_type, r.period_key)})`, can: r.access?.can })}
            />
          </>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => void submit()}>
          <AccessScope collection="payroll-budgets" objectPath={editing?.path}>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit payroll budget" : "New payroll budget"}</DialogTitle>
              <DialogDescription>
                A salary cap for one cost centre and one period. Payroll isn't blocked when it's exceeded - the budget reports against what approved and published runs actually paid.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <FormError error={err} />
              <div className="grid gap-4">
                <Field label="Cost centre" hint="Leave org-wide for a cap on the whole pay bill">
                  <Select value={form.department || "org"} onValueChange={(v) => setForm({ ...form, department: v === "org" ? "" : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="org">Org-wide</SelectItem>
                      {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <FieldRow>
                  <Field label="Period type">
                    <Select
                      value={form.period_type}
                      onValueChange={(v) => {
                        const type = v as PeriodType;
                        // Keep the same point in time while changing granularity: Jul 2026 becomes Q3 2026,
                        // not a blank field the user has to retype.
                        const at = periodRange(form.period_type, form.period_key)?.start;
                        setForm({ ...form, period_type: type, period_key: keyFor(type, at != null ? new Date(at) : new Date()) });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                        <SelectItem value="yearly">Yearly</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Period" error={duplicate ? "A budget already caps this cost centre for that period." : undefined}>
                    <PeriodPicker type={form.period_type} value={form.period_key} onChange={(period_key) => setForm({ ...form, period_key })} />
                  </Field>
                </FieldRow>
                <Field
                  label="Budget amount"
                  hint={editing && amountNum > 0 ? `Paid so far ${money(editing.spent ?? 0)} - ${Math.round(((editing.spent ?? 0) / amountNum) * 100)}% of this cap` : undefined}
                  error={form.amount !== "" && amountNum <= 0 ? "Enter an amount greater than 0." : undefined}
                >
                  <MoneyInput
                    value={form.amount}
                    onChange={(v) => setForm({ ...form, amount: v })}
                    min={0}
                    suffix={form.period_type === "monthly" ? "a month" : form.period_type === "quarterly" ? "a quarter" : "a year"}
                  />
                </Field>
                <label className="flex items-start gap-2.5 rounded-lg border p-3 text-sm">
                  <Checkbox checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: !!v })} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Repeat every period</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      When this period closes, the same cap opens for the next one automatically, at this amount. Unspent budget is never carried over.
                      {form.period_key && ` Next: ${periodLabel(form.period_type, nextKey(form.period_type, form.period_key) ?? "")}.`}
                    </span>
                  </span>
                </label>
                {/* Who moved a cap, and when: a salary budget that grew mid-period is a question somebody
                    eventually asks. */}
                {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
              <Button onClick={submit} loading={busy} disabled={!valid}>{editing ? "Save changes" : "Create"}</Button>
            </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Spend as a proportion of the cap, with a tick for where today sits in the period. A bar without the tick can
// only be read after the fact; with it, "60% at the third of the month" is obvious. No striped segment here -
// unlike an expense cap there is no queue between committed and paid, so the bar has only the one band.
function PayBar({ b, now, money }: { b: PayrollBudget; now: number; money: (n: number) => string }) {
  const pct = Math.round((b.utilization ?? 0) * 100);
  const over = pct >= 100;
  const p = paceOf(b, now);
  const showTick = p != null && p.elapsed > 0 && p.elapsed < 1;
  const bar = (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of budget used`}>
        <div className={over ? "h-full bg-destructive" : pct >= 90 ? "h-full bg-warning" : "h-full bg-primary"} style={{ width: `${Math.min(pct, 100)}%` }} />
        {showTick && <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${p!.elapsed * 100}%` }} />}
      </div>
      <span className={`text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`}>{pct}%</span>
    </div>
  );
  return (
    <TooltipProvider delayDuration={150}>
      {/* tapToOpen: the bar shows the ratio, and this is where the numbers behind it live. */}
      <Tooltip tapToOpen>
        <TooltipTrigger asChild><span>{bar}</span></TooltipTrigger>
        <TooltipContent className="font-normal leading-snug">
          <div>Paid {money(b.spent ?? 0)} of {money(b.amount)} ({pct}%)</div>
          {p && p.elapsed > 0 && p.elapsed < 1 && <div>Day {p.day} of {p.days} - {Math.round(p.elapsed * 100)}% of the period elapsed</div>}
          {p?.projectedAmount != null && <div>At this pace: {money(p.projectedAmount)}{p.projected != null && ` (${Math.round(p.projected * 100)}%)`}</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
