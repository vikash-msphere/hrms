import { Fragment, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, ChevronRight, Check, SkipForward, UserPlus, MessageSquareQuote, CircleAlert, Hourglass, CheckCircle2, AlarmClock, ChevronsDownUp, ChevronsUpDown, BellRing, FileDown } from "lucide-react";
import { get, invoke } from "@/api";
import { useRoute, setQueryParams } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { useHasPrintVersion } from "@/lib/letterheads";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Goal, Review, ReviewCycle, ReviewState, ReviewFeedback, Me, Card as KanbanCard } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { ActivitySection } from "@/components/common/ActivitySection";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/common/confirm";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

// The review stage machine, in order. Every card renders it as a trail so "where is this review and
// who moves it next" reads at a glance.
const STAGES: { key: ReviewState; label: string }[] = [
  { key: "SELF", label: "Self" },
  { key: "MANAGER", label: "Manager" },
  { key: "SHARED", label: "Shared" },
  { key: "ACKNOWLEDGED", label: "Acknowledged" },
];

const todayStr = () => new Date().toISOString().slice(0, 10);

// Compact stepper: done stages get a check, the current one is highlighted, the rest stay muted.
function StageTrail({ state }: { state: ReviewState }) {
  const idx = STAGES.findIndex((s) => s.key === state);
  const complete = state === "ACKNOWLEDGED";
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label={`Stage: ${STAGES[idx]?.label}`}>
      {STAGES.map((s, i) => {
        const done = i < idx || (complete && i === idx);
        const current = !complete && i === idx;
        return (
          <Fragment key={s.key}>
            {i > 0 && <span className={cn("h-px w-2.5", i <= idx ? "bg-primary" : "bg-border")} />}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                done && "bg-success/10 text-success",
                current && "bg-primary text-primary-foreground",
                !done && !current && "text-muted-foreground",
              )}
            >
              {done && <Check className="h-3 w-3" />} {s.label}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export default function Reviews({ me }: { me: Me }) {
  const { rows: reviews, state, error, reload } = useCollection<Review>("reviews");
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { rows: feedbackReqs, reload: reloadFb } = useCollection<ReviewFeedback>("review-feedback");
  // `cards` and `goals` are read-only EVIDENCE inside an expanded review (what this person delivered, which
  // goals fell in the cycle). A folded list of review headers shows none of it, so both are read further down,
  // gated on a card actually being open.
  const { toast } = useToast();
  const confirm = useConfirm();
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  const reloadAll = () => { reload(); reloadFb(); };

  useEffect(() => {
    getSetting<Partial<PerformanceFramework>>("performance")
      .then((cfg) => { if (cfg.value?.competencies?.length && cfg.value.scale?.length) setFramework({ ...DEFAULT_PERFORMANCE, ...cfg.value }); })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  const cycleOf = useMemo(() => {
    const m = new Map(cycles.map((c) => [idOf(c.path), c]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [cycles]);
  // Declared before `needsMe`, which calls it during the first render pass (stage ownership needs the
  // reviewee's manager) - a lower declaration would be a temporal-dead-zone crash, not a lint nit.
  const empOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [employees]);
  const mine = (r: Review) => !!r.employee && idOf(r.employee) === me.employee_id;

  // A review the caller OWNS THE CURRENT STAGE OF reads as "needs you". Holding the verb is not the same
  // thing: a super admin (and anyone granted submitManager broadly) can act on every review in the org, and
  // keying off `can` alone put a "Needs you" badge on all of them. The manager stage belongs to the
  // reviewee's manager; everyone else with the verb is an unblocker, and gets Nudge/Skip instead.
  const needsMe = (r: Review) => {
    const can = r.access?.can ?? [];
    const managerOfReviewee = () => {
      const mgr = empOf(r.employee)?.manager;
      return !!mgr && !!me.employee_id && idOf(mgr) === me.employee_id;
    };
    return (
      (r.state === "SELF" && mine(r) && can.includes("submitSelf")) ||
      (r.state === "MANAGER" && can.includes("submitManager") && managerOfReviewee()) ||
      (r.state === "SHARED" && mine(r) && can.includes("acknowledge"))
    );
  };

  // Reviews awaiting the caller's action first, then mine, then by cycle name.
  const sorted = useMemo(
    () =>
      [...reviews].sort(
        (a, b) =>
          Number(needsMe(b)) - Number(needsMe(a)) ||
          Number(mine(b)) - Number(mine(a)) ||
          (cycleOf(b.cycle)?.name ?? "").localeCompare(cycleOf(a.cycle)?.name ?? ""),
      ),
    [reviews, cycles, employees, me.employee_id],
  );

  const REVIEW_TOAST: Record<string, string> = {
    submitSelf: "Self-assessment submitted",
    submitManager: "Review shared with the employee",
    acknowledge: "Review acknowledged",
    skipStage: "Stage skipped",
    nominate: "Feedback requests sent",
    nudge: "Reminder sent",
  };
  async function act(r: Review, verb: string, body?: Record<string, unknown>) {
    try {
      await invoke(`reviews/${idOf(r.path)}`, verb, undefined, body);
      toast({ title: REVIEW_TOAST[verb] ?? "Review updated", variant: "success" });
      reloadAll();
    } catch (e) {
      toast({ title: "Couldn't update review", description: (e as Error).message, variant: "destructive" });
    }
  }
  async function feedbackAct(f: ReviewFeedback, verb: string, body?: Record<string, unknown>) {
    try {
      await invoke(`review-feedback/${idOf(f.path)}`, verb, undefined, body);
      toast({ title: verb === "decline" ? "Feedback request declined" : "Feedback submitted", variant: "success" });
      reloadAll();
    } catch (e) {
      toast({ title: "Couldn't submit feedback", description: (e as Error).message, variant: "destructive" });
    }
  }

  // 360 feedback requests addressed to the CALLER that still need a response. HR reads every feedback row
  // (review-feedback.** read), so the author check is what keeps other people's nominations out of a
  // section titled "requested from you" - without it HR sees requests it cannot answer.
  const myRequests = useMemo(
    () => feedbackReqs.filter((f) => f.state === "REQUESTED" && !!f.author && idOf(f.author) === me.employee_id),
    [feedbackReqs, me.employee_id],
  );

  // Ranked 360-nominee suggestions for a reviewee: people on the same kanban boards this cycle (they saw the
  // work) ahead of same-department colleagues. Pure client-side ranking over already-loaded collections.
  const suggestFor = (r: Review): string[] => {
    if (!r.employee) return [];
    const emp = empOf(r.employee);
    const eid = idOf(r.employee);
    const boards = new Set(deliveredFor(r.employee, cycleOf(r.cycle)).map((c) => (c.board ? idOf(c.board) : "")).filter(Boolean));
    const score = new Map<string, number>();
    for (const c of cards) {
      if (!c.employee || !c.board || !boards.has(idOf(c.board))) continue;
      const oid = idOf(c.employee);
      if (oid !== eid) score.set(oid, (score.get(oid) ?? 0) + 2);
    }
    if (emp?.department) {
      for (const e of employees) {
        const oid = idOf(e.path);
        if (oid !== eid && e.department && idOf(e.department) === idOf(emp.department)) score.set(oid, (score.get(oid) ?? 0) + 1);
      }
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => `employees/${id}`);
  };

  // List filters: a status chip row plus (when reviews span several cycles) a cycle menu. Managers/HR
  // accumulate reviews fast; everyone else just sees the chips echo the summary strip. Both filters live
  // in the hash query (?filter=&cycle=) so a filtered view survives reload and can be shared.
  type Filter = "all" | "needs" | "open" | "done" | "overdue";
  const route = useRoute();
  const isFilter = (v?: string): v is Filter => v === "needs" || v === "open" || v === "done" || v === "overdue";
  const [filter, setFilter] = useState<Filter>(() => (isFilter(route.query.filter) ? route.query.filter : "all"));
  const [cycleFilter, setCycleFilter] = useState(() => route.query.cycle ?? "all");
  const applyFilter = (f: Filter) => { setFilter(f); setQueryParams({ filter: f === "all" ? null : f }); };
  const applyCycle = (id: string) => { setCycleFilter(id); setQueryParams({ cycle: id === "all" ? null : id }); };
  // The three buckets PARTITION the list (needs you / waiting on someone else / done) so the chip counts add
  // up to "All". An "in progress" bucket that also counted the needs-you rows made the numbers unreadable.
  // Every count is taken over the CYCLE-FILTERED set, the same rows the list renders - counting org-wide
  // while showing one cycle made the chips contradict what was on screen.
  const inCycle = (r: Review) => cycleFilter === "all" || (!!r.cycle && idOf(r.cycle) === cycleFilter);
  const inScope = reviews.filter(inCycle);
  const waitingOnOthers = (r: Review) => r.state !== "ACKNOWLEDGED" && !needsMe(r);
  // The current stage's deadline (self vs manager due date) comes from the cycle. Overdue is a cross-cut of the
  // three buckets rather than a fourth partition - a review can need you AND be late - and it is what HR
  // chases, so it gets its own chip, metric and card accent.
  const stageDueOf = (r: Review) => {
    const cyc = cycleOf(r.cycle);
    return r.state === "SELF" ? cyc?.self_due_date : r.state === "MANAGER" ? cyc?.manager_due_date : undefined;
  };
  const isOverdue = (r: Review) => { const d = stageDueOf(r); return !!d && d < todayStr(); };
  const counts: Record<Filter, number> = {
    all: inScope.length,
    needs: inScope.filter(needsMe).length,
    open: inScope.filter(waitingOnOthers).length,
    done: inScope.filter((r) => r.state === "ACKNOWLEDGED").length,
    overdue: inScope.filter(isOverdue).length,
  };
  // The cycle's shape: where its reviews are, and where its ratings landed. Both over `inScope` - the same
  // reviews the chips count and the list shows, so a filtered page's numbers agree with its pictures.
  const reviewCharts = useMemo(() => {
    const stages = STAGES.map((s) => ({ label: s.label, n: inScope.filter((r) => r.state === s.key).length })).filter((s) => s.n > 0);
    // A rating scale is ordered: the bars run 1..5 whether or not anybody landed on a 2, because a gap in
    // the middle of a distribution is itself the finding.
    const shared = inScope.filter((r) => (r.state === "SHARED" || r.state === "ACKNOWLEDGED") && r.overall_rating != null);
    const max = Math.max(5, ...shared.map((r) => r.overall_rating ?? 0));
    const scale = Array.from({ length: max }, (_, i) => i + 1);
    return {
      total: inScope.length,
      stages: { labels: stages.map((s) => s.label), values: stages.map((s) => s.n) },
      ratings: { labels: scale.map(String), values: scale.map((n) => shared.filter((r) => r.overall_rating === n).length) },
    };
  }, [inScope]);

  const cycleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of reviews) {
      if (!r.cycle) continue;
      const id = idOf(r.cycle);
      if (!seen.has(id)) seen.set(id, cycleOf(r.cycle)?.name ?? "Cycle");
    }
    return [...seen].sort((a, b) => b[1].localeCompare(a[1]));
  }, [reviews, cycles]);
  const visible = sorted.filter(
    (r) =>
      inCycle(r) &&
      (filter === "all" ||
        (filter === "needs" ? needsMe(r)
          : filter === "done" ? r.state === "ACKNOWLEDGED"
          : filter === "overdue" ? isOverdue(r)
          : waitingOnOthers(r))),
  );

  const filterChip = (f: Filter, label: string) => (
    <button
      key={f}
      type="button"
      onClick={() => applyFilter(f)}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        filter === f ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{counts[f]}</span>
    </button>
  );

  const overdueCount = counts.overdue;

  // Previous-cycle overall rating per employee, so a shared result reads as a trend, not a lone number.
  // Everything needed is already client-side: order that employee's rated reviews by cycle period start.
  const prevRatingFor = useMemo(() => {
    const byEmp = new Map<string, { start: string; rating: number; path: string }[]>();
    for (const r of reviews) {
      if (!r.employee || r.overall_rating == null) continue;
      const start = cycleOf(r.cycle)?.period_start;
      if (!start) continue;
      const eid = idOf(r.employee);
      (byEmp.get(eid) ?? byEmp.set(eid, []).get(eid)!).push({ start, rating: r.overall_rating, path: r.path });
    }
    return (r: Review): number | undefined => {
      if (!r.employee) return undefined;
      const start = cycleOf(r.cycle)?.period_start;
      if (!start) return undefined;
      const prior = (byEmp.get(idOf(r.employee)) ?? []).filter((x) => x.path !== r.path && x.start < start);
      return prior.sort((a, b) => b.start.localeCompare(a.start))[0]?.rating;
    };
  }, [reviews, cycles]);

  // Open/folded state lives up here so expand/collapse-all and ?review= deep links can drive it; a card
  // with no explicit entry falls back to its default (open when it needs the caller).
  // Auto-open is capped: a manager at cycle start owns every MANAGER-stage review on the page, and opening
  // all of them buries the list under identical rating forms. Up to three needs-you cards open; past that
  // only the top one does, and the rest stay scannable headers.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const firstNeedsPath = sorted.find(needsMe)?.path;
  const defaultOpen = (r: Review) =>
    sorted.length === 1 || (needsMe(r) && (counts.needs <= 3 || r.path === firstNeedsPath));
  const isOpen = (r: Review) => openMap[r.path] ?? defaultOpen(r);
  const setAllOpen = (open: boolean) => setOpenMap(Object.fromEntries(visible.map((r) => [r.path, open])));

  // ---- Evidence, read only once a review is actually open ---------------------------------------------------
  // The delivered-work and goals panels live inside an expanded review. Reading two whole collections to fill
  // panels nobody has opened is the page's largest cost by far, so both wait for the first expansion - which,
  // on a page whose default is a folded list of headers, is often never.
  const anyOpen = visible.some(isOpen);
  const { rows: cards } = useCollection<KanbanCard>("cards", { enabled: anyOpen });
  const { rows: goals } = useCollection<Goal>("goals", { enabled: anyOpen });
  // Cards the reviewee delivered within the cycle's window — read-only evidence on the review (kanban -> perf).
  const deliveredFor = useMemo(() => (empRef?: string, cyc?: ReviewCycle): KanbanCard[] => {
    if (!empRef) return [];
    const eid = idOf(empRef);
    const start = cyc?.period_start ? new Date(cyc.period_start).getTime() : -Infinity;
    const end = cyc?.period_end ? new Date(cyc.period_end).getTime() + 86_400_000 : Infinity;
    return cards.filter((c) => {
      if (!c.employee || idOf(c.employee) !== eid || !c.deliver_time) return false;
      const t = new Date(c.deliver_time).getTime();
      return t >= start && t <= end;
    });
  }, [cards]);
  // The reviewee's goals belonging to this cycle's window: due inside it, or completed inside it (perf -> perf).
  const goalsFor = useMemo(() => (empRef?: string, cyc?: ReviewCycle): Goal[] => {
    if (!empRef) return [];
    const eid = idOf(empRef);
    const start = cyc?.period_start ? new Date(cyc.period_start).getTime() : -Infinity;
    const end = cyc?.period_end ? new Date(cyc.period_end).getTime() + 86_400_000 : Infinity;
    const inWindow = (iso?: string | null) => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return t >= start && t <= end;
    };
    return goals.filter(
      (g) => g.employee && idOf(g.employee) === eid && !g.delete_time &&
        (inWindow(g.due_date) || (g.status === "completed" && inWindow(g.update_time))),
    );
  }, [goals]);

  // Deep link: #/reviews/<id> (notification clicks) opens that card and scrolls it into view.
  useEffect(() => {
    if (!route.id) return;
    const target = reviews.find((r) => idOf(r.path) === route.id);
    if (!target) return;
    // The filters persist in the URL, so a notification can deep-link a review the current filter hides -
    // the card would never render and the scroll would land nowhere. Being sent to a review outranks the
    // filter that was left behind.
    if (!visible.some((r) => r.path === target.path)) { applyFilter("all"); applyCycle("all"); }
    setOpenMap((m) => (m[target.path] ? m : { ...m, [target.path]: true }));
    requestAnimationFrame(() => document.getElementById(`review-${route.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [route.id, reviews]);

  // When "All cycles" is showing and reviews span several, section the list by cycle (newest name first,
  // matching the menu); otherwise everything renders as one unlabelled group.
  const grouped = useMemo(() => {
    if (cycleFilter !== "all" || cycleOptions.length < 2) return [{ key: "", name: null as string | null, rows: visible }];
    const byCycle = new Map<string, Review[]>();
    for (const r of visible) {
      const id = r.cycle ? idOf(r.cycle) : "";
      (byCycle.get(id) ?? byCycle.set(id, []).get(id)!).push(r);
    }
    const groups = cycleOptions.filter(([id]) => byCycle.has(id)).map(([id, name]) => ({ key: id, name: name as string | null, rows: byCycle.get(id)! }));
    if (byCycle.has("")) groups.push({ key: "none", name: "No cycle", rows: byCycle.get("")! });
    return groups;
  }, [visible, cycleFilter, cycleOptions]);

  return (
    <div>
      <PageHeader
        accessCollection="reviews"
        title="Reviews"
        // Managers and admins see other people's reviews here too, so the subtitle can't claim the page is
        // only yours - it's the first thing that made the page read wrong for anyone above employee.
        description={reviews.some((r) => !mine(r)) ? "Performance reviews you own or oversee." : "Your performance reviews and self-assessments."}
        actions={<PageSettings me={me} host="reviews" />}
      />

      {/* Two questions a cycle is run to answer, neither of which a list of reviews shows: how far along is
          it, and what did it conclude. The distribution is the honest form for the second - an average
          rating hides whether a team is uniformly fine or split in half. */}
      {reviewCharts.total > 1 && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <ChartCard title="How far the cycle has got" description="Every review you can see, by the stage it is sitting at.">
            <Chart
              type="percentage"
              height={140}
              labels={reviewCharts.stages.labels}
              datasets={[{ name: "Reviews", values: reviewCharts.stages.values }]}
              ariaLabel="Reviews by stage"
            />
          </ChartCard>
          <ChartCard title="Rating distribution" description="Shared and acknowledged reviews only - a rating nobody has seen yet is not a result.">
            <Chart
              type="bar"
              height={180}
              labels={reviewCharts.ratings.labels}
              datasets={[{ name: "Reviews", values: reviewCharts.ratings.values }]}
              format={(v) => `${v} review${v === 1 ? "" : "s"}`}
              ariaLabel="How many shared reviews landed on each overall rating"
              emptyText="No ratings shared yet."
            />
          </ChartCard>
        </div>
      )}

      {myRequests.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><MessageSquareQuote className="h-4 w-4 text-primary" /> Feedback requested from you <Badge variant="secondary">{myRequests.length}</Badge></h2>
          <div className="space-y-3">
            {myRequests.map((f) => (
              <AccessItem key={f.path} collection="review-feedback" objectPath={f.path} can={f.access?.can} label="Feedback request">
              <FeedbackRequestCard
                request={f}
                subjectName={empName(f.reviewee)}
                framework={framework}
                onSubmit={(body) => feedbackAct(f, "submitFeedback", body)}
                onDecline={() => feedbackAct(f, "decline")}
              />
              </AccessItem>
            ))}
          </div>
        </div>
      )}

      {reviews.length > 0 && (
        <SummaryStrip
          items={[
            // Each metric drives the same ?filter= the chips below do, so clicking one narrows the list and the
            // chip row follows along - which is why the strip sits against that list, below the charts.
            { label: "All reviews", value: counts.all, icon: CheckCircle2, tone: "muted", hint: "this cycle", onClick: () => applyFilter("all"), active: filter === "all" },
            { label: "Need you", value: counts.needs, icon: CircleAlert, tone: counts.needs > 0 ? "warning" : "muted", hint: counts.needs ? "your next step" : "nothing on you", onClick: () => applyFilter("needs"), active: filter === "needs" },
            { label: "Waiting on others", value: counts.open, icon: Hourglass, tone: "primary", hint: "not with you", onClick: () => applyFilter("open"), active: filter === "open" },
            { label: "Completed", value: counts.done, icon: CheckCircle2, tone: counts.done > 0 ? "success" : "muted", hint: "closed out", onClick: () => applyFilter("done"), active: filter === "done" },
            ...(overdueCount > 0
              ? [{ label: "Overdue", value: overdueCount, icon: AlarmClock, tone: "destructive" as const, hint: "past the deadline", onClick: () => applyFilter("overdue"), active: filter === "overdue" }]
              : []),
          ]}
        />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {reviews.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {filterChip("all", "All")}
            {filterChip("needs", "Needs you")}
            {filterChip("open", "Waiting on others")}
            {filterChip("done", "Completed")}
            {counts.overdue > 0 && filterChip("overdue", "Overdue")}
            {/* Sits after a run of filter chips in a wrapping row; `ml-auto` only pushes it right on the
                line it lands on, so on a phone it simply follows the chips. */}
            <span className="ml-auto flex items-center gap-1">
              {cycleOptions.length > 1 && (
                <Select value={cycleFilter} onValueChange={applyCycle}>
                  <SelectTrigger className="h-8 w-32 text-xs sm:w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All cycles</SelectItem>
                    {cycleOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Expand all" onClick={() => setAllOpen(true)}><ChevronsUpDown className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Collapse all" onClick={() => setAllOpen(false)}><ChevronsDownUp className="h-4 w-4" /></Button>
            </span>
          </div>
        )}
        {sorted.length === 0 ? (
          myRequests.length === 0 && <EmptyState icon={ClipboardCheck} title="No reviews yet" description="When HR launches a review cycle that includes you, your review will appear here." />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No reviews match"
            description="Nothing matches the current filters."
            action={<Button variant="outline" size="sm" onClick={() => { applyFilter("all"); applyCycle("all"); }}>Clear filters</Button>}
          />
        ) : (
          <div className="space-y-6">
            {grouped.map((g) => (
            <div key={g.key}>
            {g.name && <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{g.name} <span className="tabular-nums opacity-70">({g.rows.length})</span></h2>}
            <div className="space-y-4">
            {g.rows.map((r) => (
              <div key={r.path} id={`review-${idOf(r.path)}`} className="scroll-mt-20">
              <AccessItem collection="reviews" objectPath={r.path} can={r.access?.can} why={r.access?.why} label={`${empName(r.employee)} · ${cycleOf(r.cycle)?.name ?? "review"}`}>
              <ReviewCard
                review={r}
                cycle={cycleOf(r.cycle)}
                mine={mine(r)}
                needsAction={needsMe(r)}
                open={isOpen(r)}
                onOpenChange={(o) => setOpenMap((m) => ({ ...m, [r.path]: o }))}
                prevRating={prevRatingFor(r)}
                employee={empOf(r.employee)}
                employeeName={empName(r.employee)}
                deliveredCards={deliveredFor(r.employee, cycleOf(r.cycle))}
                cycleGoals={goalsFor(r.employee, cycleOf(r.cycle))}
                empName={empName}
                framework={framework}
                employees={employees}
                departments={departments}
                getSuggested={() => suggestFor(r)}
                onSubmitSelf={(self_comment, self_ratings) => act(r, "submitSelf", { self_comment, ...(self_ratings && Object.keys(self_ratings).length ? { self_ratings } : {}) })}
                onSubmitManager={(body) => act(r, "submitManager", body)}
                onAcknowledge={(comment) => act(r, "acknowledge", comment?.trim() ? { comment: comment.trim() } : undefined)}
                onNudge={() => act(r, "nudge")}
                onSkip={async () => {
                  const ok = await confirm({
                    title: "Skip this stage?",
                    description: "The review moves to the next stage without this stage's input.",
                    confirmLabel: "Skip stage",
                  });
                  if (ok) await act(r, "skipStage");
                }}
                onNominate={(employees) => act(r, "nominate", { employees })}
              />
              </AccessItem>
              </div>
            ))}
            </div>
            </div>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}

function ReviewCard({ review, cycle, mine, needsAction, open, onOpenChange, prevRating, employee, employeeName, deliveredCards, cycleGoals, empName, framework, employees, departments, getSuggested, onSubmitSelf, onSubmitManager, onAcknowledge, onSkip, onNudge, onNominate }: {
  review: Review;
  cycle?: ReviewCycle;
  mine: boolean;
  needsAction: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prevRating?: number;
  employee?: Employee;
  employeeName: string;
  deliveredCards: KanbanCard[];
  cycleGoals: Goal[];
  empName: (ref?: string) => string;
  framework: PerformanceFramework;
  employees: Employee[];
  departments: Department[];
  getSuggested: () => string[];
  onSubmitSelf: (selfComment: string, selfRatings?: Record<string, number>) => Promise<void>;
  onSubmitManager: (body: { ratings: Record<string, number>; overall_rating?: number; manager_comment?: string }) => Promise<void>;
  onAcknowledge: (comment?: string) => Promise<void>;
  onSkip: () => Promise<void>;
  onNudge: () => Promise<void>;
  onNominate: (employees: string[]) => void;
}) {
  const can = review.access?.can ?? [];
  const confirm = useConfirm();
  const [nominating, setNominating] = useState(false);
  // Open/folded state is owned by the page (expand-all + deep links); folded, the header line still says
  // who, which cycle, what stage, and the outcome once shared.
  const feedback = review.feedback ?? [];

  // Long-form review text survives navigating away: drafts persist per review until submitted.
  const draftKey = (field: string) => `review-draft:${review.path}:${field}`;
  const loadDraft = (field: string) => { try { return localStorage.getItem(draftKey(field)) ?? ""; } catch { return ""; } };
  const saveDraft = (field: string, v: string) => { try { v.trim() ? localStorage.setItem(draftKey(field), v) : localStorage.removeItem(draftKey(field)); } catch { /* private mode */ } };
  const clearDraft = (field: string) => { try { localStorage.removeItem(draftKey(field)); } catch { /* private mode */ } };

  const [selfText, setSelfText] = useState(review.self_comment || loadDraft("self"));
  const [selfRatings, setSelfRatings] = useState<Record<string, number>>(() => {
    if (review.self_ratings && Object.keys(review.self_ratings).length) return review.self_ratings;
    try { return JSON.parse(loadDraft("selfRatings") || "{}"); } catch { return {}; }
  });
  // Manager ratings persist alongside the manager comment: half a rating grid is as expensive to redo as the
  // write-up, and losing it silently while "Draft saved on this device" showed was the worst of both.
  const [ratings, setRatings] = useState<Record<string, number>>(() => {
    if (review.ratings && Object.keys(review.ratings).length) return review.ratings;
    try { return JSON.parse(loadDraft("ratings") || "{}"); } catch { return {}; }
  });
  const [overall, setOverall] = useState<number | undefined>(() => {
    if (review.overall_rating != null) return review.overall_rating;
    const d = Number(loadDraft("overall"));
    return Number.isFinite(d) && d > 0 ? d : undefined;
  });
  const [mgrComment, setMgrComment] = useState(review.manager_comment || loadDraft("manager"));
  const [ackComment, setAckComment] = useState("");
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const reviewHasPrint = useHasPrintVersion("review");

  // One in-flight verb at a time; the clicked button spins, the rest stay idle.
  type BusyKey = "" | "self" | "manager" | "ack" | "skip" | "nudge";
  const [busy, setBusy] = useState<BusyKey>("");
  const run = (key: Exclude<BusyKey, "">, fn: () => Promise<void>) => async () => {
    setBusy(key);
    try { await fn(); } finally { setBusy(""); }
  };

  // "Waiting on the manager" is only actionable if it names them, so a nudge has an obvious target.
  const managerName = employee?.manager ? empName(employee.manager) : "";
  // The current stage's deadline comes from the cycle (self vs manager due dates).
  const stageDue = review.state === "SELF" ? cycle?.self_due_date : review.state === "MANAGER" ? cycle?.manager_due_date : undefined;
  const stageOverdue = !!stageDue && stageDue < todayStr();

  const skipBtn = can.includes("skipStage") && review.state !== "ACKNOWLEDGED" ? (
    <AccessAction verb="skipStage" can={can} label="Skip review stage">
      <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === "skip"} onClick={run("skip", onSkip)}><SkipForward className="h-3.5 w-3.5" /> Skip stage</Button>
    </AccessAction>
  ) : null;
  // A reminder to whoever owns the current stage - only shown to a viewer the review is NOT waiting on.
  const nudgeBtn = can.includes("nudge") && review.state !== "ACKNOWLEDGED" && !needsAction ? (
    <AccessAction verb="nudge" can={can} label="Nudge current stage owner">
      <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === "nudge"} onClick={run("nudge", onNudge)}><BellRing className="h-3.5 w-3.5" /> Nudge</Button>
    </AccessAction>
  ) : null;
  const waitBtns = (nudgeBtn || skipBtn) && <span className="flex shrink-0 items-center gap-1">{nudgeBtn}{skipBtn}</span>;

  // The shared outcome, readable from the folded header - a closed card still answers "how did it land?".
  const headerRating = (review.state === "SHARED" || review.state === "ACKNOWLEDGED") && review.overall_rating != null;

  // A folded card must answer "whose review, and what is being asked of me" without opening. The cycle name
  // alone answered neither: an employee's own self-assessment read as "H1 2026 · Needs you", which never says
  // it is a SELF review. So the title names the subject, and the badge names the actual task.
  const subject = mine ? "Your review" : employeeName;
  const actionLabel = review.state === "SELF" ? "self-assessment" : review.state === "MANAGER" ? "your assessment" : "acknowledge";

  // Sharing is a one-way door: it publishes the assessment to the employee and there is no path back to the
  // manager stage. So an empty form can't be submitted at all, and a partial one asks first.
  const ratedCount = framework.competencies.filter((c) => ratings[c.key] != null).length;
  const managerEmpty = overall == null && ratedCount === 0 && !mgrComment.trim();
  const submitManagerReview = async () => {
    const missing = [
      overall == null ? "an overall rating" : "",
      ratedCount < framework.competencies.length ? `${framework.competencies.length - ratedCount} of ${framework.competencies.length} competency ratings` : "",
      !mgrComment.trim() ? "written feedback" : "",
    ].filter(Boolean);
    if (missing.length) {
      const ok = await confirm({
        title: "Share an incomplete review?",
        description: `Missing: ${missing.join("; ")}. Sharing sends it to ${employeeName || "the employee"} straight away and the review can't come back to the manager stage.`,
        confirmLabel: "Share anyway",
      });
      if (!ok) return;
    }
    await run("manager", async () => {
      await onSubmitManager({ ratings, overall_rating: overall, manager_comment: mgrComment.trim() });
      clearDraft("manager");
      clearDraft("ratings");
      clearDraft("overall");
    })();
  };

  return (
    <Card className={cn("overflow-hidden", stageOverdue && "border-l-2 border-l-destructive")}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className={cn(
          "flex w-full flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50",
          open && "border-b",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          {!mine && employee ? (
            <PhotoAvatar employeeId={idOf(employee.path)} name={employeeName} photo={employee.photo} className="h-6 w-6" />
          ) : (
            <ClipboardCheck className="h-4 w-4 text-primary" />
          )}
          <span className="font-semibold">{cycle?.name ?? "Review"}</span>
          <span className="text-sm text-muted-foreground">· {subject}</span>
          {needsAction && <Badge variant="warning">Needs you: {actionLabel}</Badge>}
          {stageDue && (
            <span className={cn("text-xs tabular-nums", stageOverdue ? "font-medium text-destructive" : "text-muted-foreground")}>
              · {stageOverdue ? "was due" : "due"} {formatDate(stageDue)}
            </span>
          )}
          {headerRating && (
            <span className="text-xs text-muted-foreground tabular-nums">
              · <span className="font-semibold text-foreground">{review.overall_rating}</span> {ratingLabel(framework.scale, review.overall_rating!)}
              {prevRating != null && prevRating !== review.overall_rating && (
                <span className={cn("ml-1", review.overall_rating! > prevRating ? "text-success" : "text-destructive")}>
                  ({review.overall_rating! > prevRating ? "up" : "down"} from {prevRating})
                </span>
              )}
            </span>
          )}
        </div>
        <StageTrail state={review.state} />
      </button>

      {open && (
      <div className="space-y-4 p-4">
        {/* Goals in this cycle's period: read-only evidence from the reviewee's goals (due or completed inside it). */}
        {cycleGoals.length > 0 && (
          <Section label={`Goals this cycle (${cycleGoals.length})`}>
            <ul className="space-y-1">
              {cycleGoals.map((g) => (
                <li key={g.path} className="flex items-center gap-2 text-sm">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", g.status === "completed" ? "bg-emerald-500" : g.status === "cancelled" ? "bg-muted-foreground/40" : "bg-primary")} />
                  <span className={cn("min-w-0 flex-1 truncate", g.status === "cancelled" && "text-muted-foreground line-through")}>{g.title}</span>
                  {g.weight ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">wt {g.weight}</span> : null}
                  <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">{g.progress ?? 0}%</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Work delivered this cycle: read-only evidence pulled from the reviewee's kanban cards. */}
        {deliveredCards.length > 0 && (
          <Section label={`Work delivered this cycle (${deliveredCards.length})`}>
            <ul className="space-y-1">
              {deliveredCards.map((c) => {
                const start = c.start_time ?? c.commit_time;
                const days = start && c.deliver_time ? Math.max(0, Math.round((new Date(c.deliver_time).getTime() - new Date(start).getTime()) / 86_400_000)) : null;
                return (
                  <li key={c.path} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{c.title}</span>
                    {days != null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{days}d cycle</span>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {/* Self-assessment: editable while in SELF (by the owner); read-only after. */}
        {review.state === "SELF" && mine && can.includes("submitSelf") ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Your self-assessment</p>
            {/* Section chips kill the blank page: one click drops a competency heading into the text, so the
                write-up arrives structured the same way the manager will rate it. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Add a section:</span>
              {framework.competencies.filter((c) => !selfText.includes(`${c.label}:`)).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => {
                    const v = selfText.trim() ? `${selfText.replace(/\s+$/, "")}\n\n${c.label}:\n` : `${c.label}:\n`;
                    setSelfText(v);
                    saveDraft("self", v);
                  }}
                  className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                >
                  + {c.label}
                </button>
              ))}
            </div>
            <Textarea rows={6} value={selfText} onChange={(e) => { setSelfText(e.target.value); saveDraft("self", e.target.value); }} placeholder="Summarise your impact, wins, and where you want to grow." />
            {/* Optional self ratings on the same scale the manager uses; the gap per competency becomes a
                conversation flag once the manager's side lands. */}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Rate yourself <span className="font-normal text-muted-foreground">(optional)</span></p>
              <ScaleLegend scale={framework.scale} />
              {framework.competencies.map((comp) => (
                <div key={comp.key} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">{comp.label}</span>
                  <ScalePicker scale={framework.scale} value={selfRatings[comp.key]} onPick={(v) => setSelfRatings((r) => { const next = { ...r, [comp.key]: v }; saveDraft("selfRatings", JSON.stringify(next)); return next; })} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AccessAction verb="submitSelf" can={can} label="Submit self-assessment">
                <Button size="sm" loading={busy === "self"} disabled={!selfText.trim()} onClick={run("self", async () => { await onSubmitSelf(selfText.trim(), selfRatings); clearDraft("self"); clearDraft("selfRatings"); })}>Submit self-assessment <ChevronRight className="h-3.5 w-3.5" /></Button>
              </AccessAction>
              {skipBtn}
              {!!selfText.trim() && <span className="ml-auto text-xs text-muted-foreground">Draft saved on this device</span>}
            </div>
          </div>
        ) : review.state === "SELF" ? (
          // A sentence of prose beside a button pair: on a phone the prose gets squeezed to a column of
          // single words. Stacked below `sm`, one row from `sm` up. (Same for the two rows like it below.)
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{mine ? "Complete your self-assessment to begin." : `Waiting for ${employeeName || "the employee"} to complete their self-assessment.`}</p>
            {waitBtns}
          </div>
        ) : (
          review.self_comment != null && (
            <Section label="Self-assessment">{review.self_comment || <span className="text-muted-foreground">No self-assessment.</span>}</Section>
          )
        )}

        {/* Manager review form (MANAGER stage, manager/HR) */}
        {review.state === "MANAGER" && can.includes("submitManager") && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Manager review</p>
            <ScaleLegend scale={framework.scale} />
            {framework.competencies.map((comp) => (
              <div key={comp.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {comp.label}
                  {review.self_ratings?.[comp.key] != null && <span className="ml-1.5 text-xs text-muted-foreground">self: {review.self_ratings[comp.key]}</span>}
                </span>
                <ScalePicker scale={framework.scale} value={ratings[comp.key]} onPick={(v) => setRatings((r) => { const next = { ...r, [comp.key]: v }; saveDraft("ratings", JSON.stringify(next)); return next; })} />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <span className="text-sm font-medium">Overall</span>
              <ScalePicker scale={framework.scale} value={overall} onPick={(v) => { setOverall(v); saveDraft("overall", String(v)); }} />
            </div>
            <Textarea rows={3} value={mgrComment} onChange={(e) => { setMgrComment(e.target.value); saveDraft("manager", e.target.value); }} placeholder="Overall feedback for the employee." />
            <div className="flex flex-wrap items-center gap-2">
              <AccessAction verb="submitManager" can={can} label="Submit manager review">
                <Button size="sm" loading={busy === "manager"} disabled={managerEmpty} onClick={submitManagerReview}>Share with employee <ChevronRight className="h-3.5 w-3.5" /></Button>
              </AccessAction>
              {skipBtn}
              {(!!mgrComment.trim() || ratedCount > 0 || overall != null) && <span className="ml-auto text-xs text-muted-foreground">Draft saved on this device</span>}
            </div>
          </div>
        )}
        {review.state === "MANAGER" && !can.includes("submitManager") && (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {mine
                ? `${managerName ? `${managerName} is` : "Your manager is"} writing their review. Ratings and feedback stay hidden until they're shared with you - nothing is needed from you right now.`
                : `Waiting for ${managerName || `${employeeName || "the employee"}'s manager`} to finish this review.`}
            </p>
            {waitBtns}
          </div>
        )}

        {/* 360 peer feedback. Managers/HR (can nominate) see authors + progress and can request more; the
            employee sees only the anonymized submitted entries (server-gated, present once shared). */}
        {(can.includes("nominate") || feedback.length > 0) && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium"><MessageSquareQuote className="h-4 w-4 text-muted-foreground" /> Peer feedback</p>
              {can.includes("nominate") && (
                <AccessAction verb="nominate" can={can} label="Request 360 feedback">
                  <Button variant="outline" size="sm" onClick={() => setNominating(true)}><UserPlus className="h-3.5 w-3.5" /> Request feedback</Button>
                </AccessAction>
              )}
            </div>
            {feedback.length === 0 ? (
              <p className="text-sm text-muted-foreground">No peer feedback {can.includes("nominate") ? "requested yet." : "yet."}</p>
            ) : (
              <div className="space-y-2">
                {feedback.map((f, i) => (
                  <div key={f.id ?? i} className="rounded-md bg-background px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{f.author ? empName(f.author) : "Peer"}</span>
                      <span className="flex items-center gap-2">
                        {f.overall_rating != null && <span className="text-xs tabular-nums text-muted-foreground">{f.overall_rating} · {ratingLabel(framework.scale, f.overall_rating)}</span>}
                        <Badge variant={f.state === "SUBMITTED" ? "success" : f.state === "DECLINED" ? "muted" : "secondary"}>{f.state === "SUBMITTED" ? "Submitted" : f.state === "DECLINED" ? "Declined" : "Pending"}</Badge>
                      </span>
                    </div>
                    {f.comment && <p className="mt-1 whitespace-pre-wrap text-foreground/90">{f.comment}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Shared / acknowledged: manager assessment is visible; the finished review can leave as a PDF. */}
        {(review.state === "SHARED" || review.state === "ACKNOWLEDGED") && (
          <>
            <ManagerResult review={review} framework={framework} />
            {can.includes("pdf") && (
              <AccessAction verb="pdf" can={can} label="Export review PDF">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPdfSource({
                    path: `reviews/${idOf(review.path)}`,
                    verb: "pdf",
                    title: `Performance review · ${cycle?.name ?? "review"}`,
                    description: employeeName,
                    fileName: `review-${(employeeName || "employee").replace(/\s+/g, "-").toLowerCase()}.pdf`,
                    hasPrintVariant: reviewHasPrint, // only when the review letterhead actually has a print version
                  })}
                >
                  <FileDown className="h-3.5 w-3.5" /> Review PDF
                </Button>
              </AccessAction>
            )}
          </>
        )}

        {review.state === "SHARED" && (
          mine && can.includes("acknowledge") ? (
            <div className="space-y-2">
              <Textarea rows={2} value={ackComment} onChange={(e) => setAckComment(e.target.value)} placeholder="Optional note to record with your acknowledgement (visible to your manager and HR)." />
              <AccessAction verb="acknowledge" can={can} label="Acknowledge review">
                <Button size="sm" loading={busy === "ack"} onClick={run("ack", () => onAcknowledge(ackComment))}><Check className="h-3.5 w-3.5" /> Acknowledge</Button>
              </AccessAction>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Shared with {mine ? "you" : employeeName}. Awaiting acknowledgement.</p>
              {!mine && waitBtns}
            </div>
          )
        )}
        {review.state === "ACKNOWLEDGED" && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-success"><Check className="h-4 w-4" /> Acknowledged by {mine ? "you" : employeeName}.</p>
            {review.ack_comment && <Section label="Acknowledgement note">{review.ack_comment}</Section>}
          </div>
        )}
      </div>
      )}

      {open && <ActivitySection resource={review.path} className="border-t pt-4" />}

      <PdfPreviewDialog source={pdfSource} onClose={() => setPdfSource(null)} />

      {nominating && (
        <EmployeePicker
          title={`Request 360 feedback on ${employeeName}`}
          confirmLabel="Send requests"
          employees={employees}
          departments={departments}
          suggested={getSuggested()}
          exclude={[review.employee ?? "", ...feedback.map((f) => f.author ?? "")].filter(Boolean)}
          onClose={() => setNominating(false)}
          onConfirm={(refs) => { onNominate(refs); setNominating(false); }}
        />
      )}
    </Card>
  );
}

// A 360 feedback request addressed to the caller: who it's about, a comment, an optional overall rating.
function FeedbackRequestCard({ request, subjectName, framework, onSubmit, onDecline }: {
  request: ReviewFeedback;
  subjectName: string;
  framework: PerformanceFramework;
  onSubmit: (body: { comment: string; overall_rating?: number }) => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [overall, setOverall] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState<"" | "submit" | "decline">("");
  const run = (key: "submit" | "decline", fn: () => Promise<void>) => async () => {
    setBusy(key);
    try { await fn(); } finally { setBusy(""); }
  };
  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm">Share feedback on <span className="font-semibold">{subjectName}</span>.</p>
      <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What does this person do well? Where could they grow?" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Overall (optional)</span>
        <ScalePicker scale={framework.scale} value={overall} onPick={setOverall} />
      </div>
      <div className="flex items-center gap-2">
        <AccessAction verb="submitFeedback" can={request.access?.can} label="Submit 360 feedback">
          <Button size="sm" loading={busy === "submit"} onClick={run("submit", () => onSubmit({ comment: comment.trim(), overall_rating: overall }))} disabled={!comment.trim() && overall == null}>Submit feedback</Button>
        </AccessAction>
        <AccessAction verb="decline" can={request.access?.can} label="Decline feedback request">
          <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === "decline"} onClick={run("decline", onDecline)}>Decline</Button>
        </AccessAction>
      </div>
    </Card>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap text-sm text-foreground/90">{children}</p>
    </div>
  );
}

// Read-only manager assessment: per-competency ratings, overall, and the comment.
function ManagerResult({ review, framework }: { review: Review; framework: PerformanceFramework }) {
  const ratings = review.ratings ?? {};
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Manager review</p>
        {review.overall_rating != null && (
          <span className="text-sm"><span className="font-semibold">{review.overall_rating}</span> <span className="text-muted-foreground">· {ratingLabel(framework.scale, review.overall_rating)}</span></span>
        )}
      </div>
      <div className="space-y-1">
        {framework.competencies.map((comp) => {
          const self = review.self_ratings?.[comp.key];
          const mgr = ratings[comp.key];
          const gap = self != null && mgr != null && Math.abs(self - mgr) >= 2;
          return (
            <div key={comp.key} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{comp.label}</span>
              <span className="flex items-center gap-2 tabular-nums">
                {/* Self vs manager: a wide gap is the thing worth talking about, so it gets the accent. */}
                {self != null && <span className={cn("text-xs", gap ? "font-medium text-warning" : "text-muted-foreground")}>self: {self}</span>}
                <span>{mgr != null ? `${mgr} · ${ratingLabel(framework.scale, mgr)}` : "-"}</span>
              </span>
            </div>
          );
        })}
      </div>
      {review.manager_comment && <Section label="Feedback">{review.manager_comment}</Section>}
    </div>
  );
}

// What the numbers on the picker mean, spelled out once per form: the buttons themselves are bare digits and
// the label only appears after a pick, which is the wrong order for someone rating for the first time.
function ScaleLegend({ scale }: { scale: { value: number; label: string }[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      {scale.map((s) => `${s.value} = ${s.label}`).join(" · ")}
    </p>
  );
}

// A segmented 1..N rating picker.
function ScalePicker({ scale, value, onPick }: { scale: { value: number; label: string }[]; value?: number; onPick: (v: number) => void }) {
  const picked = scale.find((s) => s.value === value);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {picked && <span className="mr-1 text-xs text-muted-foreground">{picked.label}</span>}
      {scale.map((s) => (
        <button
          key={s.value}
          type="button"
          title={s.label}
          onClick={() => onPick(s.value)}
          className={cn(
            "h-7 w-7 rounded-md border text-sm font-medium tabular-nums transition-colors",
            value === s.value ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-accent",
          )}
        >
          {s.value}
        </button>
      ))}
    </div>
  );
}
