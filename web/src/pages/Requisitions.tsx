import { useMemo, useState } from "react";
import { Briefcase, Plus, Pencil, Trash2, Users, UserCheck } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Application, Department, Employee, Me, JobRequisition } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

type Variant = "secondary" | "success" | "destructive" | "outline";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  draft: { label: "Draft", variant: "outline" },
  open: { label: "Open", variant: "success" },
  on_hold: { label: "On hold", variant: "secondary" },
  closed: { label: "Closed", variant: "destructive" },
  filled: { label: "Filled", variant: "secondary" },
};

export default function Requisitions({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<JobRequisition>("job-requisitions");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { rows: apps } = useCollection<Application>("applications");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<JobRequisition | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [departments]);

  // Live hiring first (open, then drafts/on-hold), finished roles sink; newest within each group.
  const STATUS_ORDER: Record<string, number> = { open: 0, draft: 1, on_hold: 2, filled: 3, closed: 4 };
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

  useIntent("new-job", () => setDialog("new"));

  const newBtn = (
    <AccessAction collection="job-requisitions" create label="Open a requisition">
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> New job</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Jobs" description="Open roles you're hiring for." actions={<>{newBtn}<PageSettings me={me} host="job-requisitions" /></>} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Open jobs", value: open.length, icon: Briefcase, tone: "primary" },
              { label: "Openings", value: totalOpenings, hint: totalHired ? `${totalHired} filled` : undefined },
              { label: "Applicants", value: totalApplicants, icon: Users, hint: "on open jobs" },
              { label: "Hired", value: totalHired, icon: UserCheck, tone: totalHired ? "success" : "muted" },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState illustration="hiring" icon={Briefcase} title="No open jobs yet" description="Create a requisition to start building a pipeline of candidates." action={newBtn} />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
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
                {items.map((r) => {
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
                      <td className="px-3 py-2 text-muted-foreground">{empName(r.hiring_manager)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{empLabel(r.employment_type)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className="tabular-nums">{hired} / {openings}</span>
                        <div className="ml-auto mt-1 h-1 w-16 rounded-full bg-muted">
                          <div className="h-1 rounded-full bg-success" style={{ width: `${Math.min(100, Math.round((hired / Math.max(1, openings)) * 100))}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.applicant_count ?? 0}</td>
                      <td className="px-3 py-2">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {r.status === "open" && hired >= openings && (
                          <div className="mt-1 text-[11px] text-warning dark:text-warning">All openings filled - mark it Filled</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(r)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
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
          employees={employees}
          departments={departments}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

function RequisitionDialog({ req, employees, departments, onClose, onSaved }: {
  req: JobRequisition | null;
  employees: Employee[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!req;
  const [title, setTitle] = useState(req?.title ?? "");
  const [dept, setDept] = useState(req?.department ? idOf(req.department) : "");
  const [manager, setManager] = useState(req?.hiring_manager ? idOf(req.hiring_manager) : "");
  const [location, setLocation] = useState(req?.location ?? "");
  const [type, setType] = useState(req?.employment_type ?? "full_time");
  const [openings, setOpenings] = useState(req?.openings != null ? String(req.openings) : "1");
  const [description, setDescription] = useState(req?.description ?? "");
  const [status, setStatus] = useState(req?.status ?? "draft");
  const [busy, setBusy] = useState(false);
  const openingsError = openings !== "" && (!Number.isInteger(Number(openings)) || Number(openings) < 1) ? "Must be a whole number of 1 or more." : undefined;
  const valid = !!title.trim() && !openingsError;

  async function save() {
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        department: dept ? `departments/${dept}` : null,
        hiring_manager: manager ? `employees/${manager}` : null,
        location: location.trim() || null,
        employment_type: type || null,
        openings: Number(openings) || 1,
        description: description.trim() || null,
        status,
      };
      if (editing) await patch(`job-requisitions/${idOf(req!.path)}`, body, req!.etag);
      else await create<JobRequisition>("job-requisitions", body);
      toast({ title: editing ? "Updated" : "Requisition opened", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onEnterSubmit={() => { if (valid && !busy) void save(); }}>
        <DialogHeader><DialogTitle>{editing ? "Edit requisition" : "Open a requisition"}</DialogTitle></DialogHeader>
        <Field label="Role title"><Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Senior Backend Engineer" /></Field>
        <FieldRow>
          <Field label="Department (optional)">
            <Select value={dept || "none"} onValueChange={(v) => setDept(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Any</SelectItem>
                {departments.map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Hiring manager (optional)">
            <Combobox
              value={manager || "none"}
              onValueChange={(v) => setManager(v === "none" ? "" : v)}
              options={[{ value: "none", label: "Unassigned" }, ...employees.map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}`.trim() }))]}
              placeholder="Unassigned"
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Location (optional)"><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Remote or office city" /></Field>
          <Field label="Employment type">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{EMPLOYMENT_TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Openings" error={openingsError}><Input type="number" min={1} value={openings} onChange={(e) => setOpenings(e.target.value)} /></Field>
          <Field label="Status">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Description (optional)"><Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Role summary, responsibilities, requirements…" /></Field>
        {req && <ActivitySection resource={req.path} className="border-t pt-3" />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>{editing ? "Save" : "Open requisition"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
