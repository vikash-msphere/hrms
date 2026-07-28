import { useMemo, useState } from "react";
import { Plus, Trash2, Pencil, MoreHorizontal, KeyRound } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import type { User } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SubjectPermissionsDialog } from "@/components/access/SubjectPermissionsDialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

type Role = { path: string; name: string; label: string; protected: boolean; etag?: string };
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/; // mirrors the server (lower_snake, 2-41 chars)

// Manage the role catalog (definitions). A new role starts with NO permissions (deny-all); grant access to
// it from the Permissions tab. Assigning users to a role is the Users tab. Deletion is guarded server-side
// (protected core roles, the role you're using, and roles still held by a user cannot be deleted).
export function RolesManagePanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  const { rows: roles, reload } = useCollection<Role>("roles");
  const { rows: users } = useCollection<User>("users");
  const canWrite = usePermission("roles.write");
  const canManagePerms = usePermission("access-rules.write");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [form, setForm] = useState({ name: "", label: "", protected: false });
  const [permRole, setPermRole] = useState<Role | null>(null);

  const userCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) if (u.role) m.set(u.role, (m.get(u.role) ?? 0) + 1);
    return m;
  }, [users]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", label: "", protected: false });
    setOpen(true);
  }
  function openEdit(r: Role) {
    setEditing(r);
    setForm({ name: r.name, label: r.label, protected: r.protected });
    setOpen(true);
  }

  const nameValid = editing ? true : NAME_RE.test(form.name.trim());

  const columns: Column<Role>[] = [
    {
      id: "role", header: "Role", filter: "text", accessor: (r) => r.label,
      cell: (r) => <span className="font-medium">{r.label}{r.protected && <Badge variant="muted" className="ml-2 px-1 py-0 text-[10px]">core</Badge>}</span>,
    },
    { id: "name", header: "Identifier", filter: "text", accessor: (r) => r.name, cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.name}</span> },
    { id: "users", header: "Users", filter: "none", align: "right", accessor: (r) => userCount.get(r.name) ?? 0 },
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) =>
        (canWrite || canManagePerms) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWrite && <DropdownMenuItem onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /> Edit</DropdownMenuItem>}
              {canManagePerms && <DropdownMenuItem onClick={() => setPermRole(r)}><KeyRound className="h-4 w-4" /> Manage permissions</DropdownMenuItem>}
              {canWrite && !r.protected && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => del(r)}><Trash2 className="h-4 w-4" /> Delete</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  async function submit() {
    setBusy(true);
    try {
      if (editing) {
        await patch("roles/" + editing.name, { label: form.label.trim(), protected: form.protected }, editing.etag);
        toast({ title: "Role updated", variant: "success" });
      } else {
        await create("roles", { name: form.name.trim(), label: form.label.trim() || form.name.trim(), protected: form.protected });
        toast({ title: "Role created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save role", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function del(r: Role) {
    const inUse = userCount.get(r.name) ?? 0;
    const ok = await confirm({
      title: `Delete role "${r.label}"?`,
      description: inUse ? `${inUse} user${inUse === 1 ? "" : "s"} still have this role - reassign them first.` : "This removes the role and all its permission rules.",
      destructive: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await remove("roles/" + r.name, r.etag);
      toast({ title: "Role deleted", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <DataTable
          columns={columns}
          tableId="roles"
          rows={roles}
          getRowId={(r) => r.path}
          rowClassName={() => "group"}
          emptyTitle="No roles"
          toolbar={canWrite ? <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> New role</Button> : undefined}
          controlsSlot={controlsSlot}
        />
        <p className="mt-3 text-xs text-muted-foreground">A new role starts with no permissions - grant access to it in the Permissions tab, then assign users in the Users tab.</p>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit role" : "New role"}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <Field label="Identifier">
              <Input value={form.name} disabled className="font-mono" />
            </Field>
          ) : (
            <Field label="Identifier" hint="Lower_snake_case (a-z, 0-9, _), 2-41 chars. Immutable once created.">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. finance_lead" autoFocus className="font-mono" />
            </Field>
          )}
          <Field label="Display name">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Finance Lead" />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="role-protected" checked={form.protected} onCheckedChange={(v) => setForm({ ...form, protected: v === true })} />
            <Label htmlFor="role-protected">Protected (cannot be deleted)</Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={editing ? !form.label.trim() : !nameValid}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SubjectPermissionsDialog
        open={!!permRole}
        onClose={() => setPermRole(null)}
        subjectKind="role"
        subject={permRole?.name ?? ""}
        label={permRole?.label ?? ""}
      />
    </Card>
  );
}
