import { useCallback, useEffect, useMemo, useState } from "react";
import { Timer, ChevronLeft, ChevronRight, CopyPlus, Minus, Plus, Send, Check, X, Trash2 } from "lucide-react";
import { get, getAllPages, create, patch, remove, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr, addDaysYmd, weekStartYmd, weekdayOf } from "@/lib/orgDay";
import type { Card as KanbanCard, Employee, Me, Project, TimeEntry, TimeEntryStatus } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { Chart, ChartCard } from "@/components/common/Chart";
import { topSlices } from "@/lib/chartTheme";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

// The grid's week is a run of seven DAY STRINGS, stepped with lib/orgDay. It used to hold a local `Date` for
// the week start and format it with a local `ymd`: the week the page opened on was then the BROWSER's week
// rather than the org's, and `+weekStart + i * DAY` stops being a calendar day the moment a DST boundary
// falls inside the week - which is also how "copy last week" could land an entry on the wrong weekday.
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Ceiling on the time entries any one of this page's reads will follow the cursor for. Well past a person's
// week or a team's approval queue; it exists so a filter that goes wrong reads a bounded number of pages.
const ENTRY_ROW_CAP = 2000;
const dayNum = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(2).replace(/0$/, ""));

// Per-status cell styling so the grid itself shows where each entry is in draft → submitted → approved.
// Draft stays neutral (editable); rejected stays editable so it can be fixed and resubmitted.
const CELL: Record<TimeEntryStatus, string> = {
  DRAFT: "",
  SUBMITTED: "bg-muted/50 text-muted-foreground",
  APPROVED: "bg-success/10 text-success",
  REJECTED: "bg-destructive/10 text-destructive hover:bg-destructive/15",
};
const LEGEND: { status: TimeEntryStatus; label: string; swatch: string }[] = [
  { status: "DRAFT", label: "Draft", swatch: "border bg-card" },
  { status: "SUBMITTED", label: "Submitted", swatch: "bg-muted" },
  { status: "APPROVED", label: "Approved", swatch: "bg-success/30" },
  { status: "REJECTED", label: "Rejected", swatch: "bg-destructive/30" },
];

