import { cn } from "@/lib/utils";

// What a chart click did to the list, in words.
//
// The picture dims the marks a pick excluded (see `Chart.tsx`), which says it to somebody looking at the
// chart. It has to be said to everyone else too: a list quietly holding a subset is how a reader concludes
// the rows have vanished, and the mark that would undo it can be scrolled off the top of the page. So every
// page that lets a chart filter its list puts this line against the list - the scope, how much of the whole
// it is, and the way out - the same way Assets says which band its table is showing.
export function ChartFilterNote({ label, shown, total, onClear, className }: {
  /** The picked scope, in words ("Hardware", "Jun 26"). Null when nothing is picked: the note is then absent. */
  label: string | null;
  shown: number;
  total: number;
  onClear: () => void;
  className?: string;
}) {
  if (!label) return null;
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-2 text-sm", className)}>
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{shown} of {total}</span>
      <button type="button" className="font-medium text-primary hover:underline" onClick={onClear}>Show all</button>
    </div>
  );
}
