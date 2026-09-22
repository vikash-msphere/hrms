import { cn } from "@/lib/utils";

// The subtle "new content since you last looked" marker used on tabs (an FYI, not an actionable notification -
// notification badges are the solid primary pill). Renders nothing at zero.
export function ActivityBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      // The unrounded count, named. The badge sits INSIDE its tab or scope chip, so from the outside it is a
      // second number in the same accessible name as the scope's own row count - and "99+" is not a number at
      // all. This is what distinguishes the two for anything reading the page rather than looking at it.
      data-activity-count={count}
      className={cn(
        "ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
