import { Home, Bell, Menu, Plus, CheckCheck, Users, CalendarCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { navigate } from "@/router";
import { hasCapability } from "@/lib/perm";
import { useApprovals } from "@/lib/approvals";
import { useNotifications } from "@/lib/notifications";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { APPROVAL_CAPS } from "@/nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveQuickMenu, runQuickAction, visibleQuickActions, KUDOS_ACTION_ID, TICKET_ACTION_ID } from "@/lib/quickActions";
import { useOrg } from "@/lib/org";
import type { Me } from "@/types";

// The phone's primary navigation. Below `md` the sidebar is an off-canvas drawer, which means every
// destination in the app costs a hamburger tap, a scan of ~40 links, and a second tap - reached with the hand
// that is holding the phone, at the top of the screen. This bar puts the handful of places people actually go
// where the thumb already is, and keeps the drawer for the long tail.
//
// Five slots, fixed rather than frecency-ranked: navigation that moves under you is navigation you have to
// re-read every time. The middle slot is the create action, raised, because "start something" is the one
// thing a bar like this is for that is not a destination.
//
// Above `md` it does not render at all - the docked sidebar is strictly better with a cursor.

// The second slot adapts to the role, because "the other place you go" genuinely differs: a manager lives in
// the approval queue, an HR admin in the directory, an employee in their own attendance. First match wins.
const SECOND_SLOT: { key: string; label: string; icon: typeof Home; caps: string[] }[] = [
  { key: "approvals", label: "Approvals", icon: CheckCheck, caps: APPROVAL_CAPS },
  { key: "employees", label: "People", icon: Users, caps: ["employees.read"] },
  { key: "attendance", label: "Time", icon: CalendarCheck, caps: ["attendance.read"] },
];

export function BottomNav({
  me,
  current,
  onOpenMenu,
  menuOpen,
}: {
  me: Me;
  current: string;
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  const approvals = useApprovals();
  const { unread } = useNotifications();
  const { org } = useOrg();
  // Give kudos and raise-a-ticket are "standalone" actions: they own dedicated top-bar buttons, which the
  // phone bar does not have room for, so they are excluded from the configurable menu and would otherwise be
  // unreachable here. Folded in as their own group - the create menu is exactly where they belong on a phone.
  const visible = visibleQuickActions(me);
  const standalone = visible.filter((a) => a.id === KUDOS_ACTION_ID || a.id === TICKET_ACTION_ID);
  // What this page creates comes first. The page's own create button is in the header, which on a phone is
  // several screens up as soon as the list is scrolled - so from anywhere but the top, the fastest route to
  // "add one of these" was a scroll back up or a hunt through twenty unrelated actions. Promoted rather than
  // duplicated: an action listed here is removed from the group it would otherwise repeat in.
  const onThisPage = visible.filter((a) => a.route === current);
  const promoted = new Set(onThisPage.map((a) => a.id));
  const groups = [
    ...(onThisPage.length ? [{ id: "__page__", label: "On this page", actions: onThisPage }] : []),
    ...resolveQuickMenu(me, org.quick_actions)
      .map((g) => ({ ...g, actions: g.actions.filter((a) => !promoted.has(a.id)) }))
      .filter((g) => g.actions.length > 0),
    ...(standalone.some((a) => !promoted.has(a.id))
      ? [{ id: "__standalone__", label: "Also", actions: standalone.filter((a) => !promoted.has(a.id)) }]
      : []),
  ];
  // Typing is the one time this bar is in the way: it sits exactly where the keyboard opens, and on a browser
  // that only shrinks the visual viewport it would float over the field being filled in.
  const keyboard = useKeyboardInset();
  if (keyboard > 0) return null;

  const second = SECOND_SLOT.find((s) => s.caps.some((c) => hasCapability(me.capabilities, c)));
  const items: { key: string; label: string; icon: typeof Home; badge?: number }[] = [
    { key: "dashboard", label: "Home", icon: Home },
    ...(second
      ? [{ key: second.key, label: second.label, icon: second.icon, badge: second.key === "approvals" ? approvals.total : 0 }]
      : []),
    { key: "notifications", label: "Alerts", icon: Bell, badge: unread },
  ];

  const Tab = ({
    label,
    icon: Icon,
    badge,
    active,
    onClick,
  }: {
    label: string;
    icon: typeof Home;
    badge?: number;
    active: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      // Named explicitly, because the visible caption is dropped in landscape (see below) and the icon alone
      // would leave the button unnamed to a screen reader.
      aria-label={label}
      aria-current={active ? "page" : undefined}
      // A 56px-tall target across a fifth of the width: comfortably past the 44px floor in both axes.
      className={cn(
        "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium transition-colors active:bg-accent/60 short:py-1",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
        {/* Counts, not dots: "3 waiting" is a different decision from "something waiting", and the number
            costs nothing here. Capped so a busy queue cannot widen the slot. */}
        {badge && badge > 0 ? (
          <span className="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-primary px-1 text-[9px] font-bold leading-4 text-primary-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      {/* The caption goes first when height is scarce - the icons carry the same five destinations, and the
          accessible name is on the button either way. */}
      <span className="max-w-full truncate short:hidden">{label}</span>
    </button>
  );

  return (
    // Sits above page content (z-30, same band as the top bar) but under drawers, dialogs and toasts.
    // The safe-area padding is what keeps the labels clear of the home indicator on a notched phone.
    <nav
      aria-label="Primary"
      // Held sideways the viewport is ~390px tall, so the bar goes label-less and thin (`short:`) rather than
      // away: it is the only route to the drawer on a phone, and hiding it would strand every destination
      // that is not one of these five.
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-safe pl-safe-l pr-safe-r backdrop-blur md:hidden"
    >
      <div className="flex items-stretch gap-0.5 px-1.5 pt-1">
        {items.slice(0, 2).map((it) => (
          <Tab
            key={it.key}
            label={it.label}
            icon={it.icon}
            badge={it.badge}
            active={current === it.key && !menuOpen}
            onClick={() => navigate(it.key)}
          />
        ))}

        {/* Create. Raised out of the bar and brand-coloured: it is an action among destinations, and the
            asymmetry is what makes the bar readable at a glance. Falls back to a plain slot layout when the
            caller has no create actions at all, so the bar never shows a button that does nothing. */}
        {groups.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Create"
                className="mx-1 flex h-12 w-14 shrink-0 -translate-y-2 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition-transform active:scale-95 short:h-10 short:translate-y-0"
              >
                <Plus className="h-6 w-6" />
              </button>
            </DropdownMenuTrigger>
            {/* Anchored to the top of the button and capped to the viewport, so a long action list scrolls
                inside the menu instead of running off the top of the screen. */}
            <DropdownMenuContent
              side="top"
              align="center"
              sideOffset={12}
              className="max-h-[60dvh] w-56 overflow-y-auto"
            >
              {groups.map((g, gi) => (
                <div key={g.id}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
                  {g.actions.map((a) => {
                    const Icon = a.icon;
                    return (
                      <DropdownMenuItem key={a.id} onClick={() => runQuickAction(a)}>
                        <Icon className="h-4 w-4" />
                        {a.label}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {items.slice(2).map((it) => (
          <Tab
            key={it.key}
            label={it.label}
            icon={it.icon}
            badge={it.badge}
            active={current === it.key && !menuOpen}
            onClick={() => navigate(it.key)}
          />
        ))}
        <Tab label="Menu" icon={Menu} active={menuOpen} onClick={onOpenMenu} />
      </div>
    </nav>
  );
}
