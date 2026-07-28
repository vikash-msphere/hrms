import { useState } from "react";
import { CalendarRange, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import type { Me, PayPeriod } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type Form = { name: string; start: string; end: string; pay: string };
const EMPTY: Form = { name: "", start: "", end: "", pay: "" };

export default function PayPeriods({ embedded }: { me?: Me; embedded?: boolean }) {
  const { rows, state, error, reload } = useCollection<PayPeriod>("pay-periods", { showDeleted: true });
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("pay-periods", "pay period", reload);
  const lc = useLifecycle("pay-periods", "pay period", reload);
  const writable = usePermission("pay-periods.write");
  const canPurge = usePermission("pay-periods.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayPeriod | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  function openEdit(pp: PayPeriod) {
    setEditing(pp);
    setForm({ name: pp.display_name, start: pp.period_start, end: pp.period_end, pay: pp.pay_date });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const body = { display_name: form.name, period_start: form.start, period_end: form.end, pay_date: form.pay };
      if (editing) {
        await patch("pay-periods/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay period updated", variant: "success" });
      } else {
        await create("pay-periods", body);
        toast({ title: "Pay period created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save pay period", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<PayPeriod>[] = [
    { id: "label", header: "Label", accessor: (pp) => pp.display_name, cell: (pp) => <span className="font-medium">{pp.display_name}</span> },
    { id: "start", header: "Period start", accessor: (pp) => pp.period_start, cell: (pp) => formatDate(pp.period_start) },
    { id: "end", header: "Period end", accessor: (pp) => pp.period_end, cell: (pp) => formatDate(pp.period_end) },
    { id: "pay", header: "Pay date", accessor: (pp) => pp.pay_date, cell: (pp) => formatDate(pp.pay_date) },
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
            getRowId={(pp) => pp.path}
            rowClassName={(pp) => (pp.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No pay periods match"
            toolbar={embedded ? createBtn : undefined}
            accessCollection="pay-periods"
            accessTargetOf={(pp) => ({ objectPath: pp.path, label: pp.display_name, can: pp.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim() && form.start && form.end && form.pay && form.end >= form.start) void submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay period" : "New pay period"}</DialogTitle>
          </DialogHeader>
          <Field label="Label">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. May 2026" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Period start">
              <Input type="date" value={form.start} onChange={(e) => {
                const start = e.target.value;
                // Monthly is the overwhelming default - picking a start prefills month-end, pay date and label,
                // so the common case is one field. Anything prefilled stays editable.
                if (start && !form.end && !form.pay && !form.name.trim()) {
                  const d = new Date(start + "T00:00:00");
                  const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
                  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
                  setForm({ name: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), start, end: iso(endD), pay: iso(endD) });
                } else {
                  setForm({ ...form, start });
                }
              }} />
            </Field>
            <Field label="Period end" error={form.start && form.end && form.end < form.start ? "End is before the start." : undefined}>
              <Input type="date" value={form.end} min={form.start || undefined} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </Field>
          </div>
          <Field label="Pay date">
            <Input type="date" value={form.pay} onChange={(e) => setForm({ ...form, pay: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !form.start || !form.end || !form.pay || form.end < form.start}>
              {editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
