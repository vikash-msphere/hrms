import { useMemo, useState } from "react";
import { BellRing, CheckCircle2 } from "lucide-react";
import { invoke } from "@/api";
import { navigate } from "@/router";
import { idOf } from "@/lib/utils";
import { isTroubled, troubleRank } from "@/lib/goalState";
import { weightedProgress } from "@/lib/goalMeasure";
import { GoalDueChip, GoalPaceChip, GoalProgressBar, GoalQuietChip, GoalStageBadge } from "@/components/common/GoalChips";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import type { Department, Employee, Goal, Me } from "@/types";

/**
 * Other people's goals as a chasing pass: one row per goal, grouped by person, worst first.
 *
 * A LAYOUT, not a page. The Goals page answers "whose goals am I looking at" with its scope, and this is how
 * it draws the answer once that answer is other people: fourteen cards is the wrong shape for "who is sliding
 * and who has gone quiet", which is a comparison, and a comparison wants rows.
 *
 * It was its own page - `/team-goals` - which meant the app had two surfaces over nearly the same set, one
 * called "Other people's goals" and one called "Team goals", each with its own filters and its own copy
 * explaining how it differed from the other. The rows, the grouping and the two presses on them are worth
 * keeping; the second page around them was not.
 *
 * Everything that DECIDES which goals these are - the scope, the chips, the cycle, the team, the search, the
 * counts, the paging - belongs to the page. This takes the rows it is given.
 */
