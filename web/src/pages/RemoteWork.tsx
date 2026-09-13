import { useMemo, useState } from "react";
import { Plus, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { cn, formatDate, idOf, personName } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { navigate, navigateTab } from "@/router";
import { Card } from "@/components/ui/card";
import type { ApprovalDelegation, RemoteWorkRequest, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Segmented } from "@/components/common/Segmented";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

// Local date, not UTC: the "today"/"this month" summaries should follow the viewer's clock.
// `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's
// local parts, which is a different day for part of every day and a different day again from the one the
// server validates against.
const ymdIn = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString("en-CA"); };
// Friday of the current week (or today, if the week is already past it) - the "rest of the week" pick.
const endOfWeek = () => { const d = new Date(); const add = Math.max(0, 5 - (d.getDay() || 7)); d.setDate(d.getDate() + add); return d.toLocaleDateString("en-CA"); };
const upper = (s?: string) => (s ?? "").toUpperCase();

export default function RemoteWork({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<RemoteWorkRequest>("remote-work-requests");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const canCreate = usePermission("remote-work-requests.write");
  const canDecide = usePermission("remote-work-requests.approve");

  const [open, setOpen] = useState(false);
  // Who covers for an absent approver, used for the one line in the create form that says whose desk this will
  // land on. Private by default (no read access means [] and no request); read only while that form is open, so
  // simply looking at your own remote-work history costs nothing for it.
  const { rows: delegations } = useCollection<ApprovalDelegation>("approval-delegations", { enabled: open });
  const [form, setForm] = useState({ employee: "", start_date: todayStr(), end_date: todayStr(), startSession: 1, endSession: 2, location: "Home", reason: "" });

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string, unknown?: string) => personName(employees, p, unknown);

  const pendingTotal = useMemo(() => rows.filter((r) => upper(r.state) === "PENDING").length, [rows]);
  // Who's working remotely today (approved request covering today), and my approved days starting this month.
  const remoteTodayRows = useMemo(() => {
    const today = todayStr();
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (upper(r.state) !== "APPROVED" || !r.employee || r.start_date > today || r.end_date < today) return false;
      const id = idOf(r.employee);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [rows]);
  const remoteToday = remoteTodayRows.length;
  // "Remote today" is a roster, not a filter of anyone's request list, so the metric unfolds the names in place
  // instead of pretending to narrow the tabs below.
  const [showRoster, setShowRoster] = useState(false);
  const myMonthDays = useMemo(() => {
    if (!me.employee_id) return 0;
    const cur = todayStr().slice(0, 7);
    return rows
      .filter((r) => r.employee && idOf(r.employee) === me.employee_id && upper(r.state) === "APPROVED" && r.start_date.slice(0, 7) === cur)
      .reduce((s, r) => s + (r.days || 0), 0);
  }, [rows, me.employee_id]);
  const mine = (r: RemoteWorkRequest) => !!r.employee && !!me.employee_id && idOf(r.employee) === me.employee_id;
  const myPendingCount = useMemo(() => rows.filter((r) => mine(r) && upper(r.state) === "PENDING").length, [rows, me.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Days already approved that are still ahead of you: what you plan around, which "this month" hides.
  const myUpcomingDays = useMemo(
    () => rows.filter((r) => mine(r) && upper(r.state) === "APPROVED" && r.end_date >= todayStr()).reduce((s, r) => s + (r.days || 0), 0),
    [rows, me.employee_id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Locations people actually use here, most-used first: typing "Home" for the hundredth time is not data entry
  // anyone needs to do, and free text that drifts ("home", "WFH", "Home ") ruins the Location column filter.
  const knownLocations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const l = (r.location ?? "").trim();
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
  }, [rows]);

  const blankForm = () => ({ employee: me.employee_id ? `employees/${me.employee_id}` : "", start_date: todayStr(), end_date: todayStr(), startSession: 1, endSession: 2, location: "Home", reason: "" });
  function openCreate() { setForm(blankForm()); setOpen(true); }

  // Whose decision this waits on: the requester's manager, or whoever covers for them today.
  const decider = useMemo(() => {
    const managerRef = emp(form.employee)?.manager;
    if (!managerRef) return null;
    const today = todayStr();
    const active = delegations.find((d) => d.delegator && idOf(d.delegator) === idOf(managerRef) && (d.from_date ?? "") <= today && (d.to_date ?? "") >= today);
    // An ordinary employee cannot read their own manager's row, so the name often will not resolve. The
    // sentence still has to be true and readable, hence "your manager" rather than a raw id.
    const manager = empName(managerRef, "your manager");
    const covering = active?.delegate ? empName(active.delegate, "whoever covers for them") : null;
    return covering ? { name: covering, coveringFor: manager } : { name: manager };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.employee, employees, delegations]);

  // Throws on failure - the server's reason (an overlapping request, a policy limit) is what the next edit has
  // to answer, so WriteDialog keeps it in the form rather than in a toast.
  async function submit() {
    await create("remote-work-requests", {
      employee: form.employee,
      start_date: form.start_date,
      end_date: form.end_date,
      start_session: form.startSession,
      end_session: form.endSession,
      location: form.location.trim(),
      reason: form.reason.trim(),
    });
    toast({ title: "Remote work requested", variant: "success" });
    reload();
  }

  async function action(r: RemoteWorkRequest, verb: "approve" | "reject" | "cancel") {
    if (!(await confirmDecision(confirm, verb, `${empName(r.employee)}'s remote work from ${formatDate(r.start_date)} to ${formatDate(r.end_date)}`))) return;
    try {
      await invoke("remote-work-requests/" + idOf(r.path), verb, r.etag);
      toast({ title: `Request ${verb === "cancel" ? "cancelled" : verb === "approve" ? "approved" : "rejected"}`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't update the request", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rangeInverted = !!form.start_date && !!form.end_date && form.end_date < form.start_date;
  const validRange = !!form.start_date && !!form.end_date && !rangeInverted;
  // Same arithmetic the server serializes back as `days`: inclusive calendar days, less a half for a PM start
  // or an AM end. Deliberately NOT working-day filtered, because remote days aren't charged to anything.
  const previewDays = validRange
    ? Math.max(0.5, Math.round((Date.parse(form.end_date + "T00:00:00Z") - Date.parse(form.start_date + "T00:00:00Z")) / 86400000) + 1 - (form.startSession === 2 ? 0.5 : 0) - (form.endSession === 1 ? 0.5 : 0))
    : null;

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
    <DataTable columns={columns} tableId={tableId} rows={data} search={search} getRowId={(r) => r.path} emptyTitle={emptyTitle} emptyAction={addBtn} accessCollection="remote-work-requests" accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${r.start_date}`, can: r.access?.can })} />
  );

  return (
    <div>
      <PageHeader title="Remote work" actions={addBtn} />
      {/* The day totals below are summed over the loaded rows, which are one page of the collection. */}
      <TruncationNotice collection="remote-work-requests" what="remote-work requests" className="mb-3" />

      {state === "ready" && (
        <SummaryStrip
          items={[
            { label: "Pending", value: pendingTotal, tone: pendingTotal ? "warning" : "muted", hint: canDecide ? "decide in Approvals" : "awaiting a call", onClick: () => (canDecide ? navigate("approvals") : navigateTab("remote-work", "requests")) },
            ...(myPendingCount ? [{ label: "Your requests in flight", value: myPendingCount, tone: "warning" as const, hint: "open your requests", onClick: () => navigateTab("remote-work", "requests") }] : []),
            { label: "My remote days this month", value: myMonthDays, hint: "approved", tone: myMonthDays ? "default" : "muted", onClick: () => navigateTab("remote-work", "history") },
            ...(myUpcomingDays ? [{ label: "Your upcoming remote days", value: myUpcomingDays, tone: "primary" as const, hint: "still ahead", onClick: () => navigateTab("remote-work", "history") }] : []),
            { label: "Remote today", value: remoteToday, hint: remoteToday ? (showRoster ? "hide who" : "see who") : "everyone is in", tone: remoteToday ? "default" : "muted", ...(remoteToday ? { onClick: () => setShowRoster((v) => !v), active: showRoster } : {}) },
          ]}
        />
      )}

      {showRoster && remoteToday > 0 && (
        <Card className="mb-6 p-4">
          <p className="mb-3 text-sm font-medium">Working remotely today</p>
          <div className="flex flex-wrap gap-2">
            {remoteTodayRows.map((r) => {
              const e = emp(r.employee);
              return (
                <span key={r.path} className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-sm">
                  <PhotoAvatar employeeId={r.employee ? idOf(r.employee) : ""} name={empName(r.employee)} photo={e?.photo} className="h-6 w-6" />
                  {empName(r.employee)}
                  {r.location && <span className="text-xs text-muted-foreground">{r.location}</span>}
                </span>
              );
            })}
          </div>
        </Card>
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Request remote work"
        description={decider ? `Goes to ${decider.name} for approval${decider.coveringFor ? ` (covering for ${decider.coveringFor})` : ""}.` : "Remote days don't touch any leave balance."}
        collection="remote-work-requests"
        guardLabel="request"
        form={form}
        submitLabel="Request remote work"
        canSubmit={!!form.employee && validRange}
        whyNot={!form.employee ? "Pick whose remote work this is." : rangeInverted ? "The end date is before the start date." : "Set the dates you'll be remote."}
        onSubmit={submit}
      >
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
            <Field label="To" error={rangeInverted ? "The end date is before the start date." : undefined}><Input type="date" value={form.end_date} min={form.start_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></Field>
          </FieldRow>
          {/* The three ranges people actually ask for, one click each. */}
          <div className="-mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Quick pick</span>
            {[
              { label: "Today", from: ymdIn(0), to: ymdIn(0) },
              { label: "Tomorrow", from: ymdIn(1), to: ymdIn(1) },
              { label: "Rest of the week", from: ymdIn(0), to: endOfWeek() },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setForm({ ...form, start_date: p.from, end_date: p.to, startSession: 1, endSession: 2 })}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                  form.start_date === p.from && form.end_date === p.to && "border-primary bg-primary/10 text-primary",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {form.start_date && form.start_date === form.end_date ? (
            <Field label="Duration">
              <Segmented
                label="Duration"
                value={form.startSession === 1 && form.endSession === 2 ? "full" : form.startSession === 1 ? "am" : "pm"}
                onChange={(v) => setForm({ ...form, startSession: v === "pm" ? 2 : 1, endSession: v === "am" ? 1 : 2 })}
                options={[
                  { value: "full", label: "Full day" },
                  { value: "am", label: "Morning", hint: "First half of the day" },
                  { value: "pm", label: "Afternoon", hint: "Second half of the day" },
                ]}
              />
            </Field>
          ) : form.start_date && form.end_date && form.end_date > form.start_date ? (
            <FieldRow>
              <Field label="First day">
                <Segmented label="First day" value={form.startSession} onChange={(v) => setForm({ ...form, startSession: v })} options={[{ value: 1, label: "Full day" }, { value: 2, label: "Afternoon only" }]} />
              </Field>
              <Field label="Last day">
                <Segmented label="Last day" value={form.endSession} onChange={(v) => setForm({ ...form, endSession: v })} options={[{ value: 2, label: "Full day" }, { value: 1, label: "Morning only" }]} />
              </Field>
            </FieldRow>
          ) : null}
          {previewDays != null && (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
              <span className="text-lg font-semibold tabular-nums text-foreground">{previewDays}</span> remote day{previewDays === 1 ? "" : "s"} requested
              <span className="block text-xs">Calendar days in the range. Remote days aren't charged to any leave balance.</span>
            </p>
          )}
          {/* `htmlFor` by hand: Field can only bind its label when the field holds a SINGLE control, and this
              one also carries a datalist and the recent-location chips - so without this the label named
              nothing, for a screen reader or for anything else looking the control up by its name. */}
          <Field label="Location" htmlFor="remote-location" hint="Where you'll work from.">
            <Input id="remote-location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Home" list="remote-locations" />
            <datalist id="remote-locations">{knownLocations.map((l) => <option key={l} value={l} />)}</datalist>
            {knownLocations.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {knownLocations.slice(0, 5).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setForm({ ...form, location: l })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                      form.location.trim() === l && "border-primary bg-primary/10 text-primary",
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label="Reason"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Optional" /></Field>
      </WriteDialog>
    </div>
  );
}
