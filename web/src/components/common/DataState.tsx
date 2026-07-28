import * as React from "react";
import { AlertCircle } from "lucide-react";
import type { LoadState } from "@/hooks/useCollection";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/** Renders loading skeletons / error panel, otherwise the children. */
export function DataState({
  state,
  error,
  onRetry,
  rows = 5,
  children,
}: {
  state: LoadState;
  error?: string | null;
  onRetry?: () => void;
  rows?: number;
  children: React.ReactNode;
}) {
  if (state === "loading") {
    return (
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
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
