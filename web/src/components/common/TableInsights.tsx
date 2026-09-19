import * as React from "react";
import { cn } from "@/lib/utils";

// A page's own reading of its rows, offered above the table as chips that narrow it.
//
// This is the one part of the table that cannot be generic. A count of rows, a sum of a column, a share of a
// status - the table can already compute all of those, and none of them is worth a line of screen. What is
// worth it is the sentence a person who knows the domain would say out loud on opening the page: "seven of
// these have been waiting more than a week", "four assets are out with people who left", "two runs are stale
// against their inputs". Only the page knows which sentence that is, so the page writes it, and the table
// only renders it and applies the narrowing that isolates the rows it counted.
//
// Rules a chip has to keep, because they are what separates this from a decoration:
//  - It counts something ACTIONABLE. A chip nobody would ever act on is a fact, and facts belong in a column.
//  - Its `filters` isolate exactly the rows it counted, so clicking it is the same as reading it, then
//    narrowing by hand. A chip whose filter disagrees with its own number teaches people to distrust both.
//  - It is absent at zero. "0 overdue" is a good state and needs no chip; the empty strip is the good news.

export type InsightTone = "neutral" | "warning" | "success" | "destructive";

export type TableInsight = {
  /** Stable across renders (used as the React key and to tell an applied chip from its neighbours). */
  id: string;
  /** What the chip says, e.g. "7 waiting over a week". Lead with the figure - it is what gets scanned. */
  label: string;
  tone?: InsightTone;
  icon?: React.ReactNode;
  /** Longer explanation, on the chip's title. */
  hint?: string;
  /** The narrowing that leaves exactly the rows this chip counted. Column id -> filter value. */
  filters?: Record<string, string>;
  /** Column ordering to apply with it, "columnId.asc" | "columnId.desc" - e.g. oldest first for a backlog. */
  sort?: string;
  /** Anything a filter cannot express (opening a dialog, jumping elsewhere). Runs instead of `filters`. */
  onClick?: () => void;
};

const TONE: Record<InsightTone, string> = {
  neutral: "border-border bg-muted/60 text-foreground hover:bg-muted",
  warning: "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20",
  success: "border-success/40 bg-success/10 text-success hover:bg-success/20",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
};

export function TableInsights({
  insights,
  activeId,
  onApply,
}: {
  insights: TableInsight[];
  /** The chip whose narrowing the table is currently showing, so a second click can undo it. */
  activeId: string | null;
  onApply: (insight: TableInsight, undo: boolean) => void;
}) {
  if (insights.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {insights.map((i) => {
        const active = activeId === i.id;
        const actionable = !!i.filters || !!i.onClick || !!i.sort;
        return (
          <button
            key={i.id}
            type="button"
            disabled={!actionable}
            title={i.hint ?? (actionable ? (active ? "Click to clear this filter" : "Click to show only these") : undefined)}
            aria-pressed={actionable ? active : undefined}
            onClick={() => onApply(i, active)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors coarse:min-h-9",
              TONE[i.tone ?? "neutral"],
              active && "ring-2 ring-primary/40",
              !actionable && "cursor-default",
            )}
          >
            {i.icon}
            <span className="font-medium">{i.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** "1 request" / "4 requests" - the half of a chip label that is always the same shape. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
