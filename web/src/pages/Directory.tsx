import { useEffect, useMemo, useState } from "react";
import { Users, Plus, Mail, UserPlus, Clock } from "lucide-react";
import { create, patch, get } from "@/api";
import type { AttendanceSession } from "@/types";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import { navigate } from "@/router";
import type { Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Field, FieldRow } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessScope } from "@/components/access/AccessScope";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";

const NONE = "__none__";
type Form = { first_name: string; last_name: string; legal_name: string; employee_number: string; work_email: string; job_title: string; department: string; manager: string; start_date: string; probation_end_date: string };
const EMPTY: Form = { first_name: "", last_name: "", legal_name: "", employee_number: "", work_email: "", job_title: "", department: NONE, manager: NONE, start_date: "", probation_end_date: "" };

export default function Directory({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Employee>("employees", { showDeleted: true });
  const { rows: depts } = useCollection<Department>("departments");
  const { toast } = useToast();
  const sd = useSoftDelete("employees", "employee", reload);
  const lc = useLifecycle("employees", "employee", reload);
  const writable = usePermission("employees.write");
  const canPurge = usePermission("employees.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  // Email is required + well-formed only on create (it's not edited here). Empty passes the format check so
  // the inline error fires only on a malformed entry, not a pristine field.
  const emailOk = form.work_email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.work_email.trim());
  const canSubmit = !!form.first_name.trim() && !!form.last_name.trim() && (!!editing || (form.work_email.trim() !== "" && emailOk));

  // Live presence: employee ids with an open clock session (drives the "clocked in" dot). Best-effort.
  const [clockedIn, setClockedIn] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    get<{ results: AttendanceSession[] }>("attendance?open=true")
      .then((r) => live && setClockedIn(new Set((r.results ?? []).map((s) => (s.employee ? idOf(s.employee) : "")).filter(Boolean))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (path?: string) => (path ? m.get(idOf(path)) ?? idOf(path) : "");
  }, [depts]);
  const empName = useMemo(() => {
    const m = new Map(rows.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (path?: string) => (path ? m.get(idOf(path)) ?? idOf(path) : "");
  }, [rows]);

  // One search box across the fields people actually look someone up by (name/ID/title/email), instead of
  // hunting for the right per-column filter. It runs on the SERVER (`?q=`, FTS-backed), because a list page
  // caps at 100 rows: filtering here would only ever search the slice already loaded, so anyone past the
  // first page would be unfindable. Department still has its own column filter.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  // Two reads, deliberately: the unfiltered one above backs the stats (which must count the whole org, not
  // the current search) and is the entry every other page shares; this one is the search result set.
  const { rows: searchRows, state: searchState, hasMore: searchHasMore } = useCollection<Employee>("employees", {
    showDeleted: true,
    q: debouncedQ,
    enabled: searching,
  });
  const visibleRows = searching ? searchRows : rows;

  const stats = useMemo(() => {
    const live = rows.filter((e) => !e.delete_time);
    const month = new Date().toISOString().slice(0, 7);
    return {
      total: live.length,
      clockedIn: live.filter((e) => clockedIn.has(idOf(e.path))).length,
      joined: live.filter((e) => (e.start_date ?? "").slice(0, 7) === month).length,
    };
  }, [rows, clockedIn]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  useIntent("new-employee", openCreate);
  function openEdit(e: Employee) {
    setEditing(e);
    setForm({
      first_name: e.first_name,
      last_name: e.last_name,
      legal_name: e.legal_name ?? "",
      employee_number: e.employee_number ?? "",
      work_email: e.work_email,
      job_title: e.job_title ?? "",
      department: e.department ? `departments/${idOf(e.department)}` : NONE,
      manager: e.manager ? `employees/${idOf(e.manager)}` : NONE,
      start_date: e.start_date ?? "",
      probation_end_date: e.probation_end_date ?? "",
    });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const dept = form.department === NONE ? null : form.department;
      const mgr = form.manager === NONE ? null : form.manager;
      if (editing) {
        await patch(
          "employees/" + idOf(editing.path),
          {
            first_name: form.first_name,
            last_name: form.last_name,
            legal_name: form.legal_name.trim() || null,
            employee_number: form.employee_number.trim() || undefined,
            job_title: form.job_title || null,
            department: dept,
            manager: mgr,
            start_date: form.start_date || null,
            probation_end_date: form.probation_end_date || null,
          },
          editing.etag
        );
        toast({ title: "Employee updated", variant: "success" });
      } else {
        await create("employees", {
          first_name: form.first_name,
          last_name: form.last_name,
          legal_name: form.legal_name.trim() || undefined,
          employee_number: form.employee_number.trim() || undefined,
          work_email: form.work_email,
          job_title: form.job_title || undefined,
          department: dept || undefined,
          manager: mgr || undefined,
          start_date: form.start_date || undefined,
          probation_end_date: form.probation_end_date || undefined,
        });
        toast({ title: "Employee added", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save employee", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Employee>[] = [
    {
      id: "name",
      header: "Name",
      accessor: (e) => `${e.first_name} ${e.last_name}`,
      cell: (e) => (
        <div className="flex items-center gap-3">
          <span className="relative">
            <PhotoAvatar employeeId={idOf(e.path)} name={`${e.first_name} ${e.last_name}`} photo={e.photo} className="h-9 w-9" />
            {clockedIn.has(idOf(e.path)) && (
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card bg-success" title="Clocked in" />
            )}
          </span>
          <span className="font-medium">{e.first_name} {e.last_name}</span>
        </div>
      ),
    },
    { id: "employee_number", header: "Employee ID", accessor: (e) => e.employee_number ?? "", cell: (e) => e.employee_number ? <span className="font-mono text-xs">{e.employee_number}</span> : "-" },
    { id: "title", header: "Title", accessor: (e) => e.job_title ?? "", cell: (e) => e.job_title ?? "-" },
    { id: "department", header: "Department", filter: "select", accessor: (e) => deptName(e.department) || "-" },
    {
      id: "email",
      header: "Email",
      accessor: (e) => e.work_email,
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Mail className="h-3.5 w-3.5" /> {e.work_email}</span>
      ),
    },
    { id: "manager", header: "Manager", defaultHidden: true, filter: "select", accessor: (e) => empName(e.manager) || "-" },
    { id: "start_date", header: "Start date", defaultHidden: true, filter: "none", accessor: (e) => e.start_date ?? "", cell: (e) => (e.start_date ? formatDate(e.start_date) : "-") },
    { id: "probation_end_date", header: "Probation ends", defaultHidden: true, filter: "none", accessor: (e) => e.probation_end_date ?? "", cell: (e) => (e.probation_end_date ? formatDate(e.probation_end_date) : "-") },
    stateColumn<Employee>(),
    ...metaColumns<Employee>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (e) => (
        <div onClick={(ev) => ev.stopPropagation()}>
          <SoftDeleteRowActions row={e} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Directory"
        description="Everyone in the organization."
        actions={<>{writable && <AccessAction collection="employees" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add employee</Button></AccessAction>}<PageSettings me={me} host="employees" /></>}
      />

      <SummaryStrip
        items={[
          { label: "Employees", value: stats.total, icon: Users },
          { label: "Clocked in now", value: stats.clockedIn, icon: Clock, tone: stats.clockedIn > 0 ? "success" : "muted" },
          { label: "Joined this month", value: stats.joined, icon: UserPlus, tone: stats.joined > 0 ? "primary" : "muted" },
        ]}
      />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            illustration="team"
                title="No employees yet"
            description="Add your first employee to build the directory."
            action={writable && <AccessAction collection="employees" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Add employee</Button></AccessAction>}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="employees"
            rows={visibleRows}
            getRowId={(e) => e.path}
            onRowClick={(e) => !e.delete_time && navigate(`employees/${idOf(e.path)}`)}
            rowClassName={(e) => (e.delete_time ? "opacity-60" : undefined)}
            search={{ value: search, onChange: setSearch, placeholder: "Search people…" }}
            // While searching, the rows ARE the complete server-side result, so the table must not claim to be
            // showing a truncated first page of the collection.
            hasMore={searching ? searchHasMore : undefined}
            emptyTitle={searching && searchState === "loading" ? "Searching…" : "No employees match"}
            accessCollection="employees"
            accessTargetOf={(e) => ({ objectPath: e.path, label: `${e.first_name} ${e.last_name}`, can: e.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && canSubmit) submit(); }}>
          {/* Scope the dialog's field icons to the employee being edited (so a field rule pins to THIS
              employee). On create there is no object yet, so ordinary fields show no icon. */}
          <AccessScope collection="employees" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit employee" : "Add employee"}</DialogTitle>
          </DialogHeader>
          <FieldRow>
            <Field label="First name">
              <Input autoFocus value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            </Field>
            <Field label="Last name">
              <Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </Field>
          </FieldRow>
          <Field label="Legal name" hint="As on official documents/IDs/bank. Used for signing and letter sign-off. Leave blank to use the display name.">
            <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} placeholder={`${form.first_name} ${form.last_name}`.trim()} />
          </Field>
          <Field label="Employee ID" field="employee_number" hint={editing ? "The human-facing ID. Must be unique." : "Leave blank to auto-assign from the org format (Settings › Organization › Employee IDs)."}>
            <Input value={form.employee_number} onChange={(e) => setForm({ ...form, employee_number: e.target.value })} placeholder={editing ? undefined : "Auto"} className="font-mono" />
          </Field>
          {!editing && (
            <Field label="Work email" error={form.work_email.trim() !== "" && !emailOk ? "Enter a valid email address." : undefined}>
              <Input type="email" value={form.work_email} onChange={(e) => setForm({ ...form, work_email: e.target.value })} placeholder="name@company.com" />
            </Field>
          )}
          <Field label="Job title">
            <Input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
          </Field>
          <Field label="Manager" field="manager" hint="Approves their leave/time requests and sees them in team views.">
            <Combobox
              value={form.manager}
              onValueChange={(v) => setForm({ ...form, manager: v })}
              options={[
                { value: NONE, label: "No manager" },
                ...rows
                  .filter((e) => !e.delete_time && (!editing || e.path !== editing.path))
                  .map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` })),
              ]}
              placeholder="No manager"
              searchPlaceholder="Search people…"
              emptyText="No one matches."
            />
          </Field>
          <Field label="Department" field="department">
            <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {depts.filter((d) => !d.disabled).map((d) => (
                  <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start date" hint="Drives leave accrual.">
              <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </Field>
            <Field label="Probation ends" hint={editing ? "Leave blank to clear." : "Blank defaults from start date."}>
              <Input type="date" value={form.probation_end_date} onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!canSubmit}>
              {editing ? "Save changes" : "Add employee"}
            </Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
