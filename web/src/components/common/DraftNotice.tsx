// Shown when a dialog reopens onto a saved draft. Says what happened in one line and offers the only escape
// anyone wants - a clean form - because a restored draft you didn't expect is worse than an empty one.
export function DraftNotice({ onStartOver }: { onStartOver: () => void }) {
  return (
    <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
      Picked up where you left off.
      <button type="button" onClick={onStartOver} className="font-medium text-primary hover:underline">
        Start over
      </button>
    </p>
  );
}
