import { useMemo, useState } from "react";
import { AlertTriangle, Briefcase, Copy, Link2, Plus, Pencil, Trash2, Users, UserCheck } from "lucide-react";
import { create, get, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatMoney, idOf } from "@/lib/utils";
import { isConflict } from "@/lib/formError";
import { navigate, recordUrl, setRouteRecord } from "@/router";
import type { Application, Department, Employee, Me, JobRequisition, PayGrade } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const EMPLOYMENT_TYPES = [
  { key: "full_time", label: "Full-time" },
  { key: "part_time", label: "Part-time" },
  { key: "contract", label: "Contract" },
  { key: "intern", label: "Intern" },
  { key: "temporary", label: "Temporary" },
] as const;
const empLabel = (k?: string) => EMPLOYMENT_TYPES.find((t) => t.key === k)?.label ?? "";

// A role open longer than this is drifting on time-to-fill, whatever its funnel looks like.
const AGING_DAYS = 30;

/** A pay grade as a one-line budget: the name plus the band it spans. */
const bandLabel = (g: PayGrade) => {
  // A band end is nullable on the wire (an open-ended band has no floor or no ceiling).
  const money = (n?: number | null) => (n != null ? formatMoney(n, g.currency_code ?? "INR") : null);
  const span = [money(g.band_min), money(g.band_max)].filter(Boolean).join(" - ");
  return span ? `${g.display_name} (${span})` : g.display_name;
};

type Variant = "secondary" | "success" | "destructive" | "outline";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  draft: { label: "Draft", variant: "outline" },
  open: { label: "Open", variant: "success" },
  on_hold: { label: "On hold", variant: "secondary" },
  closed: { label: "Closed", variant: "destructive" },
  filled: { label: "Filled", variant: "secondary" },
};
// Sort rank for the list below. At module scope because it is a constant: rebuilt inside the component it was
// a fresh object every render, so the sort's dependency array either lied about it or lost its memo.
const STATUS_ORDER: Record<string, number> = { open: 0, draft: 1, on_hold: 2, filled: 3, closed: 4 };

