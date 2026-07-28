import { AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// The staleness signal for every panel that edits a split input (pay components, salary structures, CTC
// provisions), off the shared useSplitStaleness hook, so it reads identically wherever the change was made.
// Two distinct states, because they need different action:
//   stale   - amber: the split moved but the CTC still fits. A re-apply-to-all fixes these.
//   skipped - red: the change pushed committed cost past the employee's fixed CTC; NO split fits, so re-apply
//             leaves them untouched. HR must raise the CTC or trim components. (The old banner ignored these,
//             which is why a cost-increasing change looked like it "did nothing".)
// Renders nothing when the caller can't re-apply or nothing needs attention.
export function SplitStaleBanner({
  staleCount,
  skippedCount = 0,
  reapplying,
  canReapply,
  onReapply,
}: {
  staleCount: number;
  skippedCount?: number;
  reapplying: boolean;
  canReapply: boolean;
  onReapply: () => void;
}) {
  if (!canReapply || (staleCount <= 0 && skippedCount <= 0)) return null;
  return (
    <div className="space-y-2">
      {staleCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {staleCount} employee{staleCount === 1 ? "'s" : "s'"} pay split {staleCount === 1 ? "is" : "are"} out
              of date with the current setup (each annual CTC is unchanged).
            </span>
          </div>
          <Button size="sm" onClick={onReapply} disabled={reapplying}>
            {reapplying ? "Re-applying…" : "Re-apply to all employees"}
          </Button>
        </div>
      )}
      {skippedCount > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {skippedCount} employee{skippedCount === 1 ? "'s" : "s'"} CTC no longer fits the current components -
            their basic + fixed components already exceed the annual CTC, so no split can be derived. Re-apply
            cannot fix {skippedCount === 1 ? "it" : "these"}; raise the affected CTC or trim components.
          </span>
        </div>
      )}
    </div>
  );
}
