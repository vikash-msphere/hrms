import { useEffect, useRef } from "react";

// Refetch when the user returns to the tab/window, so a view someone else has been editing (a shared kanban
// board, an approvals queue) catches up without polling. Throttled so a quick alt-tab doesn't spam D1 reads -
// refreshes at most once per `minIntervalMs`, and only when the document is actually visible.
export function useRefetchOnFocus(reload: () => void, minIntervalMs = 60_000) {
  const last = useRef(Date.now());
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    const maybe = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last.current < minIntervalMs) return;
      last.current = Date.now();
      fn.current();
    };
    window.addEventListener("focus", maybe);
    document.addEventListener("visibilitychange", maybe);
    return () => {
      window.removeEventListener("focus", maybe);
      document.removeEventListener("visibilitychange", maybe);
    };
  }, [minIntervalMs]);
}
