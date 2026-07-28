import * as React from "react";
import { useNotifications } from "@/lib/notifications";
import type { Column } from "@/components/common/DataTable";

// A small blue dot for a list row that has had notification-worthy activity in the last 24h (see
// `newSubjects`). Recency-based, NOT read-based: it stays for a day even after the unread badge is cleared on
// page load, so you can still spot what just changed. Renders nothing when the row isn't recent.
export function NewBadge({ path }: { path: string }) {
  const { newSubjects } = useNotifications();
  if (!newSubjects.has(path)) return null;
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-label="New" title="New" />;
}

// Decorate a column set so the FIRST (name/identity) column shows the "New" pill inline next to the value,
// rather than as a separate column. Use on a History/decided set: `withNewBadge(cols)`. Keyed off the row's
// wire `path`, which matches the notification `subject`.
export function withNewBadge<T extends { path: string }>(cols: Column<T>[]): Column<T>[] {
  if (cols.length === 0) return cols;
  const [first, ...rest] = cols;
  const renderValue = first.cell ?? ((r: T) => { const v = first.accessor?.(r); return v == null ? "" : String(v); });
  return [
    { ...first, cell: (r: T) => (
      <span className="inline-flex items-center gap-2">{renderValue(r)}<NewBadge path={r.path} /></span>
    ) },
    ...rest,
  ];
}
