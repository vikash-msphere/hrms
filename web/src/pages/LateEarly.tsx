import { useMemo, useState } from "react";
import { Plus, Ban, AlarmClock, LogOut, Info } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { useClock } from "@/lib/clock";
import { cn, formatDate, idOf, personIndex, personName } from "@/lib/utils";
import { orgDayFromToday, thisMonthStr, todayStr } from "@/lib/orgDay";
import { localMinutes } from "@/lib/attendance";
import { navigate, navigateTab } from "@/router";
import type { Employee, LateEarlyRequest, Me } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { daysSince, fmtDaysCount, monthKey, monthLabel } from "@/lib/tableDerive";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Segmented } from "@/components/common/Segmented";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { KIND_LABEL, fmtMinutes, policySummary, usePunctualityPolicy, type LateEarlyKind } from "@/lib/lateEarly";
import { checkFiling, hhmmOf, minOfDay } from "../../../src/domain/punctuality";

const upper = (s?: string) => (s ?? "").toUpperCase();
const LIVE = new Set(["PENDING", "APPROVED"]);

type Form = { employee: string; date: string; kind: LateEarlyKind; at: string; reason: string };
/** What another page hands over when it opens this form (the attendance grid's "Request late arrival"). */
export type LateEarlyPrefill = Partial<Pick<Form, "date" | "kind" | "at" | "reason">>;

// A sensible first guess for the time: an hour past the shift start, or an hour before its end - the most
// common ask, and a value the person adjusts rather than builds from nothing.
const defaultAt = (kind: LateEarlyKind, sched: { shift_start: string; shift_end: string }) =>
  hhmmOf(Math.max(0, Math.min(1439, kind === "late_arrival" ? minOfDay(sched.shift_start) + 60 : minOfDay(sched.shift_end) - 60)));

