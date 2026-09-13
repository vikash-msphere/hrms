import { useMemo, useState } from "react";
import { BellRing, MessageSquareDashed, TrendingDown, CheckCircle2, Inbox } from "lucide-react";
import { invoke } from "@/api";
import { navigate } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { Employee, Goal, Me, ReviewCycle } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { TruncationNotice } from "@/components/common/TruncationNotice";

const STALE_DAYS = 21;

// The four questions this page sorts and counts by. At MODULE scope because each is pure over the goal it is
// handed: inside the component they were rebuilt every render, so the three memos that call them either
// listed a dependency that changed on every pass or - as here - quietly left them out and kept whichever
// closure they were first given. Nothing to depend on now, and the predicates read the same everywhere.
const isOpen = (g: Goal) => g.status === "in_progress" || g.status === "not_started";
const behind = (g: Goal) => g.pace === "behind" || g.pace === "at_risk" || g.confidence === "at_risk" || g.confidence === "off_track";
const quiet = (g: Goal) => (g.stale_days ?? 0) >= STALE_DAYS;
const troubled = (g: Goal) => behind(g) || quiet(g);

/**
 * The manager's view of their reports' goals: who is sliding, and who has gone quiet.
 *
 * The Goals page answers an owner's question - "what am I working on" - as a wall of cards. A manager's
 * question is a different one, and answering it there means opening fourteen cards to compare them. This is
 * one row per goal, grouped by person, sorted by trouble: behind pace first, then silent, then everything
 * else. Nothing here is new data; it is the same rows read through the manager's own scope, arranged around
 * the question they were always for.
 *
 * Mid-cycle, and NOT part of a review: it reads `goals` under `goals.read` and presses goal verbs (agree a
 * proposed goal, ask for an update). Reviews score a frozen goal set at the end of a cycle under
 * `reviews.read`, and this works in an org that runs no cycles at all - the cycle picker is only a filter.
 */
