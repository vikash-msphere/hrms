import { useState } from "react";
import { Tag, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { ReimbursementCategory, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

export default function ReimbursementCategories({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<ReimbursementCategory>("reimbursement-categories", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("reimbursement-categories", "category", reload);
  const lc = useLifecycle("reimbursement-categories", "category", reload);
  const writable = usePermission("reimbursement-categories.write");
  const canPurge = usePermission("reimbursement-categories.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReimbursementCategory | null>(null);
  const [form, setForm] = useState({ name: "", requiresReceipt: false });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", requiresReceipt: false });
    setOpen(true);
  }
  function openEdit(c: ReimbursementCategory) {
    setEditing(c);
    setForm({ name: c.display_name, requiresReceipt: !!c.requires_receipt });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const body = { display_name: form.name, requires_receipt: form.requiresReceipt };
      if (editing) {
        await patch("reimbursement-categories/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Category updated", variant: "success" });
      } else {
        await create("reimbursement-categories", body);
        toast({ title: "Category created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save category", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<ReimbursementCategory>[] = [
    { id: "name", header: "Name", accessor: (c) => c.display_name, cell: (c) => <span className="font-medium">{c.display_name}</span> },
    {
      id: "receipt",
      header: "Receipt",
      filter: "select",
      accessor: (c) => (c.requires_receipt ? "Required" : "Optional"),
      cell: (c) => <Badge variant={c.requires_receipt ? "warning" : "secondary"}>{c.requires_receipt ? "Required" : "Optional"}</Badge>,
    },
    stateColumn<ReimbursementCategory>(),
    ...metaColumns<ReimbursementCategory>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (c) => <SoftDeleteRowActions row={c} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="reimbursement-categories" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New category</Button>
    </AccessAction>
  );

  return (
    <div>
      {!embedded && (
        <PageHeader accessCollection="reimbursement-categories" title="Reimbursement Categories" description="Define the kinds of expense employees can claim." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={Tag} title="No categories" description="Create categories like Travel, Meals or Equipment." action={createBtn} />
        ) : (
          <DataTable
            columns={columns}
            tableId="reimbursement-categories"
            rows={rows}
            getRowId={(c) => c.path}
            rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No categories match"
            toolbar={embedded ? createBtn : undefined}
            accessCollection="reimbursement-categories"
            accessTargetOf={(c) => ({ objectPath: c.path, label: c.display_name, can: c.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim()) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
          </DialogHeader>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Travel" autoFocus />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="requiresReceipt" checked={form.requiresReceipt} onCheckedChange={(v) => setForm({ ...form, requiresReceipt: v === true })} />
            <Label htmlFor="requiresReceipt">Require a receipt</Label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">When on, a claim in this category can't be submitted without a receipt.</p>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
