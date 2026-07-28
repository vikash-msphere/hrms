import * as React from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SummaryItem = {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  hint?: React.ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "destructive" | "muted";
};

const TONE: Record<NonNullable<SummaryItem["tone"]>, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

// A compact, segmented metric bar for the top of a list page - a lighter-weight alternative to a row of full
// StatCards that gives the page shape (summary at a glance) without dominating it. Segments wrap on narrow
// viewports and split the width evenly. Drop it between PageHeader and the list/table.
export function SummaryStrip({ items, className }: { items: SummaryItem[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <div className={cn("mb-6 flex flex-wrap divide-x divide-border overflow-hidden rounded-xl border bg-card shadow-card", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex min-w-[7.5rem] flex-1 flex-col gap-0.5 px-4 py-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {it.icon && <it.icon className="h-3.5 w-3.5" />}
            {it.label}
          </span>
          <span className={cn("text-xl font-semibold tracking-tight tabular-nums", TONE[it.tone ?? "default"])}>{it.value}</span>
          {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
        </div>
      ))}
    </div>
  );
}
