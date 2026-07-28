import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, FolderKanban } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Project } from "@/types";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { name: "", client: "", code: "", billable: true, status: "active" as "active" | "archived" };

// HR/PM editor for the project catalog (Settings → Payroll → Projects).
export default function ProjectsAdmin({ openId }: { openId?: string }) {
  const { rows, state, error, reload } = useCollection<Project>("projects");
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...rows].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || a.name.localeCompare(b.name)), [rows]);

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(p: Project) {
    setEditing(p);
    setForm({ name: p.name, client: p.client ?? "", code: p.code ?? "", billable: p.billable, status: p.status });
    setOpen(true);
  }
  async function save() {
    const body = { name: form.name.trim(), client: form.client.trim() || null, code: form.code.trim() || null, billable: form.billable, status: form.status };
    setBusy(true);
    try {
      if (editing) await patch(`projects/${idOf(editing.path)}`, body, editing.etag);
      else await create("projects", body);
      toast({ title: editing ? "Project updated" : "Project added", variant: "success" });
      setOpen(false); reload();
    } catch (e) { toast({ title: "Couldn't save the project", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function del(p: Project) {
    if (!(await confirm({ title: `Delete the "${p.name}" project?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`projects/${idOf(p.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Projects</h3>
          <p className="text-sm text-muted-foreground">Projects employees log time against on their timesheets.</p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4" /> New project</Button>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No projects" description="Add a project for employees to log time against." action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New project</Button>} />
        ) : (
          <div className="space-y-2">
            {sorted.map((p) => (
              <Card key={p.path} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.code && <span className="text-xs tabular-nums text-muted-foreground">{p.code}</span>}
                    {p.billable && <Badge variant="secondary">Billable</Badge>}
                    {p.status === "archived" && <Badge variant="muted">Archived</Badge>}
                  </div>
                  {p.client && <p className="text-xs text-muted-foreground">{p.client}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(p)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(p)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim()) save(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit project" : "New project"}</DialogTitle></DialogHeader>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <FieldRow>
            <Field label="Client (optional)"><Input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} /></Field>
            <Field label="Code (optional)"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. ACME-1" /></Field>
          </FieldRow>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.billable} onCheckedChange={(v) => setForm({ ...form, billable: v === true })} /> Billable
            </label>
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as "active" | "archived" })}>
                <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
