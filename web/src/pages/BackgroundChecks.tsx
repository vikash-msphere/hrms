import { useMemo, useState } from "react";
import { UserCheck, Plus, Check, Link2, Pencil, Trash2, RotateCcw, ShieldX, Play, AlertTriangle } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf, personName } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import type { BackgroundCheck, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { ProofField, fileProof } from "@/components/common/ProofField";
import { Checkbox } from "@/components/ui/checkbox";
import { setRouteRecord, recordUrl } from "@/router";
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
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";
import { humanize } from "@/lib/utils";

const TYPES = ["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"];
const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "clear", label: "Clear" },
  { value: "discrepancy", label: "Discrepancy" },
  { value: "failed", label: "Failed" },
];
const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;
// Reaching one of these ends the check, which is what dates the completion.
const OUTCOMES = ["clear", "discrepancy", "failed"];
const EMPTY = { employee: "", check_type: "identity", status: "pending", vendor: "", reference_no: "", initiated_date: "", completed_date: "", notes: "", document: "" };
// What a new joiner's verification normally consists of. Four dialog trips for one hire is not a workflow.
const STANDARD_SET = ["identity", "address", "education", "employment"];
// `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's
// local parts, which is a different day for part of every day and a different day again from the one the
// server validates against.
// A check still with the vendor. Past this many days open it is the one to chase - the table flags the same age.
const STALE_DAYS = 14;
const isOpenCheck = (c: BackgroundCheck) => !c.delete_time && (c.status === "pending" || c.status === "in_progress");
const isStaleCheck = (c: BackgroundCheck) =>
  isOpenCheck(c) && !!c.initiated_date && (Date.now() - new Date(c.initiated_date).getTime()) / 86400000 > STALE_DAYS;

