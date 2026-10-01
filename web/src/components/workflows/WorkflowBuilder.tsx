import { useState, type ReactNode } from "react";
import { Code2, Wand2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/common/Field";
import { ConditionBuilder } from "./ConditionBuilder";
import { ActionList } from "./ActionList";
import type { AutomationDraft, WorkflowMeta, Action, Condition, Schedule, ScheduleFreq, ScheduleScope } from "./types";
import { SCHEDULE_TRIGGER } from "./types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_SCHEDULE: Schedule = { freq: "weekly", day: 1, scope: "once" };

// The no-code builder body: name, trigger, condition, actions - a view over the same AutomationDraft the API
// takes. A "JSON" toggle flips condition+actions to a raw editor (the power-user escape hatch) and back.
export function WorkflowBuilder({ draft, onChange, meta, nameError }: { draft: AutomationDraft; onChange: (d: AutomationDraft) => void; meta: WorkflowMeta | null; nameError?: string }) {
  const [json, setJson] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const set = (patch: Partial<AutomationDraft>) => onChange({ ...draft, ...patch });

  const groups = [...new Set((meta?.events ?? []).map((e) => e.module))];

  const toJson = () => { setJsonText(JSON.stringify({ condition: draft.condition, actions: draft.actions }, null, 2)); setJsonErr(null); setJson(true); };

  // THE JSON VIEW IS A VIEW, NOT A STAGING BUFFER. It used to commit to the draft only from "Back to
  // builder", and the Save button belongs to the enclosing WriteDialog, which reads the draft - so rewriting
  // the actions here and pressing "Save changes" wrote the OLD ones, said "Rule saved", and threw the
  // textarea away. Nothing contradicted it either, because everything else reads the draft too: `dirty`
  // believed nothing had changed, the unsaved-changes guard let the dialog close without asking, the preview
  // kept describing the old actions, and on a NEW rule authored entirely here `canSubmit` stayed false with
  // "Add at least one action" in front of a textarea plainly holding several. This is the escape hatch for
  // the rules the guided form cannot express, so it was the power user, mid-way through the only editor that
  // can do the job, who lost the work. Committing on every keystroke makes all of them see what the reader
  // sees; an unparseable draft just holds the error and leaves the last good value in place.
  const tryCommit = (text: string) => {
    try {
      const parsed = JSON.parse(text) as { condition: Condition | null; actions: Action[] };
      if (!Array.isArray(parsed.actions)) throw new Error("actions must be an array");
      set({ condition: parsed.condition ?? null, actions: parsed.actions });
      setJsonErr(null);
      return true;
    } catch (e) { setJsonErr(String((e as Error).message)); return false; }
  };
  const fromJson = () => { if (tryCommit(jsonText)) setJson(false); };

  return (
    <div className="space-y-5">
      {/* One column on a phone: two free-text fields side by side leave ~160px each, which is not enough
          to read back a rule name like "Welcome new hires" while typing it. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* `field` on both: inside WriteDialog's AccessScope this gives each one its manage-access icon, and a
            400 the server pins to `name` lands here rather than only above the form. */}
        <Field label="Name" field="name" error={nameError} hint="How this rule reads in the list and in the run log."><Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Welcome new hires" /></Field>
        <Field label="Description" field="description"><Input value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="What this does" /></Field>
      </div>

      <Step n={1} title="When this happens" desc="the event - or schedule - that starts the rule">
        <Select
          value={draft.trigger_type}
          onValueChange={(t) => set({ trigger_type: t, schedule: t === SCHEDULE_TRIGGER ? (draft.schedule ?? DEFAULT_SCHEDULE) : null })}
        >
          <SelectTrigger><SelectValue placeholder="Pick an event…" /></SelectTrigger>
          <SelectContent>
            {/* `SelectGroup` + `SelectLabel`, which Radix wires together with `aria-labelledby` - not a bare
                <div> with a styled heading, which is visual only. This is the app's longest Select, and a
                screen-reader user was getting one flat list of every event with no sense of which module each
                belonged to. GenerateLetterDialog uses the same pair for the same shape. */}
            {groups.map((g) => (
              <SelectGroup key={g}>
                <SelectLabel className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">{g}</SelectLabel>
                {(meta?.events ?? []).filter((e) => e.module === g).map((e) => <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {draft.trigger_type === SCHEDULE_TRIGGER && (
          <RecurrenceEditor value={draft.schedule ?? DEFAULT_SCHEDULE} onChange={(schedule) => set({ schedule })} />
        )}
      </Step>

      {json ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Condition &amp; actions (JSON)</span>
            <div className="flex items-center gap-2">
              {jsonErr && <span className="text-xs text-destructive">{jsonErr}</span>}
              <Button type="button" variant="outline" size="sm" onClick={fromJson}><Wand2 className="mr-1 h-4 w-4" /> Back to builder</Button>
            </div>
          </div>
          <Textarea
            rows={16}
            value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); tryCommit(e.target.value); }}
            className="font-mono text-xs"
            aria-invalid={!!jsonErr || undefined}
          />
          <p className="text-xs text-muted-foreground">Applied as you type - Save writes what is in this box.</p>
        </div>
      ) : (
        <>
          <Step n={2} title="Only if" desc="optional - limit when it runs"
            action={<Button type="button" variant="ghost" size="sm" onClick={toJson}><Code2 className="mr-1 h-4 w-4" /> Edit as JSON</Button>}>
            <ConditionBuilder meta={meta} triggerType={draft.trigger_type} value={draft.condition} onChange={(condition) => set({ condition })} />
          </Step>
          <Step n={3} title="Then do this" desc="the steps to run, in order">
            <ActionList actions={draft.actions} onChange={(actions) => set({ actions })} meta={meta} triggerType={draft.trigger_type} />
          </Step>
        </>
      )}
    </div>
  );
}

// A numbered builder section: a step chip + title/description, an optional right-aligned action, and its body.
function Step({ n, title, desc, action, children }: { n: number; title: string; desc?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">{title}</div>
          {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
        </div>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

// Recurrence controls for a time-driven rule: how often (or only when run by hand), which day, and whether it
// fires once (a broadcast) or once per employee (with derived metrics available to the condition).
function RecurrenceEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-dashed bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Run</span>
        <Select value={value.freq} onValueChange={(f) => set({ freq: f as ScheduleFreq, day: f === "weekly" ? (value.day ?? 1) : f === "monthly" ? (value.day ?? 1) : undefined })}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">every day</SelectItem>
            <SelectItem value="weekly">every week</SelectItem>
            <SelectItem value="monthly">every month</SelectItem>
            <SelectItem value="manual">only when run by hand</SelectItem>
          </SelectContent>
        </Select>
        {value.freq === "weekly" && (
          <>
            <span className="text-muted-foreground">on</span>
            <Select value={String(value.day ?? 1)} onValueChange={(d) => set({ day: Number(d) })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>{WEEKDAYS.map((w, i) => <SelectItem key={i} value={String(i)}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </>
        )}
        {value.freq === "monthly" && (
          <>
            <span className="text-muted-foreground">on day</span>
            <Select value={String(value.day ?? 1)} onValueChange={(d) => set({ day: Number(d) })}>
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
            </Select>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Fire</span>
        <Select value={value.scope ?? "once"} onValueChange={(s) => set({ scope: s as ScheduleScope })}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="once">once (a broadcast)</SelectItem>
            <SelectItem value="perEmployee">once per employee</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {value.scope === "perEmployee"
          ? "Runs for each active employee. The condition can use per-person metrics: pending approvals, days since last leave, leave balance, profile items still missing."
          : "Runs once, with no specific employee - use an audience notification or an API call."}
        {value.freq === "manual" && " It never runs on its own: use Run now on the rule's menu, at most once a day."}
      </p>
    </div>
  );
}
