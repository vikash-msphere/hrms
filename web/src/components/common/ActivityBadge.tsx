import { cn } from "@/lib/utils";

// The subtle "new content since you last looked" marker used on tabs (an FYI, not an actionable notification -
// notification badges are the solid primary pill). Renders nothing at zero.
export function ActivityBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
