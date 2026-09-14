import * as React from "react";
import { cn } from "@/lib/utils";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { PresencePill } from "@/components/common/PresencePill";
import type { Presence } from "@/types";

/**
 * Who you are looking at, once the header has scrolled away.
 *
 * A record page is long - eleven tabs, and panels inside them that run for screens - so by the time you are
 * deciding something about this person, their name is several screens up. The bar puts the identity and the
 * page's actions back on screen without costing anything while the real header is still visible.
 *
 * Watched with an IntersectionObserver on the header itself rather than a scroll listener: the question is
 * literally "is the header on screen", so observing it answers directly and costs nothing per frame.
 */
export function ProfileStickyBar({
  watch,
  employeeId,
  name,
  subtitle,
  photo,
  presence,
  actions,
}: {
  /**
   * The header's IDENTITY row - the name and its actions. The bar shows while this is out of view.
   * Deliberately not the whole card: watching all of it (identity, facts band and tab strip) meant the bar
   * only appeared once ~450px had scrolled past, so on any record whose page scrolls less than that it never
   * appeared at all - which reads exactly like a broken feature.
   */
  watch: React.RefObject<HTMLElement | null>;
  employeeId: string;
  name: string;
  subtitle?: string;
  photo?: string;
  presence: Presence | null;
  actions?: React.ReactNode;
}) {
  const [stuck, setStuck] = React.useState(false);
  React.useEffect(() => {
    const el = watch.current;
    // No element to watch (the record is still loading) means nothing has scrolled away yet.
    if (!el || typeof IntersectionObserver === "undefined") return;
    // A 64px top margin, so the bar appears as the header passes under the app's own top bar rather than at
    // the instant its last pixel leaves the viewport.
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), { rootMargin: "-64px 0px 0px 0px", threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [watch]);

  return (
    // ZERO-HEIGHT sticky container with the bar absolutely positioned inside it. `position: sticky` stays in
    // normal flow, so a bar that is merely transparent still reserves its own height - which put a bar's worth
    // of empty space permanently above the header, every page load, for something nobody could see. `h-0`
    // means it costs no layout at all until it is stuck, and then it floats over the content it is scrolling
    // past (hence the blur and the shadow).
    //
    // Always mounted, animated on `stuck`: mounting it on scroll would pop a fully-formed bar into place and
    // re-run the avatar fetch every time you scrolled past the header.
    // `top-14` is the app top bar's height - this sits directly under it, not over it.
    <div data-testid="profile-sticky-bar-slot" className="sticky top-14 z-20 h-0">
      <div
        data-testid="profile-sticky-bar"
        aria-hidden={!stuck}
        className={cn(
          "absolute inset-x-0 top-0 transition-all duration-200",
          stuck ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0",
        )}
      >
        <div className="flex flex-wrap items-center gap-3.5 rounded-[14px] border bg-card/85 px-4 py-2.5 shadow-lg backdrop-blur">
          <PhotoAvatar className="h-[38px] w-[38px] shrink-0 rounded-[9px]" employeeId={employeeId} name={name} photo={photo} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[15px] font-bold leading-tight tracking-[-0.01em]">{name}</span>
            {subtitle && <span className="truncate text-[12.5px] text-muted-foreground">{subtitle}</span>}
          </div>
          <PresencePill presence={presence} />
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
