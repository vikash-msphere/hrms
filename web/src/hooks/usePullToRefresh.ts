import { useEffect, useRef, useState } from "react";

// Pull down at the top of a page to re-read it. The gesture every phone user tries first, and the one thing
// a web app has to implement itself.
//
// The whole difficulty is deciding whether a downward drag is THIS gesture or somebody else's, and getting
// that wrong is worse than not having it: a pull that fires while the user meant to scroll a dialog, or that
// eats the horizontal swipe between kanban columns, breaks a working interaction to add an optional one. So
// the start is filtered hard (top of the page, a finger, no modal open, not inside anything that scrolls on
// its own) and the direction is decided once, on the first few pixels of movement, and then held.

const THRESHOLD = 72; // how far it has to travel before the release counts as a refresh
const MAX_PULL = 120; // where the rubber band stops giving

// Resistance: the finger moves further than the indicator, and progressively so. Without this the sheet
// tracks 1:1 and the gesture feels like dragging the page off, rather than stretching against a stop.
const damp = (dy: number) => MAX_PULL * (1 - Math.exp(-dy / MAX_PULL));

/** True when the touch started inside something that does its own scrolling and is not already at ITS top. */
function insideOwnScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el.scrollTop > 0) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

export function usePullToRefresh(onRefresh: () => Promise<unknown>, enabled = true) {
  // How far the indicator has travelled, and whether the refresh it asked for is still running. Kept in state
  // (not a ref) because the indicator is a React node; the gesture bookkeeping stays in refs so a move event
  // never re-renders anything but the indicator.
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<"none" | "vertical" | "other">("none");
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    // Touch only. A trackpad's overscroll is the browser's business, and a mouse has no pull.
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    const onStart = (e: TouchEvent) => {
      start.current = null;
      axis.current = "none";
      if (busy.current || e.touches.length !== 1) return;
      if (window.scrollY > 0) return; // only from the very top of the page
      // A modal owns the screen while it is open: a pull behind it would refresh a page the user cannot see.
      // Two forms of modal to catch - Radix's (every dialog and sheet, which mark themselves open) and the
      // hand-rolled navigation drawer, which announces itself with `aria-modal` only while it is open.
      if (document.querySelector('[role="dialog"][data-state="open"], [aria-modal="true"]')) return;
      if (insideOwnScroller(e.target)) return;
      const t = e.touches[0]!;
      start.current = { x: t.clientX, y: t.clientY };
    };

    const onMove = (e: TouchEvent) => {
      const from = start.current;
      if (!from) return;
      const t = e.touches[0]!;
      const dy = t.clientY - from.y;
      const dx = t.clientX - from.x;
      // Decide the axis once, after enough movement to mean something, and never revisit it. Re-deciding
      // mid-gesture is what makes a swipe feel like it is being fought over.
      if (axis.current === "none") {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        axis.current = dy > 0 && Math.abs(dy) > Math.abs(dx) ? "vertical" : "other";
        if (axis.current === "other") start.current = null;
        return;
      }
      if (axis.current !== "vertical") return;
      if (dy <= 0) { setPull(0); return; }
      // Non-passive listener, so this can be claimed: without it iOS runs its own rubber-band over the top of
      // ours and the page bounces while the indicator is being dragged.
      if (e.cancelable) e.preventDefault();
      setPull(damp(dy));
    };

    const onEnd = () => {
      const armed = start.current !== null && axis.current === "vertical";
      start.current = null;
      axis.current = "none";
      if (!armed) return;
      setPull((current) => {
        if (current < THRESHOLD || busy.current) return 0;
        busy.current = true;
        setRefreshing(true);
        // Hold the indicator at the threshold while the read runs, so the spinner has somewhere to sit.
        void Promise.resolve(run.current())
          .catch(() => {})
          .then(() => {
            busy.current = false;
            setRefreshing(false);
            setPull(0);
          });
        return THRESHOLD;
      });
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);

  return { pull, refreshing, threshold: THRESHOLD };
}
