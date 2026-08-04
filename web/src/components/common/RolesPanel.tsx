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
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ role: "employee", status: "active", employee: NONE });
  const [permUser, setPermUser] = useState<User | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  if (!isAdmin) {
    return <EmptyState icon={ShieldAlert} title="Restricted" description="Only super admins can manage roles and access." />;
  }

  function openEdit(u: User) {
    setEditing(u);
    setForm({ role: u.role, status: u.status, employee: u.employee ? `employees/${idOf(u.employee)}` : NONE });
  }

  const isSelf = editing?.email === me.email;

  async function submit() {
    if (!editing) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { employee: form.employee === NONE ? null : form.employee };
      if (!isSelf) {
        body.role = form.role;
        body.status = form.status;
      }
      await patch("users/" + idOf(editing.path), body, editing.etag);
      toast({ title: "User updated", variant: "success" });
      setEditing(null);
      reload();
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
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
            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
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

  return (
    <>
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No users yet" description="Users appear here after their first sign-in." />
        ) : (
          <DataTable tableId="users" columns={columns} rows={rows} getRowId={(u) => u.path} emptyTitle="No users match" rowClassName={() => "group"} controlsSlot={controlsSlot} />
        )}
      </DataState>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit access</DialogTitle>
          </DialogHeader>
          {editing && <p className="-mt-1 text-sm text-muted-foreground">{editing.email}</p>}
          <Field label="Role" accessTarget={{ collection: "users", field: "role", label: "Role" }}>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status" accessTarget={{ collection: "users", field: "status", label: "Status" }}>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {isSelf && <p className="text-xs text-muted-foreground">You can't change your own role or disable your own account.</p>}
          <Field label="Linked employee" hint="Connects this login to an employee record." accessTarget={{ collection: "users", field: "employee", label: "Linked employee" }}>
            <Select value={form.employee} onValueChange={(v) => setForm({ ...form, employee: v })}>
              <SelectTrigger><SelectValue placeholder="Not linked" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not linked</SelectItem>
                {employees.filter((e) => !e.disabled).map((e) => (
                  <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={submit} loading={busy}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SubjectPermissionsDialog
        open={!!permUser}
        onClose={() => setPermUser(null)}
        subjectKind="user"
        subject={permUser?.path ?? ""}
        label={permUser?.email ?? ""}
      />
    </>
  );
}
