import { useState } from "react";
import { Ruler } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useAiFeature } from "@/lib/aiFeatures";

// Ask for a unit, a starting value and a target for a goal that has none.
//
// The CHECK that this goal cannot measure itself is arithmetic and lives on the form next to the fields
// (lib/goalMeasure.ts is the web half; src/domain/goalMeasure.ts is the server's). This button is only the
// fix, and it is the one part that costs a neuron - so it appears where the gap is, on a press, and never on
// a goal that already measures itself.
//
// THE THREE VALUES LAND IN THE FORM, separately and editable. Nothing is saved: the person changes what is
// wrong, deletes what is unhelpful, and presses Save like any other edit. A model that proposed a target
// straight into the record would be writing the one number the whole goal is judged on.
export function GoalMeasureSuggest({ goalId, can, onPropose }: {
  goalId: string;
  /** The verbs this caller holds on THIS goal (`access.can`, server-computed). */
  can?: string[];
  /** Put the proposal in the form's own fields. Nulls are left alone rather than clearing what is there. */
  onPropose: (p: { unit?: string | null; baseline_value?: number | null; target_value?: number | null }) => void;
}) {
  const enabled = useAiFeature("goals.measure");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!enabled || !can?.includes("suggestMeasure")) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invoke<{ unit?: string | null; baseline_value?: number | null; target_value?: number | null }>(`goals/${goalId}`, "suggestMeasure");
      if (res.unit == null && res.baseline_value == null && res.target_value == null) {
        // Said out loud. A button that appears to do nothing is read as broken, and "the goal does not say"
        // is a real answer here - the prompt asks for null rather than a plausible-looking invention.
        toast({ title: "Nothing to propose", description: "This goal does not say enough to measure it. Add a number to the description, or set the fields by hand." });
        return;
      }
      onPropose(res);
      toast({ title: "Measure proposed", description: "Check each value before saving - nothing has been saved yet." });
    } catch (e) {
      // Loud, unlike the read-only panels: somebody pressed this and is waiting for an answer.
      toast({ title: "Couldn't propose a measure", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
      <Ruler className="h-4 w-4" /> {busy ? "Thinking…" : "Suggest a measure"}
    </Button>
  );
}
