import { useMemo } from "react";
import { Unlink, UserMinus } from "lucide-react";
import { idOf } from "@/lib/utils";
import { isOpen } from "@/lib/goalState";
import type { Employee, Goal } from "@/types";

// Two coverage questions a wall of goal cards cannot answer.
//
//   1. WHICH GOALS CONNECT TO NOTHING. A goal with no parent and no department behind it is somebody's own
//      plan for the quarter - which may be exactly right, and is worth seeing as a number: when half a
//      team's goals roll up to nothing, the department's plan does not add up, whatever the cards say.
//   2. WHO HAS NO GOAL AT ALL. The thing every cycle discovers a fortnight before its deadline.
//
// NO MODEL AND NO REQUEST: both are counted over the rows the page has already loaded.
//
// IT NAMES GOALS AND COUNTS PEOPLE. A list of names under "no goals set" is a coverage fact HR chases and
// the cycle already records a deadline for; it is not a ranking, not a score, and the panel says nothing
// about how anybody is doing. That line is the one this component must not cross.
export function GoalCoverage({ goals, employees, onOpen }: {
  /** The rows the page is showing, already scoped and filtered by it. */
  goals: Goal[];
  /** The roster the page loaded, for the people-without-goals count. */
  employees: Employee[];
  onOpen: (g: Goal) => void;
}) {
  const { unaligned, without } = useMemo(() => {
    const open = goals.filter((g) => isOpen(g) && g.kind !== "key_result");
    return {
      // A key result hangs off its objective by construction, so it is never "connected to nothing".
      unaligned: open.filter((g) => !g.parent && !g.department),
      // Live rows only. The wire resource carries no employment status, so a leaver is recognised the way
      // every other list here recognises one: by its delete stamp.
      without: employees.filter((e) => !e.delete_time
        && !goals.some((g) => g.employee && idOf(g.employee) === idOf(e.path) && isOpen(g) && g.stage === "AGREED")),
    };
  }, [goals, employees]);

  // Nothing to say. A panel that appears on every visit to report "0 of 12" is a panel people stop reading.
  if (unaligned.length === 0 && without.length === 0) return null;

  return (
    <section className="mb-5 space-y-2 rounded-lg border p-4">
      <p className="text-sm font-semibold">Coverage</p>

      {unaligned.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <Unlink className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium">{unaligned.length} of {goals.filter((g) => isOpen(g)).length}</span>
            <span className="text-muted-foreground">open goals roll up to nothing</span>
          </p>
          <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {unaligned.slice(0, 6).map((g) => (
              <button key={g.path} type="button" className="underline underline-offset-2" onClick={() => onOpen(g)}>{g.title}</button>
            ))}
            {unaligned.length > 6 && <span>and {unaligned.length - 6} more</span>}
          </p>
        </div>
      )}

      {without.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium">{without.length}</span>
            <span className="text-muted-foreground">
              {without.length === 1 ? "person has" : "people have"} no agreed goal
            </span>
          </p>
          {/* Behind a disclosure, and stated as what it is: who to talk to about goal-setting. A cycle that
              records a goal-setting deadline is a cycle that expects somebody to chase this. */}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Who to ask</summary>
            <p className="mt-0.5">{without.map((e) => `${e.first_name} ${e.last_name}`).join(", ")}</p>
          </details>
        </div>
      )}
    </section>
  );
}
