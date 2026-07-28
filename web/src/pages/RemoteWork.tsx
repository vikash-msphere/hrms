import { useMemo, useState } from "react";
import { Plus, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf } from "@/lib/utils";
import type { RemoteWorkRequest, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field, FieldRow } from "@/components/common/Field";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const pad = (n: number) => String(n).padStart(2, "0");
// Local date, not UTC: the "today"/"this month" summaries should follow the viewer's clock.
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const upper = (s?: string) => (s ?? "").toUpperCase();

export default function RemoteWork({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<RemoteWorkRequest>("remote-work-requests");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const canCreate = usePermission("remote-work-requests.write");
  const canDecide = usePermission("remote-work-requests.approve");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", start_date: todayStr(), end_date: todayStr(), startSession: 1, endSession: 2, location: "Home", reason: "" });
  const [busy, setBusy] = useState(false);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : p ? idOf(p) : ""; };

  const pendingTotal = useMemo(() => rows.filter((r) => upper(r.state) === "PENDING").length, [rows]);
  // Who's working remotely today (approved request covering today), and my approved days starting this month.
  const remoteToday = useMemo(() => {
    const today = todayStr();
    return new Set(
      rows
        .filter((r) => upper(r.state) === "APPROVED" && r.start_date <= today && r.end_date >= today && r.employee)
        .map((r) => idOf(r.employee!)),
    ).size;
  }, [rows]);
  const myMonthDays = useMemo(() => {
    if (!me.employee_id) return 0;
    const cur = todayStr().slice(0, 7);
    return rows
      .filter((r) => r.employee && idOf(r.employee) === me.employee_id && upper(r.state) === "APPROVED" && r.start_date.slice(0, 7) === cur)
      .reduce((s, r) => s + (r.days || 0), 0);
  }, [rows, me.employee_id]);

  function openCreate() { setForm({ employee: me.employee_id ? `employees/${me.employee_id}` : "", start_date: todayStr(), end_date: todayStr(), startSession: 1, endSession: 2, location: "Home", reason: "" }); setOpen(true); }

  async function submit() {
    setBusy(true);
    try {
      await create("remote-work-requests", {
        employee: form.employee || null,
        start_date: form.start_date,
        end_date: form.end_date,
        start_session: form.startSession,
        end_session: form.endSession,
        location: form.location.trim() || null,
        reason: form.reason.trim() || null,
      });
      toast({ title: "Remote work requested", variant: "success" });
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't submit the request", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function action(r: RemoteWorkRequest, verb: "approve" | "reject" | "cancel") {
    try {
      await invoke("remote-work-requests/" + idOf(r.path), verb, r.etag);
      toast({ title: `Request ${verb === "cancel" ? "cancelled" : verb === "approve" ? "approved" : "rejected"}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the request", description: (e as Error).message, variant: "destructive" });
    }
  }

  const validRange = !!form.start_date && !!form.end_date && form.end_date >= form.start_date;

  const empCol: Column<RemoteWorkRequest> = {
    id: "employee", header: "Employee", filter: "select", accessor: (r) => empName(r.employee),
    cell: (r) => { const e = emp(r.employee); return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={r.employee ? idOf(r.employee) : ""} name={empName(r.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(r.employee)}</span>; },
  };
  const baseCols: Column<RemoteWorkRequest>[] = [
    {
      id: "dates", header: "Dates", accessor: (r) => r.start_date,
      cell: (r) => {
        const single = r.start_date === r.end_date;
        const note = single ? (r.start_session === 1 && r.end_session === 1 ? " · morning" : r.start_session === 2 && r.end_session === 2 ? " · afternoon" : "") : "";
        return <span className="tabular-nums">{formatDate(r.start_date)}{!single && <> - {formatDate(r.end_date)}</>}{note && <span className="text-muted-foreground">{note}</span>}</span>;
      },
    },
    { id: "days", header: "Days", align: "right", accessor: (r) => r.days, cell: (r) => <span className="tabular-nums">{r.days}</span> },
    { id: "location", header: "Location", filter: "select", accessor: (r) => r.location ?? "", cell: (r) => r.location || <span className="text-muted-foreground">-</span> },
    { id: "state", header: "Status", filter: "select", accessor: (r) => upper(r.state), cell: (r) => <StatusBadge state={r.state} /> },
    { id: "reason", header: "Reason", accessor: (r) => r.reason ?? "", cell: (r) => r.reason || <span className="text-muted-foreground">-</span> },
  ];
  // History only: the approver's note explains WHY a request landed where it did (esp. rejections).
  const noteCol: Column<RemoteWorkRequest> = {
    id: "decision_note", header: "Decision note", accessor: (r) => r.decision_note ?? "",
    cell: (r) => r.decision_note || <span className="text-muted-foreground">-</span>,
  };
  // Requests tab is the caller's own pending remote-work - cancellable. Approve/reject live in the Approvals inbox.
  const cancelCol: Column<RemoteWorkRequest> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => (
      <div className="flex items-center justify-end gap-1">
        {upper(r.state) === "PENDING" && (
          <AccessAction collection="remote-work-requests" objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => action(r, "cancel")}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={r.path} />
      </div>
    ),
  };
  const activityCol: Column<RemoteWorkRequest> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (r) => <RowActivityButton resource={r.path} /> };
  const requestsCols = [...baseCols, ...metaColumns<RemoteWorkRequest>(), cancelCol];
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, noteCol, ...metaColumns<RemoteWorkRequest>(), activityCol] : [...baseCols, noteCol, ...metaColumns<RemoteWorkRequest>(), activityCol]);

  useIntent("new-remote", openCreate);

  const addBtn = canCreate && <AccessAction collection="remote-work-requests" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Request remote</Button></AccessAction>;

  const renderTable = (search: RequestsHistorySearch, data: RemoteWorkRequest[], columns: Column<RemoteWorkRequest>[], tableId: string, emptyTitle: string) => (
    <DataTable columns={columns} tableId={tableId} rows={data} search={search} getRowId={(r) => r.path} emptyTitle={emptyTitle} accessCollection="remote-work-requests" accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${r.start_date}`, can: r.access?.can })} />
  );

  return (
    <div>
      <PageHeader title="Remote work" actions={addBtn} />

      {state === "ready" && (
        <SummaryStrip
          items={[
            { label: "Pending", value: pendingTotal, tone: pendingTotal ? "warning" : "muted" },
            { label: "My remote days this month", value: myMonthDays, hint: "approved", tone: myMonthDays ? "default" : "muted" },
            { label: "Remote today", value: remoteToday, hint: remoteToday === 1 ? "person" : "people", tone: remoteToday ? "default" : "muted" },
          ]}
        />
      )}

      <RequestsHistoryTabs
        collection="remote-work-requests"
        pageKey="remote-work"
        rows={rows}
        state={state}
        error={error}
        reload={reload}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        accessLabel="Remote-work requests"
        render={(items, mode, search) =>
          mode === "requests"
            ? renderTable(search, items, requestsCols, "rw-active", "No active requests")
            : renderTable(search, items, historyCols, "rw-history", "No remote-work history")
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.employee && validRange) submit(); }}>
          <DialogHeader><DialogTitle>Request remote work</DialogTitle></DialogHeader>
          <Field label="Employee">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Select an employee…"
              searchPlaceholder="Search employees…"
              options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <FieldRow>
            <Field label="From"><Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value, end_date: form.end_date < e.target.value ? e.target.value : form.end_date })} /></Field>
            <Field label="To"><Input type="date" value={form.end_date} min={form.start_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></Field>
          </FieldRow>
          {form.start_date && form.start_date === form.end_date ? (
            <Field label="Duration">
              <Select value={form.startSession === 1 && form.endSession === 2 ? "full" : form.startSession === 1 ? "am" : "pm"} onValueChange={(v) => setForm({ ...form, startSession: v === "pm" ? 2 : 1, endSession: v === "am" ? 1 : 2 })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full day</SelectItem>
                  <SelectItem value="am">First half (morning)</SelectItem>
                  <SelectItem value="pm">Second half (afternoon)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : form.start_date && form.end_date && form.end_date > form.start_date ? (
            <div className="grid grid-cols-2 gap-4">
              <Field label="First day">
                <Select value={String(form.startSession)} onValueChange={(v) => setForm({ ...form, startSession: Number(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="1">Full day</SelectItem><SelectItem value="2">Second half (afternoon)</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="Last day">
                <Select value={String(form.endSession)} onValueChange={(v) => setForm({ ...form, endSession: Number(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="2">Full day</SelectItem><SelectItem value="1">First half (morning)</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>
          ) : null}
          <Field label="Location" hint="Where you'll work from."><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Home" /></Field>
          <Field label="Reason"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Optional" /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.employee || !validRange}>Request remote work</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