function StatusBadge({ s }: { s: string }) {
  if (s === "clear") return <Badge variant="success" className="gap-1"><Check className="h-3 w-3" /> Clear</Badge>;
  if (s === "discrepancy") return <Badge variant="warning">Discrepancy</Badge>;
  if (s === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (s === "in_progress") return <Badge variant="secondary">In progress</Badge>;
  return <Badge variant="muted">Pending</Badge>;
}

export default function BackgroundChecks({ me, openId }: { me: Me; openId?: string }) {
  void me;
  // `all: true`: the clash guard below searches these rows, and on one page it searched the 100 most recent
  // checks in the WHOLE org - so ordering a second check on somebody whose first is older than that window
  // showed no warning at all, and the comment on that guard states the cost in money ("two vendor invoices
  // for one answer"). Advisory is the right call; silently not checking is not.
  const { rows, state, error, reload } = useCollection<BackgroundCheck>("background-checks", { showDeleted: true, all: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const sd = useSoftDelete("background-checks", "background check", reload);
  const writable = usePermission("background-checks.write");
  const canPurge = usePermission("background-checks.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BackgroundCheck | null>(null);
  const [form, setForm] = useState(EMPTY);
  // The vendor's report staged for upload on save (the linked one lives in `form.document`).
  const [proof, setProof] = useState<File | null>(null);
  // Order the whole standard set for a new joiner rather than one check at a time.
  const [standardSet, setStandardSet] = useState(false);

  const empById = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const emp = (p?: string) => (p ? empById.get(idOf(p)) : undefined);
  const empName = (p?: string, unknown?: string) => personName(employees, p, unknown);

  const stats = useMemo(() => {
    const live = rows.filter((c) => !c.delete_time);
    return {
      open: live.filter(isOpenCheck).length,
      discrepancy: live.filter((c) => c.status === "discrepancy" || c.status === "failed").length,
      clear: live.filter((c) => c.status === "clear").length,
      // Open past the point a vendor should have answered: the queue worth chasing today, not just the queue.
      stale: live.filter(isStaleCheck).length,
      // Nobody has told the vendor to start yet - the delay is ours, not theirs.
      notStarted: live.filter((c) => c.status === "pending").length,
    };
  }, [rows]);

  // Clicking a metric narrows the table to exactly the rows it counted.
  const kf = useKpiFocus<BackgroundCheck, "open" | "adverse" | "clear" | "stale" | "notStarted">({
    open: { label: "open checks", match: isOpenCheck },
    adverse: { label: "adverse outcomes", match: (c) => c.status === "discrepancy" || c.status === "failed" },
    clear: { label: "cleared checks", match: (c) => c.status === "clear" },
    stale: { label: `checks open past ${STALE_DAYS} days`, match: isStaleCheck },
    notStarted: { label: "checks not started", match: (c) => c.status === "pending" },
  });
  const shown = useMemo(() => kf.apply(rows), [rows, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() { setEditing(null); setForm({ ...EMPTY, initiated_date: todayStr() }); setProof(null); setStandardSet(false); setOpen(true); }
  function openEdit(c: BackgroundCheck) {
    setEditing(c);
    setForm({
      employee: c.employee ? `employees/${idOf(c.employee)}` : "", check_type: c.check_type, status: c.status,
      vendor: c.vendor ?? "", reference_no: c.reference_no ?? "", initiated_date: c.initiated_date ?? "",
      completed_date: c.completed_date ?? "", notes: c.notes ?? "", document: c.document ?? "",
    });
    setProof(null);
    setStandardSet(false);
    setOpen(true);
    // A check under discussion gets pasted into a thread; `useDeepOpen` above reads this back.
    setRouteRecord(idOf(c.path));
  }
  function closeDialog() { setOpen(false); setRouteRecord(null); }
  function copyLink(c: BackgroundCheck) {
    navigator.clipboard.writeText(recordUrl("background-checks", idOf(c.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this check can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }
  function bodyFromForm(checkType: string, document: string) {
    return {
      employee: form.employee, check_type: checkType, status: form.status,
      vendor: form.vendor.trim(), reference_no: form.reference_no.trim(),
      // `format: date` fields, and "" is not a date - an empty one is left out.
      ...(form.initiated_date ? { initiated_date: form.initiated_date } : {}),
      ...(form.completed_date ? { completed_date: form.completed_date } : {}),
      notes: form.notes.trim(),
      document,
    };
  }
  async function submit() {
    // The vendor's report lands on the employee's own document shelf first, then the check links it.
    const document = proof
      ? await fileProof({
          file: proof,
          title: `${humanize(form.check_type)} verification${form.vendor.trim() ? ` - ${form.vendor.trim()}` : ""}`,
          employee: form.employee,
        })
      : form.document;
    if (editing) {
      await patch("background-checks/" + idOf(editing.path), bodyFromForm(form.check_type, document), editing.etag);
      toast({ title: "Check updated", variant: "success" });
    } else if (standardSet) {
      // One vendor, one initiation date, four checks: what actually gets ordered for a new joiner.
      for (const t of STANDARD_SET) await create("background-checks", bodyFromForm(t, t === form.check_type ? document : ""));
      toast({ title: `${STANDARD_SET.length} checks added`, description: STANDARD_SET.map(humanize).join(", "), variant: "success" });
    } else {
      await create("background-checks", bodyFromForm(form.check_type, document));
      toast({ title: "Check added", variant: "success" });
    }
    setProof(null);
    setRouteRecord(null);
    reload();
  }
  // One validity check shared by the Enter shortcut and the submit button, so they can't disagree.
  const dateConflict = !!form.initiated_date && !!form.completed_date && form.completed_date < form.initiated_date;
  const canSubmit = !!form.employee && !dateConflict;
  // The same check ordered twice on one person is two vendor invoices for one answer. Warn, never block: a
  // re-run after a discrepancy is legitimate.
  const openClash = useMemo(() => {
    if (!form.employee) return null;
    return rows.find((c) =>
      !c.delete_time && c.path !== editing?.path &&
      c.employee && idOf(c.employee) === idOf(form.employee) &&
      c.check_type === form.check_type &&
      (c.status === "pending" || c.status === "in_progress")) ?? null;
  }, [rows, form.employee, form.check_type, editing?.path]);
  // Turnaround, shown while the dates are being typed rather than only in the table afterwards.
  const turnaround = form.initiated_date && form.completed_date && !dateConflict
    ? Math.round((Date.parse(`${form.completed_date}T00:00:00`) - Date.parse(`${form.initiated_date}T00:00:00`)) / 86400000)
    : null;

  async function setStatus(c: BackgroundCheck, status: string) {
    try { await patch("background-checks/" + idOf(c.path), { status }, c.etag); toast({ title: `Marked ${statusLabel(status).toLowerCase()}`, variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" }); }
  }

  const columns: Column<BackgroundCheck>[] = [
    {
      id: "employee", header: "Employee", filter: "select", accessor: (c) => empName(c.employee),
      cell: (c) => {
        const e = emp(c.employee);
        return <span className="inline-flex items-center gap-2"><PhotoAvatar employeeId={c.employee ? idOf(c.employee) : ""} name={empName(c.employee)} photo={e?.photo} className="h-6 w-6" /> {empName(c.employee)}</span>;
      },
    },
    { id: "check_type", header: "Check", filter: "select", accessor: (c) => humanize(c.check_type), cell: (c) => <span className="inline-flex items-center gap-1.5"><Badge variant="secondary">{humanize(c.check_type)}</Badge>{c.transition && <span className="text-[10px] uppercase tracking-wide text-muted-foreground" title="From onboarding">onboarding</span>}</span> },
    { id: "status", header: "Status", filter: "select", accessor: (c) => statusLabel(c.status), cell: (c) => <StatusBadge s={c.status} /> },
    { id: "vendor", header: "Vendor", accessor: (c) => c.vendor ?? "", cell: (c) => c.vendor || <span className="text-muted-foreground">-</span> },
    {
      id: "initiated", header: "Initiated", accessor: (c) => c.initiated_date ?? "",
      // For open checks show how long they've been sitting - that's the "chase the vendor" signal.
      cell: (c) => {
        if (!c.initiated_date) return <span className="text-muted-foreground">-</span>;
        const isOpen = !c.delete_time && (c.status === "pending" || c.status === "in_progress");
        const age = isOpen ? Math.max(0, Math.floor((Date.now() - new Date(c.initiated_date).getTime()) / 86400000)) : null;
        return (
          <span>
            {formatDate(c.initiated_date)}
            {age != null && age >= 1 && (
              <span className={age > 14 ? "text-xs font-medium text-warning dark:text-warning" : "text-xs text-muted-foreground"} title={age > 14 ? "Open for more than two weeks" : "Days open"}> · {age}d open</span>
            )}
          </span>
        );
      },
    },
    {
      id: "completed", header: "Completed", accessor: (c) => c.completed_date ?? "",
      // Show the turnaround alongside the date - "how long did this check take" without mental math.
      cell: (c) => {
        if (!c.completed_date) return <span className="text-muted-foreground">-</span>;
        const days = c.initiated_date && c.completed_date >= c.initiated_date
          ? Math.round((new Date(c.completed_date).getTime() - new Date(c.initiated_date).getTime()) / 86400000)
          : null;
        return <span>{formatDate(c.completed_date)}{days != null && <span className="text-xs text-muted-foreground" title="Turnaround"> · {days}d</span>}</span>;
      },
    },
    { id: "reference", header: "Reference", defaultHidden: true, accessor: (c) => c.reference_no ?? "", cell: (c) => c.reference_no || "-" },
    stateColumn<BackgroundCheck>(),
    ...metaColumns<BackgroundCheck>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (c) => {
        const items: RowAction[] = [];
        if (c.delete_time) {
          if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sd.restore(c), verb: "restore" });
          if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sd.permanentlyDelete(c), destructive: true, verb: "delete" });
        } else if (writable) {
          // Quick status moves matching the workflow: pending → in progress → clear/discrepancy.
          if (c.status === "pending") items.push({ label: "Mark in progress", icon: <Play className="h-4 w-4" />, onClick: () => setStatus(c, "in_progress") });
          if (c.status !== "clear") items.push({ label: "Mark clear", icon: <Check className="h-4 w-4" />, onClick: () => setStatus(c, "clear") });
          if (c.status === "pending" || c.status === "in_progress") items.push({ label: "Mark discrepancy", icon: <AlertTriangle className="h-4 w-4" />, onClick: () => setStatus(c, "discrepancy") });
          items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(c) });
          items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sd.softDelete(c), destructive: true, verb: "delete" });
        }
        return <RowActions actions={items} />;
      },
    },
  ];

  const addBtn = writable && <AccessAction collection="background-checks" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add check</Button></AccessAction>;

  return (
    <div>
      <PageHeader title="Background Verification" description="Track pre-employment verification checks per employee and their outcomes." actions={addBtn} />

      <SummaryStrip
        items={[
          { label: "Open", value: stats.open, hint: "in progress", tone: stats.open > 0 ? "warning" : "muted", ...kf.kpi("open") },
          { label: "Not started", value: stats.notStarted, hint: stats.notStarted ? "nobody ordered these" : "all ordered", tone: stats.notStarted > 0 ? "warning" : "muted", ...kf.kpi("notStarted") },
          { label: `Open over ${STALE_DAYS}d`, value: stats.stale, icon: AlertTriangle, hint: stats.stale ? "chase the vendor" : "none overdue", tone: stats.stale > 0 ? "destructive" : "muted", ...kf.kpi("stale") },
          { label: "Discrepancy / failed", value: stats.discrepancy, tone: stats.discrepancy > 0 ? "destructive" : "muted", hint: stats.discrepancy ? "needs a decision" : "none adverse", ...kf.kpi("adverse") },
          { label: "Clear", value: stats.clear, tone: stats.clear > 0 ? "success" : "muted", hint: "verified, no issues", ...kf.kpi("clear") },
        ]}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={UserCheck} title="No background checks" description="Record verification checks (identity, address, education, employment, criminal) and track each to a clear or discrepancy outcome." action={addBtn} />
        ) : (
          <DataTable columns={columns} tableId="background-checks" rows={shown} getRowId={(c) => c.path} rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)} emptyTitle={kf.activeLabel ? `No ${kf.activeLabel}` : "No checks match"} accessCollection="background-checks" accessTargetOf={(c) => ({ objectPath: c.path, label: `${empName(c.employee)} · ${humanize(c.check_type)}`, can: c.access?.can })} />
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={closeDialog}
        title={editing ? "Edit background check" : "Add background check"}
        description={
          OUTCOMES.includes(form.status)
            ? form.status === "clear"
              ? "Recording a clear outcome closes this check - it drops out of the open count."
              : "An adverse outcome is what HR follows up on; the notes are the record of what was found."
            : "One verification per employee, tracked from initiated to its outcome. Open checks are counted until they land."
        }
        collection="background-checks"
        objectPath={editing?.path}
        guardLabel="background check"
        form={{ ...form, proof: proof ? `${proof.name}:${proof.size}` : null, standardSet }}
        draftKey={editing ? undefined : "background-check"}
        applyDraft={editing ? undefined : (d) => setForm({ ...EMPTY, ...d } as typeof form)}
        onStartOver={editing ? undefined : () => setForm({ ...EMPTY, initiated_date: todayStr() })}
        submitLabel={editing ? "Save changes" : standardSet ? `Add ${STANDARD_SET.length} checks` : "Add check"}
        canSubmit={canSubmit}
        whyNot={!form.employee ? "Pick whose check this is." : "The completed date is before the initiated date."}
        onSubmit={submit}
        footerStart={editing && (
          <Button type="button" variant="ghost" size="sm" onClick={() => copyLink(editing)}>
            <Link2 className="h-4 w-4" /> Copy link
          </Button>
        )}
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
          {openClash && (
            <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              A {humanize(openClash.check_type).toLowerCase()} check for {empName(openClash.employee)} is already {statusLabel(openClash.status).toLowerCase()}
              {openClash.vendor ? ` with ${openClash.vendor}` : ""} - ordering it again means paying for the same answer twice.
            </p>
          )}
          {!editing && (
            <label className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox checked={standardSet} onCheckedChange={(v) => setStandardSet(v === true)} className="mt-0.5" />
              <span>
                <span className="text-sm font-medium">Order the standard set</span>
                <span className="block text-xs text-muted-foreground">
                  {standardSet
                    ? `${STANDARD_SET.map(humanize).join(", ")} - four checks with this vendor and initiation date.`
                    : "A new joiner usually needs identity, address, education and employment verified."}
                </span>
              </span>
            </label>
          )}
          <FieldRow>
            <Field label="Check type" hint={standardSet ? "The set covers this and three more." : undefined}>
              <Select value={form.check_type} onValueChange={(v) => setForm({ ...form, check_type: v })} disabled={standardSet}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Status" hint={OUTCOMES.includes(form.status) ? "An outcome closes the check." : "Still open - it keeps showing in the open count."}>
              {/* Reaching an outcome dates the completion (and going back to open clears it), which is what the
                  Completed field used to only promise. */}
              <Select
                value={form.status}
                onValueChange={(v) => setForm({
                  ...form,
                  status: v,
                  completed_date: OUTCOMES.includes(v) ? (form.completed_date || todayStr()) : "",
                })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Vendor / agency"><Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="Name of the verification agency" /></Field>
            <Field label="Reference no." hint="Vendor case ref."><Input value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Initiated"><Input type="date" value={form.initiated_date} onChange={(e) => setForm({ ...form, initiated_date: e.target.value })} /></Field>
            <Field
              label="Completed"
              hint={turnaround != null ? `${turnaround} ${turnaround === 1 ? "day" : "days"} turnaround.` : "Set when an outcome is chosen above."}
              error={dateConflict ? "Completed is before the initiated date." : undefined}
            >
              <Input type="date" value={form.completed_date} min={form.initiated_date || undefined} onChange={(e) => setForm({ ...form, completed_date: e.target.value })} />
            </Field>
          </FieldRow>
          <Field
            label="Notes"
            hint={form.status === "discrepancy" || form.status === "failed" ? "What was found, and what happens next." : undefined}
          >
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Findings, discrepancies, follow-ups…" />
          </Field>
          {/* The vendor's report. Notes summarise a finding; a dispute is settled against the document. */}
          {!standardSet && (
            <ProofField
              label="Vendor report"
              collection="personal-documents"
              hint={form.employee ? "Filed as this employee's own document." : "Pick the employee first - the report is filed under them."}
              documentPath={form.document || null}
              fileName={`${humanize(form.check_type)} verification.pdf`}
              file={proof}
              onFile={setProof}
              onUnlink={() => setForm({ ...form, document: "" })}
              dropHint="PDF or image of the vendor's report."
            />
          )}
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
  );
}
