import { cn } from "@/lib/utils";

// The shapes the app waits in.
//
// A centred "Loading…" is the cheapest thing to write and the worst thing to look at: the panel collapses to
// two lines and then snaps to full height when the data lands, so on a phone the reader loses the card they
// just opened, and on a slow connection the screen reads as empty rather than as busy. Every wait in the app
// therefore renders a placeholder shaped roughly like what is coming, which keeps the geometry stable and
// says "nearly there".
//
// All of them are `aria-busy` with one off-screen "Loading…" - the bars themselves are decoration and would
// otherwise be announced as nothing at all, or (worse) read out as a run of empty elements.

const BAR = "animate-pulse rounded bg-muted";

function Busy({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={className} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

/** A form: label over control, N times. What a dialog shows while its record loads. */
export function FormSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <Busy className={cn("space-y-4", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <div className={cn(BAR, "h-3 w-24")} />
          <div className={cn(BAR, "h-9 w-full rounded-md")} />
        </div>
      ))}
    </Busy>
  );
}

/** A read-only detail list: label on the left, value on the right. */
export function DetailSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <Busy className={cn("divide-y", className)}>
      {Array.from({ length: rows }, (_, i) => (
        // Fluid, not fixed: a placeholder wider than the content it stands in for makes the page scroll
        // sideways while it loads and then snap back when it arrives.
        <div key={i} className="grid grid-cols-3 gap-3 py-2.5 first:pt-0">
          <div className={cn(BAR, "h-3 w-full max-w-28 self-center")} />
          <div className={cn(BAR, "col-span-2 h-3 w-full max-w-40 self-center")} />
        </div>
      ))}
    </Busy>
  );
}

/** A table. Mirrors `.table-stack`: labelled blocks below `sm`, columns from there up. */
export function TableSkeleton({ rows = 4, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  // The columns are a fraction each rather than a repeat() template so no track can state a width: a
  // placeholder is never the reason a table scrolls sideways.
  const track = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  return (
    <Busy className={cn("py-1", className)}>
      {/* Header rule, from `sm` up only - below that the real table has no thead on screen either. */}
      <div className="hidden gap-3 border-b pb-2 sm:grid" style={track}>
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className={cn(BAR, "h-3 w-14 max-w-full")} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="border-b py-2.5 last:border-0">
          {/* Stacked form: two lines, the way a labelled block reads. */}
          <div className="space-y-1.5 sm:hidden">
            <div className={cn(BAR, "h-3.5 w-2/5")} />
            <div className={cn(BAR, "h-3 w-3/4")} />
          </div>
          <div className="hidden gap-3 sm:grid" style={track}>
            {Array.from({ length: cols }, (_, c) => (
              // Staggered widths: a grid of identical bars reads as a rendering bug rather than as data.
              <div key={c} className={cn(BAR, "h-3.5 self-center")} style={{ width: `${[85, 62, 74, 55, 68][(r + c) % 5]}%` }} />
            ))}
          </div>
        </div>
      ))}
    </Busy>
  );
}

/** A divided list of rows, each an icon, a line of text and a control (notification prefs, toggle lists). */
export function RowsSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <Busy className={cn("divide-y rounded-md border", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-3 py-2.5">
          <div className={cn(BAR, "h-6 w-6 shrink-0 rounded-full")} />
          <div className={cn(BAR, "h-3.5 min-w-0 flex-1 max-w-48")} />
          <div className={cn(BAR, "h-5 w-9 shrink-0 rounded-full")} />
        </div>
      ))}
    </Busy>
  );
}

/** A feed or grid of cards (a board, an activity stream, a picker of tiles). */
export function CardsSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <Busy className={cn("space-y-3", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className={cn(BAR, "h-9 w-9 shrink-0 rounded-full")} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className={cn(BAR, "h-3.5 w-1/3")} />
              <div className={cn(BAR, "h-3 w-1/4")} />
            </div>
          </div>
          <div className={cn(BAR, "mt-3 h-3 w-full")} />
          <div className={cn(BAR, "mt-1.5 h-3 w-4/5")} />
        </div>
      ))}
    </Busy>
  );
}

/** A couple of text lines. For the small in-panel sections (a comment thread, a list of interview rounds)
 *  where a full card or table placeholder would be more furniture than the section itself. */
export function LinesSkeleton({ rows = 2, className }: { rows?: number; className?: string }) {
  return (
    <Busy className={cn("space-y-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn(BAR, "h-3")} style={{ width: `${[92, 74, 83][i % 3]}%` }} />
      ))}
    </Busy>
  );
}

/** A grid of equal tiles (an emoji or illustration picker). Same column counts as the grid it stands in. */
export function TilesSkeleton({ count = 12, className, tile = "aspect-square" }: { count?: number; className?: string; tile?: string }) {
  return (
    <Busy className={cn("grid grid-cols-6 gap-2 sm:grid-cols-8", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn(BAR, tile)} />
      ))}
    </Busy>
  );
}

/** A band of metric tiles above a page's content. Two across on a phone, like the real ones. */
export function StatsSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <Busy className={cn("grid grid-cols-2 gap-3 sm:grid-cols-4", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-2 rounded-xl border bg-card p-4">
          <div className={cn(BAR, "h-3 w-2/3")} />
          <div className={cn(BAR, "h-6 w-1/2")} />
        </div>
      ))}
    </Busy>
  );
}

/** A document page, for the PDF surfaces (viewer, signature placer) while the bytes are on their way. Paper
 *  proportions, so the panel is the size the rendered page will be rather than a centred spinner in a void. */
export function PageSkeleton({ className }: { className?: string }) {
  return (
    <Busy className={cn("flex flex-1 items-center justify-center p-4", className)}>
      <div className="aspect-[1/1.414] w-full max-w-md space-y-3 rounded-lg border bg-card p-6 shadow-sm">
        <div className={cn(BAR, "h-4 w-1/2")} />
        <div className={cn(BAR, "h-3 w-full")} />
        <div className={cn(BAR, "h-3 w-11/12")} />
        <div className={cn(BAR, "h-3 w-4/5")} />
        <div className={cn(BAR, "mt-6 h-3 w-full")} />
        <div className={cn(BAR, "h-3 w-10/12")} />
        <div className={cn(BAR, "h-3 w-3/5")} />
      </div>
    </Busy>
  );
}

/** A lazily-imported settings/config panel: a heading, a line of help, then a form. */
export function PanelSkeleton({ className }: { className?: string }) {
  return (
    <Busy className={cn("space-y-5 py-2", className)}>
      <div className="space-y-2">
        <div className={cn(BAR, "h-4 w-40")} />
        <div className={cn(BAR, "h-3 w-full max-w-md")} />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className={cn(BAR, "h-3 w-24")} />
            <div className={cn(BAR, "h-9 w-full rounded-md")} />
          </div>
        ))}
      </div>
    </Busy>
  );
}
