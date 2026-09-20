import { useState } from "react";
import { Sparkles, Copy } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { useAiFeature } from "@/lib/aiFeatures";

// What comparable finished work says about this task, and whether it is already on the board twice.
//
// ASKED FOR, NOT FETCHED ON OPEN. Every card dialog would otherwise cost an index query and three reads to
// tell most people nothing - the panel is useful on a card somebody is filing or triaging, which is a
// minority of the times a card is opened. The button is the request.
//
// GATED TWICE, on the org's switch and on the caller's own verb. `cards.triage` answers with cards OTHER than
// this one, so it is a grantable capability in its own right (accessHint.ts) - somebody who may edit a card
// is not thereby somebody who may be shown a list of its neighbours.
//
// NOTHING IS WRITTEN HERE, and nothing is even applied: "Use" puts the value in the dialog's own field, and
// the dialog saves it with everything else. So a suggestion takes the same path as a value somebody typed -
// same validation, same audit row - and a person who changes their mind just edits the field back.
export function CardTriageCard({ cardId, can, onUsePriority, onOpenCard }: {
  cardId: string;
  /** The verbs this caller holds on THIS card (`access.can`, server-computed). */
  can?: string[];
  /** Put a suggested value into the form field. Nothing is written: the dialog saves it with the rest, so
   *  the suggestion goes through the same validation and audit row as anything typed by hand. */
  onUsePriority: (priority: string) => void;
  /** Open a neighbour, or null when this surface cannot navigate. */
  onOpenCard: ((path: string) => void) | null;
}) {
  const enabled = useAiFeature("cards.triage");
  const allowed = !!can?.includes("triage");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [triage, setTriage] = useState<Triage | null>(null);

  if (!enabled || !allowed) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invoke<{ triage: Triage | null }>("cards", "triage", cardId);
      setTriage(res.triage);
    } catch {
      // Silent, deliberately. This is an enrichment on a dialog somebody opened to do something else; a red
      // banner because a suggestion could not be fetched would be louder than the feature is worth.
      setTriage(null);
    } finally {
      setAsked(true);
      setBusy(false);
    }
  }

  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
        <Sparkles className="h-4 w-4" /> {busy ? "Looking…" : "Compare with finished work"}
      </Button>
    );
  }

  // Asked and there is nothing to say. Stated plainly rather than left blank, so somebody who pressed the
  // button knows it answered - an empty space reads as a broken button.
  if (!triage) {
    return <p className="text-xs text-muted-foreground">Nothing comparable on this board yet.</p>;
  }

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-4 w-4" /> Compared with finished work
      </p>

      {/* DUPLICATES FIRST. If this work is already on the board, nothing else on the panel matters. */}
      {triage.duplicates.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
            <Copy className="h-3.5 w-3.5" /> Possibly already on the board
          </p>
          {triage.duplicates.map((d) => (
            <p key={d.path} className="text-sm">
              {onOpenCard
                ? <button type="button" className="text-left underline underline-offset-2" onClick={() => onOpenCard(d.path)}>{d.title}</button>
                : <span>{d.title}</span>}
              <span className="ml-1.5 text-xs text-muted-foreground">in {d.column}</span>
            </p>
          ))}
        </div>
      )}

      {triage.priority && (
        <div className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="text-muted-foreground">Priority</span>
          <span className="font-medium">{triage.priority.value}</span>
          {/* The vote count is the point: "3 of 4" is evidence somebody can weigh, where a bare suggestion
              asks to be trusted. */}
          <span className="text-xs text-muted-foreground">{triage.priority.votes} of {triage.priority.of} similar</span>
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => onUsePriority(triage.priority!.value)}>Use</Button>
        </div>
      )}

      {triage.size && (
        <div className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="text-muted-foreground">Size</span>
          <span className="font-medium">{triage.size.value}</span>
          <span className="text-xs text-muted-foreground">{triage.size.votes} of {triage.size.of} similar</span>
        </div>
      )}

      {triage.basis.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Based on {triage.basis.length} finished task{triage.basis.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 space-y-0.5">
            {triage.basis.map((b) => (
              <li key={b.path}>
                {onOpenCard
                  ? <button type="button" className="text-left underline underline-offset-2" onClick={() => onOpenCard(b.path)}>{b.title}</button>
                  : b.title}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type Vote = { value: string; votes: number; of: number };
type Triage = {
  department: Vote | null;
  priority: Vote | null;
  size: Vote | null;
  basis: { path: string; title: string; score: number }[];
  duplicates: { path: string; title: string; score: number; column: string }[];
};
