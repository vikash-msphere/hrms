import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, KanbanSquare, Plus, ChevronRight, ChevronLeft, X, Users, UserCheck, UserPlus, Archive, Hourglass, Link2, GripVertical, CalendarClock, FileSignature, Download, ClipboardList } from "lucide-react";
import { create, get, invoke, patch, download } from "@/api";
import type { ListResponse } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, formatDateTime, idOf } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { fireIntent } from "@/lib/intent";
import { runSequential, batchSummary } from "@/lib/batchRun";
import { describeError } from "@/lib/formError";
import { navigate, recordUrl, setRouteRecord, setQueryParam, useRoute } from "@/router";
import type { Me, Application, Candidate, Employee, Interview, InterviewFeedback, JobRequisition, Offer } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { LinesSkeleton } from "@/components/common/Skeletons";
import { Field, FieldRow } from "@/components/common/Field";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ActivitySection } from "@/components/common/ActivitySection";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessScope } from "@/components/access/AccessScope";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { REC_LABEL, REC_VARIANT, OFFER_STATUS_META } from "@/lib/ats";
import { useAtsConfig, sourceLabel } from "./Candidates";

const CLOSED = "__closed"; // synthetic column: rejected / withdrawn applications
// An active application with no movement for this long has stalled, whatever stage it is parked in.
const STALL_DAYS = 14;

