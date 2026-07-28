import { useMemo, useState } from "react";
import { Plus, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf } from "@/lib/utils";
import type { OvertimeRequest, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field } from "@/components/common/Field";
import { TimeRangeField, fmtDuration } from "@/components/common/TimeRangeField";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const pad = (n: number) => String(n).padStart(2, "0");
const upper = (s?: string) => (s ?? "").toUpperCase();
// ISO instant -> "YYYY-MM-DDTHH:mm" in the viewer's local time, for <input type="datetime-local"> (mirrors Events).
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localYmd = (iso?: string) => (iso ? toLocalInput(iso).slice(0, 10) : "");
const localHhmm = (iso?: string) => (iso ? toLocalInput(iso).slice(11, 16) : "");
const thisMonth = () => toLocalInput(new Date().toISOString()).slice(0, 7);

export default function Overtime({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<OvertimeRequest>("overtime-requests");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const canCreate = usePermission("overtime-requests.write");
  const canDecide = usePermission("overtime-requests.approve");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", start_time: "", end_time: "", reason: "" });
  const [month, setMonth] = useState(thisMonth());
  const [busy, setBusy] = useState(false);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : p ? idOf(p) : ""; };

  const pendingTotal = useMemo(() => rows.filter((r) => upper(r.state) === "PENDING").length, [rows]);
  // My approved overtime in the current calendar month, and approved-but-not-yet-paid overall.
  const myMonthMinutes = useMemo(() => {
    if (!me.employee_id) return 0;
    const cur = thisMonth();
    return rows
      .filter((r) => r.employee && idOf(r.employee) === me.employee_id && upper(r.state) === "APPROVED" && localYmd(r.start_time).slice(0, 7) === cur)
      .reduce((s, r) => s + (r.minutes || 0), 0);
  }, [rows, me.employee_id]);
  const unpaidMinutes = useMemo(
    () => rows.filter((r) => upper(r.state) === "APPROVED" && !r.paid).reduce((s, r) => s + (r.minutes || 0), 0),
    [rows],
  );

  // Approved overtime per employee for the selected (local) month: minutes summed -> total hours+minutes.
  const monthlyTotals = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of rows) {
      if (upper(r.state) !== "APPROVED" || localYmd(r.start_time).slice(0, 7) !== month) continue;
      const key = r.employee ?? "";
      by.set(key, (by.get(key) ?? 0) + (r.minutes || 0));
    }
    return [...by.entries()].map(([e, mins]) => ({ employee: e, minutes: mins })).sort((a, b) => b.minutes - a.minutes);
  }, [rows, month]);

  function openCreate() {
    const s = new Date(); s.setHours(18, 0, 0, 0);
    const e = new Date(s.getTime() + 3600000);
    setForm({ employee: me.employee_id ? `employees/${me.employee_id}` : "", start_time: s.toISOString(), end_time: e.toISOString(), reason: "" });
    setOpen(true);
  }

  const validRange = !!form.start_time && !!form.end_time && +new Date(form.end_time) > +new Date(form.start_time);

  async function submit() {
    setBusy(true);
    try {
      await create("overtime-requests", {
        employee: form.employee || null,
        start_time: form.start_time,
        end_time: form.end_time,
        reason: form.reason.trim() || null,
      });
      toast({ title: "Overtime logged", variant: "success" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't log overtime", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function action(r: OvertimeRequest, verb: "approve" | "reject" | "cancel") {
    try {
      await invoke("overtime-requests/" + idOf(r.path), verb, r.etag);
      toast({ title: `Request ${verb === "cancel" ? "cancelled" : verb === "approve" ? "approved" : "rejected"}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the request", description: (e as Error).message, variant: "destructive" });
    }
  }

  const empCol: Column<OvertimeRequest> = {
    id: "employee", header: "Employee", filter: "select", accessor: (r) => empName(r.employee),
    cell: (r) => { const e = emp(r.employee); return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={r.employee ? idOf(r.employee) : ""} name={empName(r.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(r.employee)}</span>; },
  };
  const baseCols: Column<OvertimeRequest>[] = [
    { id: "date", header: "Date", accessor: (r) => localYmd(r.start_time), cell: (r) => formatDate(localYmd(r.start_time)) },
    { id: "worked", header: "Worked", sortable: false, accessor: (r) => localHhmm(r.start_time), cell: (r) => <span className="tabular-nums text-muted-foreground">{localHhmm(r.start_time)}-{localHhmm(r.end_time)}{localYmd(r.end_time) !== localYmd(r.start_time) && <span className="text-amber-600 dark:text-amber-400"> +1</span>}</span> },
    { id: "duration", header: "Duration", align: "right", accessor: (r) => r.minutes, cell: (r) => <span className="font-medium tabular-nums">{fmtDuration(r.minutes)}</span> },
    { id: "state", header: "Status", filter: "select", accessor: (r) => upper(r.state), cell: (r) => <span className="inline-flex items-center gap-1.5"><StatusBadge state={r.state} />{r.paid && <Badge variant="success">Paid</Badge>}</span> },
    { id: "reason", header: "Reason", accessor: (r) => r.reason ?? "", cell: (r) => r.reason || <span className="text-muted-foreground">-</span> },
  ];
  // History only: the approver's note explains WHY a request landed where it did (esp. rejections).
  const noteCol: Column<OvertimeRequest> = {
    id: "decision_note", header: "Decision note", accessor: (r) => r.decision_note ?? "",
    cell: (r) => r.decision_note || <span className="text-muted-foreground">-</span>,
  };
  // Requests tab is the caller's own pending overtime - cancellable. Approve/reject live in the Approvals inbox.
  const cancelCol: Column<OvertimeRequest> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => (
      <div className="flex items-center justify-end gap-1">
        {upper(r.state) === "PENDING" && (
          <AccessAction collection="overtime-requests" objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={r.path} />
      </div>
    ),
  };
  const activityCol: Column<OvertimeRequest> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (r) => <RowActivityButton resource={r.path} /> };
  const requestsCols = [...baseCols, ...metaColumns<OvertimeRequest>(), cancelCol];
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, noteCol, ...metaColumns<OvertimeRequest>(), activityCol] : [...baseCols, noteCol, ...metaColumns<OvertimeRequest>(), activityCol]);

  useIntent("new-overtime", openCreate);

  const addBtn = canCreate && <AccessAction collection="overtime-requests" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Log overtime</Button></AccessAction>;

  const renderTable = (search: RequestsHistorySearch, data: OvertimeRequest[], columns: Column<OvertimeRequest>[], tableId: string, emptyTitle: string) => (
    <DataTable columns={columns} tableId={tableId} rows={data} search={search} getRowId={(r) => r.path} emptyTitle={emptyTitle} accessCollection="overtime-requests" accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${localYmd(r.start_time)}`, can: r.access?.can })} />
  );

  return (
    <div>
      <PageHeader title="Overtime" actions={addBtn} />

      {state === "ready" && (
        <SummaryStrip
          items={[
            { label: "Pending", value: pendingTotal, tone: pendingTotal ? "warning" : "muted" },
            { label: "My overtime this month", value: fmtDuration(myMonthMinutes), hint: "approved", tone: myMonthMinutes ? "default" : "muted" },
            { label: "Approved, unpaid", value: fmtDuration(unpaidMinutes), hint: "not yet in a payroll run", tone: unpaidMinutes ? "default" : "muted" },
          ]}
        />
      )}

      {/* Monthly approved totals (sum of all approved overtime minutes for the month). */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Approved overtime · monthly total</p>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} className="h-8 w-40" />
        </div>
        {monthlyTotals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approved overtime in this month.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {monthlyTotals.map((t) => { const e = emp(t.employee); return (
              <div key={t.employee} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <span className="inline-flex min-w-0 items-center gap-2 text-sm"><PhotoAvatar employeeId={t.employee ? idOf(t.employee) : ""} name={empName(t.employee)} photo={e?.photo} className="h-6 w-6" /> <span className="truncate">{empName(t.employee)}</span></span>
                <span className="shrink-0 font-semibold tabular-nums">{fmtDuration(t.minutes)}</span>
              </div>
            ); })}
          </div>
        )}
      </Card>

      <RequestsHistoryTabs
        collection="overtime-requests"
        pageKey="overtime"
        rows={rows}
        state={state}
        error={error}
        reload={reload}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        accessLabel="Overtime requests"
        render={(items, mode, search) =>
          mode === "requests"
            ? renderTable(search, items, requestsCols, "ot-active", "No active overtime")
            : renderTable(search, items, historyCols, "ot-history", "No overtime history")
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.employee && validRange) submit(); }}>
          <DialogHeader><DialogTitle>Log overtime</DialogTitle></DialogHeader>
          <Field label="Employee">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Select an employee…"
              searchPlaceholder="Search employees…"
              options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <Field label="When">
            <TimeRangeField initialStart={form.start_time} initialEnd={form.end_time} onChange={(s, e) => setForm((f) => ({ ...f, start_time: s, end_time: e }))} />
          </Field>
          <Field label="Reason"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="What was the extra work?" /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.employee || !validRange}>Log overtime</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
