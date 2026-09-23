import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Follow a list's server cursor by SCROLLING to the end of it, instead of pressing "Load more". Feed-shaped
 * pages (the board, the suggestion box) read a small first page and grow it as the reader travels, so a cold
 * open costs one short read rather than the whole 100-row cap.
 *
 * Still user-driven - nothing is fetched until the reader actually reaches the foot of what is on screen - so
 * this keeps the D1 read budget honest the way the explicit button did.
 *
 * Attach `sentinelRef` to an element rendered AFTER the last row, only while there is more to load. The
 * observer is rebuilt once each load settles, so if the sentinel is still on screen (a short first page under a
 * tall window) the next page follows immediately, and it stops as soon as the sentinel is pushed out of view.
 *
 * The sentinel opts OUT of scroll anchoring (`overflow-anchor: none`), which is what keeps the reader where they
 * were when a page lands. The sentinel is the one element guaranteed to be on screen at the moment of the fetch,
 * and it changes height as it does it (button -> spinner), so the browser would happily choose it as the anchor
 * and then compensate for every row appended ABOVE it - carrying the viewport straight past the page it just
 * fetched, down to the new foot of the list. Excluded here, the anchor falls to a row above the insertion and
 * the viewport holds still. Set on the node itself rather than asked of each caller: a feed that forgot the
 * property would look like the fetch had jumped the reader down a page.
 */
export function useInfiniteScroll(opts: {
  hasMore: boolean;
  loadMore: () => void | Promise<void>;
  /** Hold off entirely (a filter that hides the feed, a solo page, a view with no cursor to follow). */
  enabled?: boolean;
  /** How far ahead of the fold to start the next page, so the reader rarely meets a spinner. */
  rootMargin?: string;
}) {
  const { hasMore, loadMore, enabled = true, rootMargin = "600px" } = opts;
  const [loading, setLoading] = useState(false);
  // Callback ref rather than a plain ref: the effect has to re-run when the sentinel mounts/unmounts, which a
  // mutable ref would not tell it about.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const sentinelRef = useCallback((el: HTMLElement | null) => {
    if (el) el.style.overflowAnchor = "none";
    setNode(el);
  }, []);
  // Kept in a ref so a fresh `loadMore` identity never tears down a live observer mid-scroll.
  const fn = useRef(loadMore);
  fn.current = loadMore;

  useEffect(() => {
    if (!node || !hasMore || !enabled || loading) return;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((e) => e.isIntersecting)) return;
        done = true; // one page per observer; the effect re-arms it below once this load settles
        setLoading(true);
        void Promise.resolve(fn.current()).finally(() => setLoading(false));
      },
      { rootMargin },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node, hasMore, enabled, loading, rootMargin]);

  return { sentinelRef, loading };
}
