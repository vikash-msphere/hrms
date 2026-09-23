import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { invoke } from "@/api";
import { idOf } from "@/lib/utils";
import { useAiFeature } from "@/lib/aiFeatures";

// Which goal this task is probably serving.
//
// The link has existed as long as the boards have, and a board that opts into `deliveryAdvancesGoal` rolls a
// delivered task's progress up into the goal it names. That feature does nothing on most boards, because the
// field is filled in by hand and so it usually is not filled in at all. A task and a goal about the same work
// are two pieces of text about the same work, and the index holds both.
//
// FETCHED ON OPEN rather than behind a button, unlike the other panels on this dialog, and the reason is the
// asymmetry: this one is a single line above a field somebody is looking at, it disappears entirely when
// there is nothing to say, and the answer costs one index query with no embedding. A button here would be a
// press to find out whether there was anything worth pressing for.
//
// ONLY FOR A TASK WITH NO GOAL YET. The server refuses one that already names a goal, because that decision
// was made by a person.
export function CardGoalSuggest({ cardId, can, current, onPick }: {
  cardId: string;
  /** The verbs this caller holds on THIS card (`access.can`, server-computed). */
  can?: string[];
  /** The goal id currently in the dialog's own field, which may have been picked a second ago. */
  current: string;
  /** Put the goal in the dialog's field. Nothing is written: the dialog saves it with the rest of the card. */
  onPick: (goalId: string) => void;
}) {
  const enabled = useAiFeature("cards.triage");
  const allowed = !!can?.includes("suggestGoal");
  const [goals, setGoals] = useState<Suggested[]>([]);

  useEffect(() => {
    if (!enabled || !allowed) return;
    let live = true;
    invoke<{ goals: Suggested[] }>(`cards/${cardId}`, "suggestGoal")
      .then((res) => { if (live) setGoals(res.goals); })
      // Silent: a line that does not appear is the correct failure for a hint above a field.
      .catch(() => { if (live) setGoals([]); });
    return () => { live = false; };
  }, [cardId, enabled, allowed]);

  // Nothing to say, or the field has since been filled - either by the reader taking one of these or by
  // picking their own.
  if (goals.length === 0 || current) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="flex items-center gap-1 text-xs text-muted-foreground"><Target className="h-3 w-3" /> Looks like:</span>
      {goals.map((g) => (
        <button
          key={g.path}
          type="button"
          onClick={() => onPick(idOf(g.path))}
          title={g.owner ? `${g.title} - ${g.owner}` : g.title}
          className="max-w-56 truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
        >
          + {g.title}
        </button>
      ))}
    </div>
  );
}

type Suggested = { path: string; title: string; score: number; owner?: string };
