import { useMemo, useState } from "react";
import { Building2, Plus, Search } from "lucide-react";
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
import type { TableInsight } from "@/components/common/TableInsights";
import { countBy } from "@/lib/tableSignals";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/common/SearchInput";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

// Radix Select has no value for "nothing selected", so the top-level choice carries a sentinel that the
// submit maps back to null.
const NONE = "__none__";

export default function Departments({ embedded, title }: { me?: Me; embedded?: boolean; title?: string }) {
  const { rows, state, error, reload } = useCollection<Department>("departments", { showDeleted: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
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
  const [parent, setParent] = useState(NONE);
  const [managers, setManagers] = useState<string[]>([]); // employee resource paths
  const [mgrQuery, setMgrQuery] = useState("");
  const form = useMemo(() => ({ name, parent, managers }), [name, parent, managers]);

  const deptName = (path?: string) => {
    if (!path) return "-";
    const d = rows.find((x) => idOf(x.path) === idOf(path));
    return d ? d.display_name : idOf(path);
  };
  // A department can't sit under itself or under one of its own children - the tree would have no root and the
  // org chart would recurse. Walk the child map from the one being edited and exclude everything it reaches.
  const descendants = useMemo(() => {
    if (!editing) return new Set<string>();
    const kids = new Map<string, string[]>();
    for (const d of rows) if (d.parent) kids.set(idOf(d.parent), [...(kids.get(idOf(d.parent)) ?? []), idOf(d.path)]);
    const out = new Set<string>();
    const walk = (id: string) => { for (const k of kids.get(id) ?? []) if (!out.has(k)) { out.add(k); walk(k); } };
    walk(idOf(editing.path));
    return out;
  }, [rows, editing]);
  // Two departments with the same name are indistinguishable everywhere they're picked. Warn, don't block -
  // "Sales" under two different parents is a real shape.
  const duplicate = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return rows.find((d) => !d.delete_time && d.path !== editing?.path && d.display_name.trim().toLowerCase() === n) ?? null;
  }, [rows, name, editing]);
  const visibleManagers = useMemo(() => {
    const q = mgrQuery.trim().toLowerCase();
    const live = employees.filter((e) => !e.disabled && !e.delete_time);
    return q ? live.filter((e) => `${e.first_name} ${e.last_name}`.toLowerCase().includes(q)) : live;
  }, [employees, mgrQuery]);

  function openCreate() {
    setEditing(null);
    setName("");
    setParent(NONE);
    setManagers([]);
    setMgrQuery("");
    setOpen(true);
  }
  function openEdit(d: Department) {
    setEditing(d);
    setName(d.display_name);
    setParent(d.parent ? `departments/${idOf(d.parent)}` : NONE);
    setManagers(d.managers ?? []);
    setMgrQuery("");
    setOpen(true);
  }
  const toggleManager = (path: string) =>
    setManagers((m) => (m.includes(path) ? m.filter((x) => x !== path) : [...m, path]));

  async function submit() {
    const body = { display_name: name, parent: parent === NONE ? null : parent, managers };
    if (editing) {
      await patch("departments/" + idOf(editing.path), body, editing.etag);
      toast({ title: "Department updated", variant: "success" });
    } else {
      await create("departments", body);
      toast({ title: "Department created", variant: "success" });
    }
    reload();
  }

  // Headcount per department, and the same counted down the tree. Both are over the employees this caller can
  // see, which is the same set the rest of the page is built from.
  const directCount = useMemo(
    () => countBy(employees.filter((e) => !e.delete_time && !e.disabled), (e) => (e.department ? idOf(e.department) : null)),
    [employees],
  );
  const rollupCount = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const d of rows) {
      const parent = d.parent ? idOf(d.parent) : "";
      if (!parent) continue;
      kids.set(parent, [...(kids.get(parent) ?? []), idOf(d.path)]);
    }
    const out = new Map<string, number>();
    // Depth-first with a seen set: a cycle in the tree is a data error, not a reason to hang the page.
    const count = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return (directCount.get(id) ?? 0) + (kids.get(id) ?? []).reduce((n, kid) => n + count(kid, seen), 0);
    };
    for (const d of rows) out.set(idOf(d.path), count(idOf(d.path), new Set()));
    return out;
  }, [rows, directCount]);

  // What a department list is checked for: the gaps that break routing, and the teams that are not teams.
  const departmentInsights = (ds: Department[]): TableInsight[] => {
    const live = ds.filter((d) => !d.delete_time && !d.disabled);
    const out: TableInsight[] = [];
    const unmanaged = live.filter((d) => (d.managers ?? []).length === 0);
    if (unmanaged.length > 0) {
      out.push({
        id: "no-manager",
        label: `${unmanaged.length} with nobody running them`,
        tone: "warning",
        hint: "Approvals that route to a department manager have nowhere to go.",
        filters: { managers: "=0" },
      });
    }
    const empty = live.filter((d) => (rollupCount.get(idOf(d.path)) ?? 0) === 0);
    if (empty.length > 0) {
      out.push({
        id: "empty",
        label: `${empty.length} with nobody in them`,
        hint: "Nobody sits in these or in anything under them - usually left over from a reorg.",
        filters: { headcount_rollup: "=0" },
      });
    }
    return out;
  };

  const columns: Column<Department>[] = [
    { id: "name", header: "Name", accessor: (d) => d.display_name, cell: (d) => <span className="font-medium">{d.display_name}</span> },
    // Sorted and filtered on the readable name, not the opaque id it's stored as.
    { id: "parent", header: "Parent", filter: "select", groupBy: true, accessor: (d) => (d.parent ? deptName(d.parent) : ""), cell: (d) => (d.parent ? deptName(d.parent) : <span className="text-muted-foreground">-</span>) },
    {
      id: "managers",
      header: "Managers",
      sortable: false,
      // Filtered as a count, so "=0" is every department with nobody running it - the gap that quietly
      // breaks approval routing.
      filter: "number",
      accessor: (d) => (d.managers ?? []).length,
      cell: (d) => ((d.managers ?? []).length ? (d.managers ?? []).map(empName).join(", ") : <span className="text-muted-foreground">-</span>),
    },
    // Headcount, direct and including everything underneath. A department list without it is a list of names
    // where a team of sixty and an empty one look the same, and the rollup is the number every conversation
    // about structure actually uses.
    {
      id: "headcount", header: "People", align: "right", filter: "number", aggregate: "sum",
      accessor: (d) => directCount.get(idOf(d.path)) ?? 0,
      cell: (d) => {
        const n = directCount.get(idOf(d.path)) ?? 0;
        return n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">0</span>;
      },
    },
    {
      // Not summed: the rollups of a parent and its children overlap, so a footer total of them would count
      // most people several times.
      id: "headcount_rollup", header: "With sub-teams", align: "right", defaultHidden: true, filter: "number",
      accessor: (d) => rollupCount.get(idOf(d.path)) ?? 0,
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
            insights={departmentInsights}
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

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit department" : "New department"}
        description="Departments group people in the directory and org chart. Their managers approve requests for anyone in the team who has no manager of their own."
        collection="departments"
        objectPath={editing?.path}
        guardLabel="department"
        form={form}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={!!name.trim()}
        whyNot="Give the department a name."
        onSubmit={submit}
        addAnother={editing ? undefined : () => { setName(""); setParent(NONE); setManagers([]); setMgrQuery(""); }}
      >
          <Field label="Department name" htmlFor="dept-name">
            <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering" autoFocus />
          </Field>
          {duplicate && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              A department called "{duplicate.display_name}" already exists. Two with the same name are hard to tell apart in every picker that lists them.
            </p>
          )}
          <Field label="Parent department" field="parent" hint="Nests this team under another. Leave as Top level for a standalone department.">
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger><SelectValue placeholder="Top level" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Top level</SelectItem>
                {rows
                  .filter((d) => !d.disabled && !d.delete_time && d.path !== editing?.path && !descendants.has(idOf(d.path)))
                  .map((d) => (
                    <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          {editing && parent !== (editing.parent ? `departments/${idOf(editing.parent)}` : NONE) && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              Moving a department moves everything under it - sub-departments, their people, and the access rules scoped to them.
            </p>
          )}
          <Field label="Managers" field="managers" hint={managers.length ? `${managers.length} selected. They approve requests for the team and see it in team views.` : "One or more employees who manage this department."}>
            {employees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No employees to assign.</p>
            ) : (
              <div className="space-y-2">
                {employees.length > 8 && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <SearchInput value={mgrQuery} onChange={(e) => setMgrQuery(e.target.value)} placeholder="Search people…" className="h-9 pl-8" />
                  </div>
                )}
                <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border p-2">
                  {visibleManagers.length === 0 ? (
                    <p className="px-1.5 py-2 text-sm text-muted-foreground">No one matches.</p>
                  ) : (
                    visibleManagers.map((e) => (
                      <label key={e.path} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                        <Checkbox checked={managers.includes(`employees/${idOf(e.path)}`)} onCheckedChange={() => toggleManager(`employees/${idOf(e.path)}`)} />
                        <span>{e.first_name} {e.last_name}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
  );
}
