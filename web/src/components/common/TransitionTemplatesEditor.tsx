import { useEffect, useState } from "react";
import { Plus, Trash2, Save, UserPlus, UserMinus } from "lucide-react";
import { get, patch } from "@/api";
import { idOf, humanize } from "@/lib/utils";
import { useCollection } from "@/hooks/useCollection";
import { DEFAULT_TRANSITION_TEMPLATES, DOC_TYPES, type TemplateTask, type TransitionTemplate, type BgCheckType, type DocType } from "@/lib/transitions";
import type { Employee } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const blankTask = (): TemplateTask => ({ title: "", assignee: { type: "employee" }, due_offset_days: 0 });
const BG_CHECK_TYPES: BgCheckType[] = ["identity", "address", "education", "employment", "criminal", "reference", "credit"];

// HR editor for onboarding/offboarding templates (settings/transition-templates). Each template is an ordered
// task list; a task's assignee is by relationship (the employee / their manager / a specific person), resolved
// when a transition is started. Due offsets are days from the anchor (negative = before the start / last day).
export function TransitionTemplatesEditor() {
  const { toast } = useToast();
  const { rows: employees } = useCollection<Employee>("employees");
  const [templates, setTemplates] = useState<TransitionTemplate[]>(DEFAULT_TRANSITION_TEMPLATES);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ value?: { templates?: TransitionTemplate[] } }>("settings/transition-templates")
      .then((s) => { if (s.value?.templates?.length) setTemplates(s.value.templates); })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  const setTpl = (i: number, patchTpl: Partial<TransitionTemplate>) => setTemplates((ts) => ts.map((t, j) => (j === i ? { ...t, ...patchTpl } : t)));
  const setTask = (i: number, k: number, patchTask: Partial<TemplateTask>) =>
    setTemplates((ts) => ts.map((t, j) => (j === i ? { ...t, tasks: t.tasks.map((tk, m) => (m === k ? { ...tk, ...patchTask } : tk)) } : t)));

  async function save() {
    // Drop blank-named templates and blank-title tasks; give new templates a stable id from their name.
    const seen = new Set<string>();
    const out: TransitionTemplate[] = [];
    for (const t of templates) {
      const name = t.name.trim();
      if (!name) continue;
      let id = t.id || slug(name) || "template";
      while (seen.has(id)) id += "_x";
      seen.add(id);
      out.push({ id, name, kind: t.kind, description: t.description?.trim() || undefined, tasks: t.tasks.filter((tk) => tk.title.trim()).map((tk) => ({ ...tk, title: tk.title.trim() })) });
    }
    setBusy(true);
    try {
      await patch("settings/transition-templates", { value: { templates: out } });
      setTemplates(out);
      toast({ title: "Templates saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <AccessAction objectPath="settings/transition-templates" label="Onboarding templates"><span>Onboarding & offboarding templates</span></AccessAction>
        </CardTitle>
        <p className="text-sm text-muted-foreground">Reusable checklists. Starting a process from a template creates its tasks, with assignees and due dates resolved for the employee.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {templates.map((t, i) => (
          <div key={i} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={t.kind} onValueChange={(v) => setTpl(i, { kind: v as TransitionTemplate["kind"] })}>
                <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="onboarding"><span className="flex items-center gap-1.5"><UserPlus className="h-3.5 w-3.5" /> Onboarding</span></SelectItem>
                  <SelectItem value="offboarding"><span className="flex items-center gap-1.5"><UserMinus className="h-3.5 w-3.5" /> Offboarding</span></SelectItem>
                </SelectContent>
              </Select>
              <Input value={t.name} placeholder="Template name" className="h-9 flex-1" onChange={(e) => setTpl(i, { name: e.target.value })} />
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive" onClick={() => setTemplates((ts) => ts.filter((_, j) => j !== i))} aria-label="Remove template"><Trash2 className="h-4 w-4" /></Button>
            </div>
            <Input value={t.description ?? ""} placeholder="Description (optional)" className="h-9" onChange={(e) => setTpl(i, { description: e.target.value })} />

            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_10rem_5rem_2rem] items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>Task</span><span>Assignee</span><span>Day offset</span><span />
              </div>
              {t.tasks.map((tk, k) => (
                <div key={k} className="grid grid-cols-[1fr_10rem_5rem_2rem] items-center gap-2">
                  <Input value={tk.title} placeholder="Task title" className="h-8" onChange={(e) => setTask(i, k, { title: e.target.value })} />
                  <div className="flex gap-1">
                    <Select value={tk.assignee.type} onValueChange={(v) => setTask(i, k, { assignee: { type: v as TemplateTask["assignee"]["type"], employee: v === "specific" ? tk.assignee.employee : undefined } })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="employee">The employee</SelectItem>
                        <SelectItem value="manager">Their manager</SelectItem>
                        <SelectItem value="specific">Specific…</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Input type="number" value={tk.due_offset_days ?? 0} className="h-8" onChange={(e) => setTask(i, k, { due_offset_days: Number(e.target.value) })} />
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setTpl(i, { tasks: t.tasks.filter((_, m) => m !== k) })} aria-label="Remove task"><Trash2 className="h-3.5 w-3.5" /></Button>
                  {tk.assignee.type === "specific" && (
                    <div className="col-span-4">
                      <Select value={tk.assignee.employee ?? ""} onValueChange={(v) => setTask(i, k, { assignee: { type: "specific", employee: v } })}>
                        <SelectTrigger className="h-8"><SelectValue placeholder="Choose a person (or leave to whoever starts it)…" /></SelectTrigger>
                        <SelectContent>
                          {employees.map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {t.kind === "onboarding" && (
                    <div className="col-span-4 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">Background check:</span>
                      <Select value={tk.bg_check ?? "none"} onValueChange={(v) => setTask(i, k, { bg_check: v === "none" ? undefined : (v as BgCheckType) })}>
                        <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {BG_CHECK_TYPES.map((b) => <SelectItem key={b} value={b}>{humanize(b)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">Collect document:</span>
                      <Select value={tk.doc_type ?? "none"} onValueChange={(v) => setTask(i, k, { doc_type: v === "none" ? undefined : (v as DocType) })}>
                        <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {DOC_TYPES.map((d) => <SelectItem key={d} value={d}>{humanize(d)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setTpl(i, { tasks: [...t.tasks, blankTask()] })}><Plus className="h-3.5 w-3.5" /> Add task</Button>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => setTemplates((ts) => [...ts, { id: "", name: "", kind: "onboarding", tasks: [blankTask()] }])}><Plus className="h-3.5 w-3.5" /> Add template</Button>
          <Button onClick={save} loading={busy}>{!busy && <Save className="h-4 w-4" />} Save templates</Button>
        </div>
      </CardContent>
    </Card>
  );
}
