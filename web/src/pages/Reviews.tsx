import { Fragment, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, ChevronRight, Check, SkipForward, UserPlus, MessageSquareQuote, CircleAlert, Hourglass, CheckCircle2, AlarmClock, ChevronsDownUp, ChevronsUpDown, BellRing, FileDown } from "lucide-react";
import { get, invoke } from "@/api";
import { useRoute, setQueryParams } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Goal, Review, ReviewCycle, ReviewState, ReviewFeedback, Me, Card as KanbanCard } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
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
  const { rows: cards } = useCollection<KanbanCard>("cards");
  const { rows: goals } = useCollection<Goal>("goals");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  const reloadAll = () => { reload(); reloadFb(); };

  useEffect(() => {
    get<{ value?: Partial<PerformanceFramework> }>("settings/performance")
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
  const mine = (r: Review) => !!r.employee && idOf(r.employee) === me.employee_id;
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

  // A review the caller can move forward right now sorts (and reads) as "needs you".
  const needsMe = (r: Review) => {
    const can = r.access?.can ?? [];
    return (
      (r.state === "SELF" && mine(r) && can.includes("submitSelf")) ||
      (r.state === "MANAGER" && can.includes("submitManager")) ||
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
    [reviews, cycles, me.employee_id],
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

  // 360 feedback requests addressed to the caller that still need a response.
  const myRequests = useMemo(() => feedbackReqs.filter((f) => f.state === "REQUESTED"), [feedbackReqs]);

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

  const empOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [employees]);

  // List filters: a status chip row plus (when reviews span several cycles) a cycle menu. Managers/HR
  // accumulate reviews fast; everyone else just sees the chips echo the summary strip. Both filters live
  // in the hash query (?filter=&cycle=) so a filtered view survives reload and can be shared.
  type Filter = "all" | "needs" | "open" | "done";
  const route = useRoute();
  const isFilter = (v?: string): v is Filter => v === "needs" || v === "open" || v === "done";
  const [filter, setFilter] = useState<Filter>(() => (isFilter(route.query.filter) ? route.query.filter : "all"));
  const [cycleFilter, setCycleFilter] = useState(() => route.query.cycle ?? "all");
  const applyFilter = (f: Filter) => { setFilter(f); setQueryParams({ filter: f === "all" ? null : f }); };
  const applyCycle = (id: string) => { setCycleFilter(id); setQueryParams({ cycle: id === "all" ? null : id }); };
  const counts: Record<Filter, number> = {
    all: reviews.length,
    needs: reviews.filter(needsMe).length,
    open: reviews.filter((r) => r.state !== "ACKNOWLEDGED").length,
    done: reviews.filter((r) => r.state === "ACKNOWLEDGED").length,
  };
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
      (cycleFilter === "all" || (!!r.cycle && idOf(r.cycle) === cycleFilter)) &&
      (filter === "all" ||
        (filter === "needs" ? needsMe(r) : filter === "done" ? r.state === "ACKNOWLEDGED" : r.state !== "ACKNOWLEDGED")),
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

  // The current stage's deadline (self vs manager due date) comes from the cycle; overdue is the first
  // thing HR scans for, so it gets a summary-strip count and a card accent, not just the header text.
  const stageDueOf = (r: Review) => {
    const cyc = cycleOf(r.cycle);
    return r.state === "SELF" ? cyc?.self_due_date : r.state === "MANAGER" ? cyc?.manager_due_date : undefined;
  };
  const overdueCount = reviews.filter((r) => { const d = stageDueOf(r); return !!d && d < todayStr(); }).length;

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
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const defaultOpen = (r: Review) => needsMe(r) || sorted.length === 1;
  const isOpen = (r: Review) => openMap[r.path] ?? defaultOpen(r);
  const setAllOpen = (open: boolean) => setOpenMap(Object.fromEntries(visible.map((r) => [r.path, open])));

  // Deep link: #/reviews/<id> (notification clicks) opens that card and scrolls it into view.
  useEffect(() => {
    if (!route.id) return;
    const target = reviews.find((r) => idOf(r.path) === route.id);
    if (!target) return;
    setOpenMap((m) => (m[target.path] ? m : { ...m, [target.path]: true }));
    requestAnimationFrame(() => document.getElementById(`review-${route.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [route.id, reviews.length]);

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
        description="Your performance reviews and self-assessments."
        actions={<PageSettings me={me} host="reviews" />}
      />

      {reviews.length > 0 && (
        <SummaryStrip
          items={[
            { label: "Need you", value: counts.needs, icon: CircleAlert, tone: counts.needs > 0 ? "warning" : "muted" },
            { label: "In progress", value: counts.open, icon: Hourglass, tone: "primary" },
            { label: "Completed", value: counts.done, icon: CheckCircle2, tone: counts.done > 0 ? "success" : "muted" },
            ...(overdueCount > 0 ? [{ label: "Overdue", value: overdueCount, icon: AlarmClock, tone: "destructive" as const }] : []),
          ]}
        />
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

      <DataState state={state} error={error} onRetry={reload}>
        {reviews.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {filterChip("all", "All")}
            {filterChip("needs", "Needs you")}
            {filterChip("open", "In progress")}
            {filterChip("done", "Completed")}
            <span className="ml-auto flex items-center gap-1">
              {cycleOptions.length > 1 && (
                <Select value={cycleFilter} onValueChange={applyCycle}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
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
            action={<Button variant="outline" size="sm" onClick={() => { setFilter("all"); setCycleFilter("all"); }}>Clear filters</Button>}
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
  const [ratings, setRatings] = useState<Record<string, number>>(review.ratings ?? {});
  const [overall, setOverall] = useState<number | undefined>(review.overall_rating);
  const [mgrComment, setMgrComment] = useState(review.manager_comment || loadDraft("manager"));
  const [ackComment, setAckComment] = useState("");
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);

  // One in-flight verb at a time; the clicked button spins, the rest stay idle.
  type BusyKey = "" | "self" | "manager" | "ack" | "skip" | "nudge";
  const [busy, setBusy] = useState<BusyKey>("");
  const run = (key: Exclude<BusyKey, "">, fn: () => Promise<void>) => async () => {
    setBusy(key);
    try { await fn(); } finally { setBusy(""); }
  };

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
          {!mine && <span className="text-sm text-muted-foreground">· {employeeName}</span>}
          {needsAction && <Badge variant="warning">Needs you</Badge>}
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
          <div className="flex items-center justify-between gap-2">
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
            {framework.competencies.map((comp) => (
              <div key={comp.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {comp.label}
                  {review.self_ratings?.[comp.key] != null && <span className="ml-1.5 text-xs text-muted-foreground">self: {review.self_ratings[comp.key]}</span>}
                </span>
                <ScalePicker scale={framework.scale} value={ratings[comp.key]} onPick={(v) => setRatings((r) => ({ ...r, [comp.key]: v }))} />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <span className="text-sm font-medium">Overall</span>
              <ScalePicker scale={framework.scale} value={overall} onPick={setOverall} />
            </div>
            <Textarea rows={3} value={mgrComment} onChange={(e) => { setMgrComment(e.target.value); saveDraft("manager", e.target.value); }} placeholder="Overall feedback for the employee." />
            <div className="flex flex-wrap items-center gap-2">
              <AccessAction verb="submitManager" can={can} label="Submit manager review">
                <Button size="sm" loading={busy === "manager"} onClick={run("manager", async () => { await onSubmitManager({ ratings, overall_rating: overall, manager_comment: mgrComment.trim() }); clearDraft("manager"); })}>Share with employee <ChevronRight className="h-3.5 w-3.5" /></Button>
              </AccessAction>
              {skipBtn}
              {!!mgrComment.trim() && <span className="ml-auto text-xs text-muted-foreground">Draft saved on this device</span>}
            </div>
          </div>
        )}
        {review.state === "MANAGER" && !can.includes("submitManager") && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {mine
                ? "Your manager is writing their review. Ratings and feedback stay hidden until they're shared with you - nothing is needed from you right now."
                : `Waiting for ${employeeName || "the employee"}'s manager to finish their review.`}
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
            <div className="flex items-center justify-between gap-2">
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
        <AccessAction verb="submitFeedback" label="Submit 360 feedback">
          <Button size="sm" loading={busy === "submit"} onClick={run("submit", () => onSubmit({ comment: comment.trim(), overall_rating: overall }))} disabled={!comment.trim() && overall == null}>Submit feedback</Button>
        </AccessAction>
        <AccessAction verb="decline" label="Decline feedback request">
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
