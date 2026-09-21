import { useState } from "react";
import { Sparkles, CopyCheck, GitMerge } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { useAiFeature } from "@/lib/aiFeatures";

// Goals aiming at the same thing, and the goal this one could roll up under.
//
// THE ONE THING NOBODY CAN SEE FROM INSIDE THEIR OWN LIST: another team has written the same quarter in
// different words. Search cannot find it, because the words differ; the index already holds both.
//
// ASKED FOR, NOT FETCHED ON OPEN. The panel is worth having while somebody is writing or reviewing a goal,
// which is a small share of the times a goal is opened, and an index query on every open of every goal is
// paid by everybody else.
//
// GATED TWICE: on the org's switch and on the caller's own verb, because this answers with goals OTHER than
// the one on screen - and on a goal, the title is frequently the strategy.
//
// NOTHING IS WRITTEN. Alignment in particular stays a deliberate edit: the panel names the candidate and the
// person picks it in Edit, where the change goes through the same validation and audit row as any other.
export function GoalSimilarCard({ goalId, can, onOpenGoal }: {
  goalId: string;
  /** The verbs this caller holds on THIS goal (`access.can`, server-computed). */
  can?: string[];
  /** Open one of the named goals, or null where this surface cannot navigate. */
  onOpenGoal: ((path: string) => void) | null;
}) {
  const enabled = useAiFeature("goals.similar");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [similar, setSimilar] = useState<Similarity | null>(null);

  if (!enabled || !can?.includes("similar")) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invoke<{ similar: Similarity | null }>(`goals/${goalId}`, "similar");
      setSimilar(res.similar);
    } catch {
      // Silent: an enrichment on a drawer somebody opened to do something else.
      setSimilar(null);
    } finally {
      setAsked(true);
      setBusy(false);
    }
  }

  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
        <Sparkles className="h-4 w-4" /> {busy ? "Looking…" : "Find goals like this one"}
      </Button>
    );
  }

  if (!similar || similar.related.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing else reads like this goal.</p>;
  }

  const name = (g: SimilarGoal) => (
    onOpenGoal
      ? <button type="button" className="text-left underline underline-offset-2" onClick={() => onOpenGoal(g.path)}>{g.title}</button>
      : <span>{g.title}</span>
  );

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="h-4 w-4" /> Goals like this one</p>

      {/* THE SAME WORK TWICE, first: it is the finding that changes what a team does this quarter, where an
          alignment link only changes how the plan reads. */}
      {similar.overlaps.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
            <CopyCheck className="h-3.5 w-3.5" /> Somebody else is doing this too
          </p>
          {similar.overlaps.map((g) => (
            <p key={g.path} className="text-sm">
              {name(g)}
              <span className="ml-1.5 text-xs text-muted-foreground">{g.owner ?? "another team"} · {g.progress}%</span>
            </p>
          ))}
        </div>
      )}

      {similar.parent_candidates.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium"><GitMerge className="h-3.5 w-3.5" /> Could roll up under</p>
          {similar.parent_candidates.map((g) => (
            <p key={g.path} className="text-sm">
              {name(g)}
              <span className="ml-1.5 text-xs text-muted-foreground">
                {g.department_goal ? "a department goal" : g.owner ?? ""}
              </span>
            </p>
          ))}
          {/* Said plainly, because a suggestion that looks like it did something is worse than none. */}
          {/* The field is called "Aligns to" on the edit form. A hint that names a control which does not
              exist sends somebody hunting through a dialog for it. */}
          <p className="text-xs text-muted-foreground">Set it in Edit, under “Aligns to”.</p>
        </div>
      )}

      {similar.related.length > similar.overlaps.length + similar.parent_candidates.length && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">All {similar.related.length} related goals</summary>
          <ul className="mt-1 space-y-0.5">
            {similar.related.map((g) => (
              <li key={g.path}>{name(g)} <span className="text-muted-foreground">{g.owner ?? ""}</span></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type SimilarGoal = { path: string; title: string; status: string; progress: number; score: number; owner?: string; department_goal: boolean };
type Similarity = { overlaps: SimilarGoal[]; parent_candidates: SimilarGoal[]; related: SimilarGoal[] };
