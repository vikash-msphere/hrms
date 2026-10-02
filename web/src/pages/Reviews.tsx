import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, ChevronRight, Check, SkipForward, UserPlus, MessageSquareQuote, CircleAlert, Hourglass, CheckCircle2, AlarmClock, ChevronsDownUp, ChevronsUpDown, BellRing, FileDown, Target } from "lucide-react";
import { create, get, invoke, invokeRead } from "@/api";
import { useRoute, setQueryParams, navigate } from "@/router";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { statusForProgress } from "@/lib/goalState";
import { GoalDueChip, GoalProgressBar, GoalStageBadge } from "@/components/common/GoalChips";
import { FilterChip } from "@/components/common/FilterChips";
import { todayStr } from "@/lib/orgDay";
import { useHasPrintVersion } from "@/lib/letterheads";
import { DEFAULT_PERFORMANCE, competenciesForCycle, competencyScore, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Review, ReviewCycle, ReviewState, ReviewFeedback, Me, Card as KanbanCard } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard, ChartStrip } from "@/components/common/Chart";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { useChartFocus } from "@/lib/chartFocus";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { ActivitySection } from "@/components/common/ActivitySection";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { DraftButton } from "@/components/common/DraftButton";
import { ReviewEvidenceCard } from "@/components/common/ReviewEvidenceCard";
import { ReviewDraftCheck } from "@/components/common/ReviewDraftCheck";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useConfirm } from "@/components/common/confirm";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";
import { readDraft, writeDraft, clearDraft } from "@/lib/draftStore";

// The review stage machine, in order. Every card renders it as a trail so "where is this review and
// who moves it next" reads at a glance.
const STAGES: { key: ReviewState; label: string }[] = [
  { key: "SELF", label: "Self" },
  { key: "MANAGER", label: "Manager" },
  { key: "SHARED", label: "Shared" },
  { key: "ACKNOWLEDGED", label: "Acknowledged" },
];


