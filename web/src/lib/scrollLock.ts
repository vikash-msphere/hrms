// Freezing the page behind an overlay that is not a Radix layer (Radix brings its own lock; see the
// `body[data-scroll-locked]` note in index.css).
//
// The lock goes on <html>, never on <body>. `body` is `height: 100%`, so hiding ITS overflow shrinks the
// document to a single screen, the browser clamps the scroll position to 0, and the reader is dropped at the
// top of the list the moment the overlay opens - the position is gone before the restore can put it back.
// <html> is the element that actually scrolls, so hiding its overflow stops the scrolling with the scrollable
// height, and therefore the position, untouched.
//
// Only the y axis is touched: `html { overflow-x: clip }` is a permanent backstop against sideways drift and
// must survive the lock. And the previous inline value is restored rather than cleared, so an overlay holding
// its own lock underneath is not released early by this one closing.
export function lockPageScroll(): () => void {
  const el = document.documentElement;
  const prev = el.style.overflowY;
  el.style.overflowY = "hidden";
  return () => {
    el.style.overflowY = prev;
  };
}
