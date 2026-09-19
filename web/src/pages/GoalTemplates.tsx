import { useMemo, useState } from "react";
import { Target, Plus, Users } from "lucide-react";
import { create, patch, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { Department, Employee, GoalTemplate, Me, ReviewCycle } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { AccessAction } from "@/components/access/AccessAction";
import { ActivitySection } from "@/components/common/ActivitySection";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";

const EMPTY = { title: "", description: "", weight: "", dueInDays: "", unit: "", baseline: "", target: "", department: "none", group: "" };

/**
 * The org's goal blueprints, and the press that stamps them onto people.
 *
 * The catalogue is ordinary reference data; `:apply` is what it is for. A due date is held as an INTERVAL
 * ("30 days in") rather than a date, so the same template is still correct next quarter - the date is computed
 * when it is applied.
 */
export default function GoalTemplates({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<GoalTemplate>("goal-templates", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles", { all: true });
  const { toast } = useToast();
  const sd = useSoftDelete("goal-templates", "template", reload);
  const lc = useLifecycle("goal-templates", "template", reload);
  const writable = usePermission("goal-templates.write");
  const canPurge = usePermission("goal-templates.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<GoalTemplate | null>(null);
  const [form, setForm] = useState(EMPTY);

  // Applying is two presses, the same shape as launching a review cycle: pick the people, then confirm what
  // is about to be written (and for which cycle). Creating goals for thirty people is not an undo-able press.
  const [picking, setPicking] = useState<{ templates: GoalTemplate[]; label: string } | null>(null);
  const [applying, setApplying] = useState<{ templates: GoalTemplate[]; label: string; refs: string[] } | null>(null);
  const [applyCycle, setApplyCycle] = useState("none");
  const [applyBusy, setApplyBusy] = useState(false);
  // COMPLETE: the picker applies a template onto the people chosen here, so a window drops people silently.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });

  // Only the sets that still have something in them. Built from every row including the deleted and disabled
  // ones, it kept offering a set long after its last template had gone - and `{ showDeleted: true }` on the
  // read above means those rows never leave.
  const groups = useMemo(
    () => [...new Set(rows.filter((t) => !t.delete_time && !t.disabled).map((t) => t.group_name).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const deptName = (ref?: string | null) => departments.find((d) => idOf(d.path) === idOf(ref ?? ""))?.display_name;

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(t: GoalTemplate) {
    setEditing(t);
    setForm({
      title: t.title ?? "",
      description: t.description ?? "",
      weight: t.weight != null ? String(t.weight) : "",
      dueInDays: t.due_in_days != null ? String(t.due_in_days) : "",
      unit: t.unit ?? "",
      baseline: t.baseline_value != null ? String(t.baseline_value) : "",
      target: t.target_value != null ? String(t.target_value) : "",
      department: t.department ? `departments/${idOf(t.department)}` : "none",
      group: t.group_name ?? "",
    });
    setOpen(true);
  }

  const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
  // The same three guards the goal form itself applies. A template is a goal stamped out N times, and none of
  // these were checked here: `min`/`max` on a number input constrain the spinner and nothing else, so a
  // weight of 500 or a negative interval went straight through - and a due date computed from a negative
  // interval lands in the past, which is thirty goals that are overdue the moment they are created. A target
  // equal to the baseline is the third: it measures nothing, and the goal form refuses it by name.
  const tplWeight = num(form.weight);
  const weightInvalid = tplWeight != null && (tplWeight < 0 || tplWeight > 100);
  const dueDays = num(form.dueInDays);
  const dueInvalid = dueDays != null && dueDays < 0;
  const targetEqualsBaseline = num(form.target) != null && num(form.target) === (num(form.baseline) ?? 0);

  // Throws to fail: WriteDialog pins the message in the form and keeps what was typed.
  async function submit() {
    {
      const body = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        weight: num(form.weight) ?? 0,
        due_in_days: num(form.dueInDays),
        unit: form.unit.trim() || null,
        baseline_value: num(form.baseline),
        target_value: num(form.target),
        department: form.department === "none" ? null : form.department,
        group_name: form.group.trim() || null,
      };
      if (editing) {
        await patch(`goal-templates/${idOf(editing.path)}`, body, editing.etag);
        toast({ title: "Template updated", variant: "success" });
      } else {
        await create("goal-templates", body);
        toast({ title: "Template created", variant: "success" });
      }
      reload();
    }
  }

  // One press per template in the set. Sequential and user-initiated (the carry-over on the Goals page does
  // the same): a set is a handful of templates, and a partial run leaves real goals that are visible truth.
  async function applyNow() {
    if (!applying || !applying.refs.length) return;
    setApplyBusy(true);
    let created = 0;
    let skipped = 0;
    let done = 0;
    try {
      for (const t of applying.templates) {
        const res = await invoke<GoalTemplate>(`goal-templates/${idOf(t.path)}`, "apply", undefined, {
          employees: applying.refs,
          ...(applyCycle === "none" ? {} : { cycle: applyCycle }),
        });
        created += res.applied_count ?? 0;
        skipped += res.skipped_count ?? 0;
        done++;
      }
      toast({
        title: `${created} goal${created === 1 ? "" : "s"} created`,
        description: skipped ? `${skipped} skipped - those people already had it.` : undefined,
        variant: "success",
      });
      setApplying(null);
    } catch (e) {
      // One :apply per template, so a set that fails on the third has already written real goals for the
      // first two - and "Couldn't apply" said nothing about them. Somebody reading that would press it again
      // and, for the templates that DID land, be saved only by the server's own skip rule. Say what landed.
      toast({
        title: done === 0 ? "Couldn't apply" : `Stopped after ${done} of ${applying.templates.length} templates`,
        description: done === 0
          ? (e as Error).message
          : `${created} goal${created === 1 ? "" : "s"} were created before this failed: ${(e as Error).message}`,
        variant: "destructive",
      });
    } finally {
      setApplyBusy(false);
    }
  }

  const columns: Column<GoalTemplate>[] = [
    { id: "title", header: "Goal", accessor: (t) => t.title ?? "", cell: (t) => (
      <div className="min-w-0">
        <span className="font-medium">{t.title}</span>
        {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
      </div>
    ) },
    { id: "group", header: "Set", filter: "select", groupBy: true, accessor: (t) => t.group_name ?? "-", cell: (t) => (t.group_name ? <Badge variant="secondary">{t.group_name}</Badge> : <span className="text-muted-foreground">-</span>) },
    // Weights are meant to add up to 100 across a set, so the footer total is the check that they do.
    { id: "weight", header: "Weight", align: "right", filter: "number", aggregate: "sum", accessor: (t) => t.weight ?? 0, cell: (t) => <span className="tabular-nums">{t.weight || "-"}</span> },
    { id: "due", header: "Due", align: "right", filter: "number", formatTotal: (n) => `${n} days`, accessor: (t) => t.due_in_days ?? 0, cell: (t) => <span className="tabular-nums text-muted-foreground">{t.due_in_days != null ? `${t.due_in_days}d` : "-"}</span> },
    { id: "measure", header: "Measure", accessor: (t) => (t.target_value != null ? `${t.baseline_value ?? 0}-${t.target_value}` : ""), cell: (t) => (
      t.target_value != null
        ? <span className="tabular-nums text-muted-foreground">{t.baseline_value ?? 0} → {t.target_value}{t.unit ? ` ${t.unit}` : ""}</span>
        : <span className="text-muted-foreground">-</span>
    ) },
    { id: "department", header: "Suggested for", filter: "select", groupBy: true, accessor: (t) => deptName(t.department) ?? "Everyone", cell: (t) => <span className="text-muted-foreground">{deptName(t.department) ?? "Everyone"}</span> },
    stateColumn<GoalTemplate>(),
    ...metaColumns<GoalTemplate>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          {!t.delete_time && !t.disabled && (
            <AccessAction verb="apply" can={t.access?.can} label="Apply this template">
              <Button variant="ghost" size="sm" onClick={() => setPicking({ templates: [t], label: t.title ?? "template" })}>
                <Users className="h-3.5 w-3.5" /> Apply
              </Button>
            </AccessAction>
          )}
          <SoftDeleteRowActions row={t} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />
        </div>
      ),
    },
  ];

  const createBtn = writable && (
    <AccessAction collection="goal-templates" create>
      <Button onClick={openCreate}><Plus className="h-4 w-4" /> New template</Button>
    </AccessAction>
  );

  return (
    <div>
      {!embedded && (
        <PageHeader accessCollection="goal-templates" title="Goal templates" description="Blueprints for the goals the org sets over and over. Apply one, or a whole set, to a person or a team." actions={createBtn} />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={Target} title="No goal templates" description="Write the goals you set every quarter once, then apply them in a press." action={createBtn} />
        ) : (
          <>
            {/* Whole sets, applied in one press - the thing this catalogue exists to make possible. */}
            {groups.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Apply a set:</span>
                {/* A set whose every template has been deleted or disabled drew a greyed-out "(0)" button
                    that could never do anything - the set is gone, so the affordance goes with it. */}
                {groups.map((g) => {
                  const set = rows.filter((t) => t.group_name === g && !t.delete_time && !t.disabled);
                  if (!set.length) return null;
                  return (
                    <Button key={g} variant="outline" size="sm" onClick={() => setPicking({ templates: set, label: g })}>
                      {g} <span className="tabular-nums text-muted-foreground">({set.length})</span>
                    </Button>
                  );
                })}
              </div>
            )}
            <DataTable
              columns={columns}
              tableId="goal-templates"
              rows={rows}
              getRowId={(t) => t.path}
              rowClassName={(t) => (t.delete_time || t.disabled ? "opacity-60" : undefined)}
              emptyTitle="No templates match"
              toolbar={embedded ? createBtn : undefined}
              accessCollection="goal-templates"
              accessTargetOf={(t) => ({ objectPath: t.path, label: t.title, can: t.access?.can })}
            />
          </>
        )}
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={<span className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> {editing ? "Edit template" : "New goal template"}</span>}
        description="Everything here is copied onto the goal when the template is applied. The due date is an interval, so the template is still right next quarter."
        collection="goal-templates"
        objectPath={editing?.path}
        guardLabel="template"
        form={form}
        draftKey={editing ? undefined : "goal-template:new"}
        applyDraft={(d) => setForm(d)}
        onStartOver={editing ? undefined : () => setForm({ ...EMPTY })}
        submitLabel={editing ? "Save changes" : "Create template"}
        canSubmit={!!form.title.trim() && !weightInvalid && !dueInvalid && !targetEqualsBaseline}
        whyNot={[
          !form.title.trim() && "Give the template a title.",
          weightInvalid && "Weight has to be between 0 and 100.",
          dueInvalid && "Due in days cannot be negative - the goals would be created already overdue.",
          targetEqualsBaseline && "The target and the baseline are the same number.",
        ]}
        onSubmit={submit}
        addAnother={editing ? undefined : () => setForm({ ...EMPTY, group: form.group })}
        addAnotherLabel="Save & add another"
        submitAccess={(b) => (editing
          ? <AccessAction label="Edit template" can={editing.access?.can}>{b}</AccessAction>
          : <AccessAction collection="goal-templates" create label="New template">{b}</AccessAction>)}
      >
        <Field label="Goal title" field="title">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Complete security & compliance training" autoFocus />
        </Field>
        <Field label="Description (optional)" field="description">
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" />
        </Field>
        <FieldRow>
          <Field label="Weight" field="weight" hint="Relative importance 0-100." error={weightInvalid ? "Weight must be between 0 and 100." : undefined}>
            <Input type="number" min={0} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Due in (days)" field="due_in_days" hint="Counted from the day it is applied. Blank leaves the goal undated." error={dueInvalid ? "An interval counts forward from the day it is applied, so it cannot be negative." : undefined}>
            <Input type="number" min={0} value={form.dueInDays} onChange={(e) => setForm({ ...form, dueInDays: e.target.value })} placeholder="e.g. 30" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Baseline" field="baseline_value" hint="Where it starts."><Input type="number" value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} placeholder="0" /></Field>
          <Field label="Target" field="target_value" hint="With a target, the applied goal measures itself." error={targetEqualsBaseline ? "Target and baseline are the same, so there is nothing to measure." : undefined}><Input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="e.g. 60" /></Field>
          <Field label="Unit" field="unit"><Input value={form.unit} maxLength={24} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="customers" /></Field>
        </FieldRow>
        <FieldRow>
          <Field label="Set (optional)" field="group_name" hint="Templates sharing a name are applied together.">
            <Input value={form.group} maxLength={80} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="e.g. New hire 30/60/90" />
          </Field>
          <Field label="Suggested for" field="department" hint="A hint when picking, never a rule.">
            <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Everyone</SelectItem>
                {departments.filter((d) => !d.delete_time).map((d) => (
                  <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>

      {picking && (
        <EmployeePicker
          title={`Apply ${picking.label}`}
          confirmLabel="Review and apply"
          employees={employees}
          departments={departments}
          onClose={() => setPicking(null)}
          // The cycle resets with every new apply. It is component state that outlived the dialog, so the
          // cycle chosen for a new-hire set was still selected the next time somebody applied an unrelated
          // one - and worse, once that cycle CLOSED the option vanished from the list below while the value
          // stayed, leaving a picker showing nothing and a cycle still going out on the request.
          onConfirm={(refs) => { setApplyCycle("none"); setApplying({ ...picking, refs }); setPicking(null); }}
        />
      )}

      <Dialog open={!!applying} onOpenChange={(o) => !o && setApplying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply {applying?.label}</DialogTitle>
            <DialogDescription>
              {(applying?.templates.length ?? 0) * (applying?.refs.length ?? 0)} goal
              {(applying?.templates.length ?? 0) * (applying?.refs.length ?? 0) === 1 ? "" : "s"} for{" "}
              {applying?.refs.length} {applying?.refs.length === 1 ? "person" : "people"}. Anyone who already holds
              one in the chosen cycle is skipped, so applying twice is not a duplicate.
            </DialogDescription>
          </DialogHeader>
          {cycles.length > 0 && (
            <Field label="Review cycle (optional)" hint="The cycle these goals are set for - what the reviews will score.">
              <Select value={applyCycle} onValueChange={setApplyCycle}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No cycle</SelectItem>
                  {cycles.filter((c) => c.state !== "CLOSED").map((c) => (
                    <SelectItem key={c.path} value={`review-cycles/${idOf(c.path)}`}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplying(null)}>Cancel</Button>
            <Button onClick={applyNow} loading={applyBusy} disabled={!applying?.refs.length}>
              Create the goals
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
