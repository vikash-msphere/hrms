import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

// Lightweight client-side pagination for in-modal lists that aren't on the DataTable (role/user/collection
// rows with inline controls). Returns the current page's slice + page controls.
export function usePaged<T>(items: T[], pageSize = 10) {
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(page, totalPages - 1);
  // Snap back into range when the list shrinks (e.g. after a delete on the last page).
  React.useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);
  return {
    page: safe,
    setPage,
    pageItems: items.slice(safe * pageSize, safe * pageSize + pageSize),
    total: items.length,
    totalPages,
  };
}

export function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
      <span>{total} total</span>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="tabular-nums">{page + 1} / {totalPages}</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
