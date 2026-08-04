import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// A section of a form that starts folded: a header you can click, and the section's controls underneath.
//
// One component rather than one per caller, because a form with three disclosures that each look slightly
// different reads as three unrelated things. The header carries the same weight as a field's Label, so a folded
// section sits in a column of fields without looking like a stray button.
//
// Two rules it exists to keep:
//
//   The summary. Folding may hide the CONTROLS and never the state - a section that gives no sign of what it is
//   set to has to be opened just to be read, which is worse than not folding it. So the header says, and the
//   summary disappears when open because the controls below are then saying it better.
//
//   The actions. Anything that undoes what the section did (remove, reset) belongs in the header, not inside:
//   putting a picture back the way it was should not require opening the thing that changed it. They are
//   siblings of the trigger rather than children of it - a button inside a button is invalid, and the nested one
//   would swallow the click anyway.
export function FoldSection({
  title,
  summary,
  actions,
  open: openProp,
  onOpenChange,
  defaultOpen = false,
  children,
  className,
}: {
  title: string;
  summary?: ReactNode; // what it is currently set to, shown only while folded
  actions?: ReactNode; // undo-shaped affordances, always reachable
  open?: boolean; // controlled; omit to let the section keep its own state (and start folded)
  onOpenChange?: (open: boolean) => void;
  // Which way an UNCONTROLLED section starts. Folded is the default because folding exists to keep a column of
  // fields short; a caller with room to spare (a panel of its own) says so.
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = openProp ?? ownOpen;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => (onOpenChange ? onOpenChange(!open) : setOwnOpen(!open))}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-sm font-medium transition-colors hover:text-foreground/70"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="shrink-0">{title}</span>
          {!open && summary != null && <span className="truncate text-xs font-normal text-muted-foreground">{summary}</span>}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">{actions}</div>}
      </div>
      {open && children}
    </div>
  );
}
