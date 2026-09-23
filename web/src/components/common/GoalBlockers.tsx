import { useMemo } from "react";
import { Link2Off } from "lucide-react";
import { idOf } from "@/lib/utils";
import { blockingChains } from "@/lib/goalState";
import { GoalPaceChip } from "@/components/common/GoalChips";
import type { Goal } from "@/types";

// What to unblock first.
//
// `blocked_by` makes a team's goals a graph, and every other view of them is a list. A list sorted by drift
// shows the four goals that are behind; it cannot show the one goal that is the reason for three of them,
// because that goal is usually fine on its own numbers - it is late by a week, and the three behind it are
// late by a month each.
//
// NO MODEL AND NO REQUEST. The rows are already on screen; this is a walk over the links between them
// (lib/goalState.ts#blockingChains), so it costs nothing and works with the AI layer switched off.
//
// ONLY WHEN IT HAS SOMETHING TO SAY: one goal waiting on another is an ordinary dependency and needs no
// panel. This appears when something is holding up two or more.
export function GoalBlockers({ goals, onOpen }: {
  /** The rows the page is already showing, scoped and filtered by it. */
  goals: Goal[];
  onOpen: (g: Goal) => void;
}) {
  const chains = useMemo(
    () => blockingChains(goals, idOf).filter((c) => c.blocking.length >= MIN_HELD_UP).slice(0, 4),
    [goals],
  );
  if (chains.length === 0) return null;

  return (
    <section className="mb-5 rounded-lg border border-warning/40 bg-warning/5 p-4">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <Link2Off className="h-4 w-4 text-warning" /> Holding up other goals
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        Nothing else on this page moves until these do. Counted through the chain, so a goal two steps down
        still counts against the goal at the top of it.
      </p>
      <div className="space-y-2">
        {chains.map(({ goal, blocking }) => (
          <div key={goal.path} className="space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <button type="button" className="text-left text-sm font-medium underline underline-offset-2" onClick={() => onOpen(goal)}>
                {goal.title}
              </button>
              <GoalPaceChip goal={goal} />
              <span className="text-xs text-muted-foreground">holding up {blocking.length} goal{blocking.length === 1 ? "" : "s"}</span>
            </div>
            {/* The held-up goals by name. "3 goals" is a number somebody has to go and look up; the names are
                the reason to act, and whose they are is half of that reason. */}
            <p className="text-xs text-muted-foreground">
              {blocking.slice(0, 4).map((g) => g.title).join(" · ")}
              {blocking.length > 4 ? ` · and ${blocking.length - 4} more` : ""}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One goal waiting on another is a dependency, not a problem. Two is a queue behind somebody. */
const MIN_HELD_UP = 2;
