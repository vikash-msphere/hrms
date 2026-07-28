import { useMemo, useState } from "react";
import { Plus, Trash2, ArrowRight } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import type { ApprovalDelegation, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field, FieldRow } from "@/components/common/Field";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const COL = "approval-delegations";
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const EMPTY = { delegate: "", from_date: todayStr(), to_date: todayStr(), reason: "" };

export default function Delegations({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<ApprovalDelegation>(COL);
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const canWrite = usePermission(`${COL}.write`);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ApprovalDelegation | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : p ? idOf(p) : ""; };

  const today = todayStr();
  const activeCount = useMemo(() => rows.filter((r) => r.from_date <= today && r.to_date >= today).length, [rows, today]);

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(r: ApprovalDelegation) {
    setEditing(r);
    setForm({ delegate: r.delegate ? `employees/${idOf(r.delegate)}` : "", from_date: r.from_date, to_date: r.to_date, reason: r.reason ?? "" });
    setOpen(true);
  }

  async function submit() {
    if (!form.delegate) { toast({ title: "Pick who covers", variant: "destructive" }); return; }
    if (form.to_date < form.from_date) { toast({ title: "End date is before start date", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const body = { delegate: form.delegate, from_date: form.from_date, to_date: form.to_date, reason: form.reason || null };
      if (editing) await patch(editing.path, body, editing.etag);
      else await create(COL, body);
      toast({ title: editing ? "Delegation updated" : "Delegation added" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function del(r: ApprovalDelegation) {
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

      {error ? (
        <p className="text-sm text-destructive">{String(error)}</p>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          tableId="delegations"
          getRowId={(r) => r.path}
          emptyTitle={state === "loading" ? "Loading…" : "No delegations. Add one before you go on leave so approvals never stall."}
          accessCollection={COL}
          accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.delegate)} · ${r.from_date}`, can: r.access?.can })}
        />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? "Edit delegation" : "Add delegation"}</DialogTitle></DialogHeader>
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
              <Field label="From"><Input type="date" value={form.from_date} onChange={(e) => setForm((f) => ({ ...f, from_date: e.target.value }))} /></Field>
              <Field label="To"><Input type="date" value={form.to_date} onChange={(e) => setForm((f) => ({ ...f, to_date: e.target.value }))} /></Field>
            </FieldRow>
            <Field label="Reason (optional)"><Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Annual leave" /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy}>{editing ? "Save" : "Add"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
