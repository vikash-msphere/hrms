import { useState, useEffect, useRef } from "react";
import type { HTMLAttributes } from "react";
import { Building, X, ChevronDown, ChevronsLeft, ChevronsRight } from "lucide-react";
import { NAV, itemVisible, itemPageKeys } from "@/nav";
import { hasCapability } from "@/lib/perm";
import { useApprovals } from "@/lib/approvals";
import { useNotifications } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useOrg, orgAnniversary, orgNameFontStack, orgNameWeight, orgNameSizePx } from "@/lib/org";
import { useMedia } from "@/hooks/useMedia";
import { useCelebrationLeadDays } from "@/hooks/useCelebrations";
import { AnniversaryOrbit, AnniversaryCaption } from "@/components/layout/AnniversaryOrbit";
import { useTheme } from "@/lib/theme";
import { lockPageScroll } from "@/lib/scrollLock";
import { useNavPrefs } from "@/lib/navPrefs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Me } from "@/types";

// Nav keys that are NOT a single collection (so no collection-scope access target on them).
const NON_COLLECTION_KEYS = new Set(["dashboard", "profile", "documents"]);

// The icon rail and the full menu stack the same boxes at the same heights - brand row, one head slot per
// group, 36px item rows - so expanding the rail (the toggle, or a hover peek) only adds labels and every icon
// stays where the pointer left it. A group's head slot holds one hairline in both: the rail draws the line
// alone, and the full menu writes the heading in front of the same line, so the rail's dividers turn into the
// headings in place.
const BRAND_ROW = "h-[68px]";
const GROUP_HEAD = "h-6";
// Tinted from the heading's own ink, not sidebar-border: that token is one neutral step off the sidebar
// (neutral-200 on neutral-100), drawn to edge a panel, and as a 1px rule inside the panel it all but vanished.
const GROUP_RULE = "h-px bg-sidebar-foreground/15";

