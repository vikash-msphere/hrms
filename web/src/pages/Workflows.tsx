import { useEffect, useMemo, useState } from "react";
import {
  Workflow, Plus, Trash2, Play, Zap, ScrollText, Activity, Hourglass, Search, MoreHorizontal, Pencil,
  ArrowRight, Bell, Megaphone, Clock, Globe, Cog, CircleSlash, CheckCircle2, XCircle, AlertTriangle, MinusCircle, User, Mail,
} from "lucide-react";
import { create, invoke, patch, remove, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, humanize } from "@/lib/utils";
import type { Automation, AutomationRun, EventLogEntry, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { WorkflowBuilder } from "@/components/workflows/WorkflowBuilder";
import { useWorkflowMeta } from "@/components/workflows/useWorkflowMeta";
import { describeActions, triggerInfo, type Step } from "@/components/workflows/describe";
import type { AutomationDraft, WorkflowMeta } from "@/components/workflows/types";

type Tab = "rules" | "runs" | "instances" | "events";

export default function Workflows({ me }: { me: Me }) {
  void me;
  const canWrite = usePermission("automations.write");
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Workflows"
        description="Automate the next step whenever an event happens."
        accessCollection="automations"
        actions={<TabButtons tab={tab} setTab={setTab} />}
      />
      {tab === "rules" && <RulesTab canWrite={canWrite} />}
      {tab === "runs" && <RunsTab />}
      {tab === "instances" && <InstancesTab />}
      {tab === "events" && <EventsTab />}
    </div>
  );
}

