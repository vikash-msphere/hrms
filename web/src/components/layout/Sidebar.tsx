import { useState, useEffect } from "react";
import { Building, X, ChevronDown, ChevronsLeft, ChevronsRight } from "lucide-react";
import { NAV, itemVisible, itemPageKeys } from "@/nav";
import { hasCapability } from "@/lib/perm";
import { useApprovals } from "@/lib/approvals";
import { useNotifications } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useOrg, orgAnniversary, orgNameFontStack, orgNameWeight, orgNameSizePx, CELEBRATION_WEEK_DAYS } from "@/lib/org";
import { useMedia } from "@/hooks/useMedia";
import { useTheme } from "@/lib/theme";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Me } from "@/types";

// Nav keys that are NOT a single collection (so no collection-scope access target on them).
const NON_COLLECTION_KEYS = new Set(["dashboard", "profile", "documents"]);

// Which sidebar groups the user has collapsed, persisted per user in localStorage (a pure UI preference,
// so no server round-trip). Stored as the set of collapsed group labels.
const collapseKey = (email: string) => `nav:collapsed:${email}`;
function loadCollapsed(email: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapseKey(email)) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed(email: string, set: Set<string>) {
  try {
    localStorage.setItem(collapseKey(email), JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

// Whether the whole sidebar is collapsed to an icon rail, a per-user preference (localStorage, pure UI).
const railKey = (email: string) => `nav:rail:${email}`;
const loadRail = (email: string) => localStorage.getItem(railKey(email)) === "1";
const saveRail = (email: string, on: boolean) => {
  try { localStorage.setItem(railKey(email), on ? "1" : "0"); } catch { /* ignore */ }
};

// A festive balloon-and-ribbon overlay shown during the company anniversary week (matches the balloon+ribbon
// reference): big glossy teardrop balloons cluster up-and-right (overlapping only the logo's right edge),
// their strings trailing into a curved constant-width red banner along the bottom carrying "<n> YRS".
function AnniversaryBanner({ className, years }: { className?: string; years?: number }) {
  // Balloon: a broad rounded dome up top, widest in the upper third, then tapering down to the tie point
  // (cx, cy+ry) - the natural pear/egg balloon shape, not a perfect circle or a thin teardrop.
  const balloonPath = (cx: number, cy: number, rx: number, ry: number) =>
    `M${cx} ${cy - ry} C ${cx + rx * 0.78} ${cy - ry} ${cx + rx} ${cy - ry * 0.62} ${cx + rx} ${cy - ry * 0.22} C ${cx + rx} ${cy + ry * 0.3} ${cx + rx * 0.32} ${cy + ry * 0.78} ${cx} ${cy + ry} C ${cx - rx * 0.32} ${cy + ry * 0.78} ${cx - rx} ${cy + ry * 0.3} ${cx - rx} ${cy - ry * 0.22} C ${cx - rx} ${cy - ry * 0.62} ${cx - rx * 0.78} ${cy - ry} ${cx} ${cy - ry} Z`;
  // Gather point on the ribbon where the balloon strings meet - off to the right, not the center.
  const gx = 156, gy = 150;
  const balloons = [
    { cx: 178, cy: 18, rx: 46, ry: 56, t: 12, g: "annivRed" },
    { cx: 224, cy: 40, rx: 39, ry: 48, t: 16, g: "annivGreen" },
    { cx: 192, cy: 58, rx: 39, ry: 48, t: 14, g: "annivGold" },
  ];
  const label = years != null ? `${years} ${years === 1 ? "YR" : "YRS"}` : "";
  return (
    <svg viewBox="0 0 200 224" className={className} aria-hidden="true">
      <defs>
        <radialGradient id="annivRed" cx="36%" cy="28%" r="78%"><stop offset="0%" stopColor="#ff8585" /><stop offset="55%" stopColor="#e23b3b" /><stop offset="100%" stopColor="#a81818" /></radialGradient>
        <radialGradient id="annivGreen" cx="36%" cy="28%" r="78%"><stop offset="0%" stopColor="#bdec92" /><stop offset="55%" stopColor="#7cb342" /><stop offset="100%" stopColor="#4f8a2c" /></radialGradient>
        <radialGradient id="annivGold" cx="36%" cy="28%" r="78%"><stop offset="0%" stopColor="#ffe9a8" /><stop offset="55%" stopColor="#f6b73c" /><stop offset="100%" stopColor="#d6890c" /></radialGradient>
        <linearGradient id="annivRibbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e63b3b" /><stop offset="100%" stopColor="#9e1414" /></linearGradient>
        <linearGradient id="annivRibbonFold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8e1515" /><stop offset="100%" stopColor="#6a0f0f" /></linearGradient>
      </defs>
      {/* balloon strings (behind the balloons), gathering at the ribbon */}
      {balloons.map((b, i) => <path key={`s${i}`} d={`M${b.cx} ${b.cy + b.ry} Q ${(b.cx + gx) / 2} ${(b.cy + gy) / 2 + 10} ${gx} ${gy}`} fill="none" stroke="#9aa0a6" strokeWidth="1" />)}
      {/* glossy teardrop balloons with a highlight (the teardrop's lower point is the tie - no extra knot) */}
      {balloons.map((b, i) => (
        <g key={i} transform={`rotate(${b.t} ${b.cx} ${b.cy + b.ry})`}>
          <path d={balloonPath(b.cx, b.cy, b.rx, b.ry)} fill={`url(#${b.g})`} />
          <ellipse cx={b.cx - b.rx * 0.32} cy={b.cy - b.ry * 0.36} rx={b.rx * 0.24} ry={b.ry * 0.3} fill="#ffffff" opacity="0.5" />
        </g>
      ))}
      {/* red banner (the ribbon.png shape): swallowtail tails behind, an arched band whose ends fold down over
          them, with the darker underside showing at each fold. */}
      <path d="M44 160 20 160 23 214 33 203 43 214Z" fill="url(#annivRibbon)" stroke="#7a1010" strokeWidth="1" strokeLinejoin="round" />
      <path d="M156 160 180 160 177 214 167 203 157 214Z" fill="url(#annivRibbon)" stroke="#7a1010" strokeWidth="1" strokeLinejoin="round" />
      <path d="M30 150 Q100 116 170 150 L170 190 Q100 156 30 190 Z" fill="url(#annivRibbon)" stroke="#7a1010" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M30 189 C38 195 39 205 33 211 28 203 27 195 30 189 Z" fill="url(#annivRibbonFold)" />
      <path d="M170 189 C162 195 161 205 167 211 172 203 173 195 170 189 Z" fill="url(#annivRibbonFold)" />
      {/* "<n> YRS" centered on the band, in a festive script */}
      {label && (
        <text x="100" y="153" textAnchor="middle" dominantBaseline="central" fontSize="27" fontWeight="800" letterSpacing="0.5" fill="#ffffff" stroke="#7a1010" strokeWidth="0.3" style={{ fontFamily: '"Arial Rounded MT Bold", "Marker Felt", "Trebuchet MS", system-ui, sans-serif' }}>{label}</text>
      )}
    </svg>
  );
}

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
  // Drape a celebration banner across the logo while the incorporation anniversary is in the dashboard's
  // "this week" window - i.e. exactly when it's counted in the Celebrations StatCard.
  const anniv = orgAnniversary(org.incorporation_date);
  const celebrating = anniv != null && anniv.in_days <= CELEBRATION_WEEK_DAYS;
  const annivTitle = celebrating ? `${anniv!.years}-year company anniversary` : undefined;
  if (wordmark && !collapsed) {
    return (
      <div className="min-w-0 flex-1 px-4 py-4">
        <div className="relative" title={annivTitle}>
          {/* w-full + object-contain: fills the sidebar width, height capped, never distorted whatever the
              uploaded aspect ratio is. The wordmark carries the org name, so it takes the name as alt text. */}
          <img src={wordmark} alt={org.logo_text?.trim() || org.name} className="max-h-11 w-full object-contain object-left" />
          {celebrating && (
            <AnniversaryBanner years={anniv!.years} className="pointer-events-none absolute -top-[10px] -left-[5px] h-[52px] w-[46px] overflow-visible drop-shadow-md" />
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-2.5 py-4", collapsed ? "justify-center px-0" : "min-w-0 flex-1 px-4")}>
      <div className="relative shrink-0" title={annivTitle}>
        {logo ? (
          <img src={logo} alt="" className="h-9 w-9 rounded-lg object-cover" />
        ) : (
          <div className="brand-gradient flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-sm">
            <Building className="h-5 w-5" />
          </div>
        )}
        {celebrating && (
          <AnniversaryBanner years={anniv!.years} className="pointer-events-none absolute -top-[6px] -left-[5px] h-[52px] w-[46px] overflow-visible drop-shadow-md" />
        )}
      </div>
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
  const { unread: unreadTotal, unreadByPage } = useNotifications();
  const has = (perm: string) => hasCapability(me.capabilities, perm);
  // Unread notifications owned by a nav item = sum over its page subtree (the item + its tabs). The dedicated
  // Notifications item carries the grand total; Approvals keeps its own pending count (not notifications).
  const itemBadge = (item: (typeof NAV)[number]["items"][number]): number => {
    if (item.key === "approvals") return approvals.total;
    if (item.key === "notifications") return unreadTotal;
    return itemPageKeys(item).reduce((s, k) => s + (unreadByPage[k] ?? 0), 0);
  };
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => itemVisible(i, has)),
  })).filter((g) => g.items.length > 0);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(me.email));
  const toggleGroup = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      saveCollapsed(me.email, next);
      return next;
    });

  // Whole-sidebar icon-rail collapse: the user's manual preference, OR auto when the sidebar is docked but the
  // viewport is narrow (md up to just below lg). Below md the sidebar is a full-width drawer, so the rail never
  // applies there. `rail` is the effective state; `toggleRail` only flips the manual preference.
  const docked = useMedia("(min-width: 768px)");
  const autoNarrow = useMedia("(min-width: 768px) and (max-width: 1023px)");
  const [railPref, setRailPref] = useState(() => loadRail(me.email));
  const rail = docked && (railPref || autoNarrow);
  const toggleRail = () => setRailPref((v) => { const next = !v; saveRail(me.email, next); return next; });

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm transition-opacity md:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onNavigate}
      />
      <aside
        className={cn(
          // Mobile: a fixed off-canvas drawer. Desktop: sticky to the viewport at full height (md:sticky +
          // md:h-screen) so it never stretches with tall page content; the nav inside scrolls on its own.
          // Collapsed to a w-16 icon rail when `rail` is set (see above); full w-64 otherwise.
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar transition-[transform,width] md:sticky md:top-0 md:h-screen md:shrink-0 md:translate-x-0",
          rail ? "w-16" : "w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className={cn("flex items-center", rail ? "justify-center pt-1" : "justify-between")}>
          <Brand collapsed={rail} />
          <button className="shrink-0 px-4 text-sidebar-foreground md:hidden" onClick={onNavigate}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className={cn("flex-1 space-y-3 overflow-y-auto pb-3 pt-1", rail ? "px-2" : "px-3")}>
          {rail ? (
            // Icon rail: labels + group headers collapse to icons; the label (and unread count) live in a
            // hover tooltip, and unread badges shrink to a corner dot. Groups are split by a thin divider.
            <TooltipProvider delayDuration={0}>
              {groups.map((group, gi) => {
                const isActive = (i: (typeof group.items)[number]) => i.key === current || !!i.tabs?.some((t) => t.key === current);
                return (
                  <div key={group.label} className="space-y-1">
                    {gi > 0 && <div className="mx-2 my-2 border-t border-sidebar-border/60" aria-hidden />}
                    {group.items.map((item) => {
                      const active = isActive(item);
                      const Icon = item.icon;
                      const badge = itemBadge(item);
                      return (
                        <Tooltip key={item.key}>
                          <TooltipTrigger asChild>
                            <a
                              href={`#/${item.key}`}
                              onClick={onNavigate}
                              aria-current={active ? "page" : undefined}
                              aria-label={item.label}
                              className={cn(
                                "relative flex h-10 items-center justify-center rounded-lg transition-colors",
                                active ? "bg-sidebar-accent text-white shadow-sm" : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                              )}
                            >
                              <Icon className="h-[18px] w-[18px] shrink-0" />
                              {badge > 0 && <span className={cn("absolute right-1.5 top-1.5 h-2 w-2 rounded-full", active ? "bg-white" : "bg-primary")} aria-hidden />}
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="right">{item.label}{badge > 0 ? ` (${badge > 99 ? "99+" : badge})` : ""}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                );
              })}
            </TooltipProvider>
          ) : (
          groups.map((group) => {
            // An item is "active" for the current route when it IS the route or owns it as a workspace tab.
            const isActive = (i: (typeof group.items)[number]) => i.key === current || !!i.tabs?.some((t) => t.key === current);
            // Keep a group open if it holds the active page, even when the user collapsed it, so the current
            // location is never hidden. Single-item groups (e.g. Admin) are never collapsible.
            const hasActive = group.items.some(isActive);
            const collapsible = group.items.length > 1;
            const isOpen = !collapsible || hasActive || !collapsed.has(group.label);
            return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => collapsible && toggleGroup(group.label)}
                aria-expanded={isOpen}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/70 transition-colors",
                  collapsible && "hover:text-sidebar-foreground",
                )}
              >
                {group.label}
                {collapsible && (
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
                        href={`#/${item.key}`}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          active
                            ? "bg-sidebar-accent text-white shadow-sm"
                            : "text-sidebar-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                        )}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0" />
                        {item.label}
                        {badge > 0 && (
                          <span className={cn(
                            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums",
                            active ? "bg-white text-sidebar-accent" : "bg-primary text-white",
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
            className="absolute bottom-4 right-0 z-20 hidden h-6 w-6 translate-x-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/60 shadow-sm transition-colors hover:text-foreground md:flex"
          >
            {rail ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
          </button>
        )}
      </aside>
    </>
  );
}
