import { Fragment, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, ChevronRight, Check, SkipForward, UserPlus, MessageSquareQuote } from "lucide-react";
import { get, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import type { Department, Employee, Review, ReviewCycle, ReviewState, ReviewFeedback, Me, Card as KanbanCard } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { ActivitySection } from "@/components/common/ActivitySection";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/common/confirm";
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

  return (
    <div>
      <PageHeader
        title="Reviews"
        description="Your performance reviews and self-assessments."
        actions={<PageSettings me={me} host="reviews" />}
      />

      {myRequests.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><MessageSquareQuote className="h-4 w-4 text-primary" /> Feedback requested from you <Badge variant="secondary">{myRequests.length}</Badge></h2>
          <div className="space-y-3">
            {myRequests.map((f) => (
              <FeedbackRequestCard
                key={f.path}
                request={f}
                subjectName={empName(f.reviewee)}
                framework={framework}
                onSubmit={(body) => feedbackAct(f, "submitFeedback", body)}
                onDecline={() => feedbackAct(f, "decline")}
              />
            ))}
          </div>
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          myRequests.length === 0 && <EmptyState icon={ClipboardCheck} title="No reviews yet" description="When HR launches a review cycle that includes you, your review will appear here." />
        ) : (
          <div className="space-y-4">
            {sorted.map((r) => (
              <ReviewCard
                key={r.path}
                review={r}
                cycle={cycleOf(r.cycle)}
                mine={mine(r)}
                employeeName={empName(r.employee)}
                deliveredCards={deliveredFor(r.employee, cycleOf(r.cycle))}
                empName={empName}
                framework={framework}
                employees={employees}
                departments={departments}
                onSubmitSelf={(self_comment) => act(r, "submitSelf", { self_comment })}
                onSubmitManager={(body) => act(r, "submitManager", body)}
                onAcknowledge={() => act(r, "acknowledge")}
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
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}

function ReviewCard({ review, cycle, mine, employeeName, deliveredCards, empName, framework, employees, departments, onSubmitSelf, onSubmitManager, onAcknowledge, onSkip, onNominate }: {
  review: Review;
  cycle?: ReviewCycle;
  mine: boolean;
  employeeName: string;
  deliveredCards: KanbanCard[];
  empName: (ref?: string) => string;
  framework: PerformanceFramework;
  employees: Employee[];
  departments: Department[];
  onSubmitSelf: (selfComment: string) => Promise<void>;
  onSubmitManager: (body: { ratings: Record<string, number>; overall_rating?: number; manager_comment?: string }) => Promise<void>;
  onAcknowledge: () => Promise<void>;
  onSkip: () => Promise<void>;
  onNominate: (employees: string[]) => void;
}) {
  const can = review.access?.can ?? [];
  const [nominating, setNominating] = useState(false);
  const feedback = review.feedback ?? [];

  // Long-form review text survives navigating away: drafts persist per review until submitted.
  const draftKey = (field: string) => `review-draft:${review.path}:${field}`;
  const loadDraft = (field: string) => { try { return localStorage.getItem(draftKey(field)) ?? ""; } catch { return ""; } };
  const saveDraft = (field: string, v: string) => { try { v.trim() ? localStorage.setItem(draftKey(field), v) : localStorage.removeItem(draftKey(field)); } catch { /* private mode */ } };
  const clearDraft = (field: string) => { try { localStorage.removeItem(draftKey(field)); } catch { /* private mode */ } };

  const [selfText, setSelfText] = useState(review.self_comment || loadDraft("self"));
  const [ratings, setRatings] = useState<Record<string, number>>(review.ratings ?? {});
  const [overall, setOverall] = useState<number | undefined>(review.overall_rating);
  const [mgrComment, setMgrComment] = useState(review.manager_comment || loadDraft("manager"));

  // One in-flight verb at a time; the clicked button spins, the rest stay idle.
  const [busy, setBusy] = useState<"" | "self" | "manager" | "ack" | "skip">("");
  const run = (key: "self" | "manager" | "ack" | "skip", fn: () => Promise<void>) => async () => {
    setBusy(key);
    try { await fn(); } finally { setBusy(""); }
  };

  // The current stage's deadline comes from the cycle (self vs manager due dates).
  const stageDue = review.state === "SELF" ? cycle?.self_due_date : review.state === "MANAGER" ? cycle?.manager_due_date : undefined;
  const stageOverdue = !!stageDue && stageDue < todayStr();

  const skipBtn = can.includes("skipStage") && review.state !== "ACKNOWLEDGED" ? (
    <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === "skip"} onClick={run("skip", onSkip)}><SkipForward className="h-3.5 w-3.5" /> Skip stage</Button>
  ) : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          <span className="font-semibold">{cycle?.name ?? "Review"}</span>
          {!mine && <span className="text-sm text-muted-foreground">· {employeeName}</span>}
          {stageDue && (
            <span className={cn("text-xs tabular-nums", stageOverdue ? "font-medium text-destructive" : "text-muted-foreground")}>
              · {stageOverdue ? "was due" : "due"} {formatDate(stageDue)}
            </span>
          )}
        </div>
        <StageTrail state={review.state} />
      </div>

      <div className="space-y-4 p-4">
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
            <Textarea rows={4} value={selfText} onChange={(e) => { setSelfText(e.target.value); saveDraft("self", e.target.value); }} placeholder="Summarise your impact, wins, and where you want to grow." />
            <div className="flex items-center gap-2">
              <Button size="sm" loading={busy === "self"} disabled={!selfText.trim()} onClick={run("self", async () => { await onSubmitSelf(selfText.trim()); clearDraft("self"); })}>Submit self-assessment <ChevronRight className="h-3.5 w-3.5" /></Button>
              {skipBtn}
            </div>
          </div>
        ) : review.state === "SELF" ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{mine ? "Complete your self-assessment to begin." : `Waiting for ${employeeName || "the employee"} to complete their self-assessment.`}</p>
            {skipBtn}
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
                <span className="text-sm">{comp.label}</span>
                <ScalePicker scale={framework.scale} value={ratings[comp.key]} onPick={(v) => setRatings((r) => ({ ...r, [comp.key]: v }))} />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <span className="text-sm font-medium">Overall</span>
              <ScalePicker scale={framework.scale} value={overall} onPick={setOverall} />
            </div>
            <Textarea rows={3} value={mgrComment} onChange={(e) => { setMgrComment(e.target.value); saveDraft("manager", e.target.value); }} placeholder="Overall feedback for the employee." />
            <div className="flex items-center gap-2">
              <Button size="sm" loading={busy === "manager"} onClick={run("manager", async () => { await onSubmitManager({ ratings, overall_rating: overall, manager_comment: mgrComment.trim() }); clearDraft("manager"); })}>Share with employee <ChevronRight className="h-3.5 w-3.5" /></Button>
              {skipBtn}
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
            {skipBtn}
          </div>
        )}

        {/* 360 peer feedback. Managers/HR (can nominate) see authors + progress and can request more; the
            employee sees only the anonymized submitted entries (server-gated, present once shared). */}
        {(can.includes("nominate") || feedback.length > 0) && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium"><MessageSquareQuote className="h-4 w-4 text-muted-foreground" /> Peer feedback</p>
              {can.includes("nominate") && (
                <Button variant="outline" size="sm" onClick={() => setNominating(true)}><UserPlus className="h-3.5 w-3.5" /> Request feedback</Button>
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

        {/* Shared / acknowledged: manager assessment is visible. */}
        {(review.state === "SHARED" || review.state === "ACKNOWLEDGED") && (
          <ManagerResult review={review} framework={framework} />
        )}

        {review.state === "SHARED" && (
          <div className="flex items-center justify-between gap-2">
            {mine && can.includes("acknowledge") ? (
              <Button size="sm" loading={busy === "ack"} onClick={run("ack", onAcknowledge)}><Check className="h-3.5 w-3.5" /> Acknowledge</Button>
            ) : (
              <p className="text-sm text-muted-foreground">Shared with {mine ? "you" : employeeName}. Awaiting acknowledgement.</p>
            )}
            {!mine && skipBtn}
          </div>
        )}
        {review.state === "ACKNOWLEDGED" && (
          <p className="flex items-center gap-1.5 text-sm font-medium text-success"><Check className="h-4 w-4" /> Acknowledged by {mine ? "you" : employeeName}.</p>
        )}
      </div>

      <ActivitySection resource={review.path} className="border-t pt-4" />

      {nominating && (
        <EmployeePicker
          title={`Request 360 feedback on ${employeeName}`}
          confirmLabel="Send requests"
          employees={employees}
          departments={departments}
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
        <Button size="sm" loading={busy === "submit"} onClick={run("submit", () => onSubmit({ comment: comment.trim(), overall_rating: overall }))} disabled={!comment.trim() && overall == null}>Submit feedback</Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === "decline"} onClick={run("decline", onDecline)}>Decline</Button>
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
        {framework.competencies.map((comp) => (
          <div key={comp.key} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{comp.label}</span>
            <span className="tabular-nums">{ratings[comp.key] != null ? `${ratings[comp.key]} · ${ratingLabel(framework.scale, ratings[comp.key])}` : "-"}</span>
          </div>
        ))}
      </div>
      {review.manager_comment && <Section label="Feedback">{review.manager_comment}</Section>}
    </div>
  );
}

// A segmented 1..N rating picker.
function ScalePicker({ scale, value, onPick }: { scale: { value: number; label: string }[]; value?: number; onPick: (v: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
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