export function TeamTriage({ goals, employees, departments = [], me, deptName, onChanged, onOpen }: {
  /** The rows to draw, already scoped and filtered by the page. */
  goals: Goal[];
  employees: Employee[];
  /** The department tree, to head each team's people with the team's full path. Empty draws one ungrouped list. */
  departments?: Department[];
  me: Me;
  deptName: (ref?: string | null) => string | undefined;
  /** Re-read after a verb lands, so the row it changed stops being in the state that put it here. */
  onChanged: () => void;
  /**
   * Open one goal's drawer, in place.
   *
   * The title used to `navigate("goals/<id>")`, which is a different ROUTE: it left the triage, dropped the
   * scope, the chips and the cycle that produced this queue, and re-opened the goal on the wall of cards -
   * so glancing at one goal during a chasing pass cost the pass. The drawer belongs to the page, it already
   * walks the rows on screen with ‹ ›, and this is a row of those rows.
   */
  onOpen: (g: Goal) => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  // Keyed by VERB and path, not path alone: one shared key put both of a row's buttons into the loading state
  // for whichever one was pressed, so agreeing a goal spun the "ask for an update" button beside it as well.
  const [busy, setBusy] = useState("");
  // Goals already nudged in this visit. Asking for an update posts a comment and notifies the owner, and the
  // button gives no sign it worked when the goal is behind as well as silent (it stays in the list, because
  // being behind is why it is there) - so pressing it twice, three times, is the obvious thing to do, and the
  // owner gets the same canned paragraph three times.
  const [asked, setAsked] = useState<string[]>([]);
  /** The reader's own goal - in this list only because a team owns it. */
  const mine = (g: Goal) => !!g.employee && idOf(g.employee) === me.employee_id;

  // One block per person, people with the most trouble first - the order the question is asked in.
  const byPerson = useMemo(() => {
    const map = new Map<string, Goal[]>();
    for (const g of goals) {
      const key = idOf(g.employee ?? "");
      (map.get(key) ?? map.set(key, []).get(key)!).push(g);
    }
    return [...map.entries()]
      .map(([id, list]) => {
        const person = employees.find((e) => idOf(e.path) === id);
        return {
          id,
          person,
          name: person ? `${person.first_name} ${person.last_name}` : "",
          // Counted once per person rather than four times per comparison: the old sort re-walked both
          // people's goals on every comparison, which is a full pass over the page per pair.
          inTrouble: list.filter(isTroubled).length,
          // The one number a manager reads per person: how far this block has got, weighted the way a review
          // weighs it. Reading it off six bars by eye is the comparison this layout exists to spare them.
          avg: weightedProgress(list),
          // `troubleRank` is the shared order: a missed date ranks with the worst of them, because it is the
          // one signal that is a fact rather than a forecast.
          goals: [...list].sort((a, b) => troubleRank(a) - troubleRank(b) || (a.drift ?? 0) - (b.drift ?? 0)),
        };
      })
      .sort((a, b) => b.inTrouble - a.inTrouble || a.name.localeCompare(b.name));
  }, [goals, employees]);

  // People under their TEAM, when the list spans more than one.
  //
  // Team goals is every team the reader can see, and "My team" reaches into the sub-departments of the ones they
  // manage - so a flat run of people answers "who is sliding" and not "which team is". A person's team is their
  // department; the ownerless block's is the team that owns its goals. Headed by the full path ("Engineering ›
  // Platform"), so a sub-department is placed under its parent, and sorted by it, which keeps each subtree
  // together. Inside a team the people keep the worst-first order above. One team, or no department data, draws
  // the flat list with no heading - a heading over everything says nothing.
  const byTeam = useMemo(() => {
    const byId = new Map(departments.filter((d) => !d.delete_time).map((d) => [idOf(d.path), d]));
    const pathOf = (id: string) => {
      const names: string[] = [];
      let at = byId.get(id);
      // Bounded, so a corrupt cycle in the tree cannot spin.
      for (let i = 0; at && i < 32; i++) {
        names.unshift(at.display_name);
        at = at.parent ? byId.get(idOf(at.parent)) : undefined;
      }
      return names.join(" › ");
    };
    const groups = new Map<string, { label: string; blocks: typeof byPerson }>();
    for (const block of byPerson) {
      const ref = block.person ? block.person.department : block.goals.find((g) => g.department)?.department;
      const id = ref ? idOf(ref) : "";
      const label = (id && pathOf(id)) || "No team";
      const key = label === "No team" ? "" : id;
      (groups.get(key) ?? groups.set(key, { label, blocks: [] }).get(key)!).blocks.push(block);
    }
    return [...groups.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label)));
  }, [byPerson, departments]);

  async function act(g: Goal, verb: "comment" | "approve", body?: Record<string, unknown>, okMsg?: string) {
    setBusy(`${verb}:${g.path}`);
    try {
      await invoke(`goals/${idOf(g.path)}`, verb, undefined, body);
      toast({ title: okMsg ?? "Done", variant: "success" });
      onChanged();
      return true;
    } catch (e) {
      toast({ title: "Couldn't do that", description: (e as Error).message, variant: "destructive" });
      return false;
    } finally {
      setBusy("");
    }
  }

  // Agreeing a goal is a decision, not an edit: it ends the goal-setting handshake, notifies the owner, and
  // the goal it settles is what the cycle's review scores and variable pay is computed from. It asks first,
  // the same way every other approval in the app does (lib/confirmDecision.ts).
  async function agree(g: Goal, ownerName: string | null) {
    if (!(await confirmDecision(confirm, "approve", ownerName ? `${ownerName}'s goal “${g.title}”` : `the goal “${g.title}”`))) return;
    await act(g, "approve", undefined, "Goal agreed");
  }

  // Asking for an update IS a comment: the owner is notified, the goal stops being silent, and the ask is on
  // the record where the answer will land - rather than in a chat message nobody can find next quarter.
  const NUDGE = "Could you post an update on this one - where has it got to, and is anything blocking it?";
  async function nudge(g: Goal) {
    const ok = await act(g, "comment", { body: NUDGE }, "Update requested");
    if (ok) setAsked((a) => (a.includes(g.path) ? a : [...a, g.path]));
  }

  // The same ask, over one person's whole block.
  //
  // This is a chasing pass: a manager reads a person's four silent goals and wants one message about all four,
  // and the row-at-a-time button made that four presses and four identical toasts. It asks first, because it
  // reaches somebody else's notifications once per goal, and it reports what actually landed - a run that
  // stops halfway has still notified them about the ones it got through.
  async function nudgeAll(list: Goal[], personName: string, key: string) {
    if (
      !(await confirm({
        title: `Ask ${personName} about ${list.length} goals?`,
        description: `Each goal gets the same short request as a comment on it, and ${personName} is notified once per goal.`,
        confirmLabel: `Ask about ${list.length}`,
      }))
    ) return;
    setBusy(`comment:all:${key}`);
    const done: string[] = [];
    try {
      for (const g of list) {
        await invoke(`goals/${idOf(g.path)}`, "comment", undefined, { body: NUDGE });
        done.push(g.path);
      }
      toast({ title: `Update requested on ${done.length} goal${done.length === 1 ? "" : "s"}`, variant: "success" });
    } catch (e) {
      toast({
        title: done.length ? `Asked about ${done.length} of ${list.length}` : "Couldn't ask for an update",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setAsked((a) => [...new Set([...a, ...done])]);
      setBusy("");
      onChanged();
    }
  }

  const renderPerson = ({ id, person, inTrouble, avg, goals: list }: (typeof byPerson)[number]) => {
        // `id` is "" for every goal with no owner (a department-owned goal filed without a lead), so they all
        // land in one block. It used to be headed "Someone", which names a person and implies the rest of the
        // block is theirs - one card looking like one colleague's workload when it is in fact a pile of
        // unowned goals.
        const personName = person ? `${person.first_name} ${person.last_name}` : id ? "Someone" : "No owner";
        // The goals in this block a single ask would actually reach: somebody else's, still owned, still
        // allowed, and not already asked about in this visit.
        const nudgeable = list.filter(
          (g) => !mine(g) && !!g.employee && !asked.includes(g.path) && (g.access?.can ?? []).includes("comment"),
        );
        return (
          // Anchored by the person, so a "jump to" chip has somewhere to land.
          <Card key={id} id={`goal-person-${id}`} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
              {person && <PhotoAvatar employeeId={idOf(person.path)} name={personName} photo={person.photo} className="h-7 w-7" />}
              {/* The name goes to the person. A block headed by somebody you are about to chase is the point
                  at which you want their manager, their leave and the rest of their goals, and the heading was
                  the one thing here that led nowhere. */}
              {person ? (
                <button
                  type="button"
                  className="font-semibold hover:underline"
                  onClick={() => navigate(`employees/${idOf(person.path)}`)}
                  title={`Open ${personName}'s profile`}
                >
                  {personName}
                </button>
              ) : (
                <span className="font-semibold">{personName}</span>
              )}
              <span className="text-xs tabular-nums text-muted-foreground">{list.length} goal{list.length === 1 ? "" : "s"}</span>
              <span className="flex items-center gap-1.5" title={`Weighted average progress across these ${list.length} goals`}>
                <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${avg}%` }} />
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{avg}%</span>
              </span>
              {inTrouble > 0 && <Badge variant="warning">{inTrouble} needing attention</Badge>}
              {/* One ask for the whole block. Chasing four of somebody's goals one row at a time is four
                  presses and four identical toasts, which is the pass this layout exists to make quick. */}
              {nudgeable.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-muted-foreground"
                  loading={busy === `comment:all:${id}`}
                  onClick={() => void nudgeAll(nudgeable, person ? person.first_name : personName, id)}
                >
                  <BellRing className="h-3.5 w-3.5" /> Ask about all {nudgeable.length}
                </Button>
              )}
            </div>
            <ul className="divide-y">
              {list.map((g) => (
                <li key={g.path} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() => onOpen(g)}
                    title={g.title}
                  >
                    {g.title}
                  </button>
                  {/* The team that owns it, said on the row. Without this a department-owned goal was
                      indistinguishable from a personal one here, which is the whole reason somebody files one. */}
                  {deptName(g.department) && <Badge variant="secondary">{deptName(g.department)}</Badge>}
                  {/* The stage, the pace and the silence, in the words every other goal surface uses. This row
                      called PROPOSED "Awaiting you" where the rest of the app says "Awaiting approval", wrote
                      the drift as "12 behind" against "12 pts behind" on the card, and printed a bare number of
                      days for silence where the card says "quiet 24d". */}
                  <GoalStageBadge goal={g} />
                  <GoalPaceChip goal={g} className="text-xs" />
                  <GoalQuietChip goal={g} className="text-xs" />
                  {/* How late, not just when - and said the one way, so "43d overdue" here is the same phrase
                      the card and the drawer use. A bare date read identically whether it was next month or two
                      months gone, in the list whose job is sorting goals by trouble. */}
                  <GoalDueChip goal={g} className="shrink-0 text-xs" />
                  {/* The bar, not only the number: a column of bare percentages across a person's six goals is
                      read one figure at a time, which is the comparison this layout exists to spare the
                      reader. */}
                  <GoalProgressBar goal={g} className="hidden w-16 shrink-0 sm:block" />
                  <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{g.progress ?? 0}%</span>
                  {/* Neither press applies to your own goal - agreeing your own goal is not a handshake and
                      asking yourself for an update is a notification to nobody. Team-owned goals the reader
                      leads are in this list, so the row simply carries no actions. */}
                  <span className="flex shrink-0 items-center gap-1">
                    {!mine(g) && g.stage === "PROPOSED" && (
                      <AccessAction verb="approve" can={g.access?.can} label="Agree this goal">
                        {/* `person`, not the block's heading: for the unowned block that heading is the words
                            "No owner", and the confirm asked whether to approve "No owner's goal". */}
                        <Button variant="ghost" size="sm" loading={busy === `approve:${g.path}`} onClick={() => void agree(g, person ? personName : null)}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Agree
                        </Button>
                      </AccessAction>
                    )}
                    {/* An update is asked OF somebody: the verb posts a comment and notifies the owner, so on a
                        team goal filed without a lead it would notify nobody and leave a canned paragraph on
                        the goal with no one to answer it. */}
                    {!mine(g) && !!g.employee && (
                      <AccessAction verb="comment" can={g.access?.can} label="Ask for an update">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          loading={busy === `comment:${g.path}`}
                          disabled={asked.includes(g.path)}
                          title={asked.includes(g.path) ? "You have already asked - the request is on the goal, waiting for their reply." : undefined}
                          onClick={() => void nudge(g)}
                        >
                          <BellRing className="h-3.5 w-3.5" /> {asked.includes(g.path) ? "Update requested" : "Ask for an update"}
                        </Button>
                      </AccessAction>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        );
  };

  if (byTeam.length <= 1) return <div className="space-y-4">{byPerson.map(renderPerson)}</div>;
  return (
    <div className="space-y-6">
      {byTeam.map((team) => (
        <section key={team.key || "none"} aria-label={team.label} className="space-y-3">
          <h3 className="flex items-baseline gap-2 text-sm font-semibold">
            {team.label}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {team.blocks.length} {team.blocks.length === 1 ? "person" : "people"}
            </span>
          </h3>
          <div className="space-y-4">{team.blocks.map(renderPerson)}</div>
        </section>
      ))}
    </div>
  );
}
