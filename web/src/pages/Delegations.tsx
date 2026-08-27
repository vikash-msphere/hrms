import { useMemo, useState } from "react";
import { Plus, Trash2, ArrowRight } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf, personName } from "@/lib/utils";
import type { ApprovalDelegation, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { DataState } from "@/components/common/DataState";
import { metaColumns } from "@/components/common/metaColumns";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

const COL = "approval-delegations";
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const EMPTY = { delegate: "", from_date: todayStr(), to_date: todayStr(), reason: "" };

export default function Delegations({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<ApprovalDelegation>(COL);
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const canWrite = usePermission(`${COL}.write`);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ApprovalDelegation | null>(null);
  const [form, setForm] = useState(EMPTY);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string, unknown?: string) => personName(employees, p, unknown);

  const today = todayStr();
  const activeCount = useMemo(() => rows.filter((r) => r.from_date <= today && r.to_date >= today).length, [rows, today]);

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(r: ApprovalDelegation) {
    setEditing(r);
    setForm({ delegate: r.delegate ? `employees/${idOf(r.delegate)}` : "", from_date: r.from_date, to_date: r.to_date, reason: r.reason ?? "" });
    setOpen(true);
  }

  // Validation is inline (reddened fields + a disabled button), not a toast fired after the click: a form that
  // tells you what is wrong only once you have committed is a form that wastes the click.
  const rangeInverted = !!form.from_date && !!form.to_date && form.to_date < form.from_date;
  const canSave = !!form.delegate && !!form.from_date && !!form.to_date && !rangeInverted;
  const coverDays = canSave ? Math.round((Date.parse(form.to_date + "T00:00:00Z") - Date.parse(form.from_date + "T00:00:00Z")) / 86400000) + 1 : 0;
  // Two cover arrangements over the same day means two people get the same pending decision. Legal, rarely
  // intended, so say it before saving rather than leaving it to be discovered in the inbox.
  const overlapping = useMemo(
    () => (canSave ? rows.filter((r) => r.path !== editing?.path && r.from_date <= form.to_date && r.to_date >= form.from_date) : []),
    [rows, editing, form.from_date, form.to_date, canSave],
  );

  async function submit() {
    const body = { delegate: form.delegate, from_date: form.from_date, to_date: form.to_date, reason: form.reason || null };
    if (editing) await patch(editing.path, body, editing.etag);
    else await create(COL, body);
    toast({ title: editing ? "Delegation updated" : "Delegation added" });
    reload();
  }

  // Removing a live delegation silently re-routes approvals back to someone who may be away - worth a beat.
  async function del(r: ApprovalDelegation) {
    const ok = await confirm({
      title: "Remove this delegation?",
      description: `Approvals stop going to ${empName(r.delegate)} and return to ${empName(r.delegator)} from now on.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try { await remove(r.path, r.etag); reload(); toast({ title: "Delegation removed" }); }
    catch (e) { toast({ title: "Couldn't remove", description: String((e as Error).message ?? e), variant: "destructive" }); }
  }

  const isActive = (r: ApprovalDelegation) => r.from_date <= today && r.to_date >= today;

  const columns: Column<ApprovalDelegation>[] = [
    {
      id: "delegate", header: "Covered by", accessor: (r) => empName(r.delegate),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <PhotoAvatar employeeId={r.delegate ? idOf(r.delegate) : ""} name={empName(r.delegate)} photo={emp(r.delegate)?.photo} className="h-6 w-6" />
          <span className="font-medium">{empName(r.delegate)}</span>
        </span>
      ),
    },
    {
      id: "period", header: "Period", accessor: (r) => r.from_date,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 text-sm">
          {formatDate(r.from_date)} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {formatDate(r.to_date)}
          {isActive(r) && <span className="ml-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">Active now</span>}
        </span>
      ),
    },
    { id: "reason", header: "Reason", accessor: (r) => r.reason ?? "", cell: (r) => <span className="text-sm text-muted-foreground">{r.reason || "—"}</span> },
    ...metaColumns<ApprovalDelegation>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => canWrite ? (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>Edit</Button>
          <AccessAction collection={COL} objectPath={r.path} can={r.access?.can} label="Remove">
            <Button size="sm" variant="ghost" onClick={() => del(r)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
          </AccessAction>
        </div>
      ) : null,
    },
  ];

  const addBtn = canWrite && (
    <AccessAction collection={COL} create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add delegation</Button>
    </AccessAction>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Approval delegation"
        description="Name someone to receive and act on your approvals while you're away. They're copied on every pending decision during the window."
        actions={addBtn}
      />
      {activeCount > 0 && <p className="text-sm text-muted-foreground">{activeCount} delegation{activeCount === 1 ? "" : "s"} active today.</p>}

      {/* The wait and the failure are the shared ones (skeleton, then a retryable error panel) rather than
          this page's own: an empty table titled "Loading…" reads as "you have no delegations". */}
      <DataState state={state} error={error ? String(error) : null} onRetry={reload}>
        <DataTable
          rows={rows}
          columns={columns}
          tableId="delegations"
          getRowId={(r) => r.path}
          emptyTitle="No delegations yet"
          emptyDescription="Name someone before you go on leave so approvals never stall while you're away."
          emptyAction={addBtn}
          accessCollection={COL}
          accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.delegate)} · ${r.from_date}`, can: r.access?.can })}
        />
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit delegation" : "Add delegation"}
        description="Everything waiting on your decision is copied to them for the whole window."
        collection={COL}
        objectPath={editing?.path}
        guardLabel="delegation"
        form={form}
        submitLabel={editing ? "Save" : "Add"}
        canSubmit={canSave}
        whyNot={
          !form.delegate ? "Pick who covers for you." : !form.from_date || !form.to_date ? "Set the dates you're away." : rangeInverted ? "The end date is before the start date." : undefined
        }
        onSubmit={submit}
      >
          <div className="space-y-3">
            <Field label="Covered by">
              <Combobox
                value={form.delegate}
                onValueChange={(v) => setForm((f) => ({ ...f, delegate: v }))}
                options={employees.filter((e) => idOf(e.path) !== me.employee_id).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
                placeholder="Pick a colleague…"
              />
            </Field>
            <FieldRow>
              <Field label="From">
                <Input
                  type="date"
                  value={form.from_date}
                  // Dragging a now-stale end date along keeps the range valid while the start moves forward.
                  onChange={(e) => setForm((f) => ({ ...f, from_date: e.target.value, to_date: f.to_date && f.to_date < e.target.value ? e.target.value : f.to_date }))}
                />
              </Field>
              <Field label="To" error={rangeInverted ? "The end date is before the start date." : undefined}>
                <Input type="date" value={form.to_date} min={form.from_date} onChange={(e) => setForm((f) => ({ ...f, to_date: e.target.value }))} />
              </Field>
            </FieldRow>
            <Field label="Reason (optional)"><Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Annual leave" /></Field>
            {canSave && (
              <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{empName(form.delegate)}</span> receives your approvals for {coverDays} day{coverDays === 1 ? "" : "s"},
                {" "}{formatDate(form.from_date)} to {formatDate(form.to_date)}.
              </p>
            )}
            {overlapping.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-medium text-warning-foreground dark:text-warning">These days are already covered</p>
                <ul className="mt-1 space-y-1">
                  {overlapping.map((r) => (
                    <li key={r.path} className="flex items-center justify-between gap-2">
                      <span>{empName(r.delegate)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(r.from_date)} - {formatDate(r.to_date)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-muted-foreground">Both of them will get every pending decision in the overlap.</p>
              </div>
            )}
          </div>
      </WriteDialog>
    </div>
  );
}
