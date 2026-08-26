import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Viewport gates for the named regions of a long page, sharing ONE IntersectionObserver.
 *
 * A dashboard is a column of widgets, most of them below the fold, each backed by its own read. Fetching all
 * of them on mount spends the whole page's D1 budget before the reader has seen anything. So each region gets
 * a probe element, and its reads are gated on `seen(id)`: nothing is fetched for a widget until its slot comes
 * into view (`rootMargin` starts it slightly early, so the data is usually there by the time it is).
 *
 * Two properties make this cheap rather than chatty:
 *  - LATCHED. A region that has been seen once stays seen, so scrolling back and forth re-reads nothing and a
 *    widget never flickers back to its skeleton.
 *  - BATCHED. The observer reports every region that is already on screen in ONE callback, so their reads fire
 *    in one commit and the GET coalescer collapses them into a single `POST /v1/batch:run` (see
 *    lib/getCoalescer.ts). Scrolling to the next screenful is another single batch, not a request per widget.
 *
 * A region whose probe never renders (a section the viewer hid, or one whose slot never reaches the viewport)
 * is never fetched at all - which is the point.
 */
export function useVisibleRegions(rootMargin = "300px") {
  const [seenSet, setSeenSet] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Read inside the ref callbacks, which must stay stable across renders (a fresh callback identity would make
  // React detach and re-attach every probe on every render).
  const seenRef = useRef(seenSet);
  seenRef.current = seenSet;
  const io = useRef<IntersectionObserver | null>(null);
  const callbacks = useRef(new Map<string, (el: Element | null) => void>());
  const nodes = useRef(new Map<string, Element>());
  const margin = useRef(rootMargin);

  const observer = useCallback(() => {
    if (!io.current) {
      io.current = new IntersectionObserver(
        (entries) => {
          const arrived: string[] = [];
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const id = (e.target as HTMLElement).dataset.region;
            if (id) arrived.push(id);
            io.current?.unobserve(e.target); // latched: one sighting per region is all this needs
          }
          if (!arrived.length) return;
          setSeenSet((prev) => {
            const next = new Set(prev);
            for (const id of arrived) next.add(id);
            return next;
          });
        },
        { rootMargin: margin.current },
      );
    }
    return io.current;
  }, []);

  useEffect(() => () => io.current?.disconnect(), []);

  /** Ref for a region's probe element. Stable per id, so attaching it costs nothing on re-render. */
  const regionRef = useCallback(
    (id: string) => {
      let cb = callbacks.current.get(id);
      if (!cb) {
        cb = (el: Element | null) => {
          const prev = nodes.current.get(id);
          if (prev && prev !== el) {
            io.current?.unobserve(prev);
            nodes.current.delete(id);
          }
          if (!el || seenRef.current.has(id)) return;
          (el as HTMLElement).dataset.region = id;
          nodes.current.set(id, el);
          observer().observe(el);
        };
        callbacks.current.set(id, cb);
      }
      return cb;
    },
    [observer],
  );

  return { regionRef, seen: (id: string) => seenSet.has(id) };
}
