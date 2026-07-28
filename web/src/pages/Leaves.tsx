import { useMemo, useState } from "react";
import { Plus, Ban, CalendarPlus, Plane, Clock } from "lucide-react";
import { invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf } from "@/lib/utils";
import type { LeaveDraft } from "@/lib/leaveDraft";
import type { Employee, LeaveBalance, LeaveRequest, LeaveType, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { useConfirm } from "@/components/common/confirm";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import LeaveEncashments from "@/pages/LeaveEncashments";

const upper = (s?: string) => (s ?? "").toUpperCase();
const sumDays = (rs: LeaveRequest[]) => rs.reduce((n, r) => n + (r.days || 0), 0);
// Whole calendar days between two ymd strings (positive = `to` is later).
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
const inDaysLabel = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

// Relative timing for a live request, so "where's my request" also answers "when is it".
function whenLabel(lr: LeaveRequest, today: string): string | null {
  if (lr.start_date === today) return "starts today";
  if (lr.start_date > today) return `starts ${inDaysLabel(daysBetween(today, lr.start_date))}`;
  if (lr.end_date >= today) return "ongoing";
  return null; // back-dated request - the dates speak for themselves
}

// Short label for a leave's half-day boundaries (null = whole days). Sessions: 1 = first half (morning),
// 2 = second half (afternoon).
function halfLabel(lr: LeaveRequest): string | null {
  const ss = lr.start_session ?? 1, es = lr.end_session ?? 2;
  if (lr.start_date === lr.end_date) {
    if (ss === 1 && es === 1) return "First half";
    if (ss === 2 && es === 2) return "Second half";
    return null;
  }
  const parts: string[] = [];
  if (ss === 2) parts.push("from 2nd half");
  if (es === 1) parts.push("to 1st half");
  return parts.length ? parts.join(", ") : null;
}

export default function Leaves({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<LeaveRequest>("leave-requests");
  const { rows: types } = useCollection<LeaveType>("leave-types");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { toast } = useToast();
  const confirm = useConfirm();
  const canDecide = usePermission("leave-requests.approve");
  const canEncash = usePermission("leave-encashments.read");

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LeaveDraft | null>(null);
  // Global "Request leave" quick action (⌘K / top-bar +) opens the dialog on arrival.
  useIntent("request-leave", () => { setDraft(null); setOpen(true); });

  const typeName = useMemo(() => {
    const m = new Map(types.map((t) => [idOf(t.path), t.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [types]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  const today = new Date().toLocaleDateString("en-CA");
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const isOwn = (lr: LeaveRequest) => !!(lr.employee && me.employee_id && idOf(lr.employee) === me.employee_id);
  const isPending = (lr: LeaveRequest) => upper(lr.state) === "PENDING";
  const isUpcoming = (lr: LeaveRequest) => upper(lr.state) === "APPROVED" && lr.end_date >= today;

  // The caller's own requests drive the balance cards below; the Requests/History tab split lives in
  // RequestsHistoryTabs. "Live" for leave includes upcoming-approved (still cancellable), but an approver's
  // History excludes only pending (so freshly-approved future leave still shows org-wide).
  const myAll = useMemo(() => rows.filter(isOwn), [rows, me.employee_id]);

  const myBalances = useMemo(
    () => balances.filter((b) => me.employee_id && b.employee && idOf(b.employee) === me.employee_id),
    [balances, me.employee_id],
  );

  // Answer-first strip: the caller's next approved leave and how many requests still await a decision.
  const nextLeave = useMemo(
    () => myAll.filter((r) => upper(r.state) === "APPROVED" && r.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0],
    [myAll, today],
  );
  const myPendingCount = useMemo(() => myAll.filter(isPending).length, [myAll]);
  // The only per-row verb on this page (approve/reject live in the Approvals inbox). Cancelling an approved
  // leave gives up the approval (the server credits the days back), so that variant asks first.
  async function cancelRequest(lr: LeaveRequest) {
    if (upper(lr.state) === "APPROVED") {
      const ok = await confirm({
        title: "Cancel this approved leave?",
        description: `${formatDate(lr.start_date)} – ${formatDate(lr.end_date)} · ${lr.days} day${lr.days === 1 ? "" : "s"} will be credited back to the balance.`,
        confirmLabel: "Cancel leave",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await invoke("leave-requests/" + idOf(lr.path), "cancel", lr.etag);
      toast({ title: "Leave request cancelled", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't cancel leave request", description: (e as Error).message, variant: "destructive" });
    }
  }

  // ---- columns -------------------------------------------------------------
  const empCol: Column<LeaveRequest> = { id: "employee", header: "Employee", accessor: (lr) => empName(lr.employee), cell: (lr) => <span className="font-medium">{empName(lr.employee)}</span> };
  const baseCols: Column<LeaveRequest>[] = [
    { id: "type", header: "Type", filter: "select", accessor: (lr) => typeName(lr.leave_type) },
    { id: "start", header: "From", accessor: (lr) => lr.start_date, cell: (lr) => formatDate(lr.start_date) },
    { id: "end", header: "To", accessor: (lr) => lr.end_date, cell: (lr) => formatDate(lr.end_date) },
    { id: "days", header: "Days", align: "right", accessor: (lr) => lr.days, cell: (lr) => {
      const h = halfLabel(lr);
      return <span className="inline-flex items-center gap-1.5"><span className="tabular-nums">{lr.days}</span>{h && <Badge variant="secondary" className="font-normal">{h}</Badge>}</span>;
    } },
    { id: "state", header: "Status", filter: "select", accessor: (lr) => lr.state, cell: (lr) => <StatusBadge state={lr.state} /> },
    { id: "reason", header: "Reason", defaultHidden: true, accessor: (lr) => lr.reason ?? "", cell: (lr) => lr.reason || "-" },
  ];

  // Cancellable: a pending request, or an approved leave that hasn't started yet (server restores the balance).
  const isCancellable = (lr: LeaveRequest) => isPending(lr) || (upper(lr.state) === "APPROVED" && lr.start_date > today);
  const cancelCol: Column<LeaveRequest> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (lr) => (
      <div className="flex items-center justify-end gap-1">
        {isCancellable(lr) && (
          <AccessAction collection="leave-requests" objectPath={lr.path} verb="cancel" can={lr.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => cancelRequest(lr)}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={lr.path} />
      </div>
    ),
  };
  // On the caller's own Requests tab, "From" also says how far away the leave is (starts in 3 days / ongoing).
  const startWhenCol: Column<LeaveRequest> = {
    id: "start", header: "From", accessor: (lr) => lr.start_date,
    cell: (lr) => {
      const w = whenLabel(lr, today);
      return <span className="inline-flex items-baseline gap-1.5">{formatDate(lr.start_date)}{w && <span className="text-xs text-muted-foreground">{w}</span>}</span>;
    },
  };
  const mineCols = [...baseCols.map((c) => (c.id === "start" ? startWhenCol : c)), ...metaColumns<LeaveRequest>(), cancelCol];
  // Approvers see everyone's settled leave in History, so show whose request it is. (Pending decisions live
  // in the unified Approvals inbox, not a per-page tab.)
  const activityCol: Column<LeaveRequest> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (lr) => <RowActivityButton resource={lr.path} /> };
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, ...metaColumns<LeaveRequest>(), activityCol] : [...baseCols, ...metaColumns<LeaveRequest>(), activityCol]);

  const requestBtn = (
    <AccessAction collection="leave-requests" create label="Request leave">
      <Button onClick={() => { setDraft(null); setOpen(true); }}><Plus className="h-4 w-4" /> Request leave</Button>
    </AccessAction>
  );

  const renderTable = (search: RequestsHistorySearch, data: LeaveRequest[], columns: Column<LeaveRequest>[], tableId: string, emptyTitle: string, emptyDescription?: string) => (
    <DataTable
      tableId={tableId}
      columns={columns}
      rows={data}
      search={search}
      getRowId={(lr) => lr.path}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      accessCollection="leave-requests"
      accessTargetOf={(lr) => ({ objectPath: lr.path, label: `Leave ${lr.start_date}`, can: lr.access?.can })}
    />
  );

  return (
    <div>
      <PageHeader title="Leaves" actions={<>{requestBtn}<PageSettings me={me} host="leave-requests" /></>} />

      {/* Balance dashboard - the caller's own, accrued by the system. */}
      {myBalances.length > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {myBalances.map((b) => {
            const reqs = myAll.filter((r) => r.leave_type && b.leave_type && idOf(r.leave_type) === idOf(b.leave_type));
            const used = sumDays(reqs.filter((r) => upper(r.state) === "APPROVED" && r.start_date >= yearStart));
            const pending = sumDays(reqs.filter(isPending));
            const type = types.find((t) => b.leave_type && idOf(t.path) === idOf(b.leave_type));
            const entitled = type?.accrual_days_per_year;
            const pct = entitled ? Math.min(100, Math.round((used / entitled) * 100)) : 0;
            return (
              <Card key={b.path} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{typeName(b.leave_type)}</span>
                  {type && <Badge variant={type.paid ? "secondary" : "muted"}>{type.paid ? "Paid" : "Unpaid"}</Badge>}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tabular-nums">{b.balance_days}</span>
                  <span className="text-sm text-muted-foreground">days left</span>
                </div>
                {entitled ? (
                  <div className="mt-3">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                      <span>{used} used{pending ? ` · ${pending} pending` : ""}</span>
                      <span>{entitled}/yr</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-muted-foreground">{used} used{pending ? ` · ${pending} pending` : ""}</div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Answer-first: when is my next leave, and is anything still waiting on approval. */}
      {(nextLeave || myPendingCount > 0) && (
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
          {nextLeave && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Plane className="h-4 w-4 text-primary" />
              {nextLeave.start_date <= today ? "On leave now:" : "Next leave:"}
              <span className="font-medium text-foreground">
                {formatDate(nextLeave.start_date)}{nextLeave.end_date !== nextLeave.start_date ? ` - ${formatDate(nextLeave.end_date)}` : ""}
              </span>
              · {typeName(nextLeave.leave_type)}
              {nextLeave.start_date > today && <> · {inDaysLabel(daysBetween(today, nextLeave.start_date))}</>}
            </span>
          )}
          {myPendingCount > 0 && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-4 w-4 text-warning" />
              {myPendingCount} request{myPendingCount === 1 ? "" : "s"} awaiting approval
            </span>
          )}
        </div>
      )}

      <RequestsHistoryTabs
        collection="leave-requests"
        rows={rows}
        state={state}
        error={error}
        reload={reload}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        isLive={(r) => isPending(r) || isUpcoming(r)}
        isPendingDecision={isPending}
        accessLabel="Leave requests"
        extraTabs={canEncash ? [{
          value: "encashments",
          label: "Encashments",
          accessTarget: { collection: "leave-encashments", label: "Encashments" },
          content: <LeaveEncashments embedded />,
        }] : []}
        render={(items, mode, search) => {
          // Live requests read soonest-first; history reads most recent first.
          const sorted = [...items].sort((a, b) => (mode === "requests" ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date)));
          return mode === "requests"
            ? sorted.length === 0
              // A truly empty Requests tab gets a CTA into the create flow instead of a bare table shell.
              ? <EmptyState icon={CalendarPlus} title="No active requests" description="Pending and upcoming approved leave appears here." action={requestBtn} />
              : renderTable(search, sorted, mineCols, "leaves-active", "No active requests")
            : renderTable(search, sorted, historyCols, "leaves-history", "No decided leave", "Decided requests (approved, rejected or cancelled) appear here.");
        }}
      />

      {open && <RequestLeaveDialog open={open} onOpenChange={setOpen} me={me} initial={draft} onSubmitted={reload} />}
    </div>
  );
}
