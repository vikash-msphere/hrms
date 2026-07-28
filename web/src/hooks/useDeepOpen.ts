import { useEffect, useRef } from "react";
import { idOf } from "@/lib/utils";

// Deep-link open: when the route carries a record id (`#/<page>/<id>`, e.g. from the activity feed), find that
// row once its collection has loaded and open it via the page's own handler. Fires once per id, so closing
// the opened dialog does not immediately reopen it.
export function useDeepOpen<T extends { path: string }>(openId: string | undefined, rows: T[], open: (row: T) => void) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || done.current === openId) return;
    const row = rows.find((r) => idOf(r.path) === openId);
    if (row) {
      done.current = openId;
      open(row);
    }
  }, [openId, rows, open]);
}
