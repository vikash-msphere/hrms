import { useState } from "react";
import { Tag, Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { AssetCategory, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// The kinds of thing the inventory holds. Each one owns the short code that goes inside the tags printed for
// it (Laptop -> LAP -> MS-LAP-014) and the tag sequence runs per code, which is why the code is edited here
// rather than guessed from the name at print time.
export default function AssetCategories({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<AssetCategory>("asset-categories", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("asset-categories", "category", reload);
  const lc = useLifecycle("asset-categories", "category", reload);
  const writable = usePermission("asset-categories.write");
  const canPurge = usePermission("asset-categories.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AssetCategory | null>(null);
  const [form, setForm] = useState({ name: "", tagCode: "", requiresSerial: false });
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "category" });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", tagCode: "", requiresSerial: false });
    setErr(null);
    setOpen(true);
  }
  function openEdit(c: AssetCategory) {
    setEditing(c);
    setForm({ name: c.display_name ?? "", tagCode: c.tag_code ?? "", requiresSerial: !!c.requires_serial });
    setErr(null);
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      // A blank code is not blank on the server: it derives one from the name, so leaving it alone is the
      // normal path rather than a missing value.
      const body = { display_name: form.name, tag_code: form.tagCode.trim() || null, requires_serial: form.requiresSerial };
      if (editing) {
        await patch("asset-categories/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Category updated", variant: "success" });
      } else {
        await create("asset-categories", body);
        toast({ title: "Category created", variant: "success" });
      }
      // Codes are per category, so nothing carries over to the next one except the serial rule.
      if (again && !editing) {
        const next = { name: "", tagCode: "", requiresSerial: form.requiresSerial };
        setForm(next);
        guard.markSaved(next);
      } else {
        guard.markSaved();
        setOpen(false);
      }
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<AssetCategory>[] = [
    { id: "name", header: "Name", accessor: (c) => c.display_name, cell: (c) => <span className="font-medium">{c.display_name}</span> },
    { id: "tag_code", header: "Tag code", accessor: (c) => c.tag_code ?? "", cell: (c) => <span className="font-mono text-xs">{c.tag_code || "-"}</span> },
    {
      id: "serial",
      header: "Serial number",
      filter: "select",
      accessor: (c) => (c.requires_serial ? "Required" : "Optional"),
      cell: (c) => <Badge variant={c.requires_serial ? "warning" : "secondary"}>{c.requires_serial ? "Required" : "Optional"}</Badge>,
    },
    stateColumn<AssetCategory>(),
    ...metaColumns<AssetCategory>(),
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
    <AccessAction collection="asset-categories" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New category</Button>
    </AccessAction>
  );

  return (
    <div>
      {!embedded && (
        <PageHeader accessCollection="asset-categories" title="Asset Categories" description="Define the kinds of asset (laptop, phone, monitor…) and the code their tags carry." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={Tag} title="No categories" description="Create categories like Laptop, Phone or Monitor." action={createBtn} />
        ) : (
          <DataTable
            columns={columns}
            tableId="asset-categories"
            rows={rows}
            getRowId={(c) => c.path}
            rowClassName={(c) => (c.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No categories match"
            toolbar={embedded ? createBtn : undefined}
            accessCollection="asset-categories"
            accessTargetOf={(c) => ({ objectPath: c.path, label: c.display_name, can: c.access?.can })}
          />
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim()) submit(); }}>
          <AccessScope collection="asset-categories" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
            <DialogDescription>A category decides the code inside the tags printed for its assets, and the tag sequence runs per code.</DialogDescription>
          </DialogHeader>
          <FormError error={err} />
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Laptop" autoFocus />
          </Field>
          <Field label="Tag code" hint="Left blank, the first three letters of the name are used - numbered (LAP2) when another category already answers to them. Assets already tagged keep the tag they are wearing.">
            <Input value={form.tagCode} onChange={(e) => setForm({ ...form, tagCode: e.target.value.toUpperCase() })} placeholder="e.g. LAP" className="max-w-32 font-mono" maxLength={8} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="requiresSerial" checked={form.requiresSerial} onCheckedChange={(v) => setForm({ ...form, requiresSerial: v === true })} />
            <Label htmlFor="requiresSerial">Require a serial number</Label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">When on, an asset in this category can't be saved without its serial number.</p>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          {!editing && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={again} onCheckedChange={(v) => setAgain(v === true)} />
              Keep this open to add another
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : again ? "Create & add another" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