export default function Timesheets({ me }: { me: Me }) {
  const { rows: projects, state: projectsState } = useCollection<Project>("projects");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [copying, setCopying] = useState(false); // "copy last week" in flight
  const [deciding, setDeciding] = useState<string | null>(null); // "<path>|<verb>" of the in-flight decision
  const canApprove = usePermission("time-entries.approve");
  const meRef = me.employee_id ? `employees/${me.employee_id}` : "";

  const [weekStart, setWeekStart] = useState(() => weekStartYmd(todayStr()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStart, i)), [weekStart]);
  const [mine, setMine] = useState<TimeEntry[]>([]);
  const [weekLoaded, setWeekLoaded] = useState(false);
  const [pending, setPending] = useState<TimeEntry[]>([]);
  const [extraProjects, setExtraProjects] = useState<string[]>([]); // project ids added to the grid this week
  const [cell, setCell] = useState<{ projectId: string; date: string; existing?: TimeEntry } | null>(null);

  const activeProjects = useMemo(() => projects.filter((p) => p.status !== "archived"), [projects]);
  const projectById = useMemo(() => new Map(projects.map((p) => [idOf(p.path), p])), [projects]);
  // The caller's own undelivered board tasks, so an hour can name the task it went into. Read only once the
  // log dialog is actually open - a timesheet grid has no use for it, and this app does not load a collection
  // for a field nobody has looked at yet.
  const { rows: cards } = useCollection<KanbanCard>("cards", { enabled: !!cell });
  const myTasks = useMemo(
    () => cards
      .filter((c) => !c.delete_time && !c.deliver_time && (!meRef || c.assignee === meRef || c.employee === meRef))
      .map((c) => ({ path: c.path, label: c.key ? `${c.key} · ${c.title}` : c.title }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [cards, meRef],
  );
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  // The week's edges as named values: `days[0]` inside a dependency array is an expression the linter cannot
  // check, so the fetch and its dependencies are held together by hand. Named, they are the same two strings.
  const [weekFrom, weekTo] = [days[0]!, days[6]!];
  const loadWeek = useCallback(async () => {
    if (!meRef) { setWeekLoaded(true); return; }
    try {
      // The grid keys its cells `(project, date)` off these rows and totals the week from them, so a short read
      // is a wrong timesheet, not a short one. `max_page_size=500` was clamped to 100 by the server without
      // saying so; the cursor is followed instead, within a ceiling a week cannot legitimately reach.
      const r = await getAllPages<TimeEntry>(`time-entries?employee=${encodeURIComponent(meRef)}&from=${weekFrom}&to=${weekTo}`, ENTRY_ROW_CAP);
      setMine(r.results);
    } catch (e) { toast({ title: "Couldn't load the week's entries", description: (e as Error).message, variant: "destructive" }); }
    finally { setWeekLoaded(true); }
  }, [meRef, weekFrom, weekTo, toast]);
  const loadPending = useCallback(async () => {
    if (!canApprove) return;
    // The approval queue: unlike the week above this one really does run past a page on any busy team, and a
    // queue that stops at a hundred hides work nobody is told about.
    try { const r = await getAllPages<TimeEntry>("time-entries?status=SUBMITTED", ENTRY_ROW_CAP); setPending(r.results.filter((e) => idOf(e.employee ?? "") !== me.employee_id)); }
    catch { setPending([]); }
  }, [canApprove, me.employee_id]);
  useEffect(() => { void loadWeek(); }, [loadWeek]);
  useEffect(() => { void loadPending(); }, [loadPending]);

  // (projectId|date) -> entry (one cell = one entry; new logs create one).
  const byCell = useMemo(() => {
    const m = new Map<string, TimeEntry>();
    for (const e of mine) if (e.project && e.date) m.set(`${idOf(e.project)}|${e.date}`, e);
    return m;
  }, [mine]);
  // The same entries the grid draws, totalled two ways. Billable is split out rather than shown as a share,
  // because the useful reading is "how much of Tuesday was billable", not "what percent of the week was".
  const weekCharts = useMemo(() => {
    const billableByDay = new Map<string, number>();
    const nonBillableByDay = new Map<string, number>();
    for (const e of mine) {
      if (!e.date) continue;
      const target = e.billable ? billableByDay : nonBillableByDay;
      target.set(e.date, Math.round(((target.get(e.date) ?? 0) + e.hours) * 100) / 100);
    }
    return {
      billableByDay,
      nonBillableByDay,
      projects: topSlices(mine, (e) => projectById.get(idOf(e.project ?? ""))?.name ?? "Project", (e) => e.hours, 7),
    };
  }, [mine, projectById]);

  const gridProjects = useMemo(() => {
    const ids = new Set<string>([...mine.map((e) => idOf(e.project ?? "")), ...extraProjects].filter(Boolean));
    return [...ids].map((id) => projectById.get(id)).filter(Boolean) as Project[];
  }, [mine, extraProjects, projectById]);

  // Distinct descriptions this person has already used on a project (newest first), for the log dialog's
  // suggestion list. Drawn from what's loaded - no extra query for a convenience.
  const descriptionsFor = (projectId: string) => [
    ...new Set(mine.filter((e) => e.project && idOf(e.project) === projectId && e.description?.trim()).map((e) => e.description!.trim())),
  ].slice(0, 8);
  // The next day of the visible week whose cell for this project is still editable (a submitted or approved
  // entry is not), so "save & next day" never lands on a locked cell.
  const nextEditableDay = (projectId: string, from: string) => {
    for (const d of days.filter((x) => x > from)) {
      const at = byCell.get(`${projectId}|${d}`);
      if (!at || at.status === "DRAFT" || at.status === "REJECTED") return d;
    }
    return undefined;
  };

  // One cell of the week grid, shared by the phone card layout and the table: same target, same states, so
  // the two layouts can never drift apart.
  const dayCell = (p: Project, d: string) => {
    const e = byCell.get(`${idOf(p.path)}|${d}`);
    const locked = e && (e.status === "SUBMITTED" || e.status === "APPROVED");
    return (
      <button
        type="button"
        disabled={!!locked}
        aria-label={`${p.name}, ${d}${e ? `, ${fmt(e.hours)} hours` : ", no hours logged"}`}
        onClick={() => setCell({ projectId: idOf(p.path), date: d, existing: e })}
        className={cn(
          "h-10 w-full rounded-md text-sm tabular-nums transition-colors",
          e ? "font-medium" : "text-muted-foreground",
          locked ? "cursor-default" : "hover:bg-muted/50",
          e && CELL[e.status],
        )}
      >
        {e ? `${fmt(e.hours)}h` : "·"}
      </button>
    );
  };

  const dayTotal = (d: string) => mine.filter((e) => e.date === d).reduce((s, e) => s + e.hours, 0);
  const weekTotal = mine.reduce((s, e) => s + e.hours, 0);
  const draftCount = mine.filter((e) => e.status === "DRAFT" || e.status === "REJECTED").length;

  async function submitWeek() {
    const toSubmit = mine.filter((e) => e.status === "DRAFT" || e.status === "REJECTED");
    // Submitting hands the whole week to an approver and freezes it - the entries stop being editable, so a
    // half-finished week submitted by accident has to be rejected before it can be fixed.
    if (!(await confirmDecision(confirm, "submit", `${toSubmit.length} ${toSubmit.length === 1 ? "entry" : "entries"} (${weekTotal}h)`))) return;
    setSubmitting(true);
    try {
      for (const e of toSubmit) await invoke(`time-entries/${idOf(e.path)}`, "submit");
      toast({ title: `Submitted ${toSubmit.length} ${toSubmit.length === 1 ? "entry" : "entries"}`, variant: "success" });
      void loadWeek();
    } catch (e) { toast({ title: "Couldn't submit", description: (e as Error).message, variant: "destructive" }); }
    finally { setSubmitting(false); }
  }
  // Seed this week from the previous one: same project, same weekday, same hours and description, as fresh
  // drafts. Cells that already hold an entry this week are left alone, so it is safe to run twice.
  async function copyLastWeek() {
    if (!meRef) return;
    setCopying(true);
    try {
      const from = addDaysYmd(weekStart, -7);
      const to = addDaysYmd(weekStart, -1);
      const r = await getAllPages<TimeEntry>(`time-entries?employee=${encodeURIComponent(meRef)}&from=${from}&to=${to}`, ENTRY_ROW_CAP);
      const source = r.results.filter((e) => e.project && e.date);
      const todo = source
        .map((e) => ({ e, date: addDaysYmd(e.date!, 7) }))
        .filter(({ e, date }) => days.includes(date) && !byCell.get(`${idOf(e.project!)}|${date}`));
      if (todo.length === 0) {
        toast({ title: source.length ? "Nothing to copy" : "Last week is empty", description: source.length ? "Every day last week already has an entry here." : undefined });
        return;
      }
      for (const { e, date } of todo) {
        await create("time-entries", { project: e.project, date, hours: e.hours, description: e.description || undefined, billable: e.billable });
      }
      toast({ title: `Copied ${todo.length} ${todo.length === 1 ? "entry" : "entries"}`, variant: "success" });
      void loadWeek();
    } catch (e) { toast({ title: "Couldn't copy last week", description: (e as Error).message, variant: "destructive" }); }
    finally { setCopying(false); }
  }
  async function decide(e: TimeEntry, verb: "approve" | "reject") {
    if (!(await confirmDecision(confirm, verb, `${e.hours}h logged on ${formatDate(e.date)}`))) return;
    setDeciding(`${e.path}|${verb}`);
    try {
      await invoke(`time-entries/${idOf(e.path)}`, verb);
      toast({ title: verb === "approve" ? "Entry approved" : "Entry rejected", variant: "success" });
      // Awaited: `deciding` clears in `finally` right after this, which re-offers the Approve/Reject buttons -
      // an un-awaited reload left the just-decided row on screen, inviting a second decide on an entry the
      // server already settled.
      await Promise.all([loadPending(), loadWeek()]);
    } catch (err) { toast({ title: verb === "approve" ? "Couldn't approve the entry" : "Couldn't reject the entry", description: (err as Error).message, variant: "destructive" }); }
    finally { setDeciding(null); }
  }

  return (
    // The route key ("timesheets") is not a collection; the grid's data is time-entries. Rebind the ambient
    // scope so the header icon and the verb affordances manage the right resource.
    <AccessScope collection="time-entries">
    <div>
      <PageHeader accessCollection="time-entries" title="Timesheets" actions={<PageSettings me={me} host="timesheets" />} />

      {canApprove && pending.length > 0 && (
        <Card className="mb-6 p-4">
          <h2 className="mb-2 text-sm font-semibold">Awaiting your approval ({pending.length})</h2>
          <div className="space-y-2">
            {pending.map((e) => (
              <div key={e.path} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span><span className="font-medium">{empName(e.employee)}</span> · {projectById.get(idOf(e.project ?? ""))?.name ?? "Project"} · <span className="tabular-nums">{fmt(e.hours)}h</span> · {formatDate(e.date)}{e.description ? ` · ${e.description}` : ""}</span>
                <span className="flex gap-1">
                  <AccessAction verb="approve" objectPath={e.path} can={e.access?.can} label="Approve time entry">
                    <Button size="sm" variant="outline" loading={deciding === `${e.path}|approve`} disabled={deciding === `${e.path}|reject`} onClick={() => decide(e, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button>
                  </AccessAction>
                  <AccessAction verb="reject" objectPath={e.path} can={e.access?.can} label="Reject time entry">
                    <Button size="sm" variant="ghost" className="text-destructive" loading={deciding === `${e.path}|reject`} disabled={deciding === `${e.path}|approve`} onClick={() => decide(e, "reject")}><X className="h-3.5 w-3.5" /> Reject</Button>
                  </AccessAction>
                  <RowActivityButton resource={e.path} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => addDaysYmd(w, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
        {/* "6 - 12 Oct" needs nothing like 12rem; that floor exists to stop the label jittering as the
            week changes. On a phone it is a third of the screen reserved for eight characters, so the
            floor only applies once there is room for it. */}
        <span className="min-w-[8rem] text-center text-sm font-medium tabular-nums sm:min-w-[12rem]">{dayNum(days[0])} - {dayNum(days[6])}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => addDaysYmd(w, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(weekStartYmd(todayStr()))}>This week</Button>
        {/* Most weeks repeat the last one, so the whole grid can be seeded in a click and then corrected. */}
        <AccessAction create label="Time entry">
          <Button variant="outline" size="sm" loading={copying} onClick={copyLastWeek}><CopyPlus className="h-3.5 w-3.5" /> Copy last week</Button>
        </AccessAction>
        <span className="ml-auto text-sm text-muted-foreground">Week total <span className="font-semibold tabular-nums text-foreground">{fmt(weekTotal)}h</span></span>
        {draftCount > 0 && (
          <AccessAction verb="submit" label="Submit time entries">
            <Button size="sm" onClick={submitWeek} loading={submitting}><Send className="h-3.5 w-3.5" /> Submit week ({draftCount})</Button>
          </AccessAction>
        )}
      </div>

      {/* The week the grid holds, read two ways the grid cannot: how the hours fall across the days (a
          fourteen-hour Thursday is a fact worth seeing), and which projects they went to. */}
      {weekLoaded && weekTotal > 0 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Hours across the week" description="What was logged on each day, billable and not.">
            <Chart
              type="bar"
              height={180}
              labels={days.map((d, i) => `${WEEKDAY[i]} ${new Date(d + "T00:00:00").getDate()}`)}
              datasets={[
                { name: "Billable", values: days.map((d) => weekCharts.billableByDay.get(d) ?? 0) },
                { name: "Non-billable", values: days.map((d) => weekCharts.nonBillableByDay.get(d) ?? 0) },
              ]}
              stacked
              format={(v) => `${fmt(v)}h`}
              ariaLabel="Hours logged on each day of this week, split billable and non-billable"
            />
          </ChartCard>
          <ChartCard title="Where the week went" description="This week's hours by project.">
            <Chart
              type="donut"
              height={180}
              labels={weekCharts.projects.labels}
              datasets={[{ name: "Hours", values: weekCharts.projects.values }]}
              format={(v) => `${fmt(v)}h`}
              ariaLabel="Hours logged this week by project"
            />
          </ChartCard>
        </div>
      )}

      {!weekLoaded || projectsState === "loading" ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : gridProjects.length === 0 && activeProjects.length === 0 ? (
        <EmptyState icon={Timer} title="No projects" description="Ask HR to add projects in Settings → Payroll → Projects before logging time." />
      ) : (
        <>
          {/* A week grid is eight columns wide, which a phone cannot hold however narrow the cells get - and
              the project name is the column that must not be cut. Below `sm` the grid turns itself inside
              out: one card per project, with its seven days as a row of buttons underneath the name. Same
              cells, same taps, no sideways scrolling. */}
          <div className="space-y-2 sm:hidden">
            {gridProjects.map((p) => (
              <div key={p.path} className="rounded-lg border p-3">
                <div className="mb-2 truncate text-sm font-medium">{p.name}{p.client ? <span className="ml-1 text-xs text-muted-foreground">· {p.client}</span> : null}</div>
                <div className="grid grid-cols-7 gap-1">
                  {days.map((d, i) => (
                    <div key={d} className="min-w-0 text-center">
                      <div className={cn("text-[10px] font-medium uppercase tracking-wide text-muted-foreground", d === todayStr() && "text-primary")}>{WEEKDAY[i]}</div>
                      <div className="text-[10px] tabular-nums text-muted-foreground">{new Date(d + "T00:00:00").getDate()}</div>
                      {dayCell(p, d)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="rounded-lg border p-3">
              <AddProjectRow projects={activeProjects.filter((p) => !gridProjects.some((g) => g.path === p.path))} onAdd={(id) => setExtraProjects((x) => [...x, id])} />
              <div className="mt-2 grid grid-cols-7 gap-1 border-t pt-2">
                {days.map((d) => (
                  <div key={d} className="text-center text-[11px] font-medium tabular-nums text-muted-foreground">{dayTotal(d) ? `${fmt(dayTotal(d))}h` : "-"}</div>
                ))}
              </div>
            </div>
          </div>

          <div className="scroll-shadow-x hidden overflow-x-auto rounded-lg border sm:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">Project</th>
                  {days.map((d, i) => (
                    <th key={d} className={cn("px-2 py-2 text-center font-medium", d === todayStr() && "text-primary")}>
                      <div>{WEEKDAY[i]}</div><div className="text-xs font-normal tabular-nums text-muted-foreground">{new Date(d + "T00:00:00").getDate()}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridProjects.map((p) => (
                  <tr key={p.path} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 whitespace-nowrap border-r bg-card px-3 py-2 font-medium">{p.name}{p.client ? <span className="ml-1 text-xs text-muted-foreground">· {p.client}</span> : null}</td>
                    {days.map((d) => (
                      <td key={d} className="border-r p-1 text-center align-middle last:border-0">{dayCell(p, d)}</td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t bg-muted/20">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-2">
                    <AddProjectRow projects={activeProjects.filter((p) => !gridProjects.some((g) => g.path === p.path))} onAdd={(id) => setExtraProjects((x) => [...x, id])} />
                  </td>
                  {days.map((d) => <td key={d} className="px-2 py-2 text-center text-xs font-medium tabular-nums text-muted-foreground">{dayTotal(d) ? `${fmt(dayTotal(d))}h` : ""}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
          {/* Legend: what the cell tints mean (draft/rejected stay editable; submitted/approved are locked). */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {LEGEND.map((l) => (
              <span key={l.status} className="inline-flex items-center gap-1.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", l.swatch)} />
                {l.label}
              </span>
            ))}
          </div>
        </>
      )}

      {cell && (
        <LogDialog
          // Remount per cell: "save & next day" moves the dialog to another day, and a stale hours field
          // carried across would silently re-log the previous day's number.
          key={`${cell.projectId}|${cell.date}`}
          project={projectById.get(cell.projectId)!}
          date={cell.date}
          existing={cell.existing}
          // Everything else logged that day, so the dialog can show the day's total as edited.
          otherHours={dayTotal(cell.date) - (cell.existing?.hours ?? 0)}
          // What this person has written on this project before, so a repeated task is picked, not retyped.
          suggestions={descriptionsFor(cell.projectId)}
          tasks={myTasks}
          // The next day of the week this project can still be edited on, for the keep-going path.
          nextDate={nextEditableDay(cell.projectId, cell.date)}
          onAdvance={(date) => setCell({ projectId: cell.projectId, date, existing: byCell.get(`${cell.projectId}|${date}`) })}
          onClose={() => setCell(null)}
          // Errors propagate to the dialog, which keeps them next to the field that caused them.
          onSave={async (hours, description, card) => {
            // A cleared reference goes over the wire as "" rather than null (api.ts, "No nulls on the wire").
            if (cell.existing) await patch(`time-entries/${idOf(cell.existing.path)}`, { hours, description: description || null, card: card || "" }, cell.existing.etag);
            else await create("time-entries", { project: `projects/${cell.projectId}`, date: cell.date, hours, description: description || undefined, billable: projectById.get(cell.projectId)?.billable ?? true, ...(card ? { card } : {}) });
            void loadWeek();
          }}
          onRemove={cell.existing ? async () => {
            await remove(`time-entries/${idOf(cell.existing!.path)}`);
            setCell(null); void loadWeek();
          } : undefined}
        />
      )}
    </div>
    </AccessScope>
  );
}

function AddProjectRow({ projects, onAdd }: { projects: Project[]; onAdd: (id: string) => void }) {
  const [v, setV] = useState("");
  if (projects.length === 0) return <span className="text-xs text-muted-foreground">All projects added</span>;
  return (
    <Select value={v} onValueChange={(id) => { onAdd(id); setV(""); }}>
      <SelectTrigger className="h-8 w-56"><span className="flex items-center gap-1.5 text-sm"><Plus className="h-3.5 w-3.5" /> Add project</span></SelectTrigger>
      <SelectContent>{projects.map((p) => <SelectItem key={p.path} value={idOf(p.path)}>{p.name}{p.client ? ` · ${p.client}` : ""}</SelectItem>)}</SelectContent>
    </Select>
  );
}

const QUICK_HOURS = [0.5, 1, 2, 4, 8];
const dayFull = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
// Index into WEEKDAY (Monday-first), for naming the day a "save & next" button jumps to.
const days7Index = (s: string) => (weekdayOf(s) + 6) % 7;

// Timesheet cell editor. Hours are the only real input, so they get the whole affordance: quick amounts, quarter-hour
// steppers, and the running day total this entry lands in - typing "7.25" into a bare number box tells you nothing
// about whether the day now adds up.
function LogDialog({ project, date, existing, otherHours, suggestions, tasks, nextDate, onAdvance, onClose, onSave, onRemove }: {
  project: Project;
  date: string;
  existing?: TimeEntry;
  // Hours already logged that day on OTHER projects, so the dialog can show what the day totals after this save.
  otherHours: number;
  // Descriptions this person has used on this project before.
  suggestions: string[];
  /** Board tasks this hour could belong to: the caller's open cards, so "which task" is a pick, not a hunt. */
  tasks: { path: string; label: string }[];
  // Next editable day of the week for this project, when there is one.
  nextDate?: string;
  onAdvance: (date: string) => void;
  onClose: () => void;
  onSave: (hours: number, description: string, card: string) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const guardClose = useDiscardGuard();
  const [hours, setHours] = useState(existing ? String(existing.hours) : "");
  const [description, setDescription] = useState(existing?.description ?? "");
  // Which task inside the project, when the work is tracked as one. Optional and secondary: the project is
  // what the timesheet approves and what a client is billed for.
  const [card, setCard] = useState(existing?.card ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = saving || removing;
  const n = Number(hours);
  const valid = hours.trim() !== "" && !Number.isNaN(n) && n > 0 && n <= 24;
  // Steppers stay inside the valid range (a quarter hour up to 24), so clicking minus on an empty box can't
  // land on a zero the form then rejects.
  const bump = (by: number) => setHours(String(Math.min(24, Math.max(0.25, Math.round(((Number.isNaN(n) ? 0 : n) + by) * 4) / 4))));
  const dayAfter = otherHours + (valid ? n : 0);
  const dirty = hours !== (existing ? String(existing.hours) : "") || description.trim() !== (existing?.description ?? "") || card !== (existing?.card ?? "");
  const close = () => guardClose(dirty, onClose)(false);
  // `advance` keeps the run going: save this cell, then reopen on the next editable day of the same project,
  // which is how a week of one project actually gets logged.
  const save = async (advance = false) => {
    setSaving(true); setError(null);
    try {
      await onSave(n, description.trim(), card);
      if (advance && nextDate) onAdvance(nextDate);
      else onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) close(); }}>
      {/* scrollBody: hours, the quick amounts, a description with its suggestions and the task picker add up
          to more than a phone can show at once, and the Save button must stay reachable. */}
      <DialogContent scrollBody onEnterSubmit={() => { if (!busy && valid) void save(); }}>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit time" : "Log time"}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{project.name}</span>
              {project.client && <span>· {project.client}</span>}
              <span>· {dayFull(date)}</span>
              <Badge variant={project.billable ? "secondary" : "muted"}>{project.billable ? "Billable" : "Non-billable"}</Badge>
              {existing && <StatusBadge state={existing.status} />}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        {/* `htmlFor` by hand: the field holds a stepper, the input and the quick-hour chips, and Field can
            only bind its label when there is a single control to bind it to - so without this the label named
            nothing. */}
        <Field label="Hours" htmlFor="timesheet-hours" error={hours.trim() !== "" && !valid ? "Enter between 0 and 24 hours." : undefined}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={() => bump(-0.25)} aria-label="Quarter hour less"><Minus className="h-4 w-4" /></Button>
              <Input id="timesheet-hours" type="number" min={0} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} autoFocus
                className="h-10 w-24 text-center text-base tabular-nums" />
              <Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={() => bump(0.25)} aria-label="Quarter hour more"><Plus className="h-4 w-4" /></Button>
              <span className="ml-auto text-xs text-muted-foreground">
                Day total <span className="font-semibold tabular-nums text-foreground">{fmt(dayAfter)}h</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_HOURS.map((q) => (
                <button key={q} type="button" onClick={() => setHours(String(q))}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                    n === q ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground",
                  )}>
                  {fmt(q)}h
                </button>
              ))}
            </div>
          </div>
        </Field>
        <Field label="Description (optional)" htmlFor="timesheet-description" hint="Approvers read this when the week is submitted.">
          {/* A datalist, not a combobox: typing stays primary and past descriptions are one keystroke away. */}
          <Input id="timesheet-description" list={suggestions.length ? `desc-${project.path}` : undefined} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" />
          {suggestions.length > 0 && (
            <datalist id={`desc-${project.path}`}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          )}
        </Field>
        {/* The board task these hours went into. Not checked against the project - a board is not tied to one -
            so this only says which task, and gives "what did that task cost" an answer. */}
        {tasks.length > 0 && (
          <Field label="Task (optional)" hint="A board task these hours went into. The project is still what gets approved and billed.">
            <Combobox
              value={card}
              onValueChange={setCard}
              placeholder="No task"
              searchPlaceholder="Search your tasks…"
              options={[{ value: "", label: "No task" }, ...tasks.map((t) => ({ value: t.path, label: t.label }))]}
            />
          </Field>
        )}
        <FormError error={error} />
        </DialogBody>
        <DialogFooter className="items-center">
          {onRemove && (
            <Button variant="ghost" size="sm" className="mr-auto text-destructive" loading={removing} disabled={saving}
              onClick={async () => {
                setRemoving(true); setError(null);
                try { await onRemove(); }
                catch (e) { setError((e as Error).message); }
                finally { setRemoving(false); }
              }}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          {nextDate && <Button variant="outline" onClick={() => save(true)} loading={saving} disabled={!valid || removing}>Save &amp; {WEEKDAY[days7Index(nextDate)]}</Button>}
          <Button onClick={() => save()} loading={saving} disabled={!valid || removing}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