function Brand({ collapsed }: { collapsed?: boolean }) {
  const { org } = useOrg();
  // Dark-theme logo variant, when the org uploaded one. Picked here rather than with CSS because the logo is an
  // <img> data URL: that SVG is an isolated document, so neither our `.dark` class nor its own
  // prefers-color-scheme rules (those follow the OS) track the in-app theme.
  const { resolved } = useTheme();
  const logo = (resolved === "dark" ? org.logo_dark : undefined) || org.logo;
  // A wordmark (logo + name drawn as one wide image) replaces the square-mark-plus-text pair and spans the
  // sidebar's width. It can't shrink into the w-16 icon rail, so the rail keeps using the square mark.
  const wordmark = (resolved === "dark" ? org.wordmark_dark : undefined) || org.wordmark;
  // While the incorporation anniversary is inside the org's celebration lead time - i.e. exactly when it's
  // counted in the Celebrations StatCard - the mark goes into orbit (AnniversaryOrbit.tsx). The mark itself
  // stays the org's upload; the orbit and caption are drawn round it.
  const leadDays = useCelebrationLeadDays();
  const anniv = orgAnniversary(org.incorporation_date);
  const celebrating = anniv != null && typeof leadDays === "number" && anniv.in_days <= leadDays;
  const annivTitle = celebrating ? `${anniv!.years}-year company anniversary` : undefined;
  const caption = (placement: "under-mark" | "slot") =>
    celebrating && org.incorporation_date ? <AnniversaryCaption years={anniv!.years} incorporationDate={org.incorporation_date} placement={placement} /> : null;
  if (wordmark && !collapsed) {
    return (
      // py-3, not the square mark's py-4: the wordmark is up to 44px tall, and 44 + 24 fills the brand row's
      // fixed 68px (see BRAND_ROW) where py-4 would push the menu down 8px against the rail's square mark.
      <div className="relative min-w-0 flex-1 px-4 py-3">
        {/* `isolate`: the orbit's comet swaps z-index to pass behind the image, inside this one context. */}
        <div className="relative isolate" title={annivTitle}>
          {/* w-full + object-contain: fills the sidebar width, height capped, never distorted whatever the
              uploaded aspect ratio is. The wordmark carries the org name, so it takes the name as alt text. */}
          <img src={wordmark} alt={org.logo_text?.trim() || org.name} className="relative z-[1] max-h-11 w-full object-contain object-left" />
          {celebrating && <AnniversaryOrbit />}
          {/* In the image's box: the image is shorter when the slot is narrower (the phone drawer's close
              button takes some of it), and the caption has to follow the image, not the slot's top. */}
          {caption("under-mark")}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("relative flex items-center gap-2.5 py-4", collapsed ? "justify-center px-0" : "min-w-0 flex-1 px-4")}>
      <div className="relative isolate shrink-0" title={annivTitle}>
        {logo ? (
          <img src={logo} alt="" className="relative z-[1] h-9 w-9 rounded-lg object-cover" />
        ) : (
          <div className="brand-gradient relative z-[1] flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-sm">
            <Building className="h-5 w-5" />
          </div>
        )}
        {celebrating && <AnniversaryOrbit />}
      </div>
      {!collapsed && caption("slot")}
      {!collapsed && (
        <div className="leading-tight">
          <div className="truncate text-foreground" style={{ fontFamily: orgNameFontStack(org.name_font), fontWeight: orgNameWeight(org.name_weight), fontSize: orgNameSizePx(org.name_size) }}>{org.logo_text?.trim() || org.name}</div>
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  me,
  current,
  mobileOpen,
  onNavigate,
}: {
  me: Me;
  current: string;
  mobileOpen: boolean;
  onNavigate: () => void;
}) {
  const approvals = useApprovals();
  const { unreadByPage } = useNotifications();
  const has = (perm: string) => hasCapability(me.capabilities, perm);
  // The second half of a nav gate, for the entries that are about OTHER PEOPLE: does this caller's grant reach
  // past their own rows in that collection (users/me `caller_access.read_scopes`)? The capability alone cannot
  // say - it is scope-stripped - so "Team goals" sat in every employee's sidebar over their own two goals.
  const reachesOthers = (collection: string) => !!me.scopes.read[collection];
  // Unread notifications owned by a nav item = sum over its page subtree (the item + its tabs). Approvals keeps
  // its own pending count (not notifications). There is no Notifications nav ITEM - the feed is reached from the
  // bell in the top bar, which carries the grand total - so no branch for it here.
  const itemBadge = (item: (typeof NAV)[number]["items"][number]): number => {
    if (item.key === "approvals") return approvals.total;
    return itemPageKeys(item).reduce((s, k) => s + (unreadByPage[k] ?? 0), 0);
  };
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => itemVisible(i, has, reachesOthers)),
  })).filter((g) => g.items.length > 0);

  // The folded groups and the manual rail choice, kept per user across browsers and devices (lib/navPrefs.ts).
  const [navPrefs, updateNavPrefs] = useNavPrefs(me.email);
  const collapsed = new Set(navPrefs.collapsed);
  const toggleGroup = (label: string) => {
    updateNavPrefs({ collapsed: collapsed.has(label) ? navPrefs.collapsed.filter((g) => g !== label) : [...navPrefs.collapsed, label] });
  };
  // An item is "active" for the current route when it IS the route or owns it as a workspace tab.
  const isActive = (i: (typeof groups)[number]["items"][number]) => i.key === current || !!i.tabs?.some((t) => t.key === current);
  // Keep a group open if it holds the active page, even when the user collapsed it, so the current location is
  // never hidden. Single-item groups (e.g. Admin) are never collapsible. The icon rail folds the same groups as
  // the full menu, so the rail never shows an icon that opening the sidebar would then take away.
  const collapsible = (g: (typeof groups)[number]) => g.items.length > 1;
  const groupOpen = (g: (typeof groups)[number]) => !collapsible(g) || g.items.some(isActive) || !collapsed.has(g.label);

  // Whole-sidebar icon-rail collapse: the user's manual preference, OR auto when the sidebar is docked but the
  // viewport is narrow (md up to just below lg). Below md the sidebar is a full-width drawer, so the rail never
  // applies there. `rail` is the effective state; `toggleRail` only flips the manual preference.
  const docked = useMedia("(min-width: 768px)");
  const autoNarrow = useMedia("(min-width: 768px) and (max-width: 1023px)");
  const rail = docked && (navPrefs.rail || autoNarrow);
  // Hovering the collapsed rail with a mouse opens the full menu as an overlay (`peek`), and leaving the
  // opened menu folds it back. The rail keeps its w-16 slot in the layout while it peeks, so the page never
  // reflows under the pointer. Mouse only: a tap on a touch screen fires pointerenter too, and must just
  // follow the link. The short open delay stops a pointer that is only crossing the rail from flashing it.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(true), 120);
  };
  const onPointerLeave = () => {
    window.clearTimeout(peekTimer.current);
    setPeek(false);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  const peeking = rail && peek;
  // What the menu draws as: icons only when collapsed and not peeking.
  const iconsOnly = rail && !peek;
  // Collapsing from the handle leaves the pointer inside the sidebar, so the peek is dropped with it;
  // otherwise the collapse would not show until the pointer left.
  const toggleRail = () => {
    setPeek(false);
    updateNavPrefs({ rail: !navPrefs.rail });
  };

  // --- drawer behaviour (below md only) ---------------------------------------------------------------------
  // Open, the drawer is a modal surface and has to behave like one: Escape closes it, the page behind it does
  // not scroll, and nothing outside it is reachable. Closed, it is still in the DOM off-canvas, so it must be
  // taken out of the tab order too - otherwise tabbing off the top bar walks invisibly through forty nav links.
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerOpen = mobileOpen && !docked;
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onNavigate();
    };
    document.addEventListener("keydown", onKey);
    const unlock = lockPageScroll();
    // Move focus into the panel so a screen reader and a keyboard both land where the drawer opened.
    drawerRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
    };
  }, [drawerOpen, onNavigate]);

  // Swipe left to dismiss. Touch-only, horizontal-only, and it defers to a vertical gesture (the nav list
  // scrolls), so scrolling the menu never closes it by accident.
  const touch = useRef<{ x: number; y: number; axis: "" | "x" | "y" } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, axis: "" };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (!s.axis && Math.abs(dx) + Math.abs(dy) > 12) s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (s.axis === "x" && dx < -56) {
      touch.current = null;
      onNavigate();
    }
  };
  const onTouchEnd = () => {
    touch.current = null;
  };

  // `inert` removes a subtree from focus, hit-testing and the a11y tree in one attribute - exactly what an
  // off-canvas drawer needs. React 18's DOM typings predate it, so it is applied as an untyped attribute
  // (React still forwards it, and browsers without support just see an unknown attribute).
  const inertWhenClosed = (!mobileOpen && !docked ? { inert: "" } : {}) as HTMLAttributes<HTMLElement>;

  return (
    <>
      {/* Scrim behind the mobile drawer. `inert` when closed so it cannot swallow taps meant for the page. */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-overlay backdrop-blur-sm transition-opacity md:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        aria-hidden
        onClick={onNavigate}
      />
      <aside
        ref={drawerRef}
        // Modal-drawer semantics apply only while it IS a drawer; docked, it is plain page furniture and
        // announcing a dialog would be a lie. `inert` (closed, undocked) is what removes the off-canvas links
        // from the tab order and the accessibility tree in one attribute.
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? "Navigation" : undefined}
        tabIndex={drawerOpen ? -1 : undefined}
        {...inertWhenClosed}
        onTouchStart={drawerOpen ? onTouchStart : undefined}
        onTouchMove={drawerOpen ? onTouchMove : undefined}
        onTouchEnd={drawerOpen ? onTouchEnd : undefined}
        onPointerEnter={rail ? onPointerEnter : undefined}
        onPointerLeave={rail ? onPointerLeave : undefined}
        className={cn(
          // Mobile: a fixed off-canvas drawer. Desktop: sticky to the viewport at full height (md:sticky +
          // md:h-screen) so it never stretches with tall page content; the nav inside scrolls on its own.
          // Collapsed to a w-16 icon rail when `rail` is set (see above); full w-64 otherwise. Peeking, it is
          // w-64 with -mr-48 (256px - 192px = the rail's 64px), so it overlays the page instead of pushing it.
          // standalone:pt-safe-t: installed as a PWA there is no browser chrome, so the drawer's own top
          // edge is what the status bar/notch overlaps.
          // `pl-safe-l` is the landscape notch: the drawer is fixed to the left edge on a phone, so it is
          // exactly what the notch covers. From `md` it is sticky inside the shell, which pads itself.
          // `translate`, not `transform`, in the transition: Tailwind 4's `-translate-x-full` sets the CSS
          // `translate` property, so a `transform` transition left the phone drawer snapping open and shut.
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar pl-safe-l transition-[translate,width,margin] standalone:pt-safe-t md:sticky md:top-0 md:h-screen md:shrink-0 md:translate-x-0 md:pl-0",
          iconsOnly ? "w-16" : "w-64",
          peeking && "-mr-48 shadow-xl",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className={cn(BRAND_ROW, "flex shrink-0 items-center", iconsOnly ? "justify-center" : "justify-between")}>
          <Brand collapsed={iconsOnly} />
          {/* Finger-sized close, and labelled: an unlabelled X is the most common unnamed control in a drawer. */}
          <button
            type="button"
            aria-label="Close navigation"
            className="mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground md:hidden"
            onClick={onNavigate}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* overscroll-contain: scrolling to the end of the nav list must not start scrolling the page behind
            the open drawer. The safe-area padding keeps the last item above the home indicator. */}
        <nav
          className={cn(
            "flex-1 space-y-2 overflow-y-auto overscroll-contain pt-1",
            "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
            iconsOnly ? "px-2" : "px-3",
            // The peek widens while the full menu is already drawn, so labels would wrap and a sideways
            // scrollbar flash for the length of the width transition.
            rail && "overflow-x-hidden whitespace-nowrap",
          )}
        >
          {iconsOnly ? (
            // Icon rail: labels + group headers collapse to icons; the label (and unread count) live in a
            // hover tooltip, and unread badges shrink to a corner dot. Each group opens on the hairline its
            // heading is drawn on in the full menu (GROUP_HEAD); a folded group is that line alone.
            <TooltipProvider delayDuration={0}>
              {groups.map((group) => {
                return (
                  <div key={group.label}>
                    <div className={cn(GROUP_HEAD, "flex items-center px-2")} aria-hidden>
                      <span className={cn(GROUP_RULE, "w-full")} />
                    </div>
                    {groupOpen(group) && (
                    <div className="space-y-1">
                    {group.items.map((item) => {
                      const active = isActive(item);
                      const Icon = item.icon;
                      const badge = itemBadge(item);
                      return (
                        <Tooltip key={item.key}>
                          <TooltipTrigger asChild>
                            <a
                              href={`/${item.key}`}
                              onClick={onNavigate}
                              aria-current={active ? "page" : undefined}
                              aria-label={item.label}
                              className={cn(
                                "relative flex h-9 items-center justify-center rounded-lg transition-colors",
                                active ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                              )}
                            >
                              <Icon className="h-[18px] w-[18px] shrink-0" />
                              {badge > 0 && <span className={cn("absolute right-1.5 top-1.5 h-2 w-2 rounded-full", active ? "bg-sidebar-accent-foreground" : "bg-primary")} aria-hidden />}
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="right">{item.label}{badge > 0 ? ` (${badge > 99 ? "99+" : badge})` : ""}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                    </div>
                    )}
                  </div>
                );
              })}
            </TooltipProvider>
          ) : (
          groups.map((group) => {
            const isOpen = groupOpen(group);
            return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => collapsible(group) && toggleGroup(group.label)}
                aria-expanded={isOpen}
                className={cn(
                  GROUP_HEAD,
                  "flex w-full items-center gap-2 rounded-md px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/70 transition-colors",
                  collapsible(group) && "hover:text-sidebar-foreground",
                )}
              >
                {group.label}
                <span className={cn(GROUP_RULE, "flex-1")} aria-hidden />
                {collapsible(group) && (
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !isOpen && "-rotate-90")} />
                )}
              </button>
              {isOpen && (
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = isActive(item);
                  const Icon = item.icon;
                  const badge = itemBadge(item);
                  // Workspace items aren't a single collection, so no collection-scope access icon on them.
                  const collection = item.tabs || NON_COLLECTION_KEYS.has(item.key) ? undefined : item.key;
                  return (
                    <div key={item.key} className="relative">
                      {/* Left accent rail on the active item for at-a-glance wayfinding. */}
                      {active && (
                        <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />
                      )}
                      <a
                        href={`/${item.key}`}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                            : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                        )}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0" />
                        {item.label}
                        {badge > 0 && (
                          <span className={cn(
                            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums",
                            // Inverted against the row it sits on, so it reads as a count either way round.
                            active ? "bg-sidebar-accent-foreground text-sidebar-accent" : "bg-primary text-primary-foreground",
                          )}>
                            {badge > 99 ? "99+" : badge}
                          </span>
                        )}
                      </a>
                      {collection && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                          <AccessTarget target={{ collection, label: item.label }} />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
            );
          })
          )}
        </nav>
        {docked && !autoNarrow && (
          // A small handle straddling the sidebar's right edge (no dedicated row, so it costs no menu space).
          <button
            type="button"
            onClick={toggleRail}
            title={rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            // One neutral step LIGHTER than the sidebar in both themes, so the handle sits slightly raised off
            // the nav rows and off the page it overhangs. Not bg-background: the handle's outer half would match
            // the page it overhangs. Card is that step in light (white on neutral-100) and muted is it in dark
            // (night-750 on night-950, lighter than the night-900 page too).
            className="absolute bottom-4 right-0 z-20 hidden h-6 w-6 translate-x-1/2 items-center justify-center rounded-full border border-sidebar-border bg-card text-sidebar-foreground/80 shadow-sm transition-colors hover:text-foreground dark:bg-muted md:flex"
          >
            {rail ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
          </button>
        )}
      </aside>
    </>
  );
}
