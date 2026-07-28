import { TriangleAlert } from "lucide-react";
import { useCollectionHasMore } from "@/hooks/useCollection";
import { cn } from "@/lib/utils";

// Says out loud that a view is showing only the first page of a collection. The server caps a list page and
// nothing here follows the cursor, so any view that renders cached rows can be showing a window - and a view
// that looks complete but isn't is worse than a slow one: a calendar quietly missing leave, or a filter
// reporting "none" for a record that exists.
//
// DataTable derives this itself (from `accessCollection`); this is for the views that aren't tables. Renders
// nothing at all when the collection fits in one page, so it is safe to drop in unconditionally.
// `collection` may be several, for a view assembled from more than one (the approvals queue): one notice is
// shown if ANY of them is truncated, since the assembled view is incomplete either way.
export function TruncationNotice({ collection, what, className }: { collection: string | string[]; what?: string; className?: string }) {
  const hasMore = useCollectionHasMore(collection);
  if (!hasMore) return null;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300", className)}>
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Showing only the first page of {what ?? "records"} — there are more than are loaded here, so this view is incomplete.
        Use search (⌘K) to find a specific record.
      </span>
    </div>
  );
}
