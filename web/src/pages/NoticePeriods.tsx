import { useEffect, useMemo, useState } from "react";
import { LogOut, Plus, Check, Pencil, Trash2, RotateCcw, ShieldX, Undo2, UserMinus, Laptop } from "lucide-react";
import { create, patch, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { DEFAULT_TRANSITION_TEMPLATES, type TransitionTemplate } from "@/lib/transitions";
import { Checkbox } from "@/components/ui/checkbox";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf, humanize, personIndex, personName } from "@/lib/utils";
import { daysBetweenYmd, todayStr } from "@/lib/orgDay";
import type { Asset, Department, NoticePeriod, Employee, Me } from "@/types";
import { countBy } from "@/lib/tableSignals";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { type TableInsight } from "@/components/common/TableInsights";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

const TYPES = ["resignation", "termination", "retirement", "other"];
const EMPTY = { employee: "", type: "resignation", notice_date: todayStr(), last_working_day: "", status: "serving", reason: "", notes: "", start_offboarding: false, template: "" };

function StatusBadge({ n }: { n: NoticePeriod }) {
  if (n.status === "completed") return <Badge variant="muted">Exited</Badge>;
  if (n.status === "withdrawn") return <Badge variant="secondary">Withdrawn</Badge>;
  return <Badge variant="warning">Serving</Badge>;
}

// While serving, how urgent is the countdown - a served-time bar plus the days-left badge, so
// notice date → last working day reads as a timeline at a glance.
function RemainingBadge({ n }: { n: NoticePeriod }) {
  if (n.status !== "serving") return <span className="text-muted-foreground">-</span>;
  // `days_remaining` IS FLOOR-CLAMPED, not a countdown: the serializer returns `Math.max(0, ...)`, so a last
  // working day three days ago and one three months ago both arrive as 0, indistinguishable from a last day
  // that is genuinely today. Read as a date it painted a full bar and a destructive "Last day" over everybody
  // who had already left - an HR admin scanning this table was told somebody who went in March leaves today.
  // The dates on the row answer it exactly, which is what `isPastExit` below already does.
  const over = n.last_working_day < todayStr();
  const d = n.days_remaining ?? 0;
  const daysOver = over ? daysBetweenYmd(n.last_working_day, todayStr()) : 0;
  const total = n.total_days ?? 0;
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round(((total - Math.max(0, d)) / total) * 100))) : 0;
  const variant = over ? "destructive" : d <= 0 ? "destructive" : d <= 7 ? "warning" : "secondary";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" title={over ? "Notice period is over" : `${pct}% of the notice served`}>
        <span className={cn("block h-full rounded-full", over ? "bg-destructive" : d <= 7 ? "bg-warning" : "bg-primary")} style={{ width: `${over ? 100 : pct}%` }} />
      </span>
      <Badge variant={variant} className="tabular-nums">
        {over ? `Overdue ${daysOver}d` : d <= 0 ? "Last day" : `${d}d left`}
      </Badge>
    </span>
  );
}