function TabButtons({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const item = (key: Tab, label: string, Icon: typeof Zap) => (
    <Button variant={tab === key ? "default" : "outline"} size="sm" onClick={() => setTab(key)}>
      <Icon className="mr-1.5 h-4 w-4" />
      {label}
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {item("rules", "Rules", Zap)}
      {item("runs", "Runs", Activity)}
      {item("instances", "Waiting", Hourglass)}
      {item("events", "Event log", ScrollText)}
    </div>
  );
}

// Trigger-pill accent per module, so a rule's origin reads at a glance (subtle, theme-aware).
const MODULE_STYLE: Record<string, string> = {
  Leave: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  Attendance: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
  Payroll: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  Lifecycle: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  Recruiting: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300",
  Engagement: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  Compliance: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
  Support: "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300",
  Performance: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
};
const moduleStyle = (m: string) => MODULE_STYLE[m] ?? "bg-muted text-muted-foreground";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL = (n: number) => { const t = n % 100; const s = t >= 11 && t <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"); return `${n}${s}`; };
// Human summary of a rule's recurrence for the trigger pill, e.g. "Every Monday" / "Monthly on the 1st".
function describeSchedule(s: NonNullable<Automation["schedule"]>): string {
  const per = s.scope === "perEmployee" ? ", per person" : "";
  if (s.freq === "daily") return `Every day${per}`;
  if (s.freq === "weekly") return `Every ${WEEKDAY_NAMES[s.day ?? 1]}${per}`;
  return `Monthly on the ${ORDINAL(s.day ?? 1)}${per}`;
}

const ACTION_ICON: Record<string, typeof Bell> = {
  notify: Bell, notifyManager: Bell, notifyAudience: Megaphone, emitEvent: Zap,
  wait: Clock, waitFor: Hourglass, webhook: Globe, apiCall: Cog, email: Mail, emailAudience: Mail,
};

function StepPill({ step }: { step: Step }) {
  const Icon = ACTION_ICON[step.kind] ?? Cog;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground/80">
      <Icon className="h-3 w-3 text-muted-foreground" />
      {step.label}
    </span>
  );
}

// Track/thumb toggle for enable/disable - clearer and smaller than a text button.
function EnableToggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", on ? "bg-emerald-500" : "bg-muted-foreground/30")}>
      <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform", on ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function ModuleChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active ? "border-transparent bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-accent hover:text-accent-foreground")}>
      {label}
      <span className={cn("rounded-full px-1.5 text-[10px] leading-4", active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>{count}</span>
    </button>
  );
}

type StatusFilter = "all" | "enabled" | "disabled";

function RulesTab({ canWrite }: { canWrite: boolean }) {
  const { rows, state, error, reload } = useCollection<Automation>("automations");
  const { meta } = useWorkflowMeta();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [moduleFilter, setModuleFilter] = useState<string>("all");

  async function toggle(a: Automation) { try { await invoke(a.path, a.enabled ? "disable" : "enable"); reload(); } catch (e) { toast({ title: "Couldn't update the rule", description: String((e as Error).message), variant: "destructive" }); } }
  async function del(a: Automation) {
    const ok = await confirm({ title: "Delete this rule?", description: `"${a.name}" stops firing and is removed. Past runs stay in the log.`, destructive: true, confirmLabel: "Delete" });
    if (!ok) return;
    try { await remove(a.path, a.etag); toast({ title: "Rule deleted", variant: "success" }); reload(); } catch (e) { toast({ title: "Couldn't delete the rule", description: String((e as Error).message), variant: "destructive" }); }
  }
  async function test(a: Automation) {
    try {
      const res = await invoke<{ matched: boolean; would_run: { kind: string }[] }>(a.path, "test", undefined, { payload: {} });
      toast({ title: res.matched ? "Rule matches" : "Condition did not match", description: res.matched ? `Would run: ${res.would_run.map((x) => x.kind).join(", ") || "nothing"}` : "With an empty sample payload." });
    } catch (e) { toast({ title: "Test failed", description: String((e as Error).message), variant: "destructive" }); }
  }

  const enabledCount = rows.filter((r) => r.enabled).length;

  // Filter (search + status), then group by the trigger's owning module. Groups sorted by name.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byModule = new Map<string, Automation[]>();
    for (const r of rows) {
      if (statusFilter === "enabled" && !r.enabled) continue;
      if (statusFilter === "disabled" && r.enabled) continue;
      const info = triggerInfo(meta?.events, r.trigger_type);
      if (q && !`${r.name} ${r.description ?? ""} ${info.label} ${info.module}`.toLowerCase().includes(q)) continue;
      const arr = byModule.get(info.module) ?? [];
      if (!byModule.has(info.module)) byModule.set(info.module, arr);
      arr.push(r);
    }
    return [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, meta, query, statusFilter]);

  // Focus to one module's rules when a chip is picked. If the active module falls out of the current
  // search/status result, fall back to showing all (so the list never looks empty for a stale selection).
  const moduleActive = moduleFilter !== "all" && groups.some(([m]) => m === moduleFilter);
  const displayGroups = moduleActive ? groups.filter(([m]) => m === moduleFilter) : groups;
  const totalShown = groups.reduce((n, [, r]) => n + r.length, 0);

  const filterBtn = (key: StatusFilter, label: string) => (
    <button type="button" onClick={() => setStatusFilter(key)}
      className={cn("rounded-md px-2.5 py-1 text-sm transition-colors", statusFilter === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
      {label}
    </button>
  );

  return (
    <DataState state={state} error={error}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search rules…" className="pl-8" />
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {filterBtn("all", `All ${rows.length}`)}
          {filterBtn("enabled", `On ${enabledCount}`)}
          {filterBtn("disabled", `Off ${rows.length - enabledCount}`)}
        </div>
        {canWrite && <Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" /> New rule</Button>}
      </div>

      {/* Module filter: focus the list to one section. Only worth showing when there's more than one module. */}
      {groups.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <ModuleChip active={!moduleActive} onClick={() => setModuleFilter("all")} label="All" count={totalShown} />
          {groups.map(([m, r]) => (
            <ModuleChip key={m} active={moduleActive && moduleFilter === m} onClick={() => setModuleFilter(m)} label={m} count={r.length} />
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No automations yet" description="Create a rule to make one action trigger the next." />
      ) : displayGroups.length === 0 ? (
        <EmptyState icon={Search} title="No matching rules" description="Try a different search or filter." />
      ) : (
        <div className="space-y-6">
          {displayGroups.map(([module, rules]) => (
            <section key={module}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold">{module}</h3>
                <span className="text-xs text-muted-foreground">{rules.length}</span>
              </div>
              <div className="grid gap-2">
                {rules.map((a) => (
                  <RuleCard key={a.path} a={a} meta={meta} canWrite={canWrite}
                    onToggle={() => toggle(a)} onTest={() => test(a)} onEdit={() => setEditing(a)} onDelete={() => del(a)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </DataState>
  );
}

function RuleCard({ a, meta, canWrite, onToggle, onTest, onEdit, onDelete }: {
  a: Automation; meta: WorkflowMeta | null; canWrite: boolean;
  onToggle: () => void; onTest: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const trigger = triggerInfo(meta?.events, a.trigger_type);
  const steps = describeActions(a.actions);
  return (
    <Card className={cn("p-3.5 transition-colors", !a.enabled && "bg-muted/30")}>
      <div className="flex items-start gap-3">
        {canWrite && <div className="pt-0.5"><AccessAction collection="automations" objectPath={a.path} verb={a.enabled ? "disable" : "enable"} label={a.enabled ? "Disable rule" : "Enable rule"}><EnableToggle on={a.enabled} onClick={onToggle} label={a.enabled ? "Disable rule" : "Enable rule"} /></AccessAction></div>}
        <div className="min-w-0 flex-1">
          <AccessAction collection="automations" objectPath={a.path} label={a.name}>
            <span className={cn("font-medium", !a.enabled && "text-muted-foreground")}>{a.name}</span>
          </AccessAction>
          {a.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{a.description}</p>}

          {/* When <trigger> -> [only if] -> then <actions> */}
          <div className={cn("mt-2.5 flex flex-wrap items-center gap-1.5", !a.enabled && "opacity-70")}>
            <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium", moduleStyle(trigger.module))}>
              <Zap className="h-3 w-3" />{a.schedule ? describeSchedule(a.schedule) : `When ${trigger.label}`}
            </span>
            {a.condition ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                <CircleSlash className="h-3 w-3" />only if
              </span>
            ) : null}
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {steps.length ? steps.map((s, i) => <StepPill key={i} step={s} />) : <span className="text-xs text-muted-foreground">no actions</span>}
          </div>
        </div>

        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0" title="More"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onTest}><Play className="mr-2 h-4 w-4" /> Test</DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}><Pencil className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </Card>
  );
}

// Live "When -> [if] -> then" preview of the draft, mirroring how the rule reads in the list.
function FlowPreview({ draft, meta }: { draft: AutomationDraft; meta: WorkflowMeta | null }) {
  const steps = describeActions(draft.actions as unknown[]);
  const info = draft.trigger_type ? triggerInfo(meta?.events, draft.trigger_type) : null;
  return (
    <div className="mb-4 rounded-lg border bg-muted/30 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {info ? (
          <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium", moduleStyle(info.module))}><Zap className="h-3 w-3" />{draft.schedule ? describeSchedule(draft.schedule) : `When ${info.label}`}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Pick a trigger to start…</span>
        )}
        {draft.condition ? <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"><CircleSlash className="h-3 w-3" />only if</span> : null}
        {info && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {steps.length ? steps.map((s, i) => <StepPill key={i} step={s} />) : info ? <span className="text-xs text-muted-foreground">Add an action…</span> : null}
      </div>
    </div>
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: Automation | "new"; onClose: () => void; onSaved: () => void }) {
  const isNew = rule === "new";
  const cur = isNew ? null : (rule as Automation);
  const { meta, error: metaErr } = useWorkflowMeta();
  const [draft, setDraft] = useState<AutomationDraft>({
    name: cur?.name ?? "",
    description: cur?.description ?? "",
    trigger_type: cur?.trigger_type ?? "",
    condition: (cur?.condition as AutomationDraft["condition"]) ?? null,
    actions: (cur?.actions as AutomationDraft["actions"]) ?? [],
    schedule: (cur?.schedule as AutomationDraft["schedule"]) ?? null,
  });
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function save() {
    setBusy(true);
    try {
      const body = { name: draft.name, description: draft.description || null, trigger_type: draft.trigger_type, condition: draft.condition, actions: draft.actions, schedule: draft.schedule ?? null };
      if (isNew) await create("automations", body);
      else await patch((rule as Automation).path, body, (rule as Automation).etag);
      onSaved();
    } catch (e) { toast({ title: "Could not save rule", description: String((e as Error).message), variant: "destructive" }); }
    finally { setBusy(false); }
  }

  const missing = !draft.name ? "a name" : !draft.trigger_type ? "a trigger" : draft.actions.length === 0 ? "at least one action" : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Zap className="h-5 w-5" /></span>
            <div>
              <DialogTitle>{isNew ? "New automation" : "Edit automation"}</DialogTitle>
              <p className="text-sm text-muted-foreground">When an event happens, run the next step - no code.</p>
            </div>
          </div>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          {metaErr && <p className="mb-2 text-xs text-destructive">Could not load builder metadata: {metaErr}</p>}
          <FlowPreview draft={draft} meta={meta} />
          <WorkflowBuilder draft={draft} onChange={setDraft} meta={meta} />
        </div>
        <DialogFooter className="items-center">
          {missing && <span className="mr-auto text-xs text-muted-foreground">Add {missing} to save</span>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!!missing}>{isNew ? "Create rule" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useReadList<T>(path: string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => { get<{ results: T[] }>(path).then((r) => setRows(r.results)).catch((e) => setErr(String((e as Error).message))); }, [path, gen]);
  return { rows, err, refresh: () => setGen((g) => g + 1) };
}

// These tabs monitor live activity - a refresh that doesn't reload the whole app matters.
function RefreshButton({ onClick }: { onClick: () => void }) {
  return <Button variant="outline" size="sm" className="ml-auto" onClick={onClick}><Activity className="h-3.5 w-3.5" /> Refresh</Button>;
}

// ---- shared display helpers for the read-only tabs ----
function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 45_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}
function durationOf(a?: string, b?: string | null): string {
  if (!a || !b) return "";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Outcome/instance status -> icon + tint.
const STATUS_META: Record<string, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  done: { icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400", label: "Done" },
  partial: { icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-400", label: "Partial" },
  error: { icon: XCircle, cls: "text-red-600 dark:text-red-400", label: "Error" },
  skipped: { icon: MinusCircle, cls: "text-muted-foreground", label: "Skipped" },
  suspended: { icon: Hourglass, cls: "text-amber-600 dark:text-amber-400", label: "Waiting" },
  waiting: { icon: Hourglass, cls: "text-amber-600 dark:text-amber-400", label: "Waiting" },
  expired: { icon: MinusCircle, cls: "text-muted-foreground", label: "Expired" },
};
const statusMeta = (s: string) => STATUS_META[s] ?? { icon: Cog, cls: "text-muted-foreground", label: humanize(s) };

// A live index of automation path -> its record, to resolve a run/instance back to the rule that produced it.
function useRuleName() {
  const { rows } = useCollection<Automation>("automations");
  return useMemo(() => {
    const byPath = new Map(rows.map((r) => [r.path, r] as const));
    return (path?: string) => (path ? byPath.get(path) : undefined);
  }, [rows]);
}

// A small module-tinted pill for an event type (reused by Runs / Waiting / Events).
function EventPill({ meta, type }: { meta: WorkflowMeta | null; type: string }) {
  const info = triggerInfo(meta?.events, type);
  return <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium", moduleStyle(info.module))}><Zap className="h-3 w-3" />{info.label}</span>;
}

// Resolve an "employees/<token>" ref to a display name (for showing WHO a run/event/wait is about).
function useEmployeeName() {
  const { rows } = useCollection<Employee>("employees");
  return useMemo(() => {
    const m = new Map(rows.map((e) => [e.path, ((e as { display_name?: string }).display_name || `${e.first_name ?? ""} ${e.last_name ?? ""}`).trim() || e.path] as const));
    return (ref?: string) => (ref ? m.get(ref) ?? null : null);
  }, [rows]);
}

// "who/what caused this": the employee (by name) if known, else the subject resource.
function CauseTag({ employeeRef, subject, nameOf }: { employeeRef?: string; subject?: string; nameOf: (r?: string) => string | null }) {
  const name = nameOf(employeeRef);
  if (name) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><User className="h-3 w-3" />{name}</span>;
  if (subject) return <span className="text-xs text-muted-foreground">{humanize(subject.split("/")[0] ?? "")}</span>;
  return null;
}

// Group rows by workflow-execution trace (correlation_id). Each group is sorted chronologically; groups are
// ordered most-recent first. Rows with no trace become singleton groups. This is what makes "same workflow"
// visible - one inbound event and everything it caused cluster together.
function groupByTrace<T extends { path: string; correlation_id?: string }>(rows: T[], timeOf: (r: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.correlation_id ?? `solo:${r.path}`;
    const arr = m.get(k) ?? [];
    if (!m.has(k)) m.set(k, arr);
    arr.push(r);
  }
  const t = (r: T) => +new Date(timeOf(r));
  return [...m.values()]
    .map((rs) => [...rs].sort((a, b) => t(a) - t(b)))
    .sort((a, b) => t(b[b.length - 1]!) - t(a[a.length - 1]!));
}

// Header for a multi-step trace: the root cause (first event) + who/what + step count + when.
function TraceHeader({ meta, root, count, latest, nameOf }: { meta: WorkflowMeta | null; root: { event_type: string; subject?: string; employee?: string }; count: number; latest: string; nameOf: (r?: string) => string | null }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-b pb-2">
      <span className="text-xs font-medium text-muted-foreground">Triggered by</span>
      <EventPill meta={meta} type={root.event_type} />
      <CauseTag employeeRef={root.employee} subject={root.subject} nameOf={nameOf} />
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"><span>{count} steps</span>·<span>{timeAgo(latest)}</span></span>
    </div>
  );
}

function RunRow({ r, meta, ruleName, nameOf }: { r: AutomationRun; meta: WorkflowMeta | null; ruleName: (p?: string) => Automation | undefined; nameOf: (ref?: string) => string | null }) {
  const m = statusMeta(r.status);
  const rule = ruleName(r.automation);
  return (
    <div className="flex items-start gap-3 py-1.5">
      <m.icon className={cn("mt-0.5 h-5 w-5 shrink-0", m.cls)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{rule?.name ?? "(deleted rule)"}</span>
          <EventPill meta={meta} type={r.event_type} />
          <CauseTag employeeRef={r.employee} subject={r.subject} nameOf={nameOf} />
        </div>
        {r.result && r.result.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {r.result.map((a, i) => {
              const Icon = ACTION_ICON[a.kind] ?? Cog;
              const am = statusMeta(a.status);
              return (
                <span key={i} title={a.detail} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                  <Icon className="h-3 w-3 text-muted-foreground" />{a.kind}<am.icon className={cn("h-3 w-3", am.cls)} />
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <div>{timeAgo(r.start_time)}</div>
        {durationOf(r.start_time, r.end_time) && <div className="mt-0.5">{durationOf(r.start_time, r.end_time)}</div>}
      </div>
    </div>
  );
}

function RunsTab() {
  const { rows, err, refresh } = useReadList<AutomationRun>("automation-runs?max_page_size=100");
  const { meta } = useWorkflowMeta();
  const ruleName = useRuleName();
  const nameOf = useEmployeeName();
  if (err) return <EmptyState icon={Activity} title="Could not load runs" description={err} />;
  if (!rows) return <DataState state="loading" error={null}><div /></DataState>;
  if (!rows.length) return <EmptyState icon={Activity} title="No runs yet" description="When a rule fires, its run is recorded here - grouped by the workflow that caused it." />;

  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {} as Record<string, number>);
  const groups = groupByTrace(rows, (r) => r.start_time);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["done", "partial", "error", "skipped"] as const).filter((s) => counts[s]).map((s) => {
          const m = statusMeta(s);
          return <span key={s} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm"><m.icon className={cn("h-4 w-4", m.cls)} />{m.label}<span className="font-semibold">{counts[s]}</span></span>;
        })}
        <RefreshButton onClick={refresh} />
      </div>
      <div className="grid gap-2">
        {groups.map((g) =>
          g.length === 1 ? (
            <Card key={g[0]!.path} className="p-3"><RunRow r={g[0]!} meta={meta} ruleName={ruleName} nameOf={nameOf} /></Card>
          ) : (
            <Card key={g[0]!.correlation_id} className="p-3">
              <TraceHeader meta={meta} root={g[0]!} count={g.length} latest={g[g.length - 1]!.start_time} nameOf={nameOf} />
              <div className="divide-y">{g.map((r) => <RunRow key={r.path} r={r} meta={meta} ruleName={ruleName} nameOf={nameOf} />)}</div>
            </Card>
          ),
        )}
      </div>
    </div>
  );
}

type WorkflowInstance = { path: string; status: string; awaited_types?: string[]; arms?: unknown[]; automation?: string; origin_type?: string; subject?: string; employee?: string; correlation_id?: string; create_time?: string };
function InstancesTab() {
  const { rows, err, refresh } = useReadList<WorkflowInstance>("workflow-instances?max_page_size=100");
  const { meta } = useWorkflowMeta();
  const ruleName = useRuleName();
  const nameOf = useEmployeeName();
  if (err) return <EmptyState icon={Hourglass} title="Could not load waiting workflows" description={err} />;
  if (!rows) return <DataState state="loading" error={null}><div /></DataState>;
  if (!rows.length) return <EmptyState icon={Hourglass} title="Nothing waiting" description="Durable workflows paused on a 'wait for' step appear here until an event or timer resumes them." />;
  const waiting = rows.filter((r) => r.status === "waiting");
  const shown = waiting.length ? waiting : rows;
  return (
    <div>
    <div className="mb-4 flex"><RefreshButton onClick={refresh} /></div>
    <div className="grid gap-2">
      {shown.map((r) => {
        const rule = ruleName(r.automation);
        const hasTimer = Array.isArray(r.arms) && r.arms.some((a) => a && typeof a === "object" && "timer" in (a as object));
        const m = statusMeta(r.status);
        return (
          <Card key={r.path} className="p-3">
            <div className="flex items-start gap-3">
              <Hourglass className={cn("mt-0.5 h-5 w-5 shrink-0", m.cls)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium">{rule?.name ?? (r.origin_type ? triggerInfo(meta?.events, r.origin_type).label : "Workflow")}</span>
                  <CauseTag employeeRef={r.employee} subject={r.subject} nameOf={nameOf} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Waiting for</span>
                  {(r.awaited_types ?? []).map((t) => <EventPill key={t} meta={meta} type={t} />)}
                  {hasTimer && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5"><Clock className="h-3 w-3" />a timer</span>}
                  {!r.awaited_types?.length && !hasTimer && <span>a timer</span>}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">waiting {timeAgo(r.create_time).replace(" ago", "")}</div>
            </div>
          </Card>
        );
      })}
    </div>
    </div>
  );
}

function EventRow({ e, meta, nameOf }: { e: EventLogEntry; meta: WorkflowMeta | null; nameOf: (ref?: string) => string | null }) {
  const keys = Object.keys(e.payload ?? {});
  return (
    <div className="flex items-center gap-3 py-1.5">
      <EventPill meta={meta} type={e.type} />
      <CauseTag employeeRef={e.employee} subject={e.subject} nameOf={nameOf} />
      {keys.length > 0 && <span className="hidden truncate text-xs text-muted-foreground/70 sm:inline">{keys.join(", ")}</span>}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(e.occurred_time)}</span>
    </div>
  );
}

function EventsTab() {
  const { rows, err, refresh } = useReadList<EventLogEntry>("event-log?max_page_size=100");
  const { meta } = useWorkflowMeta();
  const nameOf = useEmployeeName();
  const [moduleFilter, setModuleFilter] = useState<string>("all");
  const modules = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of rows ?? []) { const mod = triggerInfo(meta?.events, e.type).module; counts.set(mod, (counts.get(mod) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, meta]);
  if (err) return <EmptyState icon={ScrollText} title="Could not load events" description={err} />;
  if (!rows) return <DataState state="loading" error={null}><div /></DataState>;
  if (!rows.length) return <EmptyState icon={ScrollText} title="No events yet" description="Every action announces itself here, grouped by the workflow it belongs to - the feed automations react to." />;

  const active = moduleFilter !== "all" && modules.some(([m]) => m === moduleFilter);
  const filtered = active ? rows.filter((e) => triggerInfo(meta?.events, e.type).module === moduleFilter) : rows;
  const groups = groupByTrace(filtered, (e) => e.occurred_time);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {modules.length > 1 && (
          <>
            <ModuleChip active={!active} onClick={() => setModuleFilter("all")} label="All" count={rows.length} />
            {modules.map(([m, n]) => <ModuleChip key={m} active={active && moduleFilter === m} onClick={() => setModuleFilter(m)} label={m} count={n} />)}
          </>
        )}
        <RefreshButton onClick={refresh} />
      </div>
      <div className="grid gap-2">
        {groups.map((g) =>
          g.length === 1 ? (
            <Card key={g[0]!.path} className="px-3 py-1"><EventRow e={g[0]!} meta={meta} nameOf={nameOf} /></Card>
          ) : (
            <Card key={g[0]!.correlation_id} className="p-3">
              <TraceHeader meta={meta} root={{ event_type: g[0]!.type, subject: g[0]!.subject, employee: g[0]!.employee }} count={g.length} latest={g[g.length - 1]!.occurred_time} nameOf={nameOf} />
              <div className="divide-y">{g.map((e) => <EventRow key={e.path} e={e} meta={meta} nameOf={nameOf} />)}</div>
            </Card>
          ),
        )}
      </div>
    </div>
  );
}
