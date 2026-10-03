import * as React from "react";
import { AlertTriangle } from "lucide-react";

// A failed submit inside a dialog needs to be readable WHILE the form is being fixed. A toast says it once,
// four seconds, often behind the dialog it is talking about - so the server's reason ("leave overlaps an
// existing request") is gone by the time anyone looks for it. This keeps it pinned in the form until the next
// attempt clears it.
//
// It also takes focus when it appears. Pressing Save on a long form usually leaves the reader at the bottom of
// it, and the reason why nothing happened is then above the fold - or, for anyone using a screen reader,
// nowhere at all: `role="alert"` announces the text but leaves the caret where it was, so the next Tab
// continues from the field they were in and the message is never reached. Moving focus to it says what
// happened AND puts the reader at the thing they have to act on. `tabIndex={-1}` keeps it out of the tab order
// once read.
export function FormError({ error }: { error?: string | null }) {
  const ref = React.useRef<HTMLParagraphElement>(null);
  const last = React.useRef<string | null>(null);

  React.useEffect(() => {
    // Only on a NEW message: re-focusing on every render would fight the reader's own keystrokes, and a
    // repeated identical failure (same field, same reason) is still new - hence comparing against the last
    // message rather than against null.
    if (!error) { last.current = null; return; }
    if (error === last.current) return;
    last.current = error;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  if (!error) return null;
  return (
    <p
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive outline-hidden ring-offset-2 focus-visible:ring-2 focus-visible:ring-destructive/50"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{error}</span>
    </p>
  );
}
