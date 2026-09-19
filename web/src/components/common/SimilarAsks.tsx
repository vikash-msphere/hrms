import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { invoke } from "@/api";
import { cn, idOf } from "@/lib/utils";
import { useAiFeature } from "@/lib/aiFeatures";

// "Others asking the same thing", above the merge picker on a suggestion.
//
// It does not replace the picker. The full list of suggestions stays exactly where it was and this only saves
// reading it - which matters because the answer is a similarity score, and a moderator merging on a machine's
// say-so without looking is the failure mode this feature could cause rather than cure.
//
// WHAT IT SENDS: nothing. The suggestion is already embedded by the search drain, so this reads neighbours of
// a vector that exists and generates nothing. Picking one only fills in the merge field; the merge itself is
// the existing `:merge` verb with its own grant and its own confirmation.
//
// NO SUBMITTER IS SHOWN, because the endpoint does not carry one - signed or anonymous. See
// services/suggestionSimilar.ts for why that is the shape rather than a filter.

type Similar = { path: string; title: string | null; status: string; score: number; votes: number };

export function SimilarAsks({ suggestionPath, chosen, onPick }: {
  suggestionPath: string;
  /** The path currently selected as the merge target, so the picked one reads as picked. */
  chosen: string;
  onPick: (path: string) => void;
}) {
  const enabled = useAiFeature("suggestions.similar");
  const [rows, setRows] = useState<Similar[]>([]);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // On open rather than on a button: unlike the ticket triage panel this costs no inference - the vector is
    // already there and this is one index read - and the moment somebody is deciding what to do with a
    // suggestion is exactly when knowing it was asked twice is useful.
    invoke<{ results: Similar[] }>(`suggestions/${idOf(suggestionPath)}`, "similar")
      .then((r) => { if (live) { setRows(r.results ?? []); setAsked(true); } })
      .catch(() => { if (live) setAsked(true); /* a missing second opinion is not worth a toast */ });
    return () => { live = false; };
  }, [enabled, suggestionPath]);

  if (!enabled || !asked || rows.length === 0) return null;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        {rows.length === 1 ? "Someone else asked for this" : `${rows.length} others asked for this`}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Pick one to merge into it. Check it is really the same ask first.
      </p>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.path}>
            <button
              type="button"
              onClick={() => onPick(r.path)}
              className={cn(
                "w-full rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                chosen === r.path && "bg-accent font-medium",
              )}
            >
              {r.title ?? "Untitled"}
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                {r.votes > 0 ? `+${r.votes}` : r.votes} · {r.status}
                {chosen === r.path && " · merging into this"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
