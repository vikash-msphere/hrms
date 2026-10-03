import * as React from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { STRIP_CAPS, statRow } from "@/lib/statRows";

export type SummaryItem = {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  hint?: React.ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "destructive" | "muted";
  // Make the segment a filter: clicking it narrows the list below (usually by switching tab). A metric the
  // user can act on beats one they have to translate into a filter by hand. `active` marks the segment whose
  // scope the list is currently showing.
  onClick?: () => void;
  active?: boolean;
};

const TONE: Record<NonNullable<SummaryItem["tone"]>, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

// How the segments divide by count: balanced rows, every row stretched to the full width (see
// `web/src/lib/statRows.ts` - seven segments are four then three, not four then three-and-a-gap). STRIP_CAPS
// is what a segment can be read at, measured against the strip's own width rather than the viewport's: two
// across a phone always, because these are short labels over big numbers that read fine at ~170px and
// stacking six of them one-per-row buries the list the page is actually about, up to seven where there is
// room for a compact segment to keep ~160px.
//
// The separators are drawn by each segment (a top and left border pulled back a pixel so it lands on its
// neighbour's edge, and on the container's own border at the outside), NOT by a gap over a coloured ground.
// The gap trick is tidier to write and wrong here: it would need the ground to show between segments, and a
// stretched short row would then draw that ground as a block where a blank corner belongs. Borders belong to
// the things that exist, and a row that fills its width has nothing left over to colour in.

// A compact, segmented metric bar for the top of a list page - a lighter-weight alternative to a row of full
// StatCards that gives the page shape (summary at a glance) without dominating it. Drop it directly above
// the list/table it filters (charts, if any, go above it).
export function SummaryStrip({ items, className }: { items: SummaryItem[]; className?: string }) {
  if (items.length === 0) return null;
  const rows = statRow(items.length, STRIP_CAPS);
  return (
    <div
      className={cn(
        // overflow-hidden is what lets each segment's border sit ON the container's border rather than a
        // pixel inside it, which is the difference between one rule and two touching ones.
        "stat-row mb-6 overflow-hidden rounded-xl border bg-card shadow-card",
        className
      )}
      style={rows.style}
    >
      {items.map((it, i) => {
        const body = (
          <>
            {/* Two segments across a phone is ~165px per cell, so both lines have to be able to give: the
                label truncates rather than wrapping to a second line that would misalign it against its
                neighbour, and the icon never gives up its own width to make room. */}
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {it.icon && <it.icon className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate" title={it.label}>{it.label}</span>
            </span>
            <span className={cn("truncate text-lg font-semibold tracking-tight tabular-nums sm:text-xl", TONE[it.tone ?? "default"])}>{it.value}</span>
            {/* Hints stay on one line (segments are narrow); truncate is the backstop for a dynamic one. */}
            {it.hint && <span className="truncate text-xs text-muted-foreground" title={typeof it.hint === "string" ? it.hint : undefined}>{it.hint}</span>}
          </>
        );
        // `min-w-0` (also set by `.stat-row > *`) so a long value truncates inside its cell instead of
        // widening it and pushing the row past the viewport. The pixel of negative margin pulls each segment
        // onto its neighbour's edge, so the two borders that meet there are drawn as one - and at the
        // outside, onto the container's.
        const shell = "-ml-px -mt-px flex min-w-0 flex-col gap-0.5 border-l border-t px-3 py-3 sm:px-4";
        return it.onClick ? (
          <button
            key={i}
            type="button"
            onClick={it.onClick}
            aria-pressed={!!it.active}
            style={rows.cell(i)}
            className={cn(shell, "text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", it.active && "bg-muted/60")}
          >
            {body}
          </button>
        ) : (
          <div key={i} style={rows.cell(i)} className={shell}>{body}</div>
        );
      })}
    </div>
  );
}
