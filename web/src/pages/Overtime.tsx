import { useEffect, useMemo, useState } from "react";
import { Plus, Ban } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useClock, listAllSessions } from "@/lib/clock";
import { hhmmToMin, localDay, localMinutes, zonedInstant } from "@/lib/attendance";
import { orgDayOf, orgTimezone, thisMonthStr, todayStr } from "@/lib/orgDay";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { formatDate, idOf, personName } from "@/lib/utils";
import { navigate, navigateTab } from "@/router";
import type { OvertimeRequest, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RequestsHistoryTabs, type RequestsHistorySearch } from "@/components/common/RequestsHistoryTabs";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { withNewBadge } from "@/components/common/NewBadge";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { TimeRangeField, fmtDuration } from "@/components/common/TimeRangeField";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

const pad = (n: number) => String(n).padStart(2, "0");
const upper = (s?: string) => (s ?? "").toUpperCase();

// EVERY DATE ON THIS PAGE IS THE ORG'S, not the viewer's.
//
// These were built on the browser's clock (`new Date().getFullYear()` and friends) while the punch lookup in
// the same file reads days with `localDay(iso, sched.timezone)` - so the two sides of one `===` were in
// different zones, inside the effect that documents the distinction. Overtime is worked late by definition, so
// its instants sit right against a midnight: a session clocked out at 01:30 IST on 11 March is
// `2026-03-10T20:00Z`, which the viewer's clock in the UK calls the 10th and the org calls the 11th. The punch
// chip then silently never appeared, for precisely the late shifts it exists for.
//
// It also moved money-adjacent totals: bucketing by the viewer's calendar meant two HR admins in different
// zones read DIFFERENT approved-overtime totals per employee for the same month.
const orgYmd = (iso?: string) => (iso ? orgDayOf(iso) : "");
const orgHhmm = (iso?: string) => {
  if (!iso) return "";
  const m = localMinutes(iso, orgTimezone());
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const thisMonth = () => thisMonthStr();

export default function Overtime({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<OvertimeRequest>("overtime-requests");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const guardClose = useDiscardGuard();
  const sched = useClock().sched; // org shift end + timezone, for reading overtime off the punch log
  const canCreate = usePermission("overtime-requests.write");
  const canDecide = usePermission("overtime-requests.approve");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee: "", start_time: "", end_time: "", reason: "" });
  const [month, setMonth] = useState(thisMonth());
  const [pickOther, setPickOther] = useState(false); // the form's employee row expanded into the full picker
  // A range read off the day's punches, offered as a chip: the hours are already recorded, so retyping them
  // from the punch log is work the form can do.
  const [fromPunches, setFromPunches] = useState<{ start: string; end: string } | null>(null);
  const [seedNonce, setSeedNonce] = useState(0); // bumped when the range is filled in programmatically

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string, unknown?: string) => personName(employees, p, unknown);
  const isSelf = !!me.employee_id && !!form.employee && idOf(form.employee) === me.employee_id;

  const pendingTotal = useMemo(() => rows.filter((r) => upper(r.state) === "PENDING").length, [rows]);
  // My approved overtime in the current calendar month, and approved-but-not-yet-paid overall.
  const myMonthMinutes = useMemo(() => {
    if (!me.employee_id) return 0;
    const cur = thisMonth();
    return rows
      .filter((r) => r.employee && idOf(r.employee) === me.employee_id && upper(r.state) === "APPROVED" && orgYmd(r.start_time).slice(0, 7) === cur)
      .reduce((s, r) => s + (r.minutes || 0), 0);
  }, [rows, me.employee_id]);
  const unpaidMinutes = useMemo(
    () => rows.filter((r) => upper(r.state) === "APPROVED" && !r.paid).reduce((s, r) => s + (r.minutes || 0), 0),
    [rows],
  );
  const myPendingCount = useMemo(
    () => (me.employee_id ? rows.filter((r) => r.employee && idOf(r.employee) === me.employee_id && upper(r.state) === "PENDING").length : 0),
    [rows, me.employee_id],
  );

  // Approved overtime per employee for the selected ORG month: minutes summed -> total hours+minutes.
  const monthlyTotals = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of rows) {
      if (upper(r.state) !== "APPROVED" || orgYmd(r.start_time).slice(0, 7) !== month) continue;
      const key = r.employee ?? "";
      by.set(key, (by.get(key) ?? 0) + (r.minutes || 0));
    }
    return [...by.entries()].map(([e, mins]) => ({ employee: e, minutes: mins })).sort((a, b) => b.minutes - a.minutes);
  }, [rows, month]);
  const monthTotalMinutes = monthlyTotals.reduce((s, t) => s + t.minutes, 0);
  // Anchored at UTC and rendered there, so the header names the month the buckets above were built from
  // rather than the viewer's reading of its first midnight.
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

  // `prefill` carries a range worked past the shift end, handed over by the Attendance page's "Log overtime"
  // on a long day - so the hours are already in the form instead of being re-typed from the punch log.
  function openCreate(prefill?: unknown) {
    const p = prefill as { start_time?: string; end_time?: string; reason?: string } | undefined;
    // Seeded from the ORG's shift end on the org's today, not a hard-coded 18:00 on the viewer's clock: a
    // remote employee's form used to pre-fill six in the evening THEIR time, while `sched.shift_end` - the
    // boundary the punch effect below treats as the start of overtime - was sitting right here unused.
    const s = zonedInstant(todayStr(), sched.shift_end, sched.timezone);
    const e = new Date(+new Date(s) + 3600000).toISOString();
    const seed = {
      employee: me.employee_id ? `employees/${me.employee_id}` : "",
      start_time: p?.start_time ?? s,
      end_time: p?.end_time ?? e,
      reason: p?.reason ?? "",
    };
    setForm(seed);
    setPickOther(false);
    setFromPunches(null);
    setOpen(true);
  }

  const validRange = !!form.start_time && !!form.end_time && +new Date(form.end_time) > +new Date(form.start_time);

  // Requests for the same person whose hours overlap the range being logged. Double-logging the same evening is
  // the easy mistake here (a shared laptop, a second look at the punch log), and the data to catch it is loaded.
  const overlapping = useMemo(() => {
    if (!form.employee || !validRange) return [] as OvertimeRequest[];
    const s = +new Date(form.start_time), e = +new Date(form.end_time);
    return rows.filter((r) => {
      if (!r.employee || idOf(r.employee) !== idOf(form.employee)) return false;
      if (!["PENDING", "APPROVED"].includes(upper(r.state))) return false;
      if (!r.start_time || !r.end_time) return false;
      return +new Date(r.start_time) < e && +new Date(r.end_time) > s;
    });
  }, [rows, form.employee, form.start_time, form.end_time, validRange]);

  // The punch-derived suggestion, refreshed whenever the dialog's person or day changes. One lazy read behind an
  // explicit open, in the shape the Attendance page's "log overtime" already hands over.
  // The ORG's day, which is what `localDay(..., tz)` inside the effect compares against - these were a
  // viewer-local day and an org-local day on the two sides of one `===`.
  const formDay = orgYmd(form.start_time);
  useEffect(() => {
    if (!open || !form.employee || !formDay) { setFromPunches(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        // The window is in UTC instants and the day is org-local, so it is widened by a day on each side and
        // the exact day is settled by localDay below - otherwise a zone behind UTC loses its own evening.
        const dayMs = 86_400_000;
        const mid = +new Date(`${formDay}T12:00:00Z`);
        const sessions = await listAllSessions(`attendance?from=${encodeURIComponent(new Date(mid - dayMs).toISOString())}&to=${encodeURIComponent(new Date(mid + dayMs).toISOString())}`);
        const tz = sched.timezone;
        const ends = sessions
          .filter((s) => s.employee && idOf(s.employee) === idOf(form.employee) && s.clock_out && localDay(s.clock_out, tz) === formDay)
          .map((s) => s.clock_out!);
        // Compared as INSTANTS, not as strings. A bare `.sort()` orders lexicographically, which agrees with
        // chronological order only while every value is the same spelling of the same zone - and `clock_out`
        // is a timestamp off the wire, so an offset form (`+05:30`) or a different fractional-second width is
        // all it takes for the two orders to part. Picking the wrong "last punch out" here does not fail; it
        // pre-fills the overtime dialog with an earlier departure, which is a shorter claim nobody queries.
        const last = [...ends].sort((a, b) => +new Date(a) - +new Date(b))[ends.length - 1];
        // Only a departure comfortably past the shift end is overtime worth offering.
        if (!cancelled) {
          const past = last && localMinutes(last, tz) > hhmmToMin(sched.shift_end) + 15;
          setFromPunches(past ? { start: zonedInstant(formDay, sched.shift_end, tz), end: last! } : null);
        }
      } catch { if (!cancelled) setFromPunches(null); }
    })();
    return () => { cancelled = true; };
  }, [open, form.employee, formDay, sched.timezone, sched.shift_end]);

  async function submit() {
    await create("overtime-requests", {
      employee: form.employee,
      start_time: form.start_time,
      end_time: form.end_time,
      reason: form.reason.trim(),
    });
    toast({ title: "Overtime logged", variant: "success" });
    reload();
  }

  async function action(r: OvertimeRequest, verb: "approve" | "reject" | "cancel") {
    if (!(await confirmDecision(confirm, verb, `${empName(r.employee)}'s overtime on ${formatDate(orgYmd(r.start_time))}`))) return;
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
    { id: "date", header: "Date", accessor: (r) => orgYmd(r.start_time), cell: (r) => formatDate(orgYmd(r.start_time)) },
    { id: "worked", header: "Worked", sortable: false, accessor: (r) => orgHhmm(r.start_time), cell: (r) => <span className="tabular-nums text-muted-foreground">{orgHhmm(r.start_time)}-{orgHhmm(r.end_time)}{orgYmd(r.end_time) !== orgYmd(r.start_time) && <span className="text-amber-600 dark:text-amber-400"> +1</span>}</span> },
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

  const addBtn = canCreate && <AccessAction collection="overtime-requests" create><Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> Log overtime</Button></AccessAction>;

  const renderTable = (search: RequestsHistorySearch, data: OvertimeRequest[], columns: Column<OvertimeRequest>[], tableId: string, emptyTitle: string) => (
    <DataTable columns={columns} tableId={tableId} rows={data} search={search} getRowId={(r) => r.path} emptyTitle={emptyTitle} emptyAction={addBtn} accessCollection="overtime-requests" accessTargetOf={(r) => ({ objectPath: r.path, label: `${empName(r.employee)} · ${orgYmd(r.start_time)}`, can: r.access?.can })} />
  );

  return (
    <div>
      <PageHeader title="Overtime" actions={addBtn} />
      {/* The minute totals below are summed over the loaded rows, which are one page of the collection. */}
      <TruncationNotice collection="overtime-requests" what="overtime requests" className="mb-3" />

      {state === "ready" && (
        <SummaryStrip
          items={[
            // Pending decisions belong to the Approvals inbox, own requests to the Requests tab, and settled
            // hours to History - so each metric opens the surface that can actually act on it.
            { label: "Pending", value: pendingTotal, tone: pendingTotal ? "warning" : "muted", hint: canDecide ? "decide in Approvals" : "awaiting a call", onClick: () => (canDecide ? navigate("approvals") : navigateTab("overtime", "requests")) },
            ...(myPendingCount ? [{ label: "Your requests in flight", value: myPendingCount, tone: "warning" as const, hint: "open your requests", onClick: () => navigateTab("overtime", "requests") }] : []),
            { label: "My overtime this month", value: fmtDuration(myMonthMinutes), hint: "approved", tone: myMonthMinutes ? "default" : "muted", onClick: () => navigateTab("overtime", "history") },
            { label: "Approved, unpaid", value: fmtDuration(unpaidMinutes), hint: "not in a run yet", tone: unpaidMinutes ? "default" : "muted", onClick: () => navigateTab("overtime", "history") },
            // The month card below is the payroll answer for one month; the metric jumps the reader to it.
            { label: `Approved in ${monthLabel}`, value: fmtDuration(monthTotalMinutes), tone: monthTotalMinutes ? "primary" : "muted", hint: `${monthlyTotals.length} ${monthlyTotals.length === 1 ? "person" : "people"}`, onClick: () => document.getElementById("overtime-month-card")?.scrollIntoView({ behavior: "smooth", block: "start" }) },
          ]}
        />
      )}

      {/* Monthly approved totals (sum of all approved overtime minutes for the month). */}
      <Card id="overtime-month-card" className="mb-4 scroll-mt-24 p-4">
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Log overtime"
        description="Extra hours worked beyond the normal day. They are approved first, then paid."
        collection="overtime-requests"
        guardLabel="overtime entry"
        form={form}
        submitLabel="Log overtime"
        canSubmit={!!form.employee && validRange}
        whyNot={!form.employee ? "Pick whose overtime this is." : !form.start_time || !form.end_time ? "Set when the extra hours started and ended." : "The end time must be after the start."}
        onSubmit={submit}
      >
          {/* The common case is logging your own hours, so "who" collapses to a line of text with a way out of it.
              A picker as the first field makes a self-service form read like an admin one. */}
          <Field label="Employee">
            {isSelf && !pickOther ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
                <span className="inline-flex min-w-0 items-center gap-2 text-sm">
                  <PhotoAvatar employeeId={me.employee_id ?? ""} name={empName(form.employee)} photo={emp(form.employee)?.photo} className="h-7 w-7" />
                  <span className="truncate font-medium">{empName(form.employee)}</span>
                  <Badge variant="muted">You</Badge>
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setPickOther(true)}>Someone else</Button>
              </div>
            ) : (
              <Combobox
                value={form.employee}
                onValueChange={(v) => setForm({ ...form, employee: v })}
                placeholder="Select an employee…"
                searchPlaceholder="Search employees…"
                options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
              />
            )}
          </Field>
          <Field label="When" error={!validRange ? "The end time must be after the start." : undefined}>
            {/* Keyed on the seed counter only: the control owns its own state, so it must remount when the form
                is filled FOR it (the punch-log chip) but never while someone is editing it. */}
            <TimeRangeField key={seedNonce} initialStart={form.start_time} initialEnd={form.end_time} onChange={(s, e) => setForm((f) => ({ ...f, start_time: s, end_time: e }))} />
          </Field>
          {/* The punch log already knows when they left. Offering it as a chip beats reading it off another page. */}
          {fromPunches && (fromPunches.start !== form.start_time || fromPunches.end !== form.end_time) && (
            <button type="button" onClick={() => { setForm((f) => ({ ...f, start_time: fromPunches.start, end_time: fromPunches.end })); setSeedNonce((n) => n + 1); }}
              className="self-start rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary">
              From the punch log: <span className="tabular-nums">{orgHhmm(fromPunches.start)}-{orgHhmm(fromPunches.end)}</span> ({fmtDuration(Math.round((+new Date(fromPunches.end) - +new Date(fromPunches.start)) / 60000))})
            </button>
          )}
          {overlapping.length > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              These hours overlap {overlapping.length === 1 ? "a request" : `${overlapping.length} requests`} already filed: {overlapping.map((r) => `${orgHhmm(r.start_time)}-${orgHhmm(r.end_time)} on ${orgYmd(r.start_time)}`).join(", ")}.
            </p>
          )}
          <Field label="Reason" hint="Whoever approves this reads it - say what the extra hours were for.">
            <Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="What was the extra work?" />
          </Field>
          <p className="text-xs text-muted-foreground">Once approved, the hours are paid in the next payroll run.</p>
      </WriteDialog>
    </div>
  );
}
