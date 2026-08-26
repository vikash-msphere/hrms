import { useEffect, useRef, type RefObject } from "react";

/** Keeps the active item of a horizontally scrolling bar (workspace tabs, in-page tabs, filter chips) inside
 *  the visible strip.
 *
 *  On a phone a bar of ten tabs scrolls, and the active one is routinely off screen: you land on a page with
 *  no visible indication of where you are, and finding the tab you just came from means dragging the strip
 *  back. Nothing in CSS can do this - which item is active is only known to the DOM - so it is one observer
 *  per bar rather than a scroll handler.
 *
 *  Only the horizontal axis is touched, and only when the item is actually clipped, so a bar that fits (every
 *  desktop case) never scrolls at all. The first placement is instant; later ones animate, because by then
 *  the movement is feedback for something the user just did. */
export function useScrollActiveIntoView(
  ref: RefObject<HTMLElement>,
  // Both markers, so this serves Radix tabs (`data-state`) and plain anchor bars (`aria-current`) alike.
  selector = '[data-state="active"],[aria-current="page"]',
) {
  const settled = useRef(false);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const bring = () => {
      const active = box.querySelector<HTMLElement>(selector);
      if (!active) return;
      const clipped = active.offsetLeft < box.scrollLeft || active.offsetLeft + active.offsetWidth > box.scrollLeft + box.clientWidth;
      if (!clipped) {
        settled.current = true;
        return;
      }
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      box.scrollTo({
        left: Math.max(0, active.offsetLeft - (box.clientWidth - active.offsetWidth) / 2),
        behavior: settled.current && !reduce ? "smooth" : "auto",
      });
      settled.current = true;
    };
    bring();
    const mo = new MutationObserver(bring);
    mo.observe(box, { attributes: true, subtree: true, attributeFilter: ["data-state", "aria-current"] });
    return () => mo.disconnect();
  }, [ref, selector]);
}
