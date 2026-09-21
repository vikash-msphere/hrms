import { useState } from "react";
import { Timer } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";

// How long work like this has taken on this board.
//
// NO MODEL AND NO SWITCH: the board writes a row into its movement log on every move, and this is the
// arithmetic over the rows it already has. So it works on a deployment with no AI bindings at all, which is
// most of the value on this dialog - a card that has sat in Review for nine days is either a crisis or a
// Tuesday, and only the board's own distribution says which.
//
// ASKED FOR. Two queries per press, paid by the person who wanted the answer, rather than on every open of
// every card by everybody.
export function CardFlowCard({ cardId, can }: {
  cardId: string;
  /** The verbs this caller holds on THIS card (`access.can`, server-computed). */
  can?: string[];
}) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);

  if (!can?.includes("flow")) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invoke<{ flow: Flow | null }>(`cards/${cardId}`, "flow");
      setFlow(res.flow);
    } catch {
      setFlow(null);
    } finally {
      setAsked(true);
      setBusy(false);
    }
  }

  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
        <Timer className="h-4 w-4" /> {busy ? "Reading the board…" : "How long work like this takes"}
      </Button>
    );
  }

  if (!flow) return <p className="text-xs text-muted-foreground">Nothing has been through this column yet.</p>;

  // The age is the fact; the percentile is what makes it mean something. Warned about only past the p85,
  // because a card slower than half the board is the median experience of a board.
  const late = flow.dwell != null && flow.days_here != null && flow.days_here > flow.dwell.p85;

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="flex items-center gap-1.5 font-medium"><Timer className="h-4 w-4" /> On this board</p>

      {flow.days_here != null && flow.dwell && (
        <p className={late ? "text-warning" : undefined}>
          {flow.days_here}d in this column.
          {" "}
          <span className="text-muted-foreground">
            Comparable work left within {flow.dwell.p50}d half the time, {flow.dwell.p85}d in 85%
            {flow.slower_than != null ? ` - this one is past ${flow.slower_than}% of them` : ""}.
          </span>
        </p>
      )}

      {flow.to_delivery && (
        <p>
          From here to delivered:{" "}
          <span className="font-medium">{flow.to_delivery.p50}d</span>{" "}
          <span className="text-muted-foreground">typically, {flow.to_delivery.p85}d in 85% of cases</span>
        </p>
      )}

      {/* AGEING WORK, OFFERED A REASON TO SPLIT IT. A card past the p85 of comparable work is the card that
          needed breaking up a week ago, and the checklist affordances are a few lines down this same dialog.
          Said once, as a sentence, rather than as a second warning chip. */}
      {late && (
        <p className="text-xs text-muted-foreground">
          Work that ages like this is usually work that was too big to start. Breaking it into steps is what the
          checklist below is for.
        </p>
      )}

      {/* The sample is stated, always. A percentile over four cards and one over four hundred read the same
          on screen and are not the same claim. */}
      <p className="text-xs text-muted-foreground">
        From {(flow.dwell ?? flow.to_delivery)!.count} comparable task{(flow.dwell ?? flow.to_delivery)!.count === 1 ? "" : "s"}
        {(flow.dwell ?? flow.to_delivery)!.basis === "size" ? " of the same size" : " in this column"}.
      </p>
    </div>
  );
}

type Stat = { p50: number; p85: number; count: number; basis: "size" | "column" };
type Flow = {
  column: string;
  days_here: number | null;
  dwell?: Stat;
  to_delivery?: Stat;
  slower_than?: number;
};
