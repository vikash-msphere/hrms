import * as React from "react";
import { AlertCircle } from "lucide-react";
import type { LoadState } from "@/hooks/useCollection";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/common/Skeletons";

/** Renders loading skeletons / error panel, otherwise the children. */
export function DataState({
  state,
  error,
  onRetry,
  rows = 5,
  skeleton,
  children,
}: {
  state: LoadState;
  error?: string | null;
  onRetry?: () => void;
  rows?: number;
  /** A placeholder shaped like what is actually loading. The default row of bars fits a table; a page whose
   *  content is nothing like a table (a card feed, a chart) passes its own, so the wait doesn't misdescribe
   *  what arrives. */
  skeleton?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (state === "loading") {
    if (skeleton) return <>{skeleton}</>;
    // The default is shaped like what is behind it in nearly every caller: a DataTable, which is a toolbar
    // (search, filters, view controls) over a table. A stack of identical full-width slabs is the same number
    // of pixels and says nothing about what is coming - and, worse, is a different height from the toolbar,
    // so the real one shoves the first row down as it lands.
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-9 w-full max-w-64 rounded-md" />
          <Skeleton className="ml-auto hidden h-9 w-24 rounded-md sm:block" />
        </div>
        <TableSkeleton rows={rows} cols={4} />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center">
        <AlertCircle className="mb-3 h-7 w-7 text-destructive" />
        <p className="text-sm font-medium text-foreground">Couldn't load this data</p>
        {error && <p className="mt-1 max-w-md text-sm text-muted-foreground">{error}</p>}
        {onRetry && (
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return <>{children}</>;
}