// The cycle's goals as the review carries them (live before sharing, the frozen snapshot after) and the
// manager's verdict on one. Both come off the review resource, so neither can disagree with the server's
// attainment score or with the PDF.
type CycleGoal = NonNullable<Review["goals"]>[number];
type GoalVerdict = NonNullable<Review["goal_ratings"]>[string];

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
  // `all`: this page is not only a list. `prevRatingFor` below answers "up or down from last cycle" out of
  // these rows, and `reviews` is one row per employee per cycle ordered newest-first - so the rows that fall
  // out of a window are, by construction, the older cycle, which is exactly the one a trend is measured
  // against. The wrong answer is worse than none: an employee rated 4 -> 3 -> 4 whose middle cycle aged off
  // the page reads as "up from 3", in green, on the document a pay decision is argued from. `cycleOptions`
  // is built by walking these rows too, so a cycle whose reviews all fell off the page was not in the filter
  // dropdown either - the reader could not even go and look.
  const { rows: reviews, state, error, reload } = useCollection<Review>("reviews", { all: true });
  // The walk stops at ALL_CAP. Past that the history is still partial, so the trend is withheld rather than
  // computed from whatever was loaded - a missing arrow is a non-statement, a wrong one is a false statement.
  const reviewsTruncated = useCollectionHasMore("reviews");
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles", { all: true });
  // COMPLETE: this list is what EmployeePicker offers (reviewers, 360 feedback givers) and what the name map
  // resolves. On a window, everyone past the first page is unpickable and renders as "Employee".
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { rows: feedbackReqs, reload: reloadFb } = useCollection<ReviewFeedback>("review-feedback", { all: true });
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
  // `useCallback` for both of these, because the sort below orders the whole page with them: a predicate
  // rebuilt every render is a dependency that changes every render, and leaving it out of the array is how a
  // sort keeps deciding "needs you" from the identity the page was first rendered with.
  const mine = useCallback((r: Review) => !!r.employee && idOf(r.employee) === me.employee_id, [me.employee_id]);

  // A review the caller OWNS THE CURRENT STAGE OF reads as "needs you". Holding the verb is not the same
  // thing: a super admin (and anyone granted submitManager broadly) can act on every review in the org, and
  // keying off `can` alone put a "Needs you" badge on all of them. The manager stage belongs to the
  // reviewee's manager; everyone else with the verb is an unblocker, and gets Nudge/Skip instead.
  const needsMe = useCallback((r: Review) => {
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
  }, [empOf, mine, me.employee_id]);

  // Reviews awaiting the caller's action first, then mine, then by cycle name.
  const sorted = useMemo(
    () =>
      [...reviews].sort(
        (a, b) =>
          Number(needsMe(b)) - Number(needsMe(a)) ||
          Number(mine(b)) - Number(mine(a)) ||
          (cycleOf(b.cycle)?.name ?? "").localeCompare(cycleOf(a.cycle)?.name ?? ""),
      ),
    [reviews, needsMe, mine, cycleOf],
  );

  const REVIEW_TOAST: Record<string, string> = {
    submitSelf: "Self-assessment submitted",
    submitManager: "Review shared with the employee",
    acknowledge: "Review acknowledged",
    skipStage: "Stage skipped",
    nominate: "Feedback requests sent",
    nudge: "Reminder sent",
  };
  // Returns whether the server took it. A refusal is reported here and NOT rethrown, so the outcome has to
  // travel as a value or it does not travel at all - and two callers need it: both submit paths drop the
  // manager's write-up, the competency grid and every per-goal verdict from the draft store on the line after
  // the await, which on a swallowed refusal deleted work the server never received while "Draft saved on this
  // device" was still on screen. `Tickets.tsx#act` is the same helper with the same signature, for the same
  // reason. Callers that have nothing to discard can ignore the result.
  async function act(r: Review, verb: string, body?: Record<string, unknown>): Promise<boolean> {
    try {
      await invoke(`reviews/${idOf(r.path)}`, verb, undefined, body);
      toast({ title: REVIEW_TOAST[verb] ?? "Review updated", variant: "success" });
      reloadAll();
      return true;
    } catch (e) {
      toast({ title: "Couldn't update review", description: (e as Error).message, variant: "destructive" });
      return false;
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
  // `useCallback` (with nothing to depend on - both setters and `setQueryParams` are stable) so the deep-link
  // effect below can name them in its dependency array instead of holding the first render's copies.
  const applyFilter = useCallback((f: Filter) => { setFilter(f); setQueryParams({ filter: f === "all" ? null : f }); }, []);
  const applyCycle = useCallback((id: string) => { setCycleFilter(id); setQueryParams({ cycle: id === "all" ? null : id }); }, []);
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
    const stages = STAGES.map((s) => ({ key: s.key, label: s.label, n: inScope.filter((r) => r.state === s.key).length })).filter((s) => s.n > 0);
    // A rating scale is ordered: the bars run 1..5 whether or not anybody landed on a 2, because a gap in
    // the middle of a distribution is itself the finding.
    const shared = inScope.filter((r) => (r.state === "SHARED" || r.state === "ACKNOWLEDGED") && r.overall_rating != null);
    const max = Math.max(5, ...shared.map((r) => r.overall_rating ?? 0));
    const scale = Array.from({ length: max }, (_, i) => i + 1);
    return {
      total: inScope.length,
      stages: { labels: stages.map((s) => s.label), values: stages.map((s) => s.n), keys: stages.map((s) => String(s.key)), names: new Map<string, string>(stages.map((s) => [String(s.key), s.label])) },
      ratings: { labels: scale.map(String), values: scale.map((n) => shared.filter((r) => r.overall_rating === n).length), keys: scale.map(String) },
    };
  }, [inScope]);
  // Both pictures narrow the list. A stage is the review's `state`, which crosses the chips above it (those
  // ask whose move it is, not where the review has got to); a rating is only ever on a shared review, so
  // picking one implies that scope rather than needing a second filter for it.
  const cf = useChartFocus<Review, "stage" | "rating">({
    stage: {
      keys: reviewCharts.stages.keys,
      label: (k) => reviewCharts.stages.names.get(k) ?? k,
      match: (r, k) => (r.state as string) === k,
    },
    rating: {
      keys: reviewCharts.ratings.keys,
      label: (k) => `rated ${k}`,
      match: (r, k) => r.overall_rating === Number(k) && (r.state === "SHARED" || r.state === "ACKNOWLEDGED"),
    },
  });

  const cycleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of reviews) {
      if (!r.cycle) continue;
      const id = idOf(r.cycle);
      if (!seen.has(id)) seen.set(id, cycleOf(r.cycle)?.name ?? "Cycle");
    }
    return [...seen].sort((a, b) => b[1].localeCompare(a[1]));
  }, [reviews, cycleOf]);
  const visible = cf.apply(sorted.filter(
    (r) =>
      inCycle(r) &&
      (filter === "all" ||
        (filter === "needs" ? needsMe(r)
          : filter === "done" ? r.state === "ACKNOWLEDGED"
          : filter === "overdue" ? isOverdue(r)
          : waitingOnOthers(r))),
  ));
  // The deep-link effect below asks ONE question of this list - "is the review I was sent to on screen?" - at
  // the moment a link is followed. Read through a ref, because the list itself is rebuilt on every render:
  // depending on it would re-run the effect (and re-scroll the page) on every keystroke and refetch, and
  // leaving it out of the array meant the question was answered against the first render's list.
  const latestVisible = useRef(visible);
  latestVisible.current = visible;

  const filterChip = (f: Filter, label: string) => (
    <FilterChip key={f} active={filter === f} count={counts[f]} onClick={() => applyFilter(f)}>{label}</FilterChip>
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
      if (reviewsTruncated) return undefined; // an incomplete history can name the wrong cycle as "last time"
      if (!r.employee) return undefined;
      const start = cycleOf(r.cycle)?.period_start;
      if (!start) return undefined;
      const prior = (byEmp.get(idOf(r.employee)) ?? []).filter((x) => x.path !== r.path && x.start < start);
      return prior.sort((a, b) => b.start.localeCompare(a.start))[0]?.rating;
    };
  }, [reviews, cycleOf, reviewsTruncated]);

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
  // The delivered-work panel lives inside an expanded review. Reading a whole collection to fill a panel nobody
  // has opened is expensive, so it waits for the first expansion - which, on a page whose default is a folded
  // list of headers, is often never. The goals panel needs no read at all: the cycle's goals ride the review
  // itself (`review.goals`), scored server-side, so the page never guesses which goals a cycle covered.
  const anyOpen = visible.some(isOpen);
  const { rows: cards } = useCollection<KanbanCard>("cards", { enabled: anyOpen });
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

  // Deep link: /reviews/<id> (notification clicks) opens that card and scrolls it into view.
  useEffect(() => {
    if (!route.id) return;
    const target = reviews.find((r) => idOf(r.path) === route.id);
    if (!target) return;
    // The filters persist in the URL, so a notification can deep-link a review the current filter hides -
    // the card would never render and the scroll would land nowhere. Being sent to a review outranks the
    // filter that was left behind.
    if (!latestVisible.current.some((r) => r.path === target.path)) { applyFilter("all"); applyCycle("all"); }
    setOpenMap((m) => (m[target.path] ? m : { ...m, [target.path]: true }));
    requestAnimationFrame(() => document.getElementById(`review-${route.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [route.id, reviews, applyFilter, applyCycle]);

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

      <TruncationNotice collection={["reviews", "review-cycles", "review-feedback"]} what="reviews" className="mb-3" />

      {/* Two questions a cycle is run to answer, neither of which a list of reviews shows: how far along is
          it, and what did it conclude. The distribution is the honest form for the second - an average
          rating hides whether a team is uniformly fine or split in half. */}
      {reviewCharts.total > 1 && (
        <ChartStrip id="reviews" className="mb-6">
          <ChartCard title="How far the cycle has got" description="Every review you can see, by the stage it is sitting at.">
            <Chart
              type="percentage"
              height={140}
              labels={reviewCharts.stages.labels}
              datasets={[{ name: "Reviews", values: reviewCharts.stages.values }]}
              ariaLabel="Reviews by stage"
              {...cf.chart("stage")}
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
              {...cf.chart("rating")}
            />
          </ChartCard>
        </ChartStrip>
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
                onDecline={(reason) => feedbackAct(f, "decline", reason ? { reason } : undefined)}
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
        <ChartFilterNote label={cf.activeLabel} shown={visible.length} total={inScope.length} onClear={cf.clear} />
        {sorted.length === 0 ? (
          myRequests.length === 0 && <EmptyState icon={ClipboardCheck} title="No reviews yet" description="When HR launches a review cycle that includes you, your review will appear here." />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No reviews match"
            description="Nothing matches the current filters."
            action={<Button variant="outline" size="sm" onClick={() => { applyFilter("all"); applyCycle("all"); cf.clear(); }}>Clear filters</Button>}
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
                onGoalsChanged={reload}
                empName={empName}
                framework={framework}
                employees={employees}
                departments={departments}
                getSuggested={() => suggestFor(r)}
                onSubmitSelf={(self_comment, self_ratings) => act(r, "submitSelf", { self_comment, ...(self_ratings && Object.keys(self_ratings).length ? { self_ratings } : {}) })}
                onSubmitManager={(body) => act(r, "submitManager", body)}
                onAcknowledge={async (comment) => { await act(r, "acknowledge", comment?.trim() ? { comment: comment.trim() } : undefined); }}
                onNudge={async () => { await act(r, "nudge"); }}
                onSkip={async () => {
                  const ok = await confirm({
                    title: "Skip this stage?",
                    description: "The review moves to the next stage without this stage's input.",
                    confirmLabel: "Skip stage",
                  });
                  if (ok) await act(r, "skipStage");
                }}
                onNominate={(employees) => act(r, "nominate", { employees })}
                onSuggest={(employees) => act(r, "suggestFeedback", { employees })}
                onAssignReviewer={(reviewer) => act(r, "assignReviewer", { reviewer })}
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

function ReviewCard({ review, cycle, mine, needsAction, open, onOpenChange, prevRating, employee, employeeName, deliveredCards, onGoalsChanged, empName, framework, employees, departments, getSuggested, onSubmitSelf, onSubmitManager, onAcknowledge, onSkip, onNudge, onNominate, onSuggest, onAssignReviewer }: {
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
  onGoalsChanged: () => void;
  empName: (ref?: string) => string;
  framework: PerformanceFramework;
  employees: Employee[];
  departments: Department[];
  getSuggested: () => string[];
  /** Both resolve to whether the SERVER took the submission - the local draft is only dropped on `true`. */
  onSubmitSelf: (selfComment: string, selfRatings?: Record<string, number>) => Promise<boolean>;
  onSubmitManager: (body: { ratings: Record<string, number>; overall_rating?: number; manager_comment?: string; goal_ratings?: Record<string, GoalVerdict> }) => Promise<boolean>;
  onAcknowledge: (comment?: string) => Promise<void>;
  onSkip: () => Promise<void>;
  onNudge: () => Promise<void>;
  onNominate: (employees: string[]) => void;
  /** The reviewee's own suggestion of who saw their work (the whole set at once). */
  onSuggest: (employees: string[]) => void;
  /** Name who writes this review, or "" to hand it back to the manager chain. */
  onAssignReviewer: (reviewer: string) => void;
}) {
  const can = review.access?.can ?? [];
  const confirm = useConfirm();
  // What THIS cycle asks about: the org framework narrowed to the cycle's own selection. A form that offers
  // five ratings where the cycle asks three collects two nobody wanted, and the server's competency score
  // would not count them - so the narrowing happens once, here, and everything below reads `frameworkForCycle`.
  const frameworkForCycle = useMemo<PerformanceFramework>(
    () => ({ ...framework, competencies: competenciesForCycle(framework.competencies, cycle?.competency_keys) }),
    [framework, cycle?.competency_keys],
  );
  const [nominating, setNominating] = useState(false);
  // Who actually worked with this person this cycle, from the record of shared cards, shared goals and
  // kudos. Fetched when a picker opens rather than on every review, because it is four reads for a dialog
  // most readers never open. `getSuggested()` - the client-side same-board-and-department guess - stays as
  // the fallback for a caller whose verb or scope leaves this empty.
  // What the reader took from the evidence panel into their draft. Held here rather than inside the panel so
  // the Draft button can seed its box with it: the panel shows the record, the author decides what of it is
  // worth writing about, and the instruction they send is the two of those combined.
  const [evidenceSeed, setEvidenceSeed] = useState("");
  /** Whether a writing box is on screen for THIS caller: the self-assessment in SELF, or the manager's
   *  write-up in MANAGER. Only then does "add the delivered work to my draft" have somewhere to put it. */
  const writingOpen = (review.state === "SELF" && mine && can.includes("submitSelf"))
    || (review.state === "MANAGER" && can.includes("submitManager"));
  const [collaborators, setCollaborators] = useState<{ employee: string; name: string; reasons: { detail: string }[] }[] | null>(null);
  const loadCollaborators = useCallback(async () => {
    if (collaborators || !(review.access?.can ?? []).includes("collaborators")) return;
    try {
      const res = await invokeRead<{ collaborators: { employee: string; name: string; reasons: { detail: string }[] }[] }>(`reviews/${idOf(review.path ?? "")}`, "collaborators");
      setCollaborators(res.collaborators);
    } catch {
      setCollaborators([]); // silent: the picker still works off the client-side guess
    }
  }, [collaborators, review.access, review.path]);
  const collaboratorRefs = (collaborators ?? []).map((c) => c.employee);
  const collaboratorWhy = Object.fromEntries((collaborators ?? []).map((c) => [idOf(c.employee), c.reasons.map((r) => r.detail).join(" · ")]));
  const [suggesting, setSuggesting] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  // The review line being carried into a new goal, and the goal that comes out of it.
  const verdictOf = (code: string) => (review.goal_ratings ?? {})[code];
  const [carryGoal, setCarryGoal] = useState<CycleGoal | null>(null);
  const [carryTitle, setCarryTitle] = useState("");
  const [carryDesc, setCarryDesc] = useState("");
  const [carryWeight, setCarryWeight] = useState("");
  const [carryDue, setCarryDue] = useState("");
  // Open/folded state is owned by the page (expand-all + deep links); folded, the header line still says
  // who, which cycle, what stage, and the outcome once shared.
  const feedback = review.feedback ?? [];
  // Two disjoint sets: names the reviewee put forward (nobody has been asked yet), and requests that were
  // actually made. Mixing them reads as five pending requests when only two people were asked.
  const suggestedPeers = feedback.filter((f) => f.state === "SUGGESTED" && f.author);
  const askedFeedback = feedback.filter((f) => f.state !== "SUGGESTED");

  // Long-form review text survives navigating away: drafts persist per review until submitted. Held in the
  // shared draft store (lib/draftStore.ts), which namespaces them to the author and expires them - this is one
  // manager's assessment of a named colleague, so it has no business sitting on a shared machine indefinitely
  // or being offered back to the next person who signs in, which is what an un-namespaced local key did.
  const draftKey = (field: string) => `review:${review.path}:${field}`;
  const loadDraft = (field: string) => readDraft<string>(draftKey(field))?.value ?? "";
  const saveDraft = (field: string, v: string) => (v.trim() ? writeDraft(draftKey(field), v) : clearDraft(draftKey(field)));
  const clearDraftFor = (field: string) => clearDraft(draftKey(field));

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
  // The manager's verdict per goal, keyed by goal code, drafted alongside the rest of the assessment.
  const [goalRatings, setGoalRatings] = useState<Record<string, GoalVerdict>>(() => {
    if (review.goal_ratings && Object.keys(review.goal_ratings).length) return review.goal_ratings;
    try { return JSON.parse(loadDraft("goalRatings") || "{}"); } catch { return {}; }
  });
  const setGoalVerdict = (code: string, patch: GoalVerdict) =>
    setGoalRatings((r) => {
      const next = { ...r, [code]: { ...r[code], ...patch } };
      saveDraft("goalRatings", JSON.stringify(next));
      return next;
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

  // The cycle's goals, straight off the review - never re-derived here, so the panel, the attainment score and
  // the exported PDF can never disagree about which goals this cycle covered.
  const cycleGoals = review.goals ?? [];

  /**
   * The cycle's goals as a line each, to seed a draft with.
   *
   * THE MANUAL WORK THIS REMOVES is the hunting, not the writing: today you scroll this same list, read off
   * each title and percentage, and type them back into the box below. The page already has them, so it hands
   * them over and you edit a starting point instead of assembling one.
   *
   * Straight off `review.goals`, the same snapshot the panel and the attainment score render from, so the
   * seed can never describe a different set of goals than the one on screen. Nothing else is included - no
   * rating, no manager comment, no peer feedback - because those are other people's words and this is the
   * author writing their own.
   */
  const goalSeed = (lead: string): string | undefined => {
    if (cycleGoals.length === 0) return undefined;
    const lines = cycleGoals.map((g) => {
      const pct = typeof g.progress === "number" ? `${Math.round(g.progress)}%` : "no progress recorded";
      return `- ${g.title} - ${pct}${g.status ? ` (${g.status.replace(/_/g, " ")})` : ""}`;
    });
    return `${lead}\n${lines.join("\n")}\n`;
  };

  // Move one goal's progress from inside the review (self stage). Status follows the number the same way the
  // Goals page moves it, so truing a goal up here doesn't leave it "not started" at 40%.
  const { toast } = useToast();
  const updateGoalProgress = async (g: CycleGoal, progress: number) => {
    // The shared rule. Moving progress to 100 closes a goal out and moving it off zero starts it, and this
    // was written out by hand here and again on the Goals page - two surfaces writing through the same
    // `:updateProgress` verb that each had their own copy of what the number means.
    const status = statusForProgress(progress, g.status ?? "not_started");
    try {
      await invoke(`goals/${idOf(g.path ?? "")}`, "updateProgress", undefined, { progress, ...(status ? { status } : {}) });
      toast({ title: progress >= 100 ? "Goal marked complete" : `Progress set to ${progress}%`, variant: "success" });
      onGoalsChanged();
    } catch (e) {
      toast({ title: "Couldn't update progress", description: (e as Error).message, variant: "destructive" });
    }
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
  const ratedCount = frameworkForCycle.competencies.filter((c) => ratings[c.key] != null).length;
  const managerEmpty = overall == null && ratedCount === 0 && !mgrComment.trim();
  // The framework's weighted view of what has been rated SO FAR - the manager is choosing the overall while
  // the form is still open, which is the one moment the number changes anything.
  const liveCompetencyScore = competencyScore(frameworkForCycle.competencies, ratings);
  // A goal nobody scored is the most conspicuous hole in a review that has a goals panel, so it is named in
  // the same breath as a missing competency rather than shared silently.
  const ratableGoals = cycleGoals.filter((g) => g.status !== "cancelled");
  const goalRatedCount = ratableGoals.filter((g) => goalRatings[g.code]?.rating != null).length;
  const submitManagerReview = async () => {
    const missing = [
      overall == null ? "an overall rating" : "",
      ratedCount < frameworkForCycle.competencies.length ? `${frameworkForCycle.competencies.length - ratedCount} of ${frameworkForCycle.competencies.length} competency ratings` : "",
      goalRatedCount < ratableGoals.length ? `${ratableGoals.length - goalRatedCount} of ${ratableGoals.length} goal ratings` : "",
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
      // Only verdicts that say something travel: an empty {rating, comment} pair is a form artefact.
      const goal_ratings = Object.fromEntries(
        Object.entries(goalRatings).filter(([, v]) => v?.rating != null || v?.comment?.trim()),
      );
      const saved = await onSubmitManager({
        ratings,
        overall_rating: overall,
        manager_comment: mgrComment.trim(),
        ...(Object.keys(goal_ratings).length ? { goal_ratings } : {}),
      });
      // Only once the server has the work. A refusal - a 409 from someone else moving the stage, a 403 after a
      // grant narrowed, a dropped connection - leaves the draft exactly where it was, which is the invariant
      // the "Draft saved on this device" label below is asserting.
      if (!saved) return;
      clearDraftFor("manager");
      clearDraftFor("ratings");
      clearDraftFor("overall");
      clearDraftFor("goalRatings");
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
        {/* Who writes this one. Offered before it is shared, where a transfer mid-cycle or a manager on long
            leave otherwise left one fix: re-parent the employee, which changes approvals, scopes and the org
            chart in order to solve a review. */}
        {can.includes("assignReviewer") && review.state !== "SHARED" && review.state !== "ACKNOWLEDGED" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
            <span>
              <span className="text-muted-foreground">Written by </span>
              <span className="font-medium">{review.reviewer ? empName(review.reviewer) : "their manager"}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <AccessAction verb="assignReviewer" can={can} label="Name the reviewer">
                <Button variant="outline" size="sm" onClick={() => setReassigning(true)}>{review.reviewer ? "Change" : "Assign someone else"}</Button>
              </AccessAction>
              {review.reviewer && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onAssignReviewer("")}>Back to manager</Button>
              )}
            </span>
          </div>
        )}

        {/* The goals this cycle set, with what they add up to. Live until the review is shared, the frozen
            snapshot after - both come off the review, so this panel and the PDF always tell the same story. */}
        {cycleGoals.length > 0 && (
          <GoalsPanel
            goals={cycleGoals}
            attainment={review.goal_attainment}
            frozen={!!review.goals_frozen}
            verdicts={review.goal_ratings ?? {}}
            framework={framework}
            empName={empName}
            // The self stage is where a goal list is worth truing up: the employee is about to be measured on
            // these numbers, so they get to move them here rather than on another page.
            editable={mine && review.state === "SELF" && !review.goals_frozen}
            onProgress={updateGoalProgress}
            onCarryToGoal={(g) => {
              // Prefilled here rather than inside the dialog so the form owns its own state from the first
              // render: the title carries over as-is, and the manager's verdict becomes the description,
              // because that sentence is the reason this goal exists.
              setCarryTitle(g.title);
              setCarryDesc(verdictOf(g.code)?.comment ?? "");
              setCarryWeight(g.weight ? String(g.weight) : "");
              setCarryDue("");
              setCarryGoal(g);
            }}
          />
        )}

        {/* How this person's attainment has moved across cycles. 68% reads differently after 40% than after
            90%, and every review used to be read on its own. Present on the item read only. */}
        {(review.attainment_trend?.length ?? 0) > 1 && (
          <Section label="Attainment across cycles">
            {/* Each bar's title names the CYCLE and nothing else. `maskAttributes: []` (web/src/instrument.ts)
                means a title attribute is never masked - not by this route being in SENSITIVE_PAGES, and not
                by a `data-sentry-mask` on the element - so a value in one leaves the building whatever the
                page policy says. The attainment and the rating are rendered as TEXT instead, where the route
                mask covers them; `test/replayMaskCoverage.test.ts` states the same rule for the offered
                salary on the pipeline board. */}
            <span className="flex flex-wrap items-end gap-3">
              {review.attainment_trend!.map((p) => (
                <span key={p.cycle} className="flex flex-col items-center gap-1" title={p.name}>
                  <span className="flex h-16 w-8 items-end">
                    <span className="w-full rounded-t-sm bg-primary" style={{ height: `${Math.max(4, p.attainment)}%` }} />
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {p.attainment}%{p.rating != null ? ` · ${p.rating}` : ""}
                  </span>
                  <span className="max-w-[4.5rem] truncate text-[10px] text-muted-foreground">{p.name}</span>
                </span>
              ))}
            </span>
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

        {/* WHAT THE RECORD HOLDS ABOUT THIS CYCLE, mounted ONCE and above the writing panes rather than inside
            them. It lived inside the self and manager panes, which meant it existed only for the person whose
            turn it was: a manager waiting on a self-assessment, or HR chasing a stalled cycle, got nothing -
            and they are readers of exactly the same record. The verb grant decides who may ask at all, and
            each section is decided server-side by the list verdict its own collection gives this caller.

            `onUse` is passed only where there IS a box to put the text in, because "add this to my draft" is
            a promise about a field that has to be on screen. */}
        <ReviewEvidenceCard
          reviewId={idOf(review.path ?? "")}
          can={can}
          subject={mine ? undefined : employeeName || "they"}
          onUse={writingOpen ? (t) => setEvidenceSeed(t) : undefined}
        />

        {/* Self-assessment: editable while in SELF (by the owner); read-only after. */}
        {review.state === "SELF" && mine && can.includes("submitSelf") ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Your self-assessment</p>
            {/* Section chips kill the blank page: one click drops a competency heading into the text, so the
                write-up arrives structured the same way the manager will rate it. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Add a section:</span>
              {frameworkForCycle.competencies.filter((c) => !selfText.includes(`${c.label}:`)).map((c) => (
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
            {/* Writing assistance on your OWN assessment. Nothing is read to produce it: the model gets the
                instruction typed into its dialog plus whatever is already in this box, never the review row,
                a rating or a goal - which is why it can say nothing about how the year went. It writes the
                sentences; the view stays the author's. */}
            <div className="mb-2 flex justify-end">
              <DraftButton
                collection="reviews"
                kind="review-self"
                existing={selfText}
                // Pre-filled with your own goals and where they got to. Editable in the box: add what the
                // record does not know, cut what did not matter, then draft.
                seedInstruction={[goalSeed("What I worked on this cycle:"), evidenceSeed].filter(Boolean).join("\n") || undefined}
                hint="e.g. led the payments migration, mentored two juniors, want to move into design work"
                onDraft={(text) => { setSelfText(text); saveDraft("self", text); }}
              />
            </div>
            <Textarea rows={6} value={selfText} onChange={(e) => { setSelfText(e.target.value); saveDraft("self", e.target.value); }} placeholder="Summarise your impact, wins, and where you want to grow." />
            {/* Optional self ratings on the same scale the manager uses; the gap per competency becomes a
                conversation flag once the manager's side lands. */}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Rate yourself <span className="font-normal text-muted-foreground">(optional)</span></p>
              <ScaleLegend scale={framework.scale} />
              {frameworkForCycle.competencies.map((comp) => (
                <div key={comp.key} className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 text-sm">
                    {comp.label}
                    {/* The org's own definition, where it has written one: the difference between rating a
                        word and rating the behaviour behind it. */}
                    {comp.description && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{comp.description}</span>}
                  </span>
                  <ScalePicker scale={framework.scale} value={selfRatings[comp.key]} onPick={(v) => setSelfRatings((r) => { const next = { ...r, [comp.key]: v }; saveDraft("selfRatings", JSON.stringify(next)); return next; })} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AccessAction verb="submitSelf" can={can} label="Submit self-assessment">
                <Button size="sm" loading={busy === "self"} disabled={!selfText.trim()} onClick={run("self", async () => { if (!(await onSubmitSelf(selfText.trim(), selfRatings))) return; clearDraftFor("self"); clearDraftFor("selfRatings"); })}>Submit self-assessment <ChevronRight className="h-3.5 w-3.5" /></Button>
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
            {/* Goals first: what was delivered, rated one goal at a time, before the competency scores that
                are supposed to follow from it. The weighted attainment above the grid is the number these
                ratings are answering. */}
            {ratableGoals.length > 0 && (
              <div className="space-y-2 rounded-md bg-muted/30 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Goals</p>
                  {review.goal_attainment && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      <span className="font-semibold text-foreground">{review.goal_attainment.score}%</span> attained
                      {!review.goal_attainment.weighted && " (unweighted)"}
                    </span>
                  )}
                </div>
                {ratableGoals.map((g) => (
                  <div key={g.code} className="space-y-1.5 border-t pt-2 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm">
                        {g.title}
                        <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                          {g.weight ? `wt ${g.weight} · ` : ""}{g.progress}%
                        </span>
                      </span>
                      <ScalePicker scale={framework.scale} value={goalRatings[g.code]?.rating} onPick={(v) => setGoalVerdict(g.code, { rating: v })} />
                    </div>
                    <Textarea
                      rows={1}
                      value={goalRatings[g.code]?.comment ?? ""}
                      onChange={(e) => setGoalVerdict(g.code, { comment: e.target.value })}
                      placeholder={`Note on “${g.title}” (optional)`}
                    />
                  </div>
                ))}
              </div>
            )}
            {frameworkForCycle.competencies.map((comp) => (
              <div key={comp.key} className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 text-sm">
                  {comp.label}
                  {/* Weight where the framework sets one: a 4 on a competency worth three times another is
                      not the same 4, and the rater should know that before they pick. */}
                  {comp.weight ? <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">wt {comp.weight}</span> : null}
                  {review.self_ratings?.[comp.key] != null && <span className="ml-1.5 text-xs text-muted-foreground">self: {review.self_ratings[comp.key]}</span>}
                  {comp.description && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{comp.description}</span>}
                </span>
                <ScalePicker scale={framework.scale} value={ratings[comp.key]} onPick={(v) => setRatings((r) => { const next = { ...r, [comp.key]: v }; saveDraft("ratings", JSON.stringify(next)); return next; })} />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <span className="text-sm font-medium">
                Overall
                {/* What the competency ratings add up to, live, beside the box where the manager records
                    their own judgement. The two disagreeing is the useful part - it is what a calibration
                    meeting has to talk about - so it is shown before the choice, not after it. */}
                {liveCompetencyScore && (
                  <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                    competencies average <span className="font-semibold text-foreground">{liveCompetencyScore.score}</span>
                    {liveCompetencyScore.weighted ? " (weighted)" : ""}
                  </span>
                )}
              </span>
              <ScalePicker scale={framework.scale} value={overall} onPick={(v) => { setOverall(v); saveDraft("overall", String(v)); }} />
            </div>
            {/* The manager's own observations, put into sentences. The prompt forbids the model adding a
                judgement, a score or a recommendation of its own, and it has nothing to form one from - no
                record is read. A thin instruction gets a short draft rather than an invented assessment. */}
            <div className="mb-2 flex justify-end">
              <DraftButton
                collection="reviews"
                kind="review-summary"
                existing={mgrComment}
                // The same list, so a manager writing about the year is not re-reading it off the panel
                // above. Their own observations still have to be typed in: the goals say what was worked on,
                // not what the manager makes of it, and the prompt will not fill that in for them.
                seedInstruction={[goalSeed("Goals this cycle, for reference:"), evidenceSeed].filter(Boolean).join("\n") || undefined}
                hint="e.g. shipped the migration on time, needs to delegate more, ready for a bigger scope next year"
                onDraft={(text) => { setMgrComment(text); saveDraft("manager", text); }}
              />
            </div>
            <Textarea rows={3} value={mgrComment} onChange={(e) => { setMgrComment(e.target.value); saveDraft("manager", e.target.value); }} placeholder="Overall feedback for the employee." />
            {/* The draft read back to its author before it is shared: no specific work named, a word that
                describes the person rather than what they did, an absolute nobody can answer, a comparison to
                a colleague. Advisory and dismissible - it cannot touch a rating and it cannot stop a share. */}
            <ReviewDraftCheck text={mgrComment} />
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
        {(can.includes("nominate") || can.includes("suggestFeedback") || feedback.length > 0) && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium"><MessageSquareQuote className="h-4 w-4 text-muted-foreground" /> Peer feedback</p>
              <span className="flex items-center gap-1.5">
                {/* The reviewee's own list. Nomination is the manager's decision, but who saw the work is
                    known to the person who did it - a manager two projects away is guessing at a list. */}
                {mine && can.includes("suggestFeedback") && review.state !== "SHARED" && review.state !== "ACKNOWLEDGED" && (
                  <AccessAction verb="suggestFeedback" can={can} label="Suggest who saw your work">
                    <Button variant="outline" size="sm" onClick={() => { setSuggesting(true); return loadCollaborators(); }}><UserPlus className="h-3.5 w-3.5" /> Suggest peers</Button>
                  </AccessAction>
                )}
                {can.includes("nominate") && (
                  <AccessAction verb="nominate" can={can} label="Request 360 feedback">
                    <Button variant="outline" size="sm" onClick={() => { setNominating(true); return loadCollaborators(); }}><UserPlus className="h-3.5 w-3.5" /> Request feedback</Button>
                  </AccessAction>
                )}
              </span>
            </div>
            {/* Suggestions are not feedback: nobody has been asked anything yet, so they read as a list of
                names above the answers rather than as pending requests among them. */}
            {suggestedPeers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {mine ? "You suggested" : "The reviewee suggested"}: {suggestedPeers.map((f) => empName(f.author)).join(", ")}
                {can.includes("nominate") ? " - request feedback to actually ask them." : "."}
              </p>
            )}
            {askedFeedback.length === 0 ? (
              <p className="text-sm text-muted-foreground">No peer feedback {can.includes("nominate") ? "requested yet." : "yet."}</p>
            ) : (
              <div className="space-y-2">
                {askedFeedback.map((f, i) => (
                  <div key={f.id ?? i} className="rounded-md bg-background px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{f.author ? empName(f.author) : "Peer"}</span>
                      <span className="flex items-center gap-2">
                        {f.overall_rating != null && <span className="text-xs tabular-nums text-muted-foreground">{f.overall_rating} · {ratingLabel(framework.scale, f.overall_rating)}</span>}
                        <Badge variant={f.state === "SUBMITTED" ? "success" : f.state === "DECLINED" ? "muted" : "secondary"}>{f.state === "SUBMITTED" ? "Submitted" : f.state === "DECLINED" ? "Declined" : "Pending"}</Badge>
                      </span>
                    </div>
                    {f.comment && <p className="mt-1 whitespace-pre-wrap text-foreground/90">{f.comment}</p>}
                    {/* Why somebody said no, where they said. It tells the manager to nominate somebody else
                        rather than leaving them to guess whether it was a bad match or a busy week. */}
                    {f.state === "DECLINED" && f.decline_reason && (
                      <p className="mt-1 text-xs text-muted-foreground">Declined: {f.decline_reason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Shared / acknowledged: manager assessment is visible; the finished review can leave as a PDF. */}
        {(review.state === "SHARED" || review.state === "ACKNOWLEDGED") && (
          <>
            <ManagerResult review={review} framework={frameworkForCycle} />
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
          // The reviewee's own suggestions lead the picker: they are the people who actually saw the work,
          // and asking one of them upgrades that suggestion in place rather than asking them twice.
          suggested={[...suggestedPeers.map((f) => f.author!), ...collaboratorRefs, ...getSuggested()]}
          suggestedWhy={collaboratorWhy}
          exclude={[review.employee ?? "", ...askedFeedback.map((f) => f.author ?? "")].filter(Boolean)}
          onClose={() => setNominating(false)}
          onConfirm={(refs) => { onNominate(refs); setNominating(false); }}
        />
      )}
      {/* A goal out of a review line. Prefilled from what the review already says - the goal's own title and
          the manager's verdict on it - because the point is not to retype the conversation that just
          happened. It files a NEW goal against the same person; the review's own line is untouched, since a
          shared review is a record of a moment. */}
      {carryGoal && (
        <WriteDialog
          open
          onClose={() => setCarryGoal(null)}
          title="Carry this into a new goal"
          description={`Files a new goal for ${mine ? "you" : employeeName}. Pick the cycle later on the Goals page - this leaves it unattached.`}
          collection="goals"
          guardLabel="goal"
          form={{ carryTitle, carryDesc, carryWeight, carryDue }}
          submitLabel="Create goal"
          canSubmit={!!carryTitle.trim()}
          whyNot="Give the goal a title."
          submitAccess={(b) => <AccessAction collection="goals" create label="Create a goal">{b}</AccessAction>}
          onSubmit={async () => {
            await create("goals", {
              employee: review.employee ?? "",
              title: carryTitle.trim(),
              description: carryDesc.trim() || null,
              ...(carryWeight ? { weight: Number(carryWeight) } : {}),
              ...(carryDue ? { due_date: carryDue } : {}),
            });
            setCarryGoal(null);
            onGoalsChanged();
          }}
        >
          <Field label="Title"><Input value={carryTitle} onChange={(e) => setCarryTitle(e.target.value)} autoFocus /></Field>
          <Field label="Description" info="Prefilled with the manager's note on this goal, where there was one.">
            <Textarea rows={3} value={carryDesc} onChange={(e) => setCarryDesc(e.target.value)} />
          </Field>
          <FieldRow>
            <Field label="Weight" info="Relative importance against this person's other goals. The attainment score is weighted by it.">
              <Input type="number" min="0" value={carryWeight} onChange={(e) => setCarryWeight(e.target.value)} />
            </Field>
            <Field label="Due date"><Input type="date" value={carryDue} onChange={(e) => setCarryDue(e.target.value)} /></Field>
          </FieldRow>
        </WriteDialog>
      )}
      {/* One name, so the picker confirms on the first pick rather than collecting a set. */}
      {reassigning && (
        <EmployeePicker
          title={`Who writes ${employeeName}'s review?`}
          confirmLabel="Assign reviewer"
          employees={employees}
          departments={departments}
          exclude={[review.employee ?? ""].filter(Boolean)}
          onClose={() => setReassigning(false)}
          onConfirm={(refs) => { if (refs[0]) onAssignReviewer(`employees/${idOf(refs[0])}`); setReassigning(false); }}
        />
      )}
      {/* The reviewee's own list, sent as a whole set: it is a list, not an append log, so re-opening it and
          removing a name withdraws that suggestion. */}
      {suggesting && (
        <EmployeePicker
          title="Who saw your work this cycle?"
          confirmLabel="Save suggestions"
          employees={employees}
          departments={departments}
          suggested={[...collaboratorRefs, ...getSuggested()]}
          suggestedWhy={collaboratorWhy}
          initial={suggestedPeers.map((f) => f.author!)}
          exclude={[review.employee ?? "", ...askedFeedback.map((f) => f.author ?? "")].filter(Boolean)}
          onClose={() => setSuggesting(false)}
          onConfirm={(refs) => { onSuggest(refs); setSuggesting(false); }}
        />
      )}
    </Card>
  );
}