export default function LateEarly({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<LateEarlyRequest>("late-early-requests");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { sched } = useClock();
  const policy = usePunctualityPolicy();
  const { toast } = useToast();
  const confirm = useConfirm();
  const canCreate = usePermission("late-early-requests.write");
  const canDecide = usePermission("late-early-requests.approve");

  const offered = useMemo(
    () => (["late_arrival", "early_departure"] as const).filter((k) => policy.requests.enabled && policy.requests[k]),
    [policy],
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>({ employee: "", date: todayStr(), kind: "late_arrival", at: "10:00", reason: "" });

  const empIdx = useMemo(() => personIndex(employees), [employees]);
  const empName = (p?: string | null, unknown?: string) => personName(empIdx, p ?? undefined, unknown);
  const emp = (p?: string | null) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const mine = (r: LateEarlyRequest) => !!r.employee && !!me.employee_id && idOf(r.employee) === me.employee_id;

  function openCreate(prefill?: unknown) {
    const p = (prefill ?? {}) as LateEarlyPrefill;
    const kind = p.kind && offered.includes(p.kind) ? p.kind : offered[0] ?? "late_arrival";
    setForm({
      employee: me.employee_id ? `employees/${me.employee_id}` : "",
      date: p.date ?? todayStr(),
      kind,
      at: p.at ?? defaultAt(kind, sched),
      reason: p.reason ?? "",
    });
    setOpen(true);
  }
  useIntent("new-late-early", openCreate);

  // The same verdict the server reaches (domain/punctuality.ts#checkFiling), over the rows already loaded: the
  // person sees "this is past your allowance" or "this will be approved straight away" before pressing Submit.
  // Holidays and leave are left to the server - it refuses those days in words, and reading two more
  // collections here for a sentence the submit already returns is not worth the reads.
  const verdict = useMemo(() => {
    if (!form.date || !form.at || !/^\d{2}:\d{2}$/.test(form.at)) return null;
    const month = form.date.slice(0, 7);
    const monthRequests = rows
      .filter((r) => r.employee && idOf(r.employee) === idOf(form.employee) && LIVE.has(upper(r.state)) && (r.date ?? "").slice(0, 7) === month && r.kind)
      .map((r) => ({ kind: r.kind as LateEarlyKind, minutes: r.minutes ?? 0, date: r.date! }));
    return checkFiling({
      kind: form.kind, date: form.date, at: form.at, reason: form.reason, sched, policy,
      todayYmd: todayStr(),
      nowMin: localMinutes(new Date().toISOString(), sched.timezone),
      isHoliday: false,
      onFullLeave: false,
      monthRequests,
    });
  }, [form, rows, sched, policy]);
  const duplicate = useMemo(
    () => rows.some((r) => r.employee && idOf(r.employee) === idOf(form.employee) && r.date === form.date && r.kind === form.kind && LIVE.has(upper(r.state))),
    [rows, form],
  );

  // Throws on failure - the server's reason (the allowance, the filing window) is what the next edit has to
  // answer, so WriteDialog keeps it in the form rather than in a toast.
  async function submit() {
    const row = await create<LateEarlyRequest>("late-early-requests", {
      employee: form.employee, date: form.date, kind: form.kind, at: form.at, reason: form.reason.trim() || null,
    });
    toast({
      title: row?.auto_approved ? `${KIND_LABEL[form.kind]} approved` : `${KIND_LABEL[form.kind]} requested`,
      description: row?.auto_approved ? "Within the policy's auto-approval limit, so nobody has to decide it." : row?.over_limit ? "Past the monthly allowance - your approver will see that." : undefined,
      variant: "success",
    });
    reload();
  }

  async function cancel(r: LateEarlyRequest) {
    if (!(await confirmDecision(confirm, "cancel", `your ${KIND_LABEL[r.kind as LateEarlyKind]?.toLowerCase() ?? "request"} on ${formatDate(r.date)}`))) return;
    try {
      await invoke("late-early-requests/" + idOf(r.path), "cancel", r.etag);
      toast({ title: "Request cancelled", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't cancel the request", description: (e as Error).message, variant: "destructive" });
    }
  }

  const pendingTotal = useMemo(() => rows.filter((r) => upper(r.state) === "PENDING").length, [rows]);
  const myPending = useMemo(() => rows.filter((r) => mine(r) && upper(r.state) === "PENDING").length, [rows, me.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const myMonth = useMemo(() => {
    const m = thisMonthStr();
    const live = rows.filter((r) => mine(r) && LIVE.has(upper(r.state)) && (r.date ?? "").slice(0, 7) === m);
    return { count: live.length, minutes: live.reduce((s, r) => s + (r.minutes ?? 0), 0) };
  }, [rows, me.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowance = policy.requests.monthly_count;

  const empCol: Column<LateEarlyRequest> = {
    id: "employee", header: "Employee", filter: "select", groupBy: true, accessor: (r) => empName(r.employee),
    cell: (r) => { const e = emp(r.employee); return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={r.employee ? idOf(r.employee) : ""} name={empName(r.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(r.employee)}</span>; },
  };
  const baseCols: Column<LateEarlyRequest>[] = [
    { id: "date", header: "Day", filter: "date", accessor: (r) => r.date ?? "", cell: (r) => <span className="tabular-nums">{formatDate(r.date)}</span> },
    {
      id: "kind", header: "Request", filter: "select", groupBy: true, accessor: (r) => KIND_LABEL[r.kind as LateEarlyKind] ?? r.kind ?? "",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.kind === "early_departure" ? <LogOut className="h-3.5 w-3.5 text-muted-foreground" /> : <AlarmClock className="h-3.5 w-3.5 text-muted-foreground" />}
          {KIND_LABEL[r.kind as LateEarlyKind] ?? r.kind}
        </span>
      ),
    },
    {
      id: "at", header: "Time", accessor: (r) => r.at ?? "",
      cell: (r) => <span className="tabular-nums">{r.kind === "early_departure" ? "Leave at " : "In by "}{r.at}</span>,
    },
    { id: "minutes", header: "Minutes", align: "right", filter: "number", aggregate: "sum", accessor: (r) => r.minutes, cell: (r) => <span className="tabular-nums">{fmtMinutes(r.minutes ?? 0)}</span> },
    {
      id: "state", header: "Status", filter: "select", groupBy: true, accessor: (r) => upper(r.state),
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StatusBadge state={r.state} />
          {r.auto_approved && <Badge variant="muted">By policy</Badge>}
          {r.over_limit && <Badge variant="warning">Over allowance</Badge>}
        </span>
      ),
    },
    { id: "reason", header: "Reason", accessor: (r) => r.reason ?? "", cell: (r) => r.reason || <span className="text-muted-foreground">-</span> },
    { id: "month", header: "Month", filter: "select", groupBy: true, defaultHidden: true, accessor: (r) => monthKey(r.date ?? ""), cell: (r) => monthLabel(monthKey(r.date ?? "")) },
    {
      id: "waiting", header: "Waiting", align: "right", defaultHidden: true, filter: "number", formatTotal: fmtDaysCount,
      accessor: (r) => (upper(r.state) === "PENDING" ? daysSince(r.create_time) : null),
      cell: (r) => {
        const d = upper(r.state) === "PENDING" ? daysSince(r.create_time) : null;
        if (d == null) return <span className="text-muted-foreground">-</span>;
        return <span className={cn("tabular-nums text-xs", d >= 2 ? "font-medium text-warning" : "text-muted-foreground")}>{fmtDaysCount(d)}</span>;
      },
    },
  ];
  const noteCol: Column<LateEarlyRequest> = {
    id: "decision_note", header: "Decision note", accessor: (r) => r.decision_note ?? "",
    cell: (r) => r.decision_note || <span className="text-muted-foreground">-</span>,
  };
  // The Requests tab is the caller's own live requests - cancellable while pending. Deciding lives in Approvals.
  const cancelCol: Column<LateEarlyRequest> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => (
      <div className="flex items-center justify-end gap-1">
        {upper(r.state) === "PENDING" && (
          <AccessAction collection="late-early-requests" objectPath={r.path} verb="cancel" can={r.access?.can} label="Cancel">
            <Button size="sm" variant="ghost" onClick={() => cancel(r)}><Ban className="h-4 w-4" /> Cancel</Button>
          </AccessAction>
        )}
        <RowActivityButton resource={r.path} />
      </div>
    ),
  };
  const activityCol: Column<LateEarlyRequest> = { id: "activity", header: "", sortable: false, filter: "none", align: "right", cell: (r) => <RowActivityButton resource={r.path} /> };
  const requestsCols = [...baseCols, ...metaColumns<LateEarlyRequest>(), cancelCol];
  const historyCols = withNewBadge(canDecide ? [empCol, ...baseCols, noteCol, ...metaColumns<LateEarlyRequest>(), activityCol] : [...baseCols, noteCol, ...metaColumns<LateEarlyRequest>(), activityCol]);

  const addBtn = canCreate && offered.length > 0 && (
    <AccessAction collection="late-early-requests" create>
      <Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> Request</Button>
    </AccessAction>
  );
  const renderTable = (search: RequestsHistorySearch, data: LateEarlyRequest[], columns: Column<LateEarlyRequest>[], tableId: string, emptyTitle: string) => (
    <DataTable columns={columns} tableId={tableId} rows={data} search={search} getRowId={(r) => r.path} emptyTitle={emptyTitle} emptyAction={addBtn} accessCollection="late-early-requests" accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${r.date}`, can: r.access?.can })} />
  );

  const rules = policySummary(policy);
  const offeredOptions = offered.map((k) => ({ value: k, label: KIND_LABEL[k], hint: k === "late_arrival" ? "Coming in after the shift starts" : "Leaving before the shift ends" }));
  const usage = verdict?.usage;

  return (
    <div>
      <PageHeader
        title="Late arrival & early departure"
        description="Ask ahead, or after the day, to come in late or leave early. Approved time is judged as the day's own start or end."
        actions={<><PageSettings me={me} host="late-early" />{addBtn}</>}
      />
      <TruncationNotice collection="late-early-requests" what="late arrival and early departure requests" className="mb-3" />

      {state === "ready" && (
        <SummaryStrip
          items={[
            { label: "Pending", value: pendingTotal, tone: pendingTotal ? "warning" : "muted", hint: canDecide ? "decide in Approvals" : "awaiting a call", onClick: () => (canDecide ? navigate("approvals") : navigateTab("late-early", "requests")) },
            ...(myPending ? [{ label: "Your requests in flight", value: myPending, tone: "warning" as const, hint: "open your requests", onClick: () => navigateTab("late-early", "requests") }] : []),
            {
              label: "Yours this month",
              value: allowance != null ? `${myMonth.count} of ${allowance}` : myMonth.count,
              hint: myMonth.minutes ? `${fmtMinutes(myMonth.minutes)} asked for` : "nothing asked for yet",
              tone: allowance != null && myMonth.count >= allowance ? "warning" : myMonth.count ? "default" : "muted",
              onClick: () => navigateTab("late-early", "history"),
            },
          ]}
        />
      )}

      <Card className="mb-6">
        <CardContent className="flex gap-3 p-4 sm:p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">How it works here</p>
            <ul className="space-y-0.5 text-muted-foreground">
              {rules.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </CardContent>
      </Card>

      <RequestsHistoryTabs
        collection="late-early-requests"
        pageKey="late-early"
        rows={rows}
        state={state}
        error={error}
        reload={reload}
        meEmployeeId={me.employee_id}
        canDecide={canDecide}
        accessLabel="Late arrival and early departure requests"
        render={(items, mode, search) =>
          mode === "requests"
            ? renderTable(search, items, requestsCols, "le-active", "No active requests")
            : renderTable(search, items, historyCols, "le-history", "No late arrival or early departure history")
        }
      />

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Request ${KIND_LABEL[form.kind].toLowerCase()}`}
        description={verdict?.autoApprove ? "Within the auto-approval limit, so it is approved as soon as you send it." : "Goes to your manager or HR to decide."}
        collection="late-early-requests"
        guardLabel="request"
        form={form}
        submitLabel={verdict?.autoApprove ? "Send (approved on sending)" : "Send request"}
        canSubmit={!!form.employee && !!verdict && verdict.errors.length === 0 && !duplicate}
        // Every refusal the policy has, not the first: a request short of three things says all three.
        whyNot={[
          !form.employee && "Pick whose day this is.",
          duplicate && `There is already a ${KIND_LABEL[form.kind].toLowerCase()} request for that day.`,
          ...(verdict ? verdict.errors : ["Set the day and the time."]),
        ]}
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
        {offeredOptions.length > 1 && (
          <Field label="Request">
            <Segmented label="Request" value={form.kind} onChange={(k) => setForm({ ...form, kind: k, at: defaultAt(k, sched) })} options={offeredOptions} />
          </Field>
        )}
        <FieldRow>
          <Field label="Day"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field
            label={form.kind === "late_arrival" ? "I'll be in by" : "I'll leave at"}
            hint={form.kind === "late_arrival" ? `The shift starts at ${sched.shift_start}.` : `The shift ends at ${sched.shift_end}.`}
          >
            <Input type="time" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
          </Field>
        </FieldRow>
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Quick pick</span>
          {[{ label: "Today", d: orgDayFromToday(0) }, { label: "Tomorrow", d: orgDayFromToday(1) }].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setForm({ ...form, date: p.d })}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent", form.date === p.d && "border-primary bg-primary/10 text-primary")}
            >
              {p.label}
            </button>
          ))}
        </div>
        {verdict && verdict.minutes > 0 && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p>
              <span className="text-lg font-semibold tabular-nums">{fmtMinutes(verdict.minutes)}</span>{" "}
              <span className="text-muted-foreground">{form.kind === "late_arrival" ? "after the shift starts" : "before the shift ends"}</span>
            </p>
            {usage && (usage.countLimit != null || usage.minutesLimit != null) && (
              <p className={cn("text-xs", verdict.overLimit || verdict.errors.some((e) => e.includes("allowance")) ? "text-warning" : "text-muted-foreground")}>
                This month with it: {usage.count}{usage.countLimit != null ? ` of ${usage.countLimit}` : ""} request{usage.count === 1 ? "" : "s"}
                {usage.minutesLimit != null ? `, ${fmtMinutes(usage.minutes)} of ${fmtMinutes(usage.minutesLimit)}` : ""}.
                {verdict.overLimit ? " Past the allowance - it still goes in, flagged for your approver." : ""}
              </p>
            )}
          </div>
        )}
        <Field label="Reason">
          <Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={policy.requests.reason_required ? "Required" : "Optional"} />
        </Field>
      </WriteDialog>
    </div>
  );
}