export default function Requisitions({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<JobRequisition>("job-requisitions");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  // Applications exist to put a pipeline count on each requisition, so no requisitions means nothing to count.
  const { rows: apps } = useCollection<Application>("applications", { enabled: rows.length > 0 });
  // The band a role is budgeted at. It is what an auto-drafted offer is priced from, so the picker lives on the
  // requisition rather than being re-keyed into every offer.
  const { rows: payGrades } = useCollection<PayGrade>("pay-grades");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<JobRequisition | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);
  // A job under discussion gets pasted into a thread; `useDeepOpen` above reads the id back.
  function openDialog(d: JobRequisition | "new") { setDialog(d); setRouteRecord(d === "new" ? null : idOf(d.path)); }
  function closeDialog() { setDialog(null); setRouteRecord(null); setCloneOf(null); }
  // Cloning: same role, next team - a job description gets rewritten from scratch today because the only way
  // to reuse one is to read it off the old req and retype it. A clone opens the CREATE form pre-filled, and
  // deliberately drops the status (a copy starts as a draft) and the hiring manager's name in the title.
  const [cloneOf, setCloneOf] = useState<JobRequisition | null>(null);
  function openClone(r: JobRequisition) { setCloneOf(r); setDialog("new"); setRouteRecord(null); }

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [departments]);

  // Live hiring first (open, then drafts/on-hold), finished roles sink; newest within each group.
  const items = useMemo(() =>
    [...rows].sort((a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.create_time ?? "").localeCompare(a.create_time ?? "")),
  [rows]);

  // Hired applications per requisition, to show openings-filled progress.
  const hiredCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of apps) {
      if (a.status !== "hired" || !a.requisition) continue;
      const key = idOf(a.requisition);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return (r: JobRequisition) => m.get(idOf(r.path)) ?? 0;
  }, [apps]);

  const open = items.filter((r) => r.status === "open");
  const totalOpenings = open.reduce((s, r) => s + (r.openings ?? 1), 0);
  const totalHired = open.reduce((s, r) => s + hiredCount(r), 0);
  const totalApplicants = open.reduce((s, r) => s + (r.applicant_count ?? 0), 0);

  // A role open for weeks with nobody in the funnel is the hiring problem worth surfacing; so is a role whose
  // hiring manager is the person reading the page. Every metric narrows the table to the rows behind it.
  const openDays = (r: JobRequisition) => (Date.now() - Date.parse(r.create_time ?? "")) / 86400000;
  const isStarved = (r: JobRequisition) => r.status === "open" && (r.applicant_count ?? 0) === 0;
  const isAging = (r: JobRequisition) => r.status === "open" && openDays(r) > AGING_DAYS;
  const isMine = (r: JobRequisition) => !!me.employee_id && !!r.hiring_manager && idOf(r.hiring_manager) === me.employee_id;
  const kf = useKpiFocus<JobRequisition, "all" | "open" | "unfilled" | "hired" | "starved" | "aging" | "mine">({
    all: { label: "jobs", match: () => true },
    open: { label: "open jobs", match: (r) => r.status === "open" },
    unfilled: { label: "jobs with openings left", match: (r) => r.status === "open" && hiredCount(r) < (r.openings ?? 1) },
    hired: { label: "jobs with a hire on them", match: (r) => hiredCount(r) > 0 },
    starved: { label: "open jobs with no applicants", match: isStarved },
    aging: { label: `jobs open longer than ${AGING_DAYS} days`, match: isAging },
    mine: { label: "jobs you are hiring for", match: isMine },
  });
  const shown = useMemo(() => kf.apply(items), [items, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  async function del(r: JobRequisition) {
    if (!(await confirm({
      title: "Delete this requisition?",
      description: "This removes it entirely. To stop hiring but keep its history, set its status to Closed instead.",
      destructive: true,
      confirmLabel: "Delete",
    }))) return;
    try { await remove(`job-requisitions/${idOf(r.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  useIntent("new-job", () => openDialog("new"));

  const newBtn = (
    <AccessAction collection="job-requisitions" create label="Open a requisition">
      <Button onClick={() => openDialog("new")}><Plus className="h-4 w-4" /> New job</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Jobs" description="Open roles you're hiring for." actions={<>{newBtn}<PageSettings me={me} host="job-requisitions" /></>} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Open jobs", value: open.length, icon: Briefcase, tone: "primary", hint: "accepting applicants", ...kf.kpi("open") },
              ...(items.some(isMine) ? [{ label: "Yours to hire", value: items.filter(isMine).length, icon: Users, tone: "primary" as const, hint: "you are hiring", ...kf.kpi("mine") }] : []),
              { label: "Openings", value: totalOpenings, hint: totalHired ? `${totalHired} filled` : "still to fill", ...kf.kpi("unfilled") },
              // The funnel lives on the Pipeline board, so the applicant count opens it rather than filtering here.
              { label: "Applicants", value: totalApplicants, icon: Users, hint: "on open jobs", onClick: () => navigate("pipeline") },
              ...(items.some(isStarved) ? [{ label: "No applicants yet", value: items.filter(isStarved).length, icon: Users, tone: "warning" as const, hint: "nothing in the funnel", ...kf.kpi("starved") }] : []),
              ...(items.some(isAging) ? [{ label: `Open over ${AGING_DAYS}d`, value: items.filter(isAging).length, icon: Briefcase, tone: "warning" as const, hint: "slipping time-to-fill", ...kf.kpi("aging") }] : []),
              { label: "Hired", value: totalHired, icon: UserCheck, tone: totalHired ? "success" : "muted", hint: "seats filled", ...kf.kpi("hired") },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState illustration="hiring" icon={Briefcase} title="No open jobs yet" description="Create a requisition to start building a pipeline of candidates." action={newBtn} />
        ) : (
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            {/* Seven columns: labelled blocks below `sm`, a table from there up (`.table-stack`). */}
            <table className="table-stack w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Hiring manager</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium text-right">Filled</th>
                <th className="px-3 py-2 font-medium text-right">Applicants</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No {kf.activeLabel ?? "jobs"}.{" "}
                    <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all jobs</button>
                  </td></tr>
                )}
                {shown.map((r) => {
                  const can = r.access?.can ?? [];
                  const sm = STATUS_META[r.status] ?? { label: r.status, variant: "secondary" as Variant };
                  const openings = r.openings ?? 1;
                  const hired = hiredCount(r);
                  return (
                    <tr key={r.path} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {[
                            deptName(r.department),
                            r.location,
                            // Age of open roles = time-to-fill pressure at a glance.
                            r.status === "open" && r.create_time ? `open ${Math.max(1, Math.floor((Date.now() - new Date(r.create_time).getTime()) / 86400000))}d` : "",
                          ].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td data-label="Hiring manager" className="px-3 py-2 text-muted-foreground">{empName(r.hiring_manager)}</td>
                      <td data-label="Type" className="px-3 py-2 text-muted-foreground">{empLabel(r.employment_type)}</td>
                      {/* One wrapper, so the count and its bar stay together as the cell's VALUE when the
                          row stacks into a label/value pair on a phone. */}
                      <td data-label="Filled" className="px-3 py-2 text-right">
                        <span className="inline-block">
                          <span className="tabular-nums">{hired} / {openings}</span>
                          <span className="ml-auto mt-1 block h-1 w-16 rounded-full bg-muted">
                            <span className="block h-1 rounded-full bg-success" style={{ width: `${Math.min(100, Math.round((hired / Math.max(1, openings)) * 100))}%` }} />
                          </span>
                        </span>
                      </td>
                      <td data-label="Applicants" className="px-3 py-2 text-right tabular-nums">{r.applicant_count ?? 0}</td>
                      <td data-label="Status" className="px-3 py-2">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {r.status === "open" && hired >= openings && (
                          <div className="mt-1 text-[11px] text-warning dark:text-warning">All openings filled - mark it Filled</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openDialog(r)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                          <AccessAction collection="job-requisitions" create label="Open a requisition">
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openClone(r)} aria-label="Duplicate" title="Open another job from this one"><Copy className="h-3.5 w-3.5" /></Button>
                          </AccessAction>
                          {can.includes("delete") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(r)} aria-label="Close"><Trash2 className="h-3.5 w-3.5" /></Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DataState>

      {dialog && (
        <RequisitionDialog
          req={dialog === "new" ? null : dialog}
          cloneOf={cloneOf}
          reqs={rows}
          hiredCount={hiredCount}
          employees={employees}
          departments={departments}
          payGrades={payGrades}
          me={me}
          onClose={closeDialog}
          onSaved={() => { closeDialog(); reload(); }}
        />
      )}
    </div>
  );
}

// What each status DOES, said beside the picker. "Draft" and "Open" look like two words for the same thing
// until you know that only one of them takes applications.
const STATUS_EFFECT: Record<string, string> = {
  draft: "A draft takes no applications: nothing shows on the pipeline until it's open.",
  open: "Open accepts applications and counts its openings as seats still to fill.",
  on_hold: "On hold keeps the role and its funnel, but stops it counting as active hiring.",
  closed: "Closing ends the hiring. The applications on it stay readable.",
  filled: "Filled says every opening has a hire, and drops the role out of the open count.",
};

const EMPTY_REQ = { title: "", dept: "", manager: "", location: "", type: "full_time", openings: "1", grade: "", description: "", status: "draft" };

function RequisitionDialog({ req, cloneOf, reqs, hiredCount, employees, departments, payGrades, me, onClose, onSaved }: {
  req: JobRequisition | null;
  /** The requisition this new one is being copied from, if any. */
  cloneOf?: JobRequisition | null;
  /** Every requisition, for the "you already have this role open" guard. */
  reqs: JobRequisition[];
  hiredCount: (r: JobRequisition) => number;
  employees: Employee[];
  departments: Department[];
  payGrades: PayGrade[];
  me: Me;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!req;
  const [form, setForm] = useState(() => (req || cloneOf
    ? ((source) => ({
        title: source.title ?? "",
        dept: source.department ? idOf(source.department) : "",
        manager: source.hiring_manager ? idOf(source.hiring_manager) : "",
        location: source.location ?? "",
        type: source.employment_type ?? "full_time",
        openings: source.openings != null ? String(source.openings) : "1",
        grade: source.pay_grade ? idOf(source.pay_grade) : "",
        description: source.description ?? "",
        // A copy starts as a draft, whatever the original is doing: cloning an open role should not
        // silently start taking applications for a job nobody has finished writing.
        status: req ? source.status ?? "draft" : "draft",
      }))((req ?? cloneOf)!)
    : EMPTY_REQ));
  // The version an edit writes against, refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState(req?.etag);
  const openingsError = form.openings !== "" && (!Number.isInteger(Number(form.openings)) || Number(form.openings) < 1)
    ? "Must be a whole number of 1 or more."
    : undefined;
  const canSubmit = !!form.title.trim() && !openingsError;

  // The same role opened twice is the ordinary mistake here: two recruiters, one req each, one funnel split in
  // half. Warned with what the other one is doing, never blocked - a second Backend Engineer req for a
  // different team is legitimate.
  const twin = useMemo(() => {
    const needle = form.title.trim().toLowerCase();
    if (!needle) return null;
    return reqs.find((r) =>
      r.path !== req?.path
      && (r.title ?? "").trim().toLowerCase() === needle
      && ["draft", "open", "on_hold"].includes(r.status)
      && (form.dept ? (r.department ? idOf(r.department) === form.dept : false) : true)) ?? null;
  }, [reqs, form.title, form.dept, req?.path]);

  // Openings below the number of people already hired against the role: the progress bar would read 3/2.
  const hired = req ? hiredCount(req) : 0;
  const openings = Number(form.openings) || 1;
  const overFilled = hired > openings;

  // The band is what makes the pipeline able to draft a priced offer by itself, so the hint says so plainly
  // rather than leaving the field looking like bookkeeping.
  const chosenGrade = payGrades.find((g) => idOf(g.path) === form.grade);
  const gradeHint = chosenGrade
    ? `An offer drafted at the offer stage is priced from this band (${bandLabel(chosenGrade)}).`
    : "Set one and the pipeline can draft a priced offer the moment a candidate reaches the offer stage.";

  const consequence = [
    `${openings} ${openings === 1 ? "opening" : "openings"}`,
    empLabel(form.type),
    form.location.trim(),
    hired ? `${hired} filled` : "",
  ].filter(Boolean).join(" · ");

  function copyLink() {
    navigator.clipboard.writeText(recordUrl("job-requisitions", idOf(req!.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this job can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  async function submit() {
    const body = {
      title: form.title.trim(),
      department: form.dept ? `departments/${form.dept}` : "",
      hiring_manager: form.manager ? `employees/${form.manager}` : "",
      location: form.location.trim(),
      employment_type: form.type,
      openings,
      pay_grade: form.grade ? `pay-grades/${form.grade}` : "",
      description: form.description.trim(),
      status: form.status,
    };
    if (editing) {
      try {
        const saved = await patch<JobRequisition>(`job-requisitions/${idOf(req!.path)}`, body, etag ?? req!.etag);
        setEtag(saved.etag);
      } catch (e) {
        // Lost race: a recruiter moved the status while the hiring manager had the form open. Take their
        // version's etag so the next press goes through deliberately.
        if (isConflict(e)) {
          const fresh = await get<JobRequisition>(`job-requisitions/${idOf(req!.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this job while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
    } else {
      await create<JobRequisition>("job-requisitions", body);
    }
    toast({ title: editing ? "Job updated" : "Requisition opened", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={editing ? "Edit requisition" : cloneOf ? "Open a requisition (copy)" : "Open a requisition"}
      description={cloneOf
        ? `Copied from “${cloneOf.title}” - everything but its status came across. ${STATUS_EFFECT[form.status] ?? ""}`
        : STATUS_EFFECT[form.status] ?? "A requisition is the role you are hiring for; applications hang off it."}
      collection="job-requisitions"
      objectPath={req?.path}
      guardLabel="requisition"
      form={form}
      draftKey={editing || cloneOf ? undefined : "job-requisition:new"}
      applyDraft={editing || cloneOf ? undefined : (d) => setForm(d)}
      onStartOver={editing || cloneOf ? undefined : () => setForm(EMPTY_REQ)}
      submitLabel={editing ? "Save changes" : "Open requisition"}
      canSubmit={canSubmit}
      whyNot={[!form.title.trim() && "Give the role a title.", !!openingsError && "Openings must be a whole number of 1 or more."]}
      onSubmit={submit}
      footerStart={
        <div className="flex min-w-0 items-center gap-2">
          {editing && <Button type="button" variant="ghost" size="sm" onClick={copyLink}><Link2 className="h-4 w-4" /> Copy link</Button>}
          <span className="truncate text-xs text-muted-foreground">{consequence}</span>
        </div>
      }
    >
      <Field label="Role title" field="title">
        <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus placeholder="e.g. Senior Backend Engineer" />
      </Field>
      {twin && (
        <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          “{twin.title}” is already {(STATUS_META[twin.status]?.label ?? twin.status).toLowerCase()} with {twin.applicant_count ?? 0} applicant
          {(twin.applicant_count ?? 0) === 1 ? "" : "s"}. Two requisitions for one role split the funnel in half - add openings to that one instead if it's the same hire.
        </p>
      )}
      <FieldRow>
        <Field label="Department (optional)" field="department">
          <Select value={form.dept || "none"} onValueChange={(v) => setForm({ ...form, dept: v === "none" ? "" : v })}>
            <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Any</SelectItem>
              {departments.map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Hiring manager (optional)"
          field="hiring_manager"
          hint="They're told when a candidate accepts, and the role shows as theirs to hire."
          action={me.employee_id && form.manager !== me.employee_id
            ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setForm({ ...form, manager: me.employee_id! })}>It's me</Button>
            : undefined}
        >
          <Combobox
            value={form.manager || "none"}
            onValueChange={(v) => setForm({ ...form, manager: v === "none" ? "" : v })}
            options={[{ value: "none", label: "Unassigned" }, ...employees.map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}`.trim() }))]}
            placeholder="Unassigned"
            searchPlaceholder="Search people…"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Location (optional)" field="location"><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Remote or office city" /></Field>
        <Field label="Employment type" field="employment_type">
          <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{EMPLOYMENT_TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <FieldRow>
        <Field
          label="Openings"
          field="openings"
          error={openingsError}
          hint={hired ? `${hired} already hired against this role.` : "How many seats this role fills."}
        >
          <Input type="number" min={1} value={form.openings} onChange={(e) => setForm({ ...form, openings: e.target.value })} />
        </Field>
        <Field label="Status" field="status">
          <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <Field
        label="Pay band (optional)"
        field="pay_grade"
        hint={gradeHint}
      >
        <Combobox
          value={form.grade || "none"}
          onValueChange={(v) => setForm({ ...form, grade: v === "none" ? "" : v })}
          options={[{ value: "none", label: "No band" }, ...payGrades.map((g) => ({ value: idOf(g.path), label: bandLabel(g) }))]}
          placeholder="No band"
          searchPlaceholder="Search pay grades…"
        />
      </Field>
      {overFilled && (
        <p className="-mt-1 text-xs font-medium text-warning dark:text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {hired} people are already hired on this job, so {openings} {openings === 1 ? "opening" : "openings"} reads as over-filled.
        </p>
      )}
      {form.status === "open" && hired >= openings && !overFilled && (
        <p className="-mt-1 text-xs text-muted-foreground">Every opening has a hire - Filled is probably the status you want.</p>
      )}
      <Field label="Description (optional)" field="description">
        <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Role summary, responsibilities, requirements…" />
      </Field>
      {req && <ActivitySection resource={req.path} className="border-t pt-3" />}
    </WriteDialog>
  );
}
