import { useMemo, useState } from "react";
import { ShieldAlert, Pencil, MoreHorizontal, KeyRound } from "lucide-react";
import { patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { roleLabel, type Role } from "@/lib/roles";
import { CopyEmail } from "@/components/common/CopyEmail";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { Employee, Me, User } from "@/types";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type BulkAction, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Combobox } from "@/components/ui/combobox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SubjectPermissionsDialog } from "@/components/access/SubjectPermissionsDialog";
import { useToast } from "@/components/ui/use-toast";

const ROLE_OPTIONS: Role[] = ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"];
const NONE = "__none__";
const roleVariant = (role: string) => (role === "super_admin" ? "default" : role === "employee" ? "muted" : "secondary");

/** User role/status/employee-link management. Restricted to super_admin (the `admin` capability). */
export function RolesPanel({ me, controlsSlot }: { me: Me; controlsSlot?: HTMLElement | null }) {
  const isAdmin = usePermission("users.write");
  const canManagePerms = usePermission("access-rules.write");
  const { rows, state, error, reload } = useCollection<User>("users");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();

  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ role: "employee", status: "active", employee: NONE });
  const [permUser, setPermUser] = useState<User | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  // One searchable list: "not linked", then every active employee, each saying whether another login already
  // holds them.
  const employeeOptions = useMemo(() => {
    const heldBy = new Map<string, string>();
    for (const u of rows) if (u.employee && u.path !== editing?.path) heldBy.set(idOf(u.employee), u.email);
    return [
      { value: NONE, label: "Not linked" },
      ...employees
        .filter((e) => !e.disabled)
        .map((e) => {
          const holder = heldBy.get(idOf(e.path));
          return { value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}${holder ? ` · already linked to ${holder}` : ""}` };
        }),
    ];
  }, [employees, rows, editing]);

  if (!isAdmin) {
    return <EmptyState icon={ShieldAlert} title="Restricted" description="Only super admins can manage roles and access." />;
  }

  function openEdit(u: User) {
    setEditing(u);
    setForm({ role: u.role, status: u.status, employee: u.employee ? `employees/${idOf(u.employee)}` : NONE });
  }

  const isSelf = editing?.email === me.email;
  // Save is only offered when something actually differs from the record - "Save changes" on an untouched
  // form is an action with no effect, and pressing it teaches nothing about whether it worked.
  const dirty =
    !!editing &&
    (form.role !== editing.role ||
      form.status !== editing.status ||
      form.employee !== (editing.employee ? `employees/${idOf(editing.employee)}` : NONE));

  // Throws to fail: WriteDialog pins the message in the form and keeps the choices made.
  async function submit() {
    if (!editing) return;
    const body: Record<string, unknown> = { employee: form.employee === NONE ? null : form.employee };
    if (!isSelf) {
      body.role = form.role;
      body.status = form.status;
    }
    await patch("users/" + idOf(editing.path), body, editing.etag);
    toast({ title: "User updated", variant: "success" });
    reload();
  }

  const columns: Column<User>[] = [
    { id: "email", header: "Email", accessor: (u) => u.email, cell: (u) => <CopyEmail email={u.email} className="font-medium" /> },
    { id: "role", header: "Role", filter: "select", accessor: (u) => roleLabel(u.role), cell: (u) => <Badge variant={roleVariant(u.role)}>{roleLabel(u.role)}</Badge> },
    {
      id: "status",
      header: "Status",
      filter: "select",
      accessor: (u) => (u.status === "active" ? "Active" : "Disabled"),
      cell: (u) => <Badge variant={u.status === "active" ? "success" : "destructive"}>{u.status === "active" ? "Active" : "Disabled"}</Badge>,
    },
    { id: "employee", header: "Linked employee", accessor: (u) => empName(u.employee) },
    ...metaColumns<User>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (u) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="User actions" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:h-9 coarse:w-9">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openEdit(u)}><Pencil className="h-4 w-4" /> Edit</DropdownMenuItem>
            {canManagePerms && <DropdownMenuItem onClick={() => setPermUser(u)}><KeyRound className="h-4 w-4" /> Manage permissions</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  // One person at a time is the wrong shape for the two changes that arrive in batches: a reorg that moves
  // eight people onto a new role, and an offboarding sweep that disables the leavers. Each runs through the
  // same PATCH the dialog uses, and skips the caller's own row - nobody demotes or locks themselves out here.
  const bulkPatch = async (users: User[], body: Record<string, unknown>) => {
    const targets = users.filter((u) => u.email !== me.email);
    for (const u of targets) await patch("users/" + idOf(u.path), body, u.etag);
    toast({ title: `${targets.length} user${targets.length === 1 ? "" : "s"} updated`, variant: "success" });
    reload();
  };
  const notYourself = (users: User[]) =>
    users.every((u) => u.email === me.email) ? "You can't change your own role or account this way." : null;
  const bulkActions: BulkAction<User>[] = [
    ...ROLE_OPTIONS.map((r) => ({
      label: `Set role: ${roleLabel(r)}`,
      disabled: notYourself,
      confirm: {
        title: `Move the selected people to ${roleLabel(r)}?`,
        description: "Everything they can see and do changes with the role, on their very next request. Your own row is left alone.",
      },
      run: (users: User[]) => bulkPatch(users, { role: r }),
    })),
    {
      label: "Disable",
      destructive: true,
      disabled: notYourself,
      confirm: {
        title: "Disable the selected accounts?",
        description: "They are signed out and their next request is refused. Their records stay, and approvals routed to them will sit unanswered. Your own row is left alone.",
      },
      run: (users: User[]) => bulkPatch(users, { status: "disabled" }),
    },
    {
      label: "Enable",
      disabled: notYourself,
      run: (users: User[]) => bulkPatch(users, { status: "active" }),
    },
  ];

  return (
    <>
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No users yet" description="Users appear here after their first sign-in." />
        ) : (
          <DataTable tableId="users" columns={columns} rows={rows} getRowId={(u) => u.path} emptyTitle="No users match" rowClassName={() => "group"} controlsSlot={controlsSlot} bulkActions={bulkActions} />
        )}
      </DataState>

      <WriteDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit access"
        description={editing ? `What ${editing.email} can sign in as. A role change applies on their very next request - they do not have to sign in again.` : undefined}
        collection="users"
        objectPath={editing?.path}
        guardLabel="change"
        form={form}
        submitLabel="Save changes"
        canSubmit={dirty}
        whyNot="Nothing has changed yet."
        onSubmit={submit}
        footerStart={
          editing && canManagePerms ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => { const u = editing; setEditing(null); setPermUser(u); }}>
              <KeyRound className="h-4 w-4" /> Per-user permissions
            </Button>
          ) : undefined
        }
      >
          <Field label="Role" field="role" hint="A role is a bundle of permissions. Per-user exceptions layer on top of it." accessTarget={{ collection: "users", field: "role", label: "Role" }}>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status" field="status" accessTarget={{ collection: "users", field: "status", label: "Status" }}>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {isSelf && <p className="text-xs text-muted-foreground">You can't change your own role or disable your own account.</p>}
          {/* What Save will actually do to this person, before it is pressed. Two of these three are the
              changes somebody notices only when a colleague says "I've been locked out". */}
          {editing && dirty && (
            <ul className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50/60 p-2.5 text-xs dark:border-amber-800 dark:bg-amber-950/30">
              {form.role !== editing.role && (
                <li className="flex items-start gap-2">
                  <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>Role goes from <strong>{roleLabel(editing.role)}</strong> to <strong>{roleLabel(form.role)}</strong>. Everything they can see and do changes with it.</span>
                </li>
              )}
              {form.status !== editing.status && (
                <li className="flex items-start gap-2">
                  <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    {form.status === "disabled"
                      ? "Disabling signs them out and refuses their next request. Their records stay; approvals routed to them will sit unanswered."
                      : "They can sign in again from the next request."}
                  </span>
                </li>
              )}
              {form.employee !== (editing.employee ? `employees/${idOf(editing.employee)}` : NONE) && (
                <li className="flex items-start gap-2">
                  <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    {form.employee === NONE
                      ? "Unlinking leaves this login with no employee record: their own leave, payslips and profile stop resolving."
                      : `Their own records - leave, payslips, profile - become ${empName(form.employee)}'s.`}
                  </span>
                </li>
              )}
            </ul>
          )}
          <Field label="Linked employee" field="employee" hint="Connects this login to an employee record. Type to search." accessTarget={{ collection: "users", field: "employee", label: "Linked employee" }}>
            {/* A Select of every employee is a scroll-and-hunt at any real headcount; this one filters as you
                type. Already-linked people are named with the login that holds them, because one employee on
                two logins is how "my leave disappeared" happens. */}
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              placeholder="Not linked"
              searchPlaceholder="Search employees…"
              options={employeeOptions}
            />
          </Field>
      </WriteDialog>

      <SubjectPermissionsDialog
        open={!!permUser}
        onClose={() => setPermUser(null)}
        subjectKind="user"
        subject={permUser?.path ?? ""}
        label={permUser?.email ?? ""}
        viaRole={permUser?.role}
      />
    </>
  );
}
