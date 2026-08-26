import { useEffect, useState } from "react";

/** How much of the screen the on-screen keyboard is covering, in px. Zero on desktop, and zero the moment
 *  the keyboard closes.
 *
 *  Anything anchored to the bottom of a phone screen is anchored exactly where the keyboard appears. Safari
 *  (and any browser that ignores `interactive-widget=resizes-content`) keeps the LAYOUT viewport at full
 *  height and only shrinks the VISUAL one, so `position: fixed; bottom: 0` stays pinned under the keys - and
 *  the field being typed into is the one you cannot see. visualViewport reports the difference; a bottom
 *  sheet lifts by it, and a bottom nav bar gets out of the way entirely.
 *
 *  Consumers: components/ui/dialog.tsx and sheet.tsx (lift), layout/BottomNav.tsx (hide). */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      // offsetTop matters when the page is scrolled within a pinch-zoomed viewport; without it the panel jumps.
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      // Under ~80px it is browser chrome moving, not a keyboard, and reacting to that only makes a panel
      // twitch while someone scrolls.
      setInset(covered > 80 ? Math.round(covered) : 0);
    };
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, []);
  return inset;
}
