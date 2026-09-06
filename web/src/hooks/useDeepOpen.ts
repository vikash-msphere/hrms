import { useEffect, useRef } from "react";
import { idOf } from "@/lib/utils";
import { routeRecord } from "@/router";

// Deep-link open: when the route carries a record id (`#/<page>/<id>`, e.g. from the activity feed), find that
// row once its collection has loaded and open it via the page's own handler. Fires once per id, so closing
// the opened dialog does not immediately reopen it.
export function useDeepOpen<T extends { path: string }>(openId: string | undefined, rows: T[], open: (row: T) => void) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || done.current === openId) return;
    // The record segment is written and cleared with `setRouteRecord`, which replaces the hash WITHOUT firing
    // hashchange - so `openId` (parsed by useRoute on the last hashchange) can name a record the URL no longer
    // carries. Opening on that stale value reopens a dialog the reader has just closed, which is a dialog that
    // cannot be closed at all. The live hash is the truth here.
    if (routeRecord() !== openId) return;
    const row = rows.find((r) => idOf(r.path) === openId);
    if (row) {
      done.current = openId;
      open(row);
    }
  }, [openId, rows, open]);
}
