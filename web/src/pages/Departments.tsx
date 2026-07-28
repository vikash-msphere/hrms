import { useState } from "react";
import { Building2, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

export default function Departments({ embedded, title }: { me?: Me; embedded?: boolean; title?: string }) {
  const { rows, state, error, reload } = useCollection<Department>("departments", { showDeleted: true });
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("departments", "department", reload);
  const lc = useLifecycle("departments", "department", reload);
  const writable = usePermission("departments.write");
  const canPurge = usePermission("departments.admin");

  const empName = (path: string) => {
    const e = employees.find((x) => idOf(x.path) === idOf(path));
    return e ? `${e.first_name} ${e.last_name}` : idOf(path);
  };

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [name, setName] = useState("");
  const [managers, setManagers] = useState<string[]>([]); // employee resource paths

  function openCreate() {
    setEditing(null);
    setName("");
    setManagers([]);
    setOpen(true);
  }
  function openEdit(d: Department) {
    setEditing(d);
    setName(d.display_name);
    setManagers(d.managers ?? []);
    setOpen(true);
  }
  const toggleManager = (path: string) =>
    setManagers((m) => (m.includes(path) ? m.filter((x) => x !== path) : [...m, path]));

  async function submit() {
    setBusy(true);
    try {
      const body = { display_name: name, managers };
      if (editing) {
        await patch("departments/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Department updated", variant: "success" });
      } else {
        await create("departments", body);
        toast({ title: "Department created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save department", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Department>[] = [
    { id: "name", header: "Name", accessor: (d) => d.display_name, cell: (d) => <span className="font-medium">{d.display_name}</span> },
    { id: "parent", header: "Parent", accessor: (d) => (d.parent ? idOf(d.parent) : ""), cell: (d) => (d.parent ? idOf(d.parent) : "-") },
    {
      id: "managers",
      header: "Managers",
      sortable: false,
      filter: "none",
      accessor: (d) => (d.managers ?? []).length,
      cell: (d) => ((d.managers ?? []).length ? (d.managers ?? []).map(empName).join(", ") : <span className="text-muted-foreground">-</span>),
    },
    stateColumn<Department>(),
    ...metaColumns<Department>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (d) => <SoftDeleteRowActions row={d} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="departments" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New department</Button>
    </AccessAction>
  );

  return (
    <div>
      {/* Standalone: own page header. Embedded (Settings tab): the create button rides the table toolbar. */}
      {!embedded && (
        <PageHeader accessCollection="departments" title="Departments" description="Organize your company into teams and reporting groups." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No departments yet"
            description="Create your first department to start grouping employees."
            action={createBtn}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="departments"
            rows={rows}
            getRowId={(d) => d.path}
            rowClassName={(d) => (d.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No departments match"
            title={embedded ? title : undefined}
            toolbar={embedded ? createBtn : undefined}
            accessCollection="departments"
            accessTargetOf={(d) => ({ objectPath: d.path, label: d.display_name, can: d.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && name.trim()) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit department" : "New department"}</DialogTitle>
          </DialogHeader>
          <Field label="Department name" htmlFor="dept-name">
            <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering" autoFocus />
          </Field>
          <Field label="Managers" hint="One or more employees who manage this department.">
            {employees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No employees to assign.</p>
            ) : (
              <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {employees.map((e) => (
                  <label key={e.path} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                    <Checkbox checked={managers.includes(`employees/${idOf(e.path)}`)} onCheckedChange={() => toggleManager(`employees/${idOf(e.path)}`)} />
                    <span>{e.first_name} {e.last_name}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
