import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// One group inside a tabbed write dialog or detail drawer (the task and goal editors, the goal drawer).
//
// Default, laid out like a spec sheet: from `sm` up the group's name and a quiet icon sit in a narrow left
// margin and its fields in the column beside it. Nothing is drawn - no rule or box - so the grouping comes from
// alignment alone: every group's content starts on the same vertical edge, and each name marks where its group
// begins without adding a row above it. The margin also holds what the group carries about itself: a count,
// and `aside`, a control that acts on the whole group (a template picker, a view switch, a "Draft" button). On
// a phone the margin folds into a line above the group.
//
// The margin is sized to the longest name these dialogs use ("Description") with its icon at text-xs, and no
// wider: every pixel of it comes out of the field column beside it. A control in `aside` has to fit it.
//
// `stacked`: the same heading as a line above the group at every width, with `aside` at its far end - for a
// drawer, whose ~30rem cannot spare a margin.
//
// No accessible name on the <section>: the <h3> already names the group for a screen reader's heading list,
// and a labelled section is a `region` landmark whose name ("Description") shadows the field of the same
// name inside it for anything that finds controls by label.
export function FormSection({ title, icon: Icon, count, aside, stacked, children }: { title: string; icon: LucideIcon; count?: ReactNode; aside?: ReactNode; stacked?: boolean; children: ReactNode }) {
  return (
    <section className={cn("grid gap-2", !stacked && "sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-4")}>
      <div className={cn("flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1.5", !stacked && "sm:flex-col sm:items-start sm:pt-0.5")}>
        <h3 className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70" /> {title}
        </h3>
        {count != null && <span className="text-xs tabular-nums text-muted-foreground/80">{count}</span>}
        {aside && <div className={cn("ml-auto flex flex-wrap items-center gap-1.5", !stacked && "sm:ml-0 sm:w-full sm:flex-col sm:items-start")}>{aside}</div>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}
