import * as React from "react";

// Scroll a popover with the wheel or a finger while a dialog holds the page's scroll lock.
//
// Radix's Dialog (and Sheet, which is one) locks page scrolling with react-remove-scroll, which cancels the
// `wheel` and `touchmove` events it judges to be outside the open layer. A Popover portals its content to
// <body>, so a list inside a popover opened from a dialog is outside that layer by DOM containment and is
// cancelled along with the page behind it. The list still had its scrollbar and still moved by drag and by
// keyboard; only the wheel and the finger did nothing, which reads as a broken list rather than a locked page.
//
// This is deliberately not fixed by making the popover modal so it owns the lock instead: that brings a focus
// trap, an aria-hidden sweep of the page and a scrollbar-gap shift, for what is a menu.
//
// The trigger is react-remove-scroll's OWN marker - it stamps `data-scroll-locked` on <body> while any lock is
// held (index.css leans on the same attribute). Reading the lock rather than the cancelled event matters: the
// cancel happens in a bubble-phase listener on `document`, so whether a listener of ours sees `defaultPrevented`
// depends on registration order, and Sentry's addEventListener instrumentation sits in the middle of that.
// The marker is a fact about the page, readable at any point in the dispatch.
//
// With no lock held this does nothing at all and native scrolling - momentum, chaining, smooth-scroll
// animation - is untouched. Under a lock the scrolling is ours: preventDefault first, so that the cancel
// cannot double up with it, and then the delta applied by hand.
//
// Takes the NODE, not a ref to it. A popover's content is in the DOM only while it is open, so a ref is still
// empty on the render that sets this up and an effect keyed on the ref object never runs again to find it
// filled - it would attach to nothing, for the life of the popover. Passing the node means the caller's
// callback ref re-renders on mount and unmount and this re-runs with each.
export function useWheelScrollFallback(root: HTMLElement | null) {
  React.useEffect(() => {
    if (!root) return;

    // Left alone unless the browser is about to refuse the scroll anyway: under a lock, or after something
    // else has already cancelled the event.
    const browserWillRefuse = (e: Event) => e.defaultPrevented || document.body.hasAttribute("data-scroll-locked");

    // Takes the scroll only when there is somewhere for it to go, so an exhausted list still refuses it the
    // way `overscroll-contain` on these containers says it should, instead of swallowing it silently.
    const takeOver = (e: Event, dx: number, dy: number) => {
      if (!browserWillRefuse(e)) return;
      const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
      const delta = axis === "y" ? dy : dx;
      if (!delta) return;
      // From whatever is under the pointer outwards, the way the browser itself picks a scroller: a popover
      // can hold its own scrolling list (the combobox does), and the pointer is usually over a row inside it.
      const el = scrollerFor(e.target, root, axis, delta);
      if (!el) return;
      if (e.cancelable) e.preventDefault();
      if (axis === "y") el.scrollTop += delta;
      else el.scrollLeft += delta;
    };

    const onWheel = (e: WheelEvent) => {
      // Asked before the deltas are worked out: with no lock held this is every wheel event over every
      // popover in the app, and the answer is one attribute lookup.
      if (!browserWillRefuse(e)) return;
      const [dx, dy] = deltaPixels(e, root);
      takeOver(e, dx, dy);
    };

    // The finger's own position IS the scroll amount, so where the wheel carries a delta, touch has to keep the
    // previous point to subtract from. One finger only: two is a pinch, which is not a scroll.
    let last: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches.length === 1 ? e.touches[0] : null;
      last = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches.length === 1 ? e.touches[0] : null;
      if (!t || !last) return;
      const dx = last.x - t.clientX;
      const dy = last.y - t.clientY;
      last = { x: t.clientX, y: t.clientY };
      takeOver(e, dx, dy);
    };
    const onTouchEnd = () => {
      last = null;
    };

    // On the popover itself, so only what happens inside it is ever taken over - the page behind stays locked.
    // Only the two that may cancel the browser's own handling are registered non-passively: a non-passive
    // `touchstart` tells the browser it might have to wait on JS before it can start scrolling at all, which
    // is a cost paid on every tap for a handler that does nothing but remember a coordinate.
    const cancelable = { passive: false } as const;
    const passive = { passive: true } as const;
    root.addEventListener("wheel", onWheel, cancelable);
    root.addEventListener("touchmove", onTouchMove, cancelable);
    root.addEventListener("touchstart", onTouchStart, passive);
    root.addEventListener("touchend", onTouchEnd, passive);
    root.addEventListener("touchcancel", onTouchEnd, passive);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [root]);
}

// Firefox reports wheel deltas in lines, and a page-mode wheel (rare, some mice and assistive setups) in
// pages. 16px is the line height the browser's own default scrolling assumes.
const LINE_HEIGHT = 16;

function deltaPixels(e: WheelEvent, root: HTMLElement): [number, number] {
  const unit = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? root.clientHeight : 1;
  return [e.deltaX * unit, e.deltaY * unit];
}

// The nearest ancestor that can absorb this delta, `root` included and nothing above it. "Can absorb" is the
// direction too, not just the overflow: a list already at its bottom must hand a downward wheel back rather
// than eat it, or a popover becomes a place scrolling goes to die.
function scrollerFor(from: EventTarget | null, root: HTMLElement, axis: "x" | "y", delta: number): HTMLElement | null {
  let node: Element | null = from instanceof Element ? from : null;
  while (node) {
    if (node instanceof HTMLElement && hasRoom(node, axis, delta)) return node;
    if (node === root) return null;
    node = node.parentElement;
  }
  return null;
}

// Geometry first, `getComputedStyle` second, though the overflow is the more direct question: almost every
// element the walk passes (the row under the pointer, its label, the wrappers) has no overflow at all, and
// comparing two numbers already on the element rejects those without resolving a full style declaration.
function hasRoom(el: HTMLElement, axis: "x" | "y", delta: number) {
  const [position, scroll, capacity] =
    axis === "y" ? [el.scrollTop, el.scrollHeight, el.clientHeight] : [el.scrollLeft, el.scrollWidth, el.clientWidth];
  // A sub-pixel remainder is not room: layout rounding leaves fractions on containers that are, to the eye,
  // fully scrolled.
  const room = delta > 0 ? scroll - capacity - position > 1 : position > 1;
  if (!room) return false;
  // Overflowing content is not the same as scrolling it: `overflow: hidden` and `clip` both overflow silently,
  // and taking their scroll over would move content the page deliberately pinned.
  const overflow = axis === "y" ? getComputedStyle(el).overflowY : getComputedStyle(el).overflowX;
  return overflow === "auto" || overflow === "scroll";
}
