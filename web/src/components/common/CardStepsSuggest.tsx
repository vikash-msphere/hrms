import { useState } from "react";
import { ListChecks } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { useAiFeature } from "@/lib/aiFeatures";

// The steps comparable finished work actually took.
//
// Beside the draft button, and ahead of it in the order somebody should try them: this reads what people
// wrote on delivered cards, where the draft asks a model to imagine what the work involves. The read answer
// is in the board's own vocabulary ("raise a change request" if that is what this company does), it is free,
// and it comes with the number of cards that carried each step - which is the part that makes it checkable.
//
// NOTHING IS ADDED AUTOMATICALLY. Each step is a chip the person taps to stage it in the checklist they are
// building, and the dialog saves the list with the rest of the card.
export function CardStepsSuggest({ cardId, can, onAdd }: {
  cardId: string;
  /** The verbs this caller holds on THIS card (`access.can`, server-computed). */
  can?: string[];
  /** Stage one step in the dialog's own checklist. */
  onAdd: (text: string) => void;
}) {
  const enabled = useAiFeature("cards.triage");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [used, setUsed] = useState<string[]>([]);

  if (!enabled || !can?.includes("suggestSteps")) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invoke<{ steps: Step[] }>(`cards/${cardId}`, "suggestSteps");
      setSteps(res.steps);
    } catch {
      setSteps([]);
    } finally {
      setAsked(true);
      setBusy(false);
    }
  }

  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={run} disabled={busy}>
        <ListChecks className="h-3.5 w-3.5" /> {busy ? "Reading…" : "Steps from finished work"}
      </Button>
    );
  }

  // Said rather than left blank, and it says what to do instead - the draft button is right there.
  if (steps.length === 0) {
    return <p className="text-xs text-muted-foreground">No comparable finished work to read steps from yet.</p>;
  }

  return (
    <div className="w-full space-y-1">
      <p className="text-xs text-muted-foreground">Steps comparable finished tasks carried. Tap to add.</p>
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s) => (
          <button
            key={s.text}
            type="button"
            disabled={used.includes(s.text)}
            onClick={() => { onAdd(s.text); setUsed((u) => [...u, s.text]); }}
            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            <span aria-hidden="true">{used.includes(s.text) ? "✓ " : "+ "}</span>{s.text}
            {/* The evidence, on the chip: "3 of 5" is something a person can weigh. */}
            <span className="ml-1 opacity-70">{s.seen}/{s.of}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Step = { text: string; seen: number; of: number };
