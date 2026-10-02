import { useMemo, useRef, useState } from "react";
import { Plus, Pencil, Trash2, FolderKanban } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, idOf } from "@/lib/utils";
import type { Goal, Project } from "@/types";
import { DataState } from "@/components/common/DataState";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { Field, FieldRow } from "@/components/common/Field";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { useDeletedToast } from "@/hooks/useSoftDelete";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { name: "", client: "", code: "", billable: true, goal: "none", status: "active" as "active" | "archived" };

// HR/PM editor for the project catalog (Settings → Payroll → Projects).
export default function ProjectsAdmin({ openId }: { openId?: string }) {
  // `all`: this is the whole catalog rendered as a CARD GRID, not a list page. A DataTable admits a window -
  // it draws "Showing 1-100 of ..." and a Load more - but a grid of cards has nowhere to say so and nothing
  // for a reader to press, so the first page silently presented itself as the entire catalog: past a hundred
  // projects an admin could not see, edit or archive the rest of them, and `useDeepOpen` below could not open
  // a link to one either. Costs nothing until a catalog actually exceeds one page (the walk only runs while
  // the server is still handing back a cursor), and is bounded by the hook's own cap.
  //
  // The cap is why the grid still carries a TruncationNotice below. `all` narrows the window from a hundred
  // rows to `ALL_CAP`; it does not remove it, and a grid presenting a thousand projects as the whole catalog
  // is telling the same lie as one presenting a hundred - just to an org large enough that nobody checks.
  const { rows, state, error, reload } = useCollection<Project>("projects", { all: true });
  // Small, and only used to fill one picker; empty for anybody who cannot read goals, which hides the field.
  const { rows: goals } = useCollection<Goal>("goals");
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const deleted = useDeletedToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState(EMPTY);
  const nameRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => [...rows].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || a.name.localeCompare(b.name)), [rows]);

  // A project is picked by name on the timesheet and reconciled by code on an invoice, so a repeat of either
  // makes one of those jobs guesswork. Caught here, against the loaded catalog.
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const duplicateName = !!form.name.trim() && rows.some((p) => p.path !== editing?.path && same(p.name, form.name));
  const duplicateCode = !!form.code.trim() && rows.some((p) => p.path !== editing?.path && !!p.code && same(p.code, form.code));
  const canSave = !!form.name.trim() && !duplicateName && !duplicateCode;
  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(p: Project) {
    setEditing(p);
    setForm({ name: p.name, client: p.client ?? "", code: p.code ?? "", billable: p.billable, goal: p.goal ? `goals/${idOf(p.goal)}` : "none", status: p.status });
    setOpen(true);
  }
  async function save() {
    const body = { name: form.name.trim(), client: form.client.trim() || null, code: form.code.trim() || null, billable: form.billable, goal: form.goal === "none" ? null : form.goal, status: form.status };
    if (editing) await patch(`projects/${idOf(editing.path)}`, body, editing.etag);
    else await create("projects", body);
    toast({ title: editing ? "Project updated" : "Project added", variant: "success" });
    reload();
  }
  // "Save & add another" keeps the client and billable flag: a run of projects is usually for one client.
  function nextBlank() {
    setForm({ ...EMPTY, client: form.client, billable: form.billable, goal: form.goal });
    nameRef.current?.focus();
  }
  async function del(p: Project) {
    if (!(await confirm({ title: `Delete the "${p.name}" project?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`projects/${idOf(p.path)}`); reload(); deleted({ path: `projects/${idOf(p.path)}`, noun: "project", can: p.access?.can, reload }); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  return (
    // Settings-embedded editor: no route scope to inherit, so bind the projects collection explicitly.
    <AccessScope collection="projects">
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">
            <AccessAction collection="projects" label="Projects"><span>Projects</span></AccessAction>
          </h3>
          <p className="text-sm text-muted-foreground">Projects employees log time against on their timesheets.</p>
        </div>
        <AccessAction create label="Project">
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New project</Button>
        </AccessAction>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No projects" description="Add a project for employees to log time against." action={<AccessAction create label="Project"><Button onClick={openCreate}><Plus className="h-4 w-4" /> New project</Button></AccessAction>} />
        ) : (
          <div className="space-y-2">
            <TruncationNotice collection="projects" what="projects" />
            {sorted.map((p) => (
              <AccessItem key={p.path} objectPath={p.path} can={p.access?.can} label={p.name}>
              <Card className="flex items-center justify-between gap-3 p-3">
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
                  <AccessAction objectPath={p.path} can={p.access?.can} verb="update" label={p.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(p)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                  <AccessAction objectPath={p.path} can={p.access?.can} verb="delete" label={p.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(p)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                </div>
              </Card>
              </AccessItem>
            ))}
          </div>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit project" : "New project"}
        description="Anything employees log time against on their timesheets - client work, internal work, or leave-style buckets."
        collection="projects"
        objectPath={editing?.path}
        guardLabel="project"
        form={form}
        submitLabel={editing ? "Save changes" : "Create"}
        canSubmit={canSave}
        whyNot={!form.name.trim() ? "Give the project a name." : duplicateName ? "Another project already has this name." : "Another project already uses this code."}
        onSubmit={save}
        addAnother={editing ? undefined : nextBlank}
      >
          <Field label="Name" error={duplicateName ? "Another project already has this name." : undefined}>
            <Input ref={nameRef} value={form.name} placeholder="e.g. Acme website rebuild" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <FieldRow>
            <Field label="Client (optional)" hint="Shown beside the project on timesheets."><Input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} placeholder="e.g. Acme Inc" /></Field>
            {/* Codes are compared and pasted into invoices, so they are normalised to upper case as they're typed. */}
            <Field label="Code (optional)" error={duplicateCode ? "Another project already uses this code." : undefined}>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. ACME-1" className="tabular-nums uppercase" />
            </Field>
          </FieldRow>
          {/* Billable drives every new entry's default, so it reads as a statement rather than a bare tickbox. */}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox className="mt-0.5" checked={form.billable} onCheckedChange={(v) => setForm({ ...form, billable: v === true })} />
            <span>
              <span className="font-medium">Billable</span>
              <span className="block text-xs text-muted-foreground">Time logged here counts as client-billable by default.</span>
            </span>
          </label>
          {/* What the hours are FOR. With a goal named, that goal reports the effort spent against its own
              progress - the one view that catches work going into something that is not moving. */}
          {goals.length > 0 && (
            <Field label="Goal (optional)" hint="The outcome these hours are for. The goal then shows the hours booked against it.">
              <Combobox
                value={form.goal}
                onValueChange={(v) => setForm({ ...form, goal: v })}
                searchPlaceholder="Search goals…"
                options={[{ value: "none", label: "No goal" }, ...goals.filter((g) => g.status !== "cancelled" && g.status !== "completed").map((g) => ({ value: `goals/${idOf(g.path)}`, label: g.title }))]}
              />
            </Field>
          )}
          <Field label="Status" hint={form.status === "archived" ? "Stays on past timesheets, but nobody can log new time against it." : "Anyone can pick this project on their timesheet."}>
            <div className="inline-flex rounded-lg border p-0.5">
              {(["active", "archived"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={form.status === s} onClick={() => setForm({ ...form, status: s })}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                    form.status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}>
                  {s}
                </button>
              ))}
            </div>
          </Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>
    </div>
    </AccessScope>
  );
}