/**
 * The cycle's goals on a review: what was asked for, how far it got, and what it adds up to.
 *
 * The header carries the weighted attainment the server computed from exactly these rows - the one number a
 * goals panel owes a review, and the number the PDF and the calibration grid also print. `frozen` says the
 * rows are the snapshot taken when the review was shared, which is why last year's review still reads the way
 * it did the day it was signed.
 *
 * During the self stage the owner can move a goal's progress here (an unmeasured, open one): the numbers are
 * about to be scored, and making someone leave the review to true them up is how they end up scored wrong.
 */
function GoalsPanel({ goals, attainment, frozen, verdicts, framework, editable, empName, onProgress, onCarryToGoal }: {
  goals: CycleGoal[];
  attainment?: Review["goal_attainment"];
  frozen: boolean;
  verdicts: Record<string, GoalVerdict>;
  framework: PerformanceFramework;
  editable: boolean;
  /** For naming whose goal a contributed line belongs to. */
  empName: (ref?: string) => string;
  onProgress: (goal: CycleGoal, progress: number) => Promise<void>;
  /** Open a new goal prefilled from this line (title + the manager's verdict). Absent where the caller may not create goals. */
  onCarryToGoal?: (goal: CycleGoal) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          Goals this cycle <span className="tabular-nums text-muted-foreground">({goals.length})</span>
          {frozen && <span className="ml-1.5 text-xs font-normal text-muted-foreground">as shared</span>}
        </p>
        {attainment && (
          <span className="text-sm tabular-nums">
            <span className="font-semibold">{attainment.score}%</span>{" "}
            <span className="text-muted-foreground">
              attained{attainment.weighted ? ` · weighted (${attainment.weight_total})` : " · unweighted"}
            </span>
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {goals.map((g) => (
          <li key={g.code} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {/* The shared bar, not a private dot. Every other surface that shows a goal shows how far along
                  it is; this one showed a coloured full stop and a percentage, so the one place the numbers
                  are actually being judged was the hardest place to compare them. Toned by the shared rule
                  too, which means a goal that blew its date inside the cycle now reads as one - the dot
                  coloured by status alone called it healthy. */}
              <GoalProgressBar goal={g} className="hidden w-16 shrink-0 sm:block" />
              {/* Linked, because the snapshot carries `path` and always has - it was used to decide whether
                  to offer the slider and never to get anybody to the goal. A reviewer reading "62%" had no
                  route to the history, the comments or the measure behind it. */}
              {g.path ? (
                <button
                  type="button"
                  onClick={() => navigate(`goals/${idOf(g.path!)}`)}
                  title={`Open “${g.title}”`}
                  className={cn("min-w-0 flex-1 truncate text-left hover:underline", g.status === "cancelled" && "text-muted-foreground line-through")}
                >
                  {g.title}
                </button>
              ) : (
                <span className={cn("min-w-0 flex-1 truncate", g.status === "cancelled" && "text-muted-foreground line-through")}>{g.title}</span>
              )}
              {/* When it was due, and whether it landed late. The snapshot has carried `due_date` since it
                  existed and the review never said it: a goal scored 60% three weeks past its date read
                  exactly like one scored 60% with a month still to run. */}
              <GoalDueChip goal={g} className="shrink-0 text-xs" />
              {/* A goal nobody agreed is still scored - it is what the person worked on - but the review says
                  so on its face rather than presenting it as an objective both sides signed up to. */}
              {/* A share of somebody else's goal: the weight is already scaled, but whose work it was still
                  belongs on the line. The title says WHOSE, not what share of it - the figure is already
                  beside it as text the route mask covers, and a title attribute is never masked (see the
                  trend chart above). */}
              {g.contribution && (
                <span className="shrink-0 text-xs text-muted-foreground" title={`Share of ${empName(g.contribution.owner)}'s goal`}>
                  {g.contribution.share}% share
                </span>
              )}
              {/* The same badge and the same words the Goals page uses. This said "not agreed" / "draft" in
                  its own amber; the cockpit said "Awaiting you"; the card said "Awaiting approval". One
                  stage, three vocabularies. */}
              <GoalStageBadge goal={g} className="shrink-0" />
              {!!g.weight && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">weight {g.weight}</span>}
              {verdicts[g.code]?.rating != null && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={ratingLabel(framework.scale, verdicts[g.code]!.rating!)}>
                  rated {verdicts[g.code]!.rating}
                </span>
              )}
              <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">{g.progress}%</span>
              {/* The development conversation used to die in `goal_ratings`: a manager writes "keep pushing on
                  this next quarter" and then somebody retypes it as a goal, or nobody does. One press carries
                  the line and the verdict into next cycle's goal. */}
              {onCarryToGoal && (
                <AccessAction collection="goals" create label="Make this next cycle's goal">
                  <button
                    type="button"
                    onClick={() => onCarryToGoal(g)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    title="Carry this into a new goal"
                    aria-label={`Carry “${g.title}” into a new goal`}
                  >
                    <Target className="h-3.5 w-3.5" />
                  </button>
                </AccessAction>
              )}
            </div>
            {/* The owner's own account of what happened, which the snapshot has always carried and this
                panel has never shown. It reaches the exported PDF and not the screen the rating is typed on -
                so the manager scoring the goal was reading a percentage while the sentence explaining it sat
                in the payload. It comes FIRST: what happened, then the verdict on it. */}
            {g.retro && (
              <p className="whitespace-pre-wrap pl-3.5 text-sm text-muted-foreground">
                <span className="font-medium text-foreground/80">What happened: </span>{g.retro}
              </p>
            )}
            {verdicts[g.code]?.comment && <p className="pl-3.5 text-sm text-foreground/90">{verdicts[g.code]!.comment}</p>}
            {/* A measured goal's progress is its measure; offering a slider would promise a write the server
                recomputes away. Cancelled and completed goals are settled. */}
            {editable && !g.measured && g.status !== "cancelled" && g.status !== "completed" && g.path && (
              <GoalProgressRow goal={g} onProgress={onProgress} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The self-stage progress control for one goal: drag, then save. Explicit rather than save-on-release, so a
// scrub past 100 doesn't complete a goal by accident.
function GoalProgressRow({ goal, onProgress }: { goal: CycleGoal; onProgress: (goal: CycleGoal, progress: number) => Promise<void> }) {
  const [value, setValue] = useState(goal.progress);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(goal.progress), [goal.path, goal.progress]);
  const dirty = value !== goal.progress;
  return (
    <div className="flex items-center gap-2 pl-3.5">
      <input
        type="range" min={0} max={100} step={5} value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-label={`Progress on ${goal.title}`}
        className="h-1.5 w-full cursor-pointer accent-primary"
      />
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{value}%</span>
      <Button
        size="sm" variant="outline" className="shrink-0" disabled={!dirty} loading={saving}
        onClick={async () => { setSaving(true); try { await onProgress(goal, value); } finally { setSaving(false); } }}
      >
        Save
      </Button>
    </div>
  );
}

// A 360 feedback request addressed to the caller: who it's about, a comment, an optional overall rating.
function FeedbackRequestCard({ request, subjectName, framework, onSubmit, onDecline }: {
  request: ReviewFeedback;
  subjectName: string;
  framework: PerformanceFramework;
  onSubmit: (body: { comment: string; overall_rating?: number }) => Promise<void>;
  onDecline: (reason?: string) => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [overall, setOverall] = useState<number | undefined>(undefined);
  // Declining opens one line rather than firing immediately: "I have not worked with them this cycle" tells
  // the manager to nominate somebody else, where a bare decline leaves them guessing.
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
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
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setDeclining((d) => !d)}>Decline</Button>
        </AccessAction>
      </div>
      {declining && (
        <div className="space-y-2 rounded-md border border-dashed p-2.5">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Why? (optional) e.g. we haven't worked together this cycle"
            aria-label="Reason for declining"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" loading={busy === "decline"} onClick={run("decline", () => onDecline(reason.trim() || undefined))}>Decline the request</Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => { setDeclining(false); setReason(""); }}>Keep it</Button>
          </div>
        </div>
      )}
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
  const ratedGoals = (review.goals ?? []).filter((g) => review.goal_ratings?.[g.code]?.rating != null || review.goal_ratings?.[g.code]?.comment);
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
            <div key={comp.key} className="flex items-start justify-between gap-2 text-sm">
              <span className="min-w-0 text-muted-foreground">
                {comp.label}
                {comp.weight ? <span className="ml-1.5 text-xs tabular-nums">wt {comp.weight}</span> : null}
                {/* The definition travels with the score: this panel is read months later, by people who
                    were not in the conversation. */}
                {comp.description && <span className="mt-0.5 block text-xs">{comp.description}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {/* Self vs manager: a wide gap is the thing worth talking about, so it gets the accent. */}
                {self != null && <span className={cn("text-xs", gap ? "font-medium text-warning" : "text-muted-foreground")}>self: {self}</span>}
                <span>{mgr != null ? `${mgr} · ${ratingLabel(framework.scale, mgr)}` : "-"}</span>
              </span>
            </div>
          );
        })}
        {/* Server-computed, from the same framework the PDF uses - so the page, the export and the
            calibration grid never quote three different numbers for one review. */}
        {review.competency_score && (
          <div className="flex items-center justify-between gap-2 border-t pt-1.5 text-sm">
            <span className="font-medium">
              Competency score
              {!review.competency_score.weighted && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(unweighted mean)</span>}
            </span>
            <span className="font-semibold tabular-nums">{review.competency_score.score}</span>
          </div>
        )}
      </div>
      {/* The per-goal verdicts, where the manager left any. The goals themselves are listed by GoalsPanel
          above; this is the assessment of them, so it sits with the rest of the manager's. */}
      {ratedGoals.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          {ratedGoals.map((g) => {
            const v = review.goal_ratings?.[g.code];
            return (
              <div key={g.code} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">{g.title}</span>
                  {v?.rating != null && <span className="shrink-0 tabular-nums">{v.rating} · {ratingLabel(framework.scale, v.rating)}</span>}
                </div>
                {v?.comment && <p className="text-foreground/90">{v.comment}</p>}
              </div>
            );
          })}
        </div>
      )}
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