export default function GoalCockpit({ me }: { me: Me }) {
  const { rows: goals, state, error, reload } = useCollection<Goal>("goals");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles");
  const { toast } = useToast();
  const [cycle, setCycle] = useState("all");
  const [only, setOnly] = useState<"trouble" | "unagreed" | "all">("trouble");
  const [busy, setBusy] = useState("");

  // Other people's goals only: a manager reviewing their own alongside their reports' reads as a to-do list,
  // and the press this page offers (nudge, agree) is not one anybody applies to themselves.
  const scoped = useMemo(() => {
    return goals.filter((g) => {
      if (!isOpen(g) || g.delete_time) return false;
      if (g.employee && idOf(g.employee) === me.employee_id) return false;
      if (cycle !== "all" && idOf(g.cycle ?? "") !== idOf(cycle)) return false;
      if (only === "trouble") return troubled(g);
      if (only === "unagreed") return g.stage !== "AGREED";
      return true;
    });
  }, [goals, cycle, only, me.employee_id]);

  // One block per person, people with the most trouble first - the order the question is asked in.
  const byPerson = useMemo(() => {
    const map = new Map<string, Goal[]>();
    for (const g of scoped) {
      const key = idOf(g.employee ?? "");
      (map.get(key) ?? map.set(key, []).get(key)!).push(g);
    }
    const rank = (g: Goal) => (g.pace === "at_risk" || g.confidence === "off_track" ? 0 : behind(g) ? 1 : quiet(g) ? 2 : 3);
    return [...map.entries()]
      .map(([id, list]) => ({
        id,
        person: employees.find((e) => idOf(e.path) === id),
        goals: [...list].sort((a, b) => rank(a) - rank(b) || (a.drift ?? 0) - (b.drift ?? 0)),
      }))
      .sort((a, b) => a.goals.filter(troubled).length === b.goals.filter(troubled).length
        ? (a.person ? `${a.person.first_name} ${a.person.last_name}` : "").localeCompare(b.person ? `${b.person.first_name} ${b.person.last_name}` : "")
        : b.goals.filter(troubled).length - a.goals.filter(troubled).length);
  }, [scoped, employees]);

  const counts = useMemo(() => {
    const mine = goals.filter((g) => isOpen(g) && !g.delete_time && g.employee && idOf(g.employee) !== me.employee_id);
    return {
      trouble: mine.filter(troubled).length,
      unagreed: mine.filter((g) => g.stage !== "AGREED").length,
      all: mine.length,
    };
  }, [goals, me.employee_id]);

  async function act(g: Goal, verb: "comment" | "approve", body?: Record<string, unknown>, okMsg?: string) {
    setBusy(g.path);
    try {
      await invoke(`goals/${idOf(g.path)}`, verb, undefined, body);
      toast({ title: okMsg ?? "Done", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't do that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy("");
    }
  }

  // Asking for an update IS a comment: the owner is notified, the goal stops being silent, and the ask is on
  // the record where the answer will land - rather than in a chat message nobody can find next quarter.
  const nudge = (g: Goal) =>
    act(g, "comment", { body: "Could you post an update on this one - where has it got to, and is anything blocking it?" }, "Update requested");

  return (
    <div>
      <PageHeader
        accessCollection="goals"
        title="Team goals"
        description="Your reports' open goals, sorted by trouble: behind pace first, then the ones nobody has touched."
      />

      <TruncationNotice collection="goals" what="goals" className="mb-3" />

      <DataState state={state} error={error} onRetry={reload}>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {([["trouble", "Needs attention"], ["unagreed", "Not agreed"], ["all", "All open"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setOnly(key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                only === key ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {label} <span className="tabular-nums opacity-70">{counts[key]}</span>
            </button>
          ))}
          {cycles.length > 0 && (
            <Select value={cycle} onValueChange={setCycle}>
              <SelectTrigger className="ml-auto h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All cycles</SelectItem>
                {cycles.map((c) => <SelectItem key={c.path} value={c.path}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        {byPerson.length === 0 ? (
          <EmptyState
            icon={only === "trouble" ? CheckCircle2 : Inbox}
            title={only === "trouble" ? "Nothing needs chasing" : "Nothing to show"}
            description={only === "trouble"
              ? "Every goal you can see is on pace and has been updated recently."
              : "No open goals match this filter."}
          />
        ) : (
          <div className="space-y-4">
            {byPerson.map(({ id, person, goals: list }) => (
              <Card key={id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                  {person && <PhotoAvatar employeeId={idOf(person.path)} name={`${person.first_name} ${person.last_name}`} photo={person.photo} className="h-7 w-7" />}
                  <span className="font-semibold">{person ? `${person.first_name} ${person.last_name}` : "Someone"}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{list.length} goal{list.length === 1 ? "" : "s"}</span>
                  {list.filter(troubled).length > 0 && (
                    <Badge variant="warning">{list.filter(troubled).length} needing attention</Badge>
                  )}
                </div>
                <ul className="divide-y">
                  {list.map((g) => (
                    <li key={g.path} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                        onClick={() => navigate(`goals/${idOf(g.path)}`)}
                        title={g.title}
                      >
                        {g.title}
                      </button>
                      {g.stage !== "AGREED" && <Badge variant={g.stage === "PROPOSED" ? "secondary" : "muted"}>{g.stage === "PROPOSED" ? "Awaiting you" : "Draft"}</Badge>}
                      {behind(g) && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                          <TrendingDown className="h-3 w-3" />
                          {g.drift != null && g.drift < 0 ? `${-g.drift} behind` : g.confidence === "off_track" ? "off track" : "at risk"}
                        </span>
                      )}
                      {quiet(g) && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`No update for ${g.stale_days} days`}>
                          <MessageSquareDashed className="h-3 w-3" /> {g.stale_days}d
                        </span>
                      )}
                      {g.due_date && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(g.due_date)}</span>}
                      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{g.progress ?? 0}%</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {g.stage === "PROPOSED" && (
                          <AccessAction verb="approve" can={g.access?.can} label="Agree this goal">
                            <Button variant="ghost" size="sm" loading={busy === g.path} onClick={() => act(g, "approve", undefined, "Goal agreed")}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Agree
                            </Button>
                          </AccessAction>
                        )}
                        <AccessAction verb="comment" can={g.access?.can} label="Ask for an update">
                          <Button variant="ghost" size="sm" className="text-muted-foreground" loading={busy === g.path} onClick={() => nudge(g)}>
                            <BellRing className="h-3.5 w-3.5" /> Ask for an update
                          </Button>
                        </AccessAction>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
