import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, Pencil, MoreHorizontal, KeyRound, LockKeyhole } from "lucide-react";
import { patch, invoke, type AepResource } from "@/api";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useCollection } from "@/hooks/useCollection";
import { roleLabel, registerRoleLabels, EVERYONE_ROLE } from "@/lib/roles";
import { CopyEmail } from "@/components/common/CopyEmail";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf } from "@/lib/utils";
import { daysSince, fmtDaysCount } from "@/lib/tableDerive";
import type { Employee, Me, User } from "@/types";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type BulkAction, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { BLANK } from "@/lib/tableFilter";
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

// When an account stops looking idle and starts looking abandoned. A quarter of silence on a privileged
// login is the question an access review exists to ask.
const DORMANT_DAYS = 90;

const NONE = "__none__";

/**
 * User role/status/employee-link management, for whoever writes `users` (super admin by default). Also opens,
 * read-only, for a caller who may only reset app PINs (HR by default): the list and the Reset app PIN action,
 * with every edit, role and permission control left out.
 */
export function RolesPanel({ me, controlsSlot }: { me: Me; controlsSlot?: HTMLElement | null }) {
  const isAdmin = usePermission("users.write");
  const canResetPin = usePermission("users.resetPin");
  const canManagePerms = usePermission("access-rules.write");
  // `all`: these rows are not only listed, they are searched. `employeeOptions` below builds the "already
  // linked to <email>" warning out of them, and past one page that hint silently stops appearing - so an admin
  // links a second login to an employee who already has one, which is the single thing the hint exists to
  // prevent. An absent warning reads as "no clash", not as "not checked".
  const { rows, state, error, reload } = useCollection<User>("users", { all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  // The roles this org actually has, read from the `roles` collection. Every assignable-role control below
  // offers these and nothing else: a user's role is a foreign key to a roles row, so a name that is not in the
  // table cannot be saved, and a role the org created has to be offered or it cannot be given to anyone.
  // `everyone` is a rule subject every caller already holds, never a role a person is assigned.
  // Only an editor offers roles, so only an editor reads them; the labels in the list come from `users/me`.
  const { rows: roleRows, state: rolesState } = useCollection<{ path: string; name: string; label?: string; provisioned?: boolean }>("roles", { all: true, enabled: isAdmin });
  useEffect(() => registerRoleLabels(roleRows), [roleRows]);
  const roleOptions = useMemo(() => roleRows.map((r) => r.name).filter((n) => n !== EVERYONE_ROLE), [roleRows]);
  // The role new accounts are given (the org sets it on the Roles tab). "Privileged" below means anything above
  // it: that is the baseline every hire gets, so holding more is what an access review asks about.
  const provisioned = roleRows.find((r) => r.provisioned)?.name;
  const isPrivileged = (role: string | undefined) => !!role && !!provisioned && role !== provisioned;
  const roleVariant = (role: string) => (isPrivileged(role) ? "secondary" : "muted");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ role: "", status: "active", employee: NONE, roles: [] as string[] });
  const [permUser, setPermUser] = useState<User | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Someone" : "-");
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

  if (!isAdmin && !canResetPin) {
    return <EmptyState icon={ShieldAlert} title="Restricted" description="Only super admins can manage roles and access." />;
  }

  function openEdit(u: User) {
    setEditing(u);
    setForm({ role: u.role, status: u.status, employee: u.employee ? `employees/${idOf(u.employee)}` : NONE, roles: [...(u.roles ?? [])].sort() });
  }

  // Consequential and not undoable from the same button: it signs the person out everywhere and makes whatever
  // their browsers stored unreadable. Harmless on an account that never set a PIN, which is why it is offered
  // on every row rather than only where a PIN exists (nothing here knows which accounts have one).
  async function resetPin(u: User) {
    const ok = await confirm({
      title: `Reset the app PIN for ${u.email}?`,
      description: "Their PIN is cleared and they are signed out on every device. They can set a new PIN after signing in again. They'll be told it was reset.",
      confirmLabel: "Reset PIN",
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke("users/" + idOf(u.path), "resetPin");
      toast({ title: "App PIN reset", description: `${u.email} is signed out everywhere.`, variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't reset the PIN", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    }
  }

  const isSelf = editing?.email === me.email;
  // Save is only offered when something actually differs from the record - "Save changes" on an untouched
  // form is an action with no effect, and pressing it teaches nothing about whether it worked.
  const dirty =
    !!editing &&
    (form.role !== editing.role ||
      form.status !== editing.status ||
      form.roles.join() !== [...(editing.roles ?? [])].sort().join() ||
      form.employee !== (editing.employee ? `employees/${idOf(editing.employee)}` : NONE));

  // Throws to fail: WriteDialog pins the message in the form and keeps the choices made.
  async function submit() {
    if (!editing) return;
    const body: Record<string, unknown> = { employee: form.employee === NONE ? null : form.employee };
    if (!isSelf) {
      body.role = form.role;
      body.status = form.status;
      // Sent whole, not as a diff - the server replaces the set. The primary is filtered out there too, but
      // dropping it here keeps the request saying exactly what the form means.
      body.roles = form.roles.filter((r) => r !== form.role);
    }
    await patch("users/" + idOf(editing.path), body, editing.etag);
    toast({ title: "User updated", variant: "success" });
    reload();
  }

  // Two gaps a login list is audited for, both of which look like ordinary rows: an account with nobody
  // behind it survives every leaver process, and a disabled account holding a privileged role is one
  // re-enable away from being live again.
  const userInsights = (us: User[]): TableInsight[] => {
    const out: TableInsight[] = [];
    const unlinked = us.filter((u) => u.status === "active" && !u.employee);
    if (unlinked.length > 0) {
      out.push({
        id: "no-employee",
        label: `${unlinked.length} not linked to an employee`,
        tone: "warning",
        hint: "Nothing ties these logins to a person, so an exit never touches them and no self-scoped rule applies.",
        filters: { employee: BLANK, status: "Active" },
      });
    }
    // Active, privileged, and nobody has signed in for a quarter. The account most worth asking about in a
    // review: it still opens every door it ever did, and nothing is using it.
    const dormant = us.filter((u) => u.status === "active" && isPrivileged(u.role) && (daysSince(u.last_seen_time ?? u.create_time) ?? 0) >= DORMANT_DAYS);
    const baseline = provisioned ? roleLabel(provisioned) : "the role new accounts get";
    if (dormant.length > 0) {
      out.push({
        id: "dormant",
        label: `${dormant.length} privileged and dormant`,
        tone: "warning",
        hint: `Above ${baseline}, still enabled, and unused for ${DORMANT_DAYS} days or never signed in.`,
        filters: { dormant_days: `>=${DORMANT_DAYS}`, status: "Active" },
        sort: "dormant_days.desc",
      });
    }
    const disabledPrivileged = us.filter((u) => u.status !== "active" && isPrivileged(u.role));
    if (disabledPrivileged.length > 0) {
      out.push({
        id: "disabled-privileged",
        label: `${disabledPrivileged.length} disabled but still privileged`,
        hint: `Disabled accounts that keep a role above ${baseline}. Re-enabling one hands the access straight back.`,
        filters: { status: "Disabled" },
      });
    }
    return out;
  };

  const columns: Column<User>[] = [
    { id: "email", header: "Email", accessor: (u) => u.email, cell: (u) => <CopyEmail email={u.email} className="font-medium" /> },
    { id: "role", header: "Role", filter: "select", groupBy: true, accessor: (u) => roleLabel(u.role), cell: (u) => <Badge variant={roleVariant(u.role)}>{roleLabel(u.role)}</Badge> },
    {
      id: "status",
      header: "Status",
      filter: "select",
      groupBy: true,
      accessor: (u) => (u.status === "active" ? "Active" : "Disabled"),
      cell: (u) => <Badge variant={u.status === "active" ? "success" : "destructive"}>{u.status === "active" ? "Active" : "Disabled"}</Badge>,
    },
    // Blank is a login with no employee behind it - the account that gets missed when somebody leaves.
    { id: "employee", header: "Linked employee", filter: "select", accessor: (u) => empName(u.employee) },
    {
      // When the account was last used. An access review is a list of accounts and a question - "does this
      // person still need this?" - and the only evidence on the page was who they are.
      id: "last_seen", header: "Last seen", filter: "date", dateHint: "past", defaultHidden: true,
      accessor: (u) => u.last_seen_time ?? "",
      cell: (u) => (u.last_seen_time ? formatDate(u.last_seen_time) : <span className="text-muted-foreground">never</span>),
    },
    {
      // The same reading as a number, because a review asks it as a threshold: "anything not used this
      // quarter". An account that has NEVER been seen falls back to its own age, which is the honest figure -
      // a login created two hundred days ago and never used has been dormant for two hundred days - and it
      // keeps the chip's filter exact, since a blank would drop those rows out of a range it counted them in.
      id: "dormant_days", header: "Dormant", align: "right", defaultHidden: true, filter: "number", formatTotal: fmtDaysCount,
      accessor: (u) => daysSince(u.last_seen_time ?? u.create_time),
      cell: (u) => {
        const d = daysSince(u.last_seen_time ?? u.create_time);
        if (d == null) return <span className="text-muted-foreground">-</span>;
        const never = !u.last_seen_time;
        return (
          <span className={cn("tabular-nums text-xs", d >= DORMANT_DAYS ? "font-medium text-warning" : "text-muted-foreground")}>
            {never ? `never · ${fmtDaysCount(d)} old` : fmtDaysCount(d)}
          </span>
        );
      },
    },
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
            {isAdmin && <DropdownMenuItem onClick={() => openEdit(u)}><Pencil className="h-4 w-4" /> Edit</DropdownMenuItem>}
            {canManagePerms && <DropdownMenuItem onClick={() => setPermUser(u)}><KeyRound className="h-4 w-4" /> Manage permissions</DropdownMenuItem>}
            {/* The only way back from a forgotten app PIN (services/appLock.ts resetPin). */}
            <AccessAction verb="resetPin" collection="users" objectPath={`users/${idOf(u.path)}`} can={(u as User & AepResource).access?.can}>
              <DropdownMenuItem onClick={() => void resetPin(u)}><LockKeyhole className="h-4 w-4" /> Reset app PIN</DropdownMenuItem>
            </AccessAction>
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
  const bulkActions: BulkAction<User>[] = !isAdmin ? [] : [
    ...roleOptions.map((r) => ({
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
          <DataTable tableId="users" columns={columns} rows={rows} insights={userInsights} getRowId={(u) => u.path} accessCollection="users" emptyTitle="No users match" rowClassName={() => "group"} controlsSlot={controlsSlot} bulkActions={bulkActions} />
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
                {/* The user's current role is always listed, so the control shows what they hold even before
                    the roles have loaded. */}
                {(roleOptions.includes(form.role) ? roleOptions : [form.role, ...roleOptions]).map((r) => (
                  <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rolesState === "error" && <p className="mt-1 text-xs text-destructive">Couldn't load this organization's roles, so only the current one is offered.</p>}
          </Field>
          {/* ADDITIONAL roles. Separate from the primary rather than folded into one multi-select, because the
              primary is not interchangeable with these: it is what the audit trail records for every act this
              person performs and what the app labels them by. Toggles rather than a combobox - the list is short,
              and seeing which roles somebody does NOT hold is half of what this control is read for. */}
          <Field
            label="Additional roles"
            field="roles"
            hint="Their permissions are added to the primary role. Someone who is both a team lead and the office's asset manager holds both - and keeps tracking each bundle as it changes."
            accessTarget={{ collection: "users", field: "roles", label: "Additional roles" }}
          >
            <div className="flex flex-wrap gap-1.5">
              {/* Plus any extra role the user already holds that the list lacks, so it can still be taken off. */}
              {[...roleOptions, ...form.roles.filter((r) => !roleOptions.includes(r))].filter((r) => r !== form.role).map((r) => {
                const on = form.roles.includes(r);
                return (
                  <Button
                    key={r}
                    type="button"
                    variant={on ? "default" : "outline"}
                    size="sm"
                    className="h-7"
                    disabled={isSelf}
                    aria-pressed={on}
                    onClick={() => setForm({ ...form, roles: on ? form.roles.filter((x) => x !== r) : [...form.roles, r].sort() })}
                  >
                    {roleLabel(r)}
                  </Button>
                );
              })}
            </div>
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
