import { useMemo, useRef, useState } from "react";
import { CalendarRange, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { isWeekend, weekdayName, weekendLabel } from "@/lib/tableDerive";
import { countBy } from "@/lib/tableSignals";
import type { Me, PayPeriod, PayrollRun } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { AccessScope } from "@/components/access/AccessScope";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type Form = { name: string; start: string; end: string; pay: string; cutoff: string };
const EMPTY: Form = { name: "", start: "", end: "", pay: "", cutoff: "" };

export default function PayPeriods({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<PayPeriod>("pay-periods", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("pay-periods", "pay period", reload);
  const lc = useLifecycle("pay-periods", "pay period", reload);
  const writable = usePermission("pay-periods.write");
  const canPurge = usePermission("pay-periods.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayPeriod | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  // Periods are set up in runs of twelve, so the form offers to stay open rather than making someone reopen it
  // eleven times. A checkbox, not a third footer button: three stacked buttons on a phone is worse than a tick.
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "pay period" });
  const nameRef = useRef<HTMLInputElement>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setErr(null);
    setOpen(true);
  }
  function openEdit(pp: PayPeriod) {
    setEditing(pp);
    setForm({ name: pp.display_name, start: pp.period_start, end: pp.period_end, pay: pp.pay_date, cutoff: pp.input_cutoff_on ?? "" });
    setErr(null);
    setOpen(true);
  }

  // A period that overlaps a live one double-counts everyone in it, and the clash only surfaces later as two
  // runs paying the same days. Cheaper to say so while the dates are still being typed.
  const clash = rows.find(
    (pp) =>
      !pp.delete_time &&
      pp.path !== editing?.path &&
      form.start &&
      form.end &&
      pp.period_start <= form.end &&
      pp.period_end >= form.start,
  );

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      // null, not omitted, when the box is empty: clearing an adopted cutoff is a real edit, and leaving the
      // field out would be read as "unchanged" and silently keep the old date.
      const body = { display_name: form.name, period_start: form.start, period_end: form.end, pay_date: form.pay, input_cutoff_on: form.cutoff || null };
      if (editing) {
        await patch("pay-periods/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay period updated", variant: "success" });
      } else {
        await create("pay-periods", body);
        toast({ title: "Pay period created", variant: "success" });
      }
      // The just-cleared Name loses focus the instant its own Create button disables with it - see
      // ReimbursementCategories' identical fix - so a run of twelve periods drops the reader onto the panel
      // between fields, not back onto the one they are about to retype.
      if (again && !editing) { setForm(EMPTY); guard.markSaved(EMPTY); nameRef.current?.focus(); }
      else { guard.markSaved(); setOpen(false); }
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // How many payroll runs each period carries. Read only where the caller can see runs at all - an employee
  // with no payroll grant gets the same period list without a column that would always read zero.
  const canRuns = usePermission("payroll-runs.read");
  const { rows: runs } = useCollection<PayrollRun>("payroll-runs", { enabled: canRuns });
  const runCounts = useMemo(() => countBy(runs, (r) => (r.pay_period ? idOf(r.pay_period) : null)), [runs]);

  // The two things a payroll calendar is checked for, neither of which a list of dates can show.
  const periodInsights = (pps: PayPeriod[]): TableInsight[] => {
    const out: TableInsight[] = [];
    const today = todayStr();
    // Only periods that have already ENDED: a period still running has nothing to pay yet, and counting it
    // would make the chip permanent furniture.
    const unrun = canRuns
      ? pps.filter((pp) => !pp.delete_time && pp.period_end && pp.period_end < today && (runCounts.get(idOf(pp.path)) ?? 0) === 0)
      : [];
    if (unrun.length > 0) {
      out.push({
        id: "no-run",
        label: `${unrun.length} ended with no payroll run`,
        tone: "destructive",
        hint: "The period is over and nothing has been run against it.",
        filters: { runs: "=0", end: `..${today}` },
        sort: "end.asc",
      });
    }
    const weekend = pps.filter((pp) => !pp.delete_time && pp.pay_date && pp.pay_date >= today && isWeekend(pp.pay_date));
    if (weekend.length > 0) {
      out.push({
        id: "weekend-pay",
        label: `${weekend.length} pay on a weekend`,
        tone: "warning",
        hint: "Banks do not settle then, so the money lands the next working day. Move the date or expect the delay.",
        filters: { pay_day: "Weekend", pay: `${today}..` },
        sort: "pay.asc",
      });
    }
    return out;
  };

  const columns: Column<PayPeriod>[] = [
    { id: "label", header: "Label", accessor: (pp) => pp.display_name, cell: (pp) => <span className="font-medium">{pp.display_name}</span> },
    { id: "start", header: "Period start", filter: "date", accessor: (pp) => pp.period_start, cell: (pp) => formatDate(pp.period_start) },
    { id: "end", header: "Period end", filter: "date", accessor: (pp) => pp.period_end, cell: (pp) => formatDate(pp.period_end) },
    // The calendar this page exists for: "which run pays out this month" is one click on the date filter.
    { id: "pay", header: "Pay date", filter: "date", dateHint: "future", accessor: (pp) => pp.pay_date, cell: (pp) => formatDate(pp.pay_date) },
    {
      // Banks do not settle on a Saturday, so a pay date that lands on one pays late whatever the run says.
      // It is fixable weeks ahead and invisible until somebody is not paid, which is exactly the kind of
      // thing a column should say out loud.
      id: "pay_day", header: "Pay day", filter: "select", groupBy: true, defaultHidden: true,
      accessor: (pp) => weekendLabel(pp.pay_date),
      cell: (pp) => (isWeekend(pp.pay_date)
        ? <span className="text-warning">{weekdayName(pp.pay_date)}</span>
        : <span className="text-muted-foreground">{weekdayName(pp.pay_date) || "-"}</span>),
    },
    {
      // Whether payroll has actually been run for this period. The list of periods and the list of runs were
      // two tabs that never referred to each other, and a period nobody ran is the quietest way to miss a
      // payroll: nothing on this page was wrong, there was simply nothing there.
      id: "runs", header: "Runs", align: "right", filter: "number",
      accessor: (pp) => runCounts.get(idOf(pp.path)) ?? 0,
      cell: (pp) => {
        const n = runCounts.get(idOf(pp.path)) ?? 0;
        return n === 0
          ? <span className="text-muted-foreground">none</span>
          : <span className="tabular-nums">{n}</span>;
      },
    },
    stateColumn<PayPeriod>(),
    ...metaColumns<PayPeriod>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (pp) => <SoftDeleteRowActions row={pp} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="pay-periods" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New pay period</Button>
    </AccessAction>
  );

  return (
    <div>
      {/* Standalone: own page header. Embedded (Payroll Runs tab): the create button rides the table toolbar. */}
      {!embedded && <PageHeader title="Pay Periods" description="The cycles payroll runs against." actions={createBtn} />}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No pay periods"
            description="Define monthly or bi-weekly periods to run payroll against."
            action={createBtn}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="pay-periods"
            rows={rows}
            insights={periodInsights}
            getRowId={(pp) => pp.path}
            rowClassName={(pp) => (pp.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No pay periods match"
            toolbar={embedded ? createBtn : undefined}
            accessCollection="pay-periods"
            accessTargetOf={(pp) => ({ objectPath: pp.path, label: pp.display_name, can: pp.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim() && form.start && form.end && form.pay && form.end >= form.start) void submit(); }}>
          <AccessScope collection="pay-periods" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay period" : "New pay period"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Runs already built against this period keep their numbers until they're rebuilt."
                : "The cycle a payroll run is built against: the days it pays for, and the date the money leaves."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <Field label="Label">
            <Input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. May 2026" autoFocus />
          </Field>
          <FieldRow>
            <Field label="Period start">
              <Input type="date" value={form.start} onChange={(e) => {
                const start = e.target.value;
                // Monthly is the overwhelming default - picking a start prefills month-end, pay date and label,
                // so the common case is one field. Anything prefilled stays editable.
                if (start && !form.end && !form.pay && !form.name.trim()) {
                  // Day 0 of the next month is the last of this one, in UTC so the answer is the date rather
                  // than the machine's evening: built from local parts, a month-end prefilled one day early
                  // for anyone east of UTC, and a pay period is not a thing to be a day out by.
                  const endYmd = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10);
                  const monthName = new Date(`${start.slice(0, 8)}01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
                  // The cutoff is NOT prefilled. End and pay date are arithmetic on the start; a cutoff is a
                  // policy the org either has or has not adopted, and guessing one would put a deadline on the
                  // calendar that nobody chose.
                  setForm({ name: monthName, start, end: endYmd, pay: endYmd, cutoff: "" });
                } else {
                  setForm({ ...form, start });
                }
              }} />
            </Field>
            {/* Eager: Create goes disabled on this the moment the date is inverted, so holding the reason back
                until the field is left would leave a dead button with nothing saying why. */}
            <Field label="Period end" eager error={form.start && form.end && form.end < form.start ? "End is before the start." : undefined}>
              <Input type="date" value={form.end} min={form.start || undefined} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </Field>
          </FieldRow>
          {/* Paying before the period closes is legitimate (many payrolls pay on the 25th for a month ending on
              the 31st) but it means the last days are paid on estimate, so it is said rather than blocked. */}
          <Field
            label="Pay date"
            hint={form.pay && form.end && form.pay < form.end ? "Falls inside the period - the last days are paid before they're worked." : "The day the money reaches employees."}
          >
            <Input type="date" value={form.pay} onChange={(e) => setForm({ ...form, pay: e.target.value })} />
          </Field>
          {/* Optional, and the hint says what it does rather than what it enforces - nothing is refused after
              this date. It is the day the org tells everyone upstream of payroll to have their claims,
              overtime and corrections in by, so the run is built against figures that have stopped moving. */}
          <Field
            label="Inputs close (optional)"
            error={form.cutoff && form.start && form.cutoff < form.start ? "Before the period starts - nothing to freeze yet."
              : form.cutoff && form.pay && form.cutoff > form.pay ? "After the pay date - the inputs are already paid by then." : undefined}
            hint="The day claims and corrections should be in by. Shown on the run's timeline; late writes are still accepted and flag the run stale."
          >
            <Input type="date" value={form.cutoff} min={form.start || undefined} max={form.pay || undefined} onChange={(e) => setForm({ ...form, cutoff: e.target.value })} />
          </Field>
          {clash && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              Overlaps <span className="font-medium">{clash.display_name}</span> ({formatDate(clash.period_start)} - {formatDate(clash.period_end)}). Two periods covering the same days can pay those days twice.
            </p>
          )}
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
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !form.start || !form.end || !form.pay || form.end < form.start}>
              {editing ? "Save changes" : again ? "Create & add another" : "Create"}
            </Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