export default function NoticePeriods({ me, openId }: { me: Me; openId?: string }) {
  void me;
  const { rows, state, error, reload } = useCollection<NoticePeriod>("notice-periods", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const sd = useSoftDelete("notice-periods", "notice period", reload);
  const writable = usePermission("notice-periods.write");
  const canPurge = usePermission("notice-periods.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NoticePeriod | null>(null);
  const [form, setForm] = useState(EMPTY);

  // Offboarding templates (for the "start offboarding" option), from settings with a default fallback.
  const [templates, setTemplates] = useState<TransitionTemplate[]>(DEFAULT_TRANSITION_TEMPLATES);
  useEffect(() => {
    getSetting<{ templates?: TransitionTemplate[] }>("transition-templates").then((s) => { if (s.value?.templates?.length) setTemplates(s.value.templates); }).catch(() => {});
  }, []);
  const offboardingTemplates = templates.filter((t) => t.kind === "offboarding");
  const chosenTemplate = offboardingTemplates.find((t) => t.id === form.template);

  // Kit still out with the people on this page. Read only where the caller can see assets at all - the
  // column is about company property, not about the leaver, so somebody without that grant gets the page
  // without it rather than a column of zeroes that would read as "nothing to collect".
  const canAssets = usePermission("assets.read");
  const { rows: assets } = useCollection<Asset>("assets", { enabled: canAssets });
  const assetsOut = useMemo(
    () => countBy(assets.filter((a) => a.assigned_to), (a) => idOf(a.assigned_to!)),
    [assets],
  );
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [departments]);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  /** The employee row behind a notice period, for the columns that read their department. */
  const empOf = (p?: string) => emp(p);
  // Built ONCE per directory read, not once per call - this is a DataTable column accessor (see `personName`).
  const empIdx = useMemo(() => personIndex(employees), [employees]);
  const empName = (p?: string, unknown?: string) => personName(empIdx, p, unknown);

  const isServing = (n: NoticePeriod) => !n.delete_time && n.status === "serving";
  const isThisMonth = (n: NoticePeriod) => isServing(n) && n.last_working_day.slice(0, 7) === todayStr().slice(0, 7);
  // Still marked serving after their own last working day: the record nobody closed, which leaves a login alive.
  const isPastExit = (n: NoticePeriod) => isServing(n) && n.last_working_day < todayStr();
  // `!isPastExit` rather than `days_remaining >= 0`, which cannot exclude anything: the server clamps that
  // value at zero (serialize.ts), so every overdue record satisfied it and landed in the "Last week of notice"
  // tile - diluting the hand-over window with people who left months ago, and double-counting them against the
  // "Past last working day" tile right beside it, which is the page's security-relevant queue.
  const isLeavingSoon = (n: NoticePeriod) => isServing(n) && !isPastExit(n) && (n.days_remaining ?? 0) <= 7;
  // On notice with no offboarding checklist started - the exit tasks nobody has kicked off.
  const isNoOffboarding = (n: NoticePeriod) => isServing(n) && !n.transition;
  const stats = useMemo(() => {
    const live = rows.filter(isServing);
    return {
      serving: live.length,
      exitingThisMonth: rows.filter(isThisMonth).length,
      leavingSoon: rows.filter(isLeavingSoon).length,
      pastExit: rows.filter(isPastExit).length,
      noOffboarding: rows.filter(isNoOffboarding).length,
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const kf = useKpiFocus<NoticePeriod, "all" | "serving" | "month" | "soon" | "pastExit" | "noOffboarding">({
    all: { label: "notice records", match: () => true },
    serving: { label: "people serving notice", match: isServing },
    month: { label: "exits this month", match: isThisMonth },
    soon: { label: "exits in the next week", match: isLeavingSoon },
    pastExit: { label: "records past their last working day", match: isPastExit },
    noOffboarding: { label: "exits with no offboarding started", match: isNoOffboarding },
  });

  // Default order: currently serving first (soonest exit at the top), then past records newest-exit first.
  const sorted = useMemo(() => kf.apply([...rows].sort((a, b) => {
    const ga = a.status === "serving" ? 0 : 1;
    const gb = b.status === "serving" ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return ga === 0 ? a.last_working_day.localeCompare(b.last_working_day) : b.last_working_day.localeCompare(a.last_working_day);
  })), [rows, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() { setEditing(null); setForm({ ...EMPTY, notice_date: todayStr() }); setOpen(true); }
  function openEdit(n: NoticePeriod) {
    setEditing(n);
    setForm({ employee: n.employee ? `employees/${idOf(n.employee)}` : "", type: n.type, notice_date: n.notice_date, last_working_day: n.last_working_day, status: n.status, reason: n.reason ?? "", notes: n.notes ?? "", start_offboarding: false, template: "" });
    setOpen(true);
  }
  function bodyFromForm() {
    // Empty fields go as `""`, never `null` - every service reads the empty string as "clear it", and a null
    // fails contract validation at the Prism proxy the dev server goes through (web/src/api.ts).
    return { employee: form.employee || "", type: form.type, notice_date: form.notice_date, last_working_day: form.last_working_day, status: form.status, reason: form.reason.trim(), notes: form.notes.trim() };
  }
  async function submit() {
    if (editing) { await patch("notice-periods/" + idOf(editing.path), bodyFromForm(), editing.etag); toast({ title: "Notice updated", variant: "success" }); }
    else {
      await create("notice-periods", { ...bodyFromForm(), start_offboarding: form.start_offboarding, template: form.start_offboarding ? form.template || "" : "" });
      toast({ title: form.start_offboarding ? "Notice recorded · offboarding started" : "Notice recorded", variant: "success" });
    }
    reload();
  }
  async function setStatus(n: NoticePeriod, status: string) {
    // Marking exited terminates the employee + disables their login - confirm first.
    if (status === "completed" && !(await confirm({ title: `Mark ${empName(n.employee)} as exited?`, description: "This terminates them and disables their login.", destructive: true, confirmLabel: "Mark exited" }))) return;
    try { await patch("notice-periods/" + idOf(n.path), { status }, n.etag); toast({ title: status === "completed" ? "Marked exited" : "Notice withdrawn", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }

  const validForm = !!form.employee && !!form.notice_date && !!form.last_working_day && form.last_working_day >= form.notice_date;
  // Inline feedback under the last-working-day field: the computed notice length, or why it's invalid.
  const lwdInvalid = !!form.notice_date && !!form.last_working_day && form.last_working_day < form.notice_date;
  const noticeDays = !lwdInvalid && form.notice_date && form.last_working_day
    ? Math.round((new Date(form.last_working_day).getTime() - new Date(form.notice_date).getTime()) / 86400000)
    : null;
  // A record still "serving" past its own last working day counts down into negative days and keeps the login
  // alive - almost always a status nobody came back to change.
  const pastExit = form.status === "serving" && !!form.last_working_day && form.last_working_day < todayStr();

  // An exit list is a countdown, so what matters is who leaves next and who has already gone without
  // anyone closing the record off.
  const noticeInsights = (ns: NoticePeriod[]): TableInsight[] => {
    const live = ns.filter((n) => !n.delete_time);
    const out: TableInsight[] = [];
    const soon = live.filter((n) => n.status === "serving" && (n.days_remaining ?? 0) >= 0 && (n.days_remaining ?? 0) <= 14);
    if (soon.length > 0) {
      out.push({
        id: "leaving-soon",
        label: `${soon.length} leaving within two weeks`,
        tone: "warning",
        hint: "Handover, final pay and getting the kit back all hang off the last working day.",
        filters: { status: "serving", remaining: "0..14" },
        sort: "lwd.asc",
      });
    }
    // Still "serving" with the last working day behind them: the record nobody came back to close, which
    // leaves the login alive.
    const overdue = live.filter((n) => n.status === "serving" && n.last_working_day < todayStr());
    if (overdue.length > 0) {
      out.push({
        id: "past-exit",
        label: `${overdue.length} past their last working day`,
        tone: "destructive",
        hint: "Still marked as serving. Mark them exited to close the account off.",
        filters: { status: "serving", lwd: "past" },
        sort: "lwd.asc",
      });
    }
    // Leaving with company kit still assigned to them. The assets page knows, the exit list knows, and
    // until now neither said it to the person doing the offboarding.
    if (canAssets) {
      const withKit = live.filter((n) => isServing(n) && (assetsOut.get(idOf(n.employee ?? "")) ?? 0) > 0);
      if (withKit.length > 0) {
        out.push({
          id: "kit-out",
          label: `${withKit.length} leaving with kit still out`,
          tone: "warning",
          hint: "Laptops, phones and anything else still assigned to them. Collect before the last working day.",
          filters: { assets_out: ">0" },
          sort: "lwd.asc",
        });
      }
    }
    return out;
  };

  const columns: Column<NoticePeriod>[] = [
    {
      id: "employee", header: "Employee", filter: "select", groupBy: true, accessor: (n) => empName(n.employee),
      cell: (n) => { const e = emp(n.employee); return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={n.employee ? idOf(n.employee) : ""} name={empName(n.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(n.employee)}{n.transition && <UserMinus className="h-3.5 w-3.5 text-muted-foreground" aria-label="Offboarding started" />}</span>; },
    },
    { id: "type", header: "Type", filter: "select", groupBy: true, accessor: (n) => humanize(n.type), cell: (n) => <Badge variant="secondary">{humanize(n.type)}</Badge> },
    { id: "notice_date", header: "Notice given", filter: "date", dateHint: "past", accessor: (n) => n.notice_date, cell: (n) => formatDate(n.notice_date) },
    // The date everything else hangs off: handover, the final payout, the laptop coming back.
    { id: "lwd", header: "Last working day", filter: "date", dateHint: "future", accessor: (n) => n.last_working_day, cell: (n) => formatDate(n.last_working_day) },
    { id: "remaining", header: "Remaining", filter: "number", formatTotal: (d) => `${d} days`, accessor: (n) => (n.status === "serving" ? n.days_remaining ?? 0 : -1), cell: (n) => <RemainingBadge n={n} /> },
    { id: "status", header: "Status", filter: "select", groupBy: true, accessor: (n) => n.status, cell: (n) => <StatusBadge n={n} /> },
    { id: "total", header: "Notice (days)", defaultHidden: true, align: "right", filter: "number", formatTotal: (d) => `${d} days`, accessor: (n) => n.total_days, cell: (n) => <span className="tabular-nums">{n.total_days}</span> },
    { id: "reason", header: "Reason", defaultHidden: true, accessor: (n) => n.reason ?? "", cell: (n) => n.reason || "-" },
    {
      // Which team is losing somebody. An exit list reads as a list of individuals until it is folded by
      // department, at which point "three of the four leavers are in one team" is a single glance.
      id: "department", header: "Department", filter: "select", groupBy: true, defaultHidden: true,
      accessor: (n) => deptName(empOf(n.employee)?.department),
    },
    ...(canAssets ? [{
      // Company kit still assigned to somebody who is working out their notice. It is the single most
      // expensive thing to discover after a last working day, and neither page could see the other.
      id: "assets_out", header: "Kit out", align: "right" as const, filter: "number" as const, aggregate: "sum" as const,
      accessor: (n: NoticePeriod) => (isServing(n) ? assetsOut.get(idOf(n.employee ?? "")) ?? 0 : null),
      cell: (n: NoticePeriod) => {
        if (!isServing(n)) return <span className="text-muted-foreground">-</span>;
        const count = assetsOut.get(idOf(n.employee ?? "")) ?? 0;
        return count
          ? <span className="inline-flex items-center gap-1 font-medium text-warning"><Laptop className="h-3.5 w-3.5" />{count}</span>
          : <span className="text-muted-foreground">0</span>;
      },
    }] : []),
    stateColumn<NoticePeriod>(),
    ...metaColumns<NoticePeriod>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (n) => {
        const items: RowAction[] = [];
        if (n.delete_time) {
          if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sd.restore(n), verb: "restore" });
          if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sd.permanentlyDelete(n), destructive: true, verb: "delete" });
        } else if (writable) {
          if (n.status === "serving") {
            items.push({ label: "Mark exited", icon: <Check className="h-4 w-4" />, onClick: () => setStatus(n, "completed") });
            items.push({ label: "Withdraw notice", icon: <Undo2 className="h-4 w-4" />, onClick: () => setStatus(n, "withdrawn") });
          }
          items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(n) });
          items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sd.softDelete(n), destructive: true, verb: "delete" });
        }
        return <RowActions actions={items} />;
      },
    },
  ];

  const addBtn = writable && <AccessAction collection="notice-periods" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Record notice</Button></AccessAction>;

  return (
    <div>
      <PageHeader title="Notice Periods" description="Track who's on notice, their last working day, and the countdown to exit." actions={addBtn} />

      <SummaryStrip
        items={[
          { label: "Currently serving", value: stats.serving, tone: stats.serving > 0 ? "warning" : "muted", hint: "working out notice", ...kf.kpi("serving") },
          { label: "Exiting this month", value: stats.exitingThisMonth, tone: stats.exitingThisMonth > 0 ? "destructive" : "muted", hint: "last day this month", ...kf.kpi("month") },
          { label: "Last week of notice", value: stats.leavingSoon, tone: stats.leavingSoon > 0 ? "warning" : "muted", hint: stats.leavingSoon ? "hand-over window" : "nobody this week", ...kf.kpi("soon") },
          ...(stats.noOffboarding
            ? [{ label: "No offboarding started", value: stats.noOffboarding, tone: "warning" as const, hint: "no exit tasks", ...kf.kpi("noOffboarding") }]
            : []),
          ...(stats.pastExit
            ? [{ label: "Past last working day", value: stats.pastExit, tone: "destructive" as const, hint: "mark them exited", ...kf.kpi("pastExit") }]
            : []),
          { label: "All records", value: rows.length, tone: "muted", hint: "past exits included", onClick: () => kf.setFocus(null), active: kf.focus === null },
        ]}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={LogOut} title="No notice periods" description="Record an employee's notice so you can track their last working day and exit countdown." action={addBtn} />
        ) : (
          <DataTable columns={columns} insights={noticeInsights} tableId="notice-periods" rows={sorted} getRowId={(n) => n.path} rowClassName={(n) => (n.delete_time ? "opacity-60" : undefined)} emptyTitle={kf.activeLabel ? `No ${kf.activeLabel}` : "No records match"} accessCollection="notice-periods" accessTargetOf={(n) => ({ objectPath: n.path, label: empName(n.employee), can: n.access?.can })} />
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit notice period" : "Record notice period"}
        description="Starts the exit countdown. On the last working day they're marked exited and their login is disabled; their full & final settlement is computed from that date."
        collection="notice-periods"
        objectPath={editing?.path}
        guardLabel="notice record"
        form={form}
        draftKey={editing ? undefined : "notice-period-new"}
        applyDraft={setForm}
        onStartOver={() => setForm({ ...EMPTY, notice_date: todayStr() })}
        submitLabel={editing ? "Save changes" : "Record"}
        canSubmit={validForm}
        whyNot={
          !form.employee ? "Pick whose notice this is." : !form.last_working_day ? "Set their last working day." : lwdInvalid ? "The last working day can't be before the notice date." : undefined
        }
        onSubmit={submit}
      >
          <Field label="Employee">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Select an employee…"
              searchPlaceholder="Search employees…"
              options={employees
                .filter((e) => !e.disabled)
                // Someone already serving notice can't get a second one - edit the existing record instead.
                .filter((e) => (editing ? true : !rows.some((n) => !n.delete_time && n.status === "serving" && n.employee && idOf(n.employee) === idOf(e.path))))
                .map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <FieldRow>
            <Field label="Type">
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="serving">Serving</SelectItem><SelectItem value="completed">Exited</SelectItem><SelectItem value="withdrawn">Withdrawn</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Notice given"><Input type="date" value={form.notice_date} onChange={(e) => setForm({ ...form, notice_date: e.target.value, last_working_day: form.last_working_day && form.last_working_day < e.target.value ? e.target.value : form.last_working_day })} /></Field>
            <Field
              label="Last working day"
              error={lwdInvalid ? "Before the notice date." : undefined}
              hint={noticeDays != null ? `${noticeDays} day${noticeDays === 1 ? "" : "s"} of notice.` : undefined}
            ><Input type="date" value={form.last_working_day} min={form.notice_date} onChange={(e) => setForm({ ...form, last_working_day: e.target.value })} /></Field>
          </FieldRow>
          {noticeDays === 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              Same-day exit: they leave on the day notice is given, so their login is disabled immediately.
            </p>
          )}
          {pastExit && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              That last working day has already passed. Set the status to Exited if they've left - "Serving" keeps them active with a negative countdown.
            </p>
          )}
          <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Optional" /></Field>
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Handover, exit interview, settlement…" /></Field>
          {!editing && (
            <div className="space-y-2 rounded-lg border p-3">
              {/* The hint stays OUT of the label: text inside one becomes part of the checkbox's accessible
                  name, and a name carrying "…the last working day" makes this box answer to the same
                  label as the date field above it. Described, not named. */}
              <div className="flex items-start gap-2">
                <Checkbox
                  id="notice-start-offboarding"
                  aria-describedby="notice-start-offboarding-hint"
                  checked={form.start_offboarding}
                  onCheckedChange={(v) => setForm({ ...form, start_offboarding: v === true })}
                  className="mt-0.5"
                />
                <span>
                  <label htmlFor="notice-start-offboarding" className="flex items-center gap-1.5 text-sm font-medium"><UserMinus className="h-4 w-4" /> Start offboarding</label>
                  <span id="notice-start-offboarding-hint" className="block text-xs text-muted-foreground">Creates an offboarding checklist anchored to the last working day.</span>
                </span>
              </div>
              {form.start_offboarding && (
                <>
                  <Select value={form.template} onValueChange={(v) => setForm({ ...form, template: v })}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Offboarding template (optional)" /></SelectTrigger>
                    <SelectContent>{offboardingTemplates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {/* What the checklist will actually contain, before it's created - a template name alone says
                      nothing about how much work lands on whom. */}
                  <p className="text-xs text-muted-foreground">
                    {chosenTemplate
                      ? `${chosenTemplate.tasks.length} task${chosenTemplate.tasks.length === 1 ? "" : "s"}${form.last_working_day ? `, anchored to ${formatDate(form.last_working_day)}` : ""}.`
                      : "No template: an empty checklist you fill in yourself."}
                  </p>
                </>
              )}
            </div>
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
  );
}
