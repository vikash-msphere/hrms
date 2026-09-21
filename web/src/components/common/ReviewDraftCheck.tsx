import { useMemo, useState } from "react";
import { PenLine, X } from "lucide-react";
import { checkReviewDraft, type DraftFlagCode } from "@/lib/reviewDraftCheck";

// What the manager wrote, read back to them before they share it.
//
// Not a check on the employee, not a score, and it cannot stop anybody sharing anything: every line is
// advisory and dismissible, and the Share button does not know this component exists. See
// lib/reviewDraftCheck.ts for the rules and why they are a readable lexicon rather than a classifier.
//
// NOTHING LEAVES THE PAGE. The text is checked where it is being typed, which is why this needs no feature
// flag, no verb and no budget - and why an org with the AI layer switched off gets it anyway.
export function ReviewDraftCheck({ text }: { text: string }) {
  const [dismissed, setDismissed] = useState<DraftFlagCode[]>([]);
  const flags = useMemo(() => checkReviewDraft(text), [text]);
  const showing = flags.filter((f) => !dismissed.includes(f.code));
  if (showing.length === 0) return null;

  return (
    <div className="space-y-1 rounded-md border bg-muted/30 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <PenLine className="h-3.5 w-3.5" /> About the writing, not the person
      </p>
      {showing.map((f) => (
        <div key={f.code} className="flex items-start gap-2 text-xs">
          <span className="flex-1">{f.message}</span>
          {/* Dismissible one at a time: a writer who has considered a point and disagrees should be able to
              put it away without losing the others. */}
          <button
            type="button"
            aria-label="Dismiss this note"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
            onClick={() => setDismissed((d) => [...d, f.code])}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