export default function Pipeline({ me, openId }: { me: Me; openId?: string }) {
  const route = useRoute();
  const { rows: apps, state, error, reload } = useCollection<Application>("applications", { all: true });
  // The two lists every card is LABELLED from (who applied, for which role). An empty pipeline has no cards to
  // label, so it reads neither - the same rule the offers read below already follows. COMPLETE, not the first
  // page: pages are the hundred NEWEST rows, so a card whose candidate applied a few months ago would label
  // itself "Candidate" with no role - a record that reads as missing a name rather than as unloaded.
  // They are ALSO the New application dialog's two pickers, so opening it reads them on an empty board too -
  // gated on the cards alone, the first application an org ever filed offered "No candidates" and no jobs.
  const [dialog, setDialog] = useState(false);
  const needLists = apps.length > 0 || dialog;
  const { rows: candidates, state: candidatesState } = useCollection<Candidate>("candidates", { enabled: needLists, all: true });
  const { rows: reqs, state: reqsState } = useCollection<JobRequisition>("job-requisitions", { enabled: needLists, all: true });
  const cfg = useAtsConfig();
  // Offers are read only once a card is actually at the offer stage or past it: on a board of early-stage
  // candidates there is nothing to say, and an unconditional read would spend a D1 page for nothing. When they
  // are read, the card can show what the "draft the offer" rule produced without anyone opening the drawer.
  const anyAtOffer = useMemo(() => apps.some((a) => a.status === "active" && cfg.stages.findIndex((s) => s.key === a.stage) >= cfg.stages.findIndex((s) => s.key === "offer") && cfg.stages.some((s) => s.key === "offer")), [apps, cfg]);
  const { rows: boardOffers, reload: reloadOffers } = useCollection<Offer>("offers", { enabled: anyAtOffer, all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const [reqFilter, setReqFilter] = useState("all");
  const [rejecting, setRejecting] = useState<Application[] | null>(null);
  const [advancing, setAdvancing] = useState<string | null>(null);
  // The hired card's one action converts the candidate first when nobody accepted an offer, so it can spin.
  const [hiring, setHiring] = useState<string | null>(null);
  // The card that is open in the drawer. Linkable: `/pipeline/<applicationId>`.
  const [detail, setDetail] = useState<Application | null>(null);
  useDeepOpen(openId, apps, setDetail);
  // Bulk selection, by application path. "Position filled" means rejecting nine people, and doing that one
  // dialog at a time is how a board gets abandoned half-tidied.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Drag state: what is being dragged, and which column is under it.
  const dragPath = useRef<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  const candName = useMemo(() => {
    const m = new Map(candidates.map((c) => [idOf(c.path), c.name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Candidate" : "");
  }, [candidates]);
  // The hire's email is how the Onboarding page finds the employee the accepted offer created - the
  // application itself carries no employee ref.
  const candEmail = useMemo(() => {
    const m = new Map(candidates.map((c) => [idOf(c.path), c.email]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [candidates]);
  // The live offer on each application: the one the stage rule drafted, or the one a person wrote. Declined and
  // rescinded offers are history, not the card's current state.
  const liveOffer = useMemo(() => {
    const m = new Map<string, Offer>();
    for (const o of boardOffers) {
      if (!o.application || o.status === "declined" || o.status === "rescinded") continue;
      m.set(idOf(o.application), o);
    }
    return (a: Application) => m.get(idOf(a.path));
  }, [boardOffers]);
  const reqTitle = useMemo(() => {
    const m = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [reqs]);

  const onJob = useMemo(
    () => apps.filter((a) => reqFilter === "all" || (a.requisition && idOf(a.requisition) === reqFilter)),
    [apps, reqFilter],
  );

  // An application nobody has touched for two weeks is the pipeline's real problem - it sits in a stage
  // looking healthy. Clicking a metric narrows the board to exactly those cards.
  const isStalled = (a: Application) =>
    a.status === "active" && (Date.now() - Date.parse(a.update_time ?? a.create_time ?? "")) / 86400000 > STALL_DAYS;
  const kf = useKpiFocus<Application, "active" | "hired" | "closed" | "stalled">({
    active: { label: "applications in the pipeline", match: (a) => a.status === "active" },
    hired: { label: "hired applications", match: (a) => a.status === "hired" },
    closed: { label: "closed applications", match: (a) => a.status === "rejected" || a.status === "withdrawn" },
    stalled: { label: `applications untouched for over ${STALL_DAYS} days`, match: isStalled },
  });
  const visible = useMemo(() => kf.apply(onJob), [onJob, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Columns: the configured active stages, the hired stage, then a synthetic Closed column.
  const allColumns = useMemo(() => {
    const cols = cfg.stages.map((s) => ({ key: s.key, label: s.label, kind: s.kind }));
    return [...cols, { key: CLOSED, label: "Closed", kind: "rejected" as const }];
  }, [cfg]);
  // `?stage=` brings the board down to one column. It is how the recruiting funnel drills through: a stage
  // band on that page is exactly this column, and a board that opened on all eight would make the reader
  // find it again by eye. Unknown stage keys are ignored rather than emptying the board.
  const stageParam = route.query.stage ?? null;
  const stageFocus = stageParam && allColumns.some((c) => c.key === stageParam) ? stageParam : null;
  const columns = useMemo(() => (stageFocus ? allColumns.filter((c) => c.key === stageFocus) : allColumns), [allColumns, stageFocus]);

  // Bucketed over ALL the columns, not the ones being rendered: the fallback below puts a card whose stage
  // no longer exists into Closed, and with the board narrowed to one stage that bucket would not be here to
  // catch it.
  const byColumn = useMemo(() => {
    const m = new Map<string, Application[]>();
    for (const col of allColumns) m.set(col.key, []);
    for (const a of visible) {
      const key = a.status === "rejected" || a.status === "withdrawn" ? CLOSED : a.stage;
      (m.get(key) ?? m.get(CLOSED)!).push(a);
    }
    return m;
  }, [visible, allColumns]);

  // Label of the stage `advance` moves this application into, so the button says where it's going.
  const nextStageLabel = useMemo(() => {
    return (stage: string) => {
      const i = cfg.stages.findIndex((s) => s.key === stage);
      return i >= 0 ? cfg.stages[i + 1]?.label : undefined;
    };
  }, [cfg]);

  async function advance(a: Application) {
    if (!(await confirmDecision(confirm, "advance", candName(a.candidate)))) return;
    setAdvancing(a.path);
    try {
      const moved = await invoke<Application>(`applications/${idOf(a.path)}`, "advance");
      reload();
      afterMove(a, moved.stage);
    }
    catch (e) { toast({ title: "Couldn't advance", description: (e as Error).message, variant: "destructive" }); }
    finally { setAdvancing(null); }
  }

  // A hired card has one job left, and it isn't on this board: the hand-off to onboarding. So the hired column
  // carries exactly one action - and it does the hiring too, when nothing else did. Moving a card into a hired
  // stage only ever wrote a string: with no offer accepted there is no employee, so there is nothing to
  // onboard. `:hire` performs that conversion (idempotently), and `hired_employee` is how we know whether it
  // has already happened.
  //
  // The hand-off carries everything Onboarding would otherwise ask for - who they are and when they start
  // (the accepted offer's join date) - so the reader lands on a filled-in start dialog, not an empty one.
  async function openOnboarding(a: Application) {
    let hire = a.hired_employee;
    if (!hire) {
      if (!(await confirm({
        title: `Hire ${candName(a.candidate)}?`,
        description: "This creates their employee record from the candidate's details and starts their onboarding. It can't be undone.",
        confirmLabel: "Hire",
      }))) return;
      setHiring(a.path);
      try {
        const updated = await invoke<Application>(`applications/${idOf(a.path)}`, "hire");
        hire = updated.hired_employee;
        reload();
      } catch (e) {
        toast({ title: "Couldn't hire", description: describeError(e), variant: "destructive" });
        return;
      } finally { setHiring(null); }
    }
    navigate("transitions");
    fireIntent("onboard-hire", {
      employee: hire,
      email: candEmail(a.candidate),
      name: candName(a.candidate),
      startDate: liveOffer(a)?.join_time?.slice(0, 10),
    });
  }

  // The drawer: one card's whole story (rounds, verdicts, offer, resume) instead of four pages.
  function openDetail(a: Application) { setDetail(a); setRouteRecord(idOf(a.path)); }
  function closeDetail() { setDetail(null); setRouteRecord(null); }

  // Dropping a card into a column IS the stage move - the same PATCH the stage picker sends. Not a verb, and
  // deliberately not confirmed: it is one drag back to undo, and a board you have to confirm is a board
  // nobody drags on. Dropping into Closed asks for a reason instead, because that one is not a stage.
  async function moveToStage(a: Application, stage: string) {
    if (a.stage === stage && a.status === "active") return;
    try {
      await patch(`applications/${idOf(a.path)}`, { stage });
      reload();
      afterMove(a, stage);
    } catch (e) {
      toast({ title: "Couldn't move the card", description: describeError(e), variant: "destructive" });
    }
  }

  // A stage move is not just a stage move: the automation rules on `application.stageChanged` run inside that
  // same request, so by the time it returns an offer may have been drafted, a round booked, or the candidate
  // converted. Two things follow from that. The records those rules created have to be re-read (the client only
  // invalidated `applications`), and the person who moved the card deserves to be told what else happened
  // rather than discovering it in the bell. What each stage sets off is the org's own rule set, so this names
  // the stage's usual consequence and points at it, instead of claiming more than it knows.
  function afterMove(a: Application, stage: string) {
    const kind = cfg.stages.find((s) => s.key === stage)?.kind;
    if (kind === "hired") { reload(); return; }
    if (stage === "offer") {
      reloadOffers();
      toast({
        title: `${candName(a.candidate)} is at the offer stage`,
        description: "If your workflow drafts offers, one is waiting for approval on the Offers page.",
        action: { label: "Offers", onClick: () => navigate("offers") },
      });
      return;
    }
    if (stage === "interview") {
      toast({
        title: `${candName(a.candidate)} is at the interview stage`,
        description: "If your workflow books rounds, one is open for the panel and the time to be set.",
        action: { label: "Interviews", onClick: () => navigate("interviews") },
      });
    }
  }

  function onDropInColumn(colKey: string) {
    const path = dragPath.current;
    dragPath.current = null;
    setOverCol(null);
    const a = apps.find((x) => x.path === path);
    if (!a) return;
    if (colKey === CLOSED) { setRejecting([a]); return; }
    void moveToStage(a, colKey);
  }

  const selectedApps = useMemo(() => apps.filter((a) => selected.has(a.path)), [apps, selected]);
  const toggleSelected = (a: Application) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(a.path)) n.delete(a.path); else n.add(a.path);
    return n;
  });

  // Bulk moves run one at a time and report what actually happened: a run that skipped four people says so
  // rather than flashing "done".
  async function bulkMove(stage: string) {
    const targets = selectedApps.filter((a) => a.status === "active");
    if (!targets.length) return;
    const label = cfg.stages.find((s) => s.key === stage)?.label ?? stage;
    if (!(await confirm({
      title: `Move ${targets.length} ${targets.length === 1 ? "candidate" : "candidates"} to ${label}?`,
      description: "Each card moves stage; nothing is sent to the candidates.",
      confirmLabel: `Move to ${label}`,
    }))) return;
    setBulkBusy(true);
    const result = await runSequential(targets, (a) => candName(a.candidate), (a) => patch(`applications/${idOf(a.path)}`, { stage }));
    setBulkBusy(false);
    setSelected(new Set());
    reload();
    toast({
      title: batchSummary(result, "move"),
      description: result.failures.length ? result.failures.map((f) => `${f.label}: ${f.message}`).join("; ") : undefined,
      variant: result.failures.length ? "destructive" : "success",
    });
  }

  const newBtn = (
    <AccessAction collection="applications" create label="Add an application">
      <Button onClick={() => setDialog(true)}><Plus className="h-4 w-4" /> New application</Button>
    </AccessAction>
  );

  const openReqs = reqs.filter((r) => r.status === "open" || r.status === "draft" || r.status === "on_hold");

  return (
    // The route key ("pipeline") is not a collection; the board's data is applications. Rebind the ambient
    // scope so every affordance inside manages the right resource.
    <AccessScope collection="applications">
    <div>
      <PageHeader
        accessCollection="applications"
        title="Pipeline"
        description="Applications by stage. Advance or reject candidates as they move through hiring."
        actions={<>{newBtn}<PageSettings me={me} host="pipeline" /></>}
      />

      {/* The board is assembled from four collections and is not a table, so nothing else here would admit a
          short read. `all: true` narrows the window rather than closing it, so the notice is its complement. */}
      <TruncationNotice collection={["applications", "candidates", "job-requisitions", "offers"]} what="applications" className="mb-3" />

      {onJob.length > 0 && (
        <SummaryStrip
          items={[
            { label: "In pipeline", value: onJob.filter((a) => a.status === "active").length, icon: Users, tone: "primary", hint: "still in play", ...kf.kpi("active") },
            ...(onJob.some(isStalled)
              ? [{ label: `Stalled over ${STALL_DAYS}d`, value: onJob.filter(isStalled).length, icon: Hourglass, tone: "warning" as const, hint: "no movement since", ...kf.kpi("stalled") }]
              : []),
            { label: "Hired", value: onJob.filter((a) => a.status === "hired").length, icon: UserCheck, tone: "success", hint: "offer accepted", ...kf.kpi("hired") },
            { label: "Closed", value: onJob.filter((a) => a.status === "rejected" || a.status === "withdrawn").length, icon: Archive, tone: "muted", hint: "rejected or withdrew", ...kf.kpi("closed") },
          ]}
        />
      )}

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Job</span>
        <Select value={reqFilter} onValueChange={setReqFilter}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {reqs.map((r) => <SelectItem key={r.path} value={idOf(r.path)}>{r.title}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {stageFocus && (
          <ChartFilterNote
            label={allColumns.find((c) => c.key === stageFocus)?.label ?? stageFocus}
            shown={byColumn.get(stageFocus)?.length ?? 0}
            total={visible.length}
            onClear={() => setQueryParam("stage", null)}
          />
        )}
        {visible.length === 0 ? (
          kf.activeLabel ? (
            <EmptyState icon={KanbanSquare} title={`No ${kf.activeLabel}`} description="Nothing on the board matches that metric right now." action={<Button variant="outline" onClick={kf.clear}>Show the whole board</Button>} />
          ) : apps.length > 0 ? (
            <EmptyState icon={KanbanSquare} title="No applications on this job" description="Pick another job above, or add an application to this one." action={newBtn} />
          ) : (
            <EmptyState icon={KanbanSquare} title="No applications yet" description="Apply a candidate to an open job to start moving them through the pipeline." action={newBtn} />
          )
        ) : (
          // Snap per column on a phone, free scroll from `sm` up - same treatment as the task boards.
          <div className="scroll-shadow-x flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:snap-none">
            {columns.map((col) => {
              const items = byColumn.get(col.key) ?? [];
              return (
                <div
                  key={col.key}
                  // A named group, like the task board's columns: the stage a card sits in is the single most
                  // important thing about it, and a column of unnamed divs says nothing to a reader who
                  // cannot see the header above them.
                  role="group"
                  aria-label={col.label}
                  // From `2xl` the stages share the row (18rem basis, no maximum), as on the task board: a
                  // pipeline whose stages fit fills the width, and its cards reflow onto fewer rows (`pipe-card`).
                  className={cn(
                    "flex w-[86vw] max-w-[20rem] shrink-0 snap-start flex-col rounded-lg border bg-muted/20 transition-colors sm:w-72 sm:max-w-none 2xl:grow 2xl:basis-72",
                    overCol === col.key && "border-primary bg-primary/5",
                  )}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverCol(col.key); }}
                  onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                  onDrop={(e) => { e.preventDefault(); onDropInColumn(col.key); }}
                >
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-sm font-medium">{col.label}</span>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {items.map((a) => {
                      const can = a.access?.can ?? [];
                      const closed = a.status === "rejected" || a.status === "withdrawn";
                      const hired = col.kind === "hired";
                      // Time-in-stage is the "is this candidate going stale" signal recruiters scan for.
                      const since = a.stage_changed_time ?? a.applied_time;
                      const days = !closed && !hired && since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : null;
                      const picked = selected.has(a.path);
                      const advanceLabel = nextStageLabel(a.stage) ? `Advance to ${nextStageLabel(a.stage)}` : "Advance";
                      // The hired column's single action: open this hire's onboarding, converting them first
                      // if the board is the only place the hire ever happened.
                      const onboardBtn = (
                        <Button size="sm" variant="outline" className="h-7 min-w-0 gap-1 px-2" loading={hiring === a.path} onClick={() => openOnboarding(a)} title={a.hired_employee ? "Open this hire's onboarding" : "Create their employee record and start onboarding"}>
                          <UserPlus className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{a.hired_employee ? "Onboarding" : "Start onboarding"}</span>
                        </Button>
                      );
                      return (
                        <div
                          key={a.path}
                          // Draggable by the whole card, as on the task board: a card that only moves by a
                          // handle is a card people go on moving with the button instead.
                          draggable={!closed}
                          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", a.path); dragPath.current = a.path; }}
                          onDragEnd={() => { dragPath.current = null; setOverCol(null); }}
                          // `pipe-card`: a size container, so the card reflows by its OWN width (index.css). In an
                          // 18rem column - every column at 1440px or narrower - it is the four-row stack below. In a
                          // column grown past ~21.5rem (from `2xl`; 19rem of the card's content), the name and job share a
                          // line and the badges and actions share the next.
                          className={cn(
                            "pipe-card group rounded-md border bg-background p-2.5 shadow-sm transition-colors",
                            !closed && "cursor-grab active:cursor-grabbing",
                            picked && "border-primary ring-1 ring-primary",
                          )}
                        >
                          <div className="pipe-card-head">
                            <div className="pipe-card-name flex items-baseline justify-between gap-2">
                              <div className="pipe-card-who flex min-w-0 items-center gap-1.5">
                                {/* Selection is opt-in and quiet: the box appears on hover, or stays put once
                                    something is picked, so an ordinary board isn't a wall of checkboxes. */}
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() => toggleSelected(a)}
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label={`Select ${candName(a.candidate)}`}
                                  className={cn("h-3.5 w-3.5 shrink-0 accent-primary", !picked && selected.size === 0 && "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100")}
                                />
                                {/* The name truncates in a 288px column, so the title carries it in full. */}
                                <button type="button" className="truncate text-sm font-medium hover:underline" onClick={() => openDetail(a)} title={`${candName(a.candidate)} - open this application`}>
                                  {candName(a.candidate)}
                                </button>
                              </div>
                              {days != null && days >= 1 && (
                                <span className={`pipe-card-days shrink-0 text-[11px] tabular-nums ${days > 14 ? "font-medium text-warning dark:text-warning" : "text-muted-foreground"}`} title={`In this stage since ${new Date(since!).toLocaleDateString()}`}>{days}d</span>
                              )}
                            </div>
                            <div className="pipe-card-job pl-5 text-xs text-muted-foreground">{reqTitle(a.requisition)}</div>
                          </div>
                          <div className="pipe-card-foot">
                            <div className="pipe-card-badges mt-1 flex flex-wrap items-center gap-1 pl-5">
                              {a.source && <Badge variant="outline" className="text-[10px]">{sourceLabel(a.source)}</Badge>}
                              {/* The offer the stage rule drafted (or a person wrote), on the card: the work the
                                  pipeline did for you is visible where it happened, not only in the drawer. */}
                              {(() => {
                                const o = liveOffer(a);
                                if (!o) return null;
                                const m = OFFER_STATUS_META[o.status] ?? { label: o.status, variant: "secondary" as const };
                                return (
                                  <button
                                    type="button"
                                    onClick={() => navigate(`offers/${idOf(o.path)}`)}
                                    // No figure in the tooltip: `maskAttributes` is empty (instrument.ts), so a
                                    // title attribute is recorded verbatim in session replay.
                                    title={`Offer ${m.label.toLowerCase()} - open it`}
                                    className="rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    <Badge variant={m.variant} className="text-[10px] hover:opacity-80">Offer · {m.label}</Badge>
                                  </button>
                                );
                              })()}
                              {a.status === "withdrawn" && <Badge variant="secondary" className="text-[10px]">Withdrawn</Badge>}
                              {closed && a.rejection_reason && <span className="text-[11px] text-destructive">{a.rejection_reason}</span>}
                            </div>
                            {!closed && (
                              // The action row is buttons, not text, so it starts at the card edge: the
                              // name's checkbox indent only ever squeezed a long "Advance to …" label out
                              // of a 288px column.
                              <div className="pipe-card-actions mt-2 flex items-center gap-1">
                                {hired ? (
                                  // Already converted, so this is only navigation and needs no gate; the
                                  // un-converted case below is a real write, so it wears the access affordance.
                                  a.hired_employee ? onboardBtn : (
                                    <AccessAction verb="hire" collection="applications" objectPath={a.path} can={can} label="Hire and onboard">{onboardBtn}</AccessAction>
                                  )
                                ) : (
                                  <>
                                    {can.includes("advance") && (
                                      <AccessAction verb="advance" collection="applications" objectPath={a.path} can={can} label="Advance application">
                                        <Button size="sm" variant="outline" className="h-7 min-w-0 gap-1 px-2" loading={advancing === a.path} onClick={() => advance(a)} title={advanceLabel}>
                                          <span className="truncate">{advanceLabel}</span>
                                          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                        </Button>
                                      </AccessAction>
                                    )}
                                    {can.includes("reject") && <AccessAction verb="reject" collection="applications" objectPath={a.path} can={can} label="Reject application"><Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 px-2 text-destructive" onClick={() => setRejecting([a])}><X className="h-3.5 w-3.5" /> Reject</Button></AccessAction>}
                                  </>
                                )}
                                <GripVertical className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && (
                      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                        {overCol === col.key ? (col.key === CLOSED ? "Drop to reject" : `Drop to move to ${col.label}`) : "Empty"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DataState>

      {/* One bar for the whole selection: the alternative is nine dialogs and a half-tidied board. */}
      {selected.size > 0 && (
        // Docked above the phone's home indicator; 16px from the viewport edge from `md` up, where there is none.
        <div className="sticky bottom-[calc(1.75rem+env(safe-area-inset-bottom))] z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-full border bg-background/95 px-3 py-2 shadow-lg backdrop-blur md:bottom-4">
          <span className="px-1 text-sm font-medium tabular-nums">{selected.size} selected</span>
          <Select value="" onValueChange={(v) => void bulkMove(v)}>
            <SelectTrigger className="h-8 w-40" disabled={bulkBusy}><SelectValue placeholder="Move to stage…" /></SelectTrigger>
            <SelectContent>{cfg.stages.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          <AccessAction verb="reject" collection="applications" label="Reject applications">
            <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={bulkBusy} onClick={() => setRejecting(selectedApps.filter((a) => a.status === "active"))}>
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </AccessAction>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {dialog && (
        <ApplicationDialog
          candidates={candidates}
          loading={{ candidates: candidatesState === "loading", reqs: reqsState === "loading" }}
          apps={apps}
          reqs={openReqs}
          stages={cfg.stages}
          sources={cfg.sources}
          // Adding an application while the board is filtered to one job means that job, every time - unless
          // that job is closed, in which case there is nothing to pre-fill with.
          defaultReq={openReqs.some((r) => idOf(r.path) === reqFilter) ? reqFilter : ""}
          onClose={() => setDialog(false)}
          onSaved={() => { setDialog(false); reload(); }}
        />
      )}
      {rejecting && rejecting.length > 0 && (
        <RejectDialog
          apps={rejecting}
          reasons={cfg.rejection_reasons}
          candName={candName}
          jobTitle={reqTitle}
          stageLabel={(stage) => cfg.stages.find((s) => s.key === stage)?.label ?? stage}
          onClose={() => setRejecting(null)}
          onDone={() => { setRejecting(null); setSelected(new Set()); reload(); }}
        />
      )}
      {detail && (
        <ApplicationDrawer
          app={detail}
          me={me}
          candidate={candidates.find((c) => detail.candidate && idOf(c.path) === idOf(detail.candidate)) ?? null}
          req={reqs.find((r) => detail.requisition && idOf(r.path) === idOf(detail.requisition)) ?? null}
          stages={cfg.stages}
          criteria={cfg.scorecard_criteria}
          // The queue is the board as drawn: "next" means the next card on screen, not the next row in some
          // other ordering.
          siblings={visible}
          onOpen={openDetail}
          onClose={closeDetail}
          onReject={(a) => setRejecting([a])}
          onOnboard={openOnboarding}
          onMoveStage={moveToStage}
          onChanged={reload}
        />
      )}
    </div>
    </AccessScope>
  );
}


function ApplicationDialog({ candidates, loading, apps, reqs, stages, sources, defaultReq, onClose, onSaved }: {
  candidates: Candidate[];
  /** Which picker's list is still arriving - an empty picker then says so, rather than "add some first". */
  loading: { candidates: boolean; reqs: boolean };
  apps: Application[];
  reqs: JobRequisition[];
  stages: { key: string; label: string }[];
  sources: string[];
  defaultReq: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    candidate: "",
    req: defaultReq,
    stage: stages[0]?.key ?? "applied",
    source: "",
    applied: todayStr(),
  });
  const canSubmit = !!form.candidate && !!form.req;

  const chosenCand = candidates.find((c) => idOf(c.path) === form.candidate);
  const chosenReq = reqs.find((r) => idOf(r.path) === form.req);

  // Everyone stays pickable. Hiding the candidates who already have a live application on the job (what this
  // used to do) answers "where did they go?" with silence; the warning below says it instead.
  const options = useMemo(() => candidates.map((c) => ({ value: idOf(c.path), label: c.name })), [candidates]);

  // Their history on THIS job: a live application is a duplicate, a closed one is a re-application worth
  // knowing about ("we said no in June").
  const history = useMemo(() => {
    if (!form.candidate || !form.req) return { live: null as Application | null, closed: null as Application | null };
    const theirs = apps.filter((a) => a.candidate && idOf(a.candidate) === form.candidate && a.requisition && idOf(a.requisition) === form.req);
    return {
      live: theirs.find((a) => a.status === "active" || a.status === "hired") ?? null,
      closed: theirs.find((a) => a.status === "rejected" || a.status === "withdrawn") ?? null,
    };
  }, [apps, form.candidate, form.req]);

  // Seats and traffic per job, so the picker is a decision and not a list of titles.
  const jobMeta = useMemo(() => {
    const hired = new Map<string, number>();
    const live = new Map<string, number>();
    for (const a of apps) {
      if (!a.requisition) continue;
      const key = idOf(a.requisition);
      if (a.status === "hired") hired.set(key, (hired.get(key) ?? 0) + 1);
      if (a.status === "active") live.set(key, (live.get(key) ?? 0) + 1);
    }
    return (r: JobRequisition) => ({ hired: hired.get(idOf(r.path)) ?? 0, live: live.get(idOf(r.path)) ?? 0, openings: r.openings ?? 1 });
  }, [apps]);
  const jobOptions = useMemo(
    () => reqs.map((r) => {
      const m = jobMeta(r);
      const bits = [r.status === "open" ? "" : r.status === "on_hold" ? "on hold" : "draft", `${m.live} in play`, `${m.hired}/${m.openings} filled`].filter(Boolean);
      return { value: idOf(r.path), label: `${r.title} · ${bits.join(" · ")}` };
    }),
    [reqs, jobMeta],
  );
  const meta = chosenReq ? jobMeta(chosenReq) : null;

  // The source the server would infer from the candidate, so the field reads as pre-filled rather than empty.
  const inheritedSource = chosenCand?.source ?? "";
  const consequence = [
    chosenReq ? `${stages.find((s) => s.key === form.stage)?.label ?? form.stage} on ${chosenReq.title}` : "",
    form.applied ? `applied ${formatDate(form.applied)}` : "",
    meta ? `${meta.live} others in play` : "",
  ].filter(Boolean).join(" · ");

  async function submit() {
    await create<Application>("applications", {
      candidate: `candidates/${form.candidate}`,
      requisition: `job-requisitions/${form.req}`,
      stage: form.stage,
      source: form.source,
      ...(form.applied ? { applied_date: form.applied } : {}),
    });
    toast({ title: "Application added", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="New application"
      description="Puts the candidate on the board at the stage you pick. The job's applicant count and the candidate's pipeline both follow from it."
      collection="applications"
      guardLabel="application"
      form={form}
      submitLabel="Add application"
      canSubmit={canSubmit}
      whyNot={[!form.candidate && "Pick the candidate.", !form.req && "Pick the job they're applying to."]}
      onSubmit={submit}
      // Screening a batch means the same job over and over with a different name each time.
      addAnother={() => setForm({ ...form, candidate: "" })}
      footerStart={consequence ? <span className="truncate text-xs text-muted-foreground" title={consequence}>{consequence}</span> : undefined}
    >
      <Field label="Candidate" field="candidate">
        <Combobox
          value={form.candidate}
          onValueChange={(v) => setForm({ ...form, candidate: v })}
          options={options}
          placeholder="Pick a candidate"
          searchPlaceholder="Search the pool…"
          emptyText={loading.candidates ? "Loading candidates…" : "No candidates. Add them on the Candidates page first."}
          autoFocus
        />
      </Field>
      {history.live && (
        <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {chosenCand?.name} is already {history.live.status === "hired" ? "hired on" : "in play on"} this job
          {history.live.stage ? ` (${stages.find((s) => s.key === history.live!.stage)?.label ?? history.live.stage})` : ""}.
          A second application means two cards for one person.
        </p>
      )}
      {!history.live && history.closed && (
        <p className="-mt-1 text-xs text-muted-foreground">
          They applied to this job before and it was closed{history.closed.rejection_reason ? ` (${history.closed.rejection_reason})` : ""}
          {history.closed.update_time ? ` on ${formatDate(history.closed.update_time)}` : ""}. This starts a fresh application.
        </p>
      )}
      <Field label="Job" field="requisition">
        <Combobox
          value={form.req}
          onValueChange={(v) => setForm({ ...form, req: v })}
          options={jobOptions}
          placeholder="Pick a job"
          searchPlaceholder="Search jobs…"
          emptyText={loading.reqs ? "Loading jobs…" : "No jobs to apply to. Open a requisition first."}
        />
      </Field>
      {chosenReq && chosenReq.status !== "open" && (
        <p className="-mt-1 text-xs text-warning dark:text-warning">
          This job is {chosenReq.status === "on_hold" ? "on hold" : "still a draft"}, so it isn't accepting applications yet. The card lands on the board either way.
        </p>
      )}
      {meta && meta.hired >= meta.openings && (
        <p className="-mt-1 text-xs text-warning dark:text-warning">
          Every opening on this job is filled ({meta.hired}/{meta.openings}) - there may be nothing left to hire for.
        </p>
      )}
      <FieldRow>
        <Field label="Starting stage" field="stage" hint="Where they enter the board. Screening skips the applied column.">
          <Select value={form.stage} onValueChange={(v) => setForm({ ...form, stage: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{stages.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Applied on" field="applied_date" hint="Back-date it for an application that arrived by email days ago - time-in-stage counts from here.">
          <Input type="date" value={form.applied} max={todayStr()} onChange={(e) => setForm({ ...form, applied: e.target.value })} />
        </Field>
      </FieldRow>
      <Field
        label="Source (optional)"
        field="source"
        hint={inheritedSource && !form.source
          ? `Left alone, it inherits "${sourceLabel(inheritedSource)}" from the candidate.`
          : "Where this particular application came from, when it differs from the candidate's own source."}
      >
        <Select value={form.source || "none"} onValueChange={(v) => setForm({ ...form, source: v === "none" ? "" : v })}>
          <SelectTrigger><SelectValue placeholder={inheritedSource ? sourceLabel(inheritedSource) : "From the candidate"} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{inheritedSource ? `${sourceLabel(inheritedSource)} (from the candidate)` : "Unknown"}</SelectItem>
            {sources.map((s) => <SelectItem key={s} value={s}>{sourceLabel(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </WriteDialog>
  );
}

function RejectDialog({ apps, reasons, candName, jobTitle, stageLabel, onClose, onDone }: {
  /** One card, or everything picked on the board - the same dialog either way. */
  apps: Application[];
  reasons: string[];
  candName: (ref?: string) => string;
  jobTitle: (ref?: string) => string;
  stageLabel: (stage: string) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  // No pre-picked reason: the reason IS the record of this decision, and a default one is the one that gets
  // filed by accident.
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  // Telling the candidate is a decision, so it is a decision on this form - off by default, and never carrying
  // the internal reason with it.
  const [notify, setNotify] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const other = reason === "Other" || (!!reason && !reasons.includes(reason));
  const canSubmit = !!reason && (!other || !!detail.trim());
  const one = apps.length === 1 ? apps[0]! : null;
  const since = one ? one.stage_changed_time ?? one.applied_time ?? one.create_time : undefined;
  const days = since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000)) : null;

  async function submit() {
    const text = other ? detail.trim() : reason;
    // already confirmed: this dialog IS the confirmation - it exists to collect the reason, and its own
    // destructive button fires the verb.
    const result = await runSequential(
      apps,
      (a) => candName(a.candidate),
      (a) => invoke(`applications/${idOf(a.path)}`, "reject", undefined, { reason: text, notify_candidate: notify }),
      (p) => setProgress({ done: p.done, total: p.total }),
    );
    if (result.failures.length) {
      // Half a batch really did go through: say how far it got rather than throwing the whole thing away.
      throw new Error(`${batchSummary(result, "rejection")} ${result.failures.map((f) => `${f.label}: ${f.message}`).join("; ")}`);
    }
    toast({ title: one ? `${candName(one.candidate)} rejected` : batchSummary(result, "rejection"), description: "Moved to Closed on the board." });
    onDone();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={one ? `Reject ${candName(one.candidate)}` : `Reject ${apps.length} candidates`}
      description={one
        ? "The card moves to Closed with this reason on it. Nothing is sent to the candidate - and you can put them back by moving them to a stage later."
        : "One reason, filed on every card. They all move to Closed; nothing is sent to the candidates."}
      collection="applications"
      objectPath={one?.path}
      guardLabel="rejection"
      form={{ reason, detail, notify }}
      submitLabel={one ? "Reject" : `Reject ${apps.length}`}
      canSubmit={canSubmit}
      whyNot={[!reason && "Pick a reason - it's the record of this decision.", other && !detail.trim() && "Say what the reason was."]}
      onSubmit={submit}
      footerStart={progress && progress.total > 1 ? <span className="text-xs tabular-nums text-muted-foreground">{progress.done}/{progress.total} done</span> : undefined}
    >
      {one ? (
        <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {[jobTitle(one.requisition), stageLabel(one.stage), days != null ? `${days}d in this stage` : ""].filter(Boolean).join(" · ")}
        </p>
      ) : (
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {apps.map((a) => (
            <div key={a.path} className="truncate" title={`${candName(a.candidate)} · ${jobTitle(a.requisition)} · ${stageLabel(a.stage)}`}><span className="font-medium text-foreground">{candName(a.candidate)}</span> · {jobTitle(a.requisition)} · {stageLabel(a.stage)}</div>
          ))}
        </div>
      )}
      <Field label="Reason">
        <Select value={reason} onValueChange={setReason}>
          <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
          <SelectContent>{reasons.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      {other && (
        <Field label="What was it?" hint="This is what shows on the closed card, so write it for whoever reads it in six months.">
          <Textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} autoFocus />
        </Field>
      )}
      <label className="flex items-start gap-2 rounded-lg border p-3">
        <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} className="mt-0.5" />
        <span>
          <span className="text-sm font-medium">Send {one ? "them" : "each of them"} a note</span>
          <span className="block text-xs text-muted-foreground">
            {notify
              ? "A short, reason-free thank-you goes to whoever has an email on file. The reason above stays internal - it is a record for the hiring team, not a message to a person."
              : "Nothing is sent. Candidates who are never told are the ones who chase, and the ones who tell other candidates."}
          </span>
        </span>
      </label>
    </WriteDialog>
  );
}

// ── The application drawer ──────────────────────────────────────────────────────────────────────────────────
//
// A pipeline card used to be four words on a tile, and everything about the person lived somewhere else: the
// resume on Candidates, the rounds and their verdicts on Interviews, the money on Offers. Triaging ten people
// meant forty page loads. This is the one place that holds an application: where it stands, who has met them
// and what they said, what has been offered, and the two actions that move it. Everything below the header is
// fetched when the drawer opens (never with the board), and `j`/`k` walk the column without closing it.
function ApplicationDrawer({ app, me, candidate, req, stages, criteria, siblings, onOpen, onClose, onReject, onOnboard, onMoveStage, onChanged }: {
  app: Application;
  me: Me;
  candidate: Candidate | null;
  req: JobRequisition | null;
  stages: { key: string; label: string; kind?: string }[];
  criteria: { key: string; label: string }[];
  siblings: Application[];
  onOpen: (a: Application) => void;
  onClose: () => void;
  onReject: (a: Application) => void;
  onOnboard: (a: Application) => void;
  onMoveStage: (a: Application, stage: string) => Promise<void>;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const [rounds, setRounds] = useState<Interview[] | null>(null);
  const [feedback, setFeedback] = useState<InterviewFeedback[]>([]);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);

  // Two reads on open, coalesced into one batch by the API client; the scorecards follow once the rounds are
  // known (again one batch, whatever the number of rounds).
  useEffect(() => {
    let live = true;
    setRounds(null);
    setOffers(null);
    setFeedback([]);
    const id = idOf(app.path);
    void Promise.all([
      get<ListResponse<Interview>>(`interviews?application=applications/${id}&max_page_size=100`).catch(() => ({ results: [] as Interview[] })),
      get<ListResponse<Offer>>(`offers?application=applications/${id}&max_page_size=50`).catch(() => ({ results: [] as Offer[] })),
    ]).then(async ([iv, of]) => {
      if (!live) return;
      const list = iv.results ?? [];
      setRounds(list);
      setOffers(of.results ?? []);
      const cards = await Promise.all(
        list.map((i) => get<ListResponse<InterviewFeedback>>(`interview-feedback?interview=interviews/${idOf(i.path)}&max_page_size=50`).catch(() => ({ results: [] as InterviewFeedback[] }))),
      );
      if (live) setFeedback(cards.flatMap((r) => r.results ?? []));
    });
    return () => { live = false; };
  }, [app.path]);

  // Walking the queue: the board as drawn, so "next" is the next card on screen.
  const qIndex = siblings.findIndex((s) => s.path === app.path);
  const canStep = (delta: number) => qIndex >= 0 && !!siblings[qIndex + delta];
  const step = (delta: number) => { const next = siblings[qIndex + delta]; if (next) onOpen(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-bound each render on purpose: the handler closes over the queue position.
  });

  const can = app.access?.can ?? [];
  const closed = app.status === "rejected" || app.status === "withdrawn";
  const stageIdx = stages.findIndex((s) => s.key === app.stage);
  const nextStage = stageIdx >= 0 ? stages[stageIdx + 1] : undefined;
  const since = app.stage_changed_time ?? app.applied_time ?? app.create_time;
  const days = since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000)) : null;

  // The panel's verdict across every round: the number the offer decision is actually made on.
  const verdicts = feedback.filter((f) => f.recommendation);
  const yes = verdicts.filter((f) => f.recommendation === "yes" || f.recommendation === "strong_yes").length;
  const no = verdicts.length - yes;
  const rated = feedback.filter((f) => f.overall_rating != null);
  const avg = rated.length ? rated.reduce((s, f) => s + (f.overall_rating ?? 0), 0) / rated.length : null;

  function copyLink() {
    navigator.clipboard.writeText(recordUrl("pipeline", idOf(app.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this application can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  async function advanceHere() {
    if (!(await confirmDecision(confirm, "advance", candidate?.name ?? "this candidate"))) return;
    setBusy("advance");
    try { await invoke(`applications/${idOf(app.path)}`, "advance"); onChanged(); }
    catch (e) { toast({ title: "Couldn't advance", description: describeError(e), variant: "destructive" }); }
    finally { setBusy(null); }
  }

  // Cross-page hand-offs: land on the page that owns the record with its form already open and this
  // application pre-picked, rather than making the reader find it in a combobox again.
  function scheduleInterview() { onClose(); navigate("interviews"); fireIntent("new-interview", idOf(app.path)); }
  function makeOffer() { onClose(); navigate("offers"); fireIntent("new-offer", idOf(app.path)); }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent scrollBody className="max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <span className="truncate" title={candidate?.name ?? undefined}>{candidate?.name ?? "Candidate"}</span>
            <button type="button" onClick={copyLink} title="Copy a link to this application" aria-label="Copy a link to this application" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
              <Link2 className="h-3.5 w-3.5" />
            </button>
            {siblings.length > 1 && qIndex >= 0 && (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous application" title="Previous application (k)"><ChevronLeft className="h-4 w-4" /></Button>
                <span className="tabular-nums">{qIndex + 1}/{siblings.length}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next application" title="Next application (j)"><ChevronRight className="h-4 w-4" /></Button>
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {[req?.title, stages[stageIdx]?.label ?? app.stage, days != null ? `${days}d in this stage` : "", app.source ? sourceLabel(app.source) : ""].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {/* The two decisions, where the reader is looking. */}
          <div className="flex flex-wrap items-center gap-2">
            {closed ? (
              <Badge variant="secondary">{app.status === "withdrawn" ? "Withdrawn" : "Rejected"}{app.rejection_reason ? ` · ${app.rejection_reason}` : ""}</Badge>
            ) : app.status === "hired" ? (
              <>
                <Badge variant="success">Hired</Badge>
                {/* Same single hand-off as the hired card, gated the same way: once converted this is only
                    navigation, and before that it is the `hire` write. */}
                {app.hired_employee ? (
                  <Button size="sm" variant="outline" onClick={() => { onClose(); onOnboard(app); }}>
                    <UserPlus className="h-3.5 w-3.5" /> Onboarding
                  </Button>
                ) : (
                  <AccessAction verb="hire" collection="applications" objectPath={app.path} can={can} label="Hire and onboard">
                    <Button size="sm" variant="outline" onClick={() => { onClose(); onOnboard(app); }}>
                      <UserPlus className="h-3.5 w-3.5" /> Start onboarding
                    </Button>
                  </AccessAction>
                )}
              </>
            ) : (
              <>
                {can.includes("advance") && (
                  <AccessAction verb="advance" collection="applications" objectPath={app.path} can={can} label="Advance application">
                    <Button size="sm" loading={busy === "advance"} onClick={advanceHere}>
                      {nextStage ? `Advance to ${nextStage.label}` : "Advance"} <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </AccessAction>
                )}
                <Select value={app.stage} onValueChange={(v) => void onMoveStage(app, v)}>
                  <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>{stages.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
                {can.includes("reject") && (
                  <AccessAction verb="reject" collection="applications" objectPath={app.path} can={can} label="Reject application">
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onReject(app)}><X className="h-3.5 w-3.5" /> Reject</Button>
                  </AccessAction>
                )}
              </>
            )}
          </div>

          {/* Who they are, without a trip to the profile page. */}
          <div className="mt-4 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{candidate?.name}</span>
              {candidate?.email && <span className="text-muted-foreground">{candidate.email}</span>}
              {candidate?.phone && <span className="text-muted-foreground">{candidate.phone}</span>}
              <span className="ml-auto flex items-center gap-1">
                {candidate?.has_resume && (
                  <AccessAction verb="download" objectPath={candidate.path} can={candidate.access?.can} label="Download resume">
                    <Button size="sm" variant="outline" className="h-7" onClick={() => download(`candidates/${idOf(candidate.path)}`, `resume-${candidate.name}`)}>
                      <Download className="h-3.5 w-3.5" /> Resume
                    </Button>
                  </AccessAction>
                )}
                {candidate && <Button size="sm" variant="ghost" className="h-7" onClick={() => { onClose(); navigate(`candidates/${idOf(candidate.path)}`); }}>Full profile</Button>}
              </span>
            </div>
            {(candidate?.tags || candidate?.notes) && (
              <div className="mt-2 space-y-1">
                {candidate.tags && <div className="flex flex-wrap gap-1">{candidate.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}</div>}
                {candidate.notes && <p className="text-xs text-muted-foreground">{candidate.notes}</p>}
              </div>
            )}
          </div>

          {/* Rounds and what each panelist said - the reason this drawer exists. */}
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Interviews {verdicts.length > 0 && <span className="font-normal normal-case tracking-normal">· {yes} yes · {no} no{avg != null ? ` · avg ${avg.toFixed(1)}/5` : ""}</span>}
              </p>
              {!closed && <Button size="sm" variant="outline" className="h-7" onClick={scheduleInterview}><CalendarClock className="h-3.5 w-3.5" /> Schedule</Button>}
            </div>
            {rounds === null ? (
              <LinesSkeleton rows={2} className="mt-2" />
            ) : rounds.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No interviews yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {rounds.map((i) => {
                  const cards = feedback.filter((f) => f.interview && idOf(f.interview) === idOf(i.path));
                  const owed = (i.interviewers ?? []).filter((ref) => !cards.some((f) => f.author && idOf(f.author) === idOf(ref)));
                  return (
                    <div key={i.path} className="rounded-lg border p-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <button type="button" className="font-medium hover:underline" onClick={() => { onClose(); navigate(`interviews/${idOf(i.path)}`); }}>{i.title}</button>
                        <span className="text-xs text-muted-foreground">
                          {[i.scheduled_start_time ? formatDateTime(i.scheduled_start_time) : "not scheduled", i.mode, i.location].filter(Boolean).join(" · ")}
                        </span>
                        <Badge variant={i.status === "done" ? "success" : i.status === "cancelled" ? "destructive" : "secondary"} className="ml-auto text-[10px]">{i.status}</Badge>
                      </div>
                      {cards.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          {cards.map((f) => (
                            <div key={f.path} className="text-xs">
                              <span className="font-medium">{empName(f.author)}</span>
                              {f.recommendation && <Badge variant={REC_VARIANT[f.recommendation] ?? "secondary"} className="ml-1.5 text-[10px]">{REC_LABEL[f.recommendation] ?? f.recommendation}</Badge>}
                              {f.overall_rating != null && <span className="ml-1.5 text-muted-foreground">{f.overall_rating}/5</span>}
                              {criteria.length > 0 && f.ratings && (
                                <span className="ml-1.5 text-muted-foreground">
                                  {criteria.filter((c) => f.ratings?.[c.key] != null).map((c) => `${c.label} ${f.ratings![c.key]}`).join(" · ")}
                                </span>
                              )}
                              {f.comment && <div className="text-muted-foreground">{f.comment}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* A round held with scorecards still owed is the commonest reason a decision stalls. */}
                      {i.status === "done" && owed.length > 0 && (
                        <p className="mt-1.5 flex items-center gap-1 text-xs text-warning dark:text-warning">
                          <ClipboardList className="h-3.5 w-3.5" />
                          Waiting on {owed.map((ref) => empName(ref)).join(", ")}
                          {me.employee_id && owed.some((ref) => idOf(ref) === me.employee_id) && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { onClose(); navigate(`interviews/${idOf(i.path)}`); }}>File yours</Button>
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* The money, and the one action that starts it. */}
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Offer</p>
              {!closed && app.status !== "hired" && (offers?.length ?? 0) === 0 && (
                // Drafting one is a create on `offers`, not an action on the application - hence its own gate.
                <AccessAction collection="offers" create label="Make an offer">
                  <Button size="sm" variant="outline" className="h-7" onClick={makeOffer}><FileSignature className="h-3.5 w-3.5" /> Make an offer</Button>
                </AccessAction>
              )}
            </div>
            {offers === null ? (
              <LinesSkeleton rows={2} className="mt-2" />
            ) : offers.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Nothing offered yet.</p>
            ) : (
              <div className="mt-2 space-y-1">
                {offers.map((o) => (
                  <button key={o.path} type="button" onClick={() => { onClose(); navigate(`offers/${idOf(o.path)}`); }} className="flex w-full flex-wrap items-baseline gap-2 rounded-lg border p-2.5 text-left text-sm hover:bg-accent">
                    <Badge variant={o.status === "accepted" ? "success" : o.status === "declined" || o.status === "rescinded" ? "destructive" : "secondary"}>{o.status}</Badge>
                    {/* Masked in replay like every other rendering of an offered figure (instrument.ts). */}
                    {o.base_comp != null && <span data-sentry-mask className="tabular-nums">{o.base_comp.toLocaleString()} {o.currency_code}</span>}
                    {o.join_time && <span className="text-xs text-muted-foreground">joins {formatDate(o.join_time)}</span>}
                    {o.expiry_time && <span className="text-xs text-muted-foreground">expires {formatDate(o.expiry_time)}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ActivitySection resource={app.path} className="mt-4 border-t pt-3" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
