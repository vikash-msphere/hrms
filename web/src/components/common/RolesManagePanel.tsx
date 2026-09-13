import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Pencil, MoreHorizontal, KeyRound } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { registerRoleLabels } from "@/lib/roles";
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
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { cloneAccessRules } from "@/components/access/cloneRules";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SubjectPermissionsDialog } from "@/components/access/SubjectPermissionsDialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

type Role = { path: string; name: string; label: string; protected: boolean; etag?: string };
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/; // mirrors the server (lower_snake, 2-41 chars)
// "Finance Lead" -> "finance_lead": the identifier nearly always is the display name, so it is derived
// rather than asked for twice, and stops being derived the moment somebody types one by hand.
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 41);
// "Start from" sentinel: a role built from scratch rather than copied.
const NO_CLONE = "__none__";

// Manage the role catalog (definitions). A new role starts with NO permissions (deny-all); grant access to
// it from the Permissions tab. Assigning users to a role is the Users tab. Deletion is guarded server-side
// (protected core roles, the role you're using, and roles still held by a user cannot be deleted).
export function RolesManagePanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  const { rows: roles, reload } = useCollection<Role>("roles");
  // The one page that always has every role's own label in hand - hand it to the shared lookup so a rule
  // subject reads as "Finance Lead" rather than `finance_lead` wherever it is rendered next.
  useEffect(() => registerRoleLabels(roles), [roles]);
  const { rows: users } = useCollection<User>("users");
  const canWrite = usePermission("roles.write");
  const canManagePerms = usePermission("access-rules.write");
  // Copying a whole role's permissions is its own custom method (`access-rules:clone`), grantable apart from
  // authoring rules one at a time - so the "Start from" field only renders for callers who hold it.
  const canClonePerms = usePermission("access-rules.clone");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  // `touchedName` is form state rather than a ref so the discard guard sees the same object it always did;
  // it only records whether the identifier was typed by hand, which stops the display name overwriting it.
  const [form, setForm] = useState({ name: "", label: "", protected: false, touchedName: false, cloneFrom: NO_CLONE });
  const [permRole, setPermRole] = useState<Role | null>(null);

  const userCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) if (u.role) m.set(u.role, (m.get(u.role) ?? 0) + 1);
    return m;
  }, [users]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", label: "", protected: false, touchedName: false, cloneFrom: NO_CLONE });
    setOpen(true);
  }
  function openEdit(r: Role) {
    setEditing(r);
    setForm({ name: r.name, label: r.label, protected: r.protected, touchedName: true, cloneFrom: NO_CLONE });
    setOpen(true);
  }

  const nameValid = editing ? true : NAME_RE.test(form.name.trim());
  // Both clashes are worth catching here rather than at the server's 409: an identifier collision fails the
  // save, and a duplicate display name succeeds and then leaves two identical-looking roles in every picker.
  const duplicateName = !editing && !!form.name.trim() && roles.some((r) => r.name === form.name.trim());
  const duplicateLabel = !!form.label.trim() && roles.some((r) => r.path !== editing?.path && (r.label ?? "").trim().toLowerCase() === form.label.trim().toLowerCase());

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
              <Button variant="ghost" size="icon" aria-label="Role actions" className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:h-9 coarse:w-9">
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

  // Throws to fail: WriteDialog pins the message in the form and keeps what was typed.
  async function submit() {
    if (editing) {
      await patch("roles/" + editing.name, { label: form.label.trim(), protected: form.protected }, editing.etag);
      toast({ title: "Role updated", variant: "success" });
    } else {
      const name = form.name.trim();
      const label = form.label.trim() || name;
      await create("roles", { name, label, protected: form.protected });
      // Copied through the same create API as any other grant, so the four-eyes queue and the audit trail
      // apply to every one of them. Additive - the new role has nothing to overwrite.
      if (form.cloneFrom !== NO_CLONE) {
        const { added, skipped } = await cloneAccessRules({ kind: "role", subject: form.cloneFrom }, { kind: "role", subject: name });
        toast({ title: `Role created · ${added} rules copied${skipped ? ` · ${skipped} skipped` : ""}`, variant: "success" });
      } else {
        toast({ title: "Role created", variant: "success" });
      }
      // A role with no permissions is inert, so hand over its permissions dialog instead of dropping the
      // reader back on a table row that does nothing. This is the step that used to get forgotten.
      if (canManagePerms) setPermRole({ path: "roles/" + name, name, label, protected: form.protected });
    }
    reload();
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
      <CardContent className="pt-4 sm:pt-6">
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit role" : "New role"}
        description={
          editing
            ? "The display name is what people see; the identifier is what rules are written against and never changes."
            : "A role is a named bundle of permissions. It starts with none - nobody gains anything until you grant it access."
        }
        collection="roles"
        objectPath={editing?.path}
        guardLabel="role"
        form={form}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={editing ? !!form.label.trim() : nameValid && !duplicateName}
        // Every blocker at once: a new role can be short of an identifier AND a name, and finding that out one
        // press at a time is the slowest way to fill in two fields.
        whyNot={[
          !editing && !form.name.trim() && "Give the role an identifier.",
          !editing && !!form.name.trim() && !nameValid && "The identifier must be lower_snake_case, 2-41 characters, starting with a letter.",
          !editing && duplicateName && "A role with that identifier already exists.",
          editing && !form.label.trim() && "Give the role a display name.",
        ]}
        onSubmit={submit}
        submitAccess={editing ? undefined : (b) => <AccessAction collection="roles" create label="New role">{b}</AccessAction>}
        footerStart={
          editing ? (
            <span className="truncate text-xs text-muted-foreground">
              {(userCount.get(editing.name) ?? 0) === 0 ? "Nobody holds this role yet." : `${userCount.get(editing.name)} ${userCount.get(editing.name) === 1 ? "person holds" : "people hold"} this role.`}
            </span>
          ) : undefined
        }
      >
          {editing ? (
            <Field label="Identifier" hint="Fixed: access rules are written against it.">
              <Input value={form.name} disabled className="font-mono" />
            </Field>
          ) : (
            <Field
              label="Identifier"
              field="name"
              hint="Lower_snake_case (a-z, 0-9, _), 2-41 chars. Immutable once created."
              error={
                duplicateName ? "A role with this identifier already exists."
                : form.name.trim() && !nameValid ? "Lower_snake_case only: start with a letter, then letters, digits or underscores."
                : undefined
              }
            >
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, touchedName: true })} placeholder="e.g. finance_lead" autoFocus className="font-mono" />
            </Field>
          )}
          {/* Typing the display name fills the identifier while nobody has touched it, so the common case is
              one field: "Finance Lead" becomes `finance_lead`. */}
          <Field label="Display name" field="label" error={duplicateLabel ? "Another role is already called that - the two are indistinguishable in every picker." : undefined}>
            <Input
              value={form.label}
              onChange={(e) => {
                const label = e.target.value;
                setForm((f) => ({ ...f, label, name: !editing && !f.touchedName ? slugify(label) : f.name }));
              }}
              placeholder="e.g. Finance Lead"
              autoFocus={!!editing}
            />
          </Field>
          <div className="flex items-start gap-2">
            <Checkbox id="role-protected" className="mt-0.5" aria-describedby="role-protected-hint" checked={form.protected} onCheckedChange={(v) => setForm({ ...form, protected: v === true })} />
            {/* The hint stays OUT of the label: text inside one joins the checkbox's accessible name, and a
                name carrying a sentence about roles answers to every label this form has. Described, not named. */}
            <span className="leading-snug">
              <Label htmlFor="role-protected" className="font-normal">Protected</Label>
              <span id="role-protected-hint" className="block text-xs text-muted-foreground">Nobody can delete this role, including you. Use it for the roles the org's access model is built on.</span>
            </span>
          </div>
          {/* Most new roles are a near-copy of an existing one ("Finance Lead is Manager plus payroll"), and
              building that by hand across sixty collections is why a fresh role sits unused. Copying is
              additive and goes through the same grant API, so the audit trail and any four-eyes queue apply. */}
          {!editing && canManagePerms && canClonePerms && roles.length > 0 && (
            <Field label="Start from" hint="Copies that role's permissions into the new one. You can change them straight afterwards.">
              <Select value={form.cloneFrom} onValueChange={(v) => setForm({ ...form, cloneFrom: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLONE}>Nothing - start with no permissions</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.name} value={r.name}>{r.label || r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {!editing && (
            <p className="rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
              {form.cloneFrom === NO_CLONE
                ? "The new role can do nothing until it is granted access. Saving opens its permissions straight away, so it doesn't get created and forgotten."
                : `The new role starts with everything ${roles.find((r) => r.name === form.cloneFrom)?.label ?? form.cloneFrom} can do. Saving opens its permissions so you can take away what it shouldn't have.`}
            </p>
          )}
      </WriteDialog>

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
