import { RefreshCw } from "lucide-react";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { refetchMounted } from "@/lib/resourceStore";
import { cn } from "@/lib/utils";

// The indicator for the pull gesture (hooks/usePullToRefresh). A disc that slides down out of the top bar,
// turning as it is dragged and spinning while the read runs - the same vocabulary as the platform's own, so
// nobody has to learn what it means.
//
// Refresh here means "re-read what is on screen" (resourceStore.refetchMounted), not "empty the cache": the
// user pulling is asking about the rows in front of them.
export function PullToRefresh() {
  const { pull, refreshing, threshold } = usePullToRefresh(refetchMounted);
  if (pull <= 0 && !refreshing) return null;

  const ready = pull >= threshold;
  // The disc starts hidden above the viewport and is carried down by the pull. Rotation tracks the drag so the
  // gesture feels attached to the finger rather than merely observed by it.
  const travel = Math.min(pull, threshold + 24);
  const spin = refreshing ? "" : `rotate(${(pull / threshold) * 270}deg)`;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center"
      style={{ transform: `translateY(${travel}px)`, marginTop: "calc(env(safe-area-inset-top) - 2.5rem)" }}
    >
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border bg-card shadow-lg transition-colors",
          ready ? "border-primary/40 text-primary" : "text-muted-foreground"
        )}
      >
        <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} style={{ transform: spin }} />
      </div>
    </div>
  );
}
