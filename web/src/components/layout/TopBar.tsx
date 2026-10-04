import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Search, ChevronRight, ChevronDown, Plus, LifeBuoy, Ticket, LogIn, LogOut, Bug, Menu, Loader2 } from "lucide-react";
import { navBreadcrumb } from "@/nav";
import { navigate } from "@/router";
import { cn, humanize } from "@/lib/utils";
import { resolveQuickMenu, visibleQuickActions, runQuickAction, TICKET_ACTION_ID, REPORT_PROBLEM_ACTION_ID } from "@/lib/quickActions";
import { ReportProblemDialog } from "@/components/common/ReportProblemDialog";
import { RecordingChip } from "@/components/common/RecordingChip";
import { useOrg } from "@/lib/org";
import { useClock, useElapsedMinutes } from "@/lib/clock";
import { usePermission } from "@/lib/perm";
import { useMedia } from "@/hooks/useMedia";
import { fmtDuration } from "@/lib/attendance";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { UserMenu } from "@/components/layout/UserMenu";
import { InlineSearch } from "@/components/layout/CommandPalette";
import { LockButton } from "@/components/lock/LockButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Me } from "@/types";

// Modifier hint for the search shortcut (⌘ on Mac, Ctrl elsewhere).
//
// `userAgentData.platform` first, `navigator.platform` as the fallback: the latter is deprecated and FROZEN -
// Chrome reports "MacIntel" whatever the actual chip is - so it is a value that happens to still answer this
// one question correctly rather than one that is maintained to. The fallback stays because `userAgentData` is
// Chromium-only, and Safari and Firefox are exactly the browsers `navigator.platform` still answers for.
const platformName = (): string => {
  if (typeof navigator === "undefined") return "";
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return ua?.platform || navigator.platform || "";
};
const isMac = /Mac|iP(hone|ad|od)/.test(platformName());

// The open search field's widest: room for the category chips in its drop-down on one line, and for the results
// list with the preview pane beside it at a comfortable width (CommandPalette.tsx PREVIEW_ROOM_REM).
const OPEN_FIELD_REM = 64;

// How wide the search field may be while its results are open, and whether that crowds out the bar.
//
// It grows evenly on both sides of where it sits, so the open width is the most that fits inside the bar on
// BOTH sides of that centre - the nearer edge decides - capped at OPEN_FIELD_REM, and never narrower than it
// already is. Inside the room between the breadcrumb and the cluster it simply grows and nothing else moves;
// only a field that would reach past that room is `crowded`, and then the bar fades out both sides together -
// the breadcrumb (with the drawer button) and the cluster - rather than leaving half of either under the field,
// and the field moves to the middle of the bar (`shift`), now that nothing else is in it.
// Measured when the search opens and again whenever the bar resizes; null while it is closed.
function useOpenSearchFit(open: boolean, header: RefObject<HTMLElement | null>, room: RefObject<HTMLElement | null>) {
  const [fit, setFit] = useState<{ width: number; crowded: boolean; shift: number } | null>(null);
  useLayoutEffect(() => {
    const h = header.current;
    if (!open || !h) {
      setFit(null);
      return;
    }
    const measure = () => {
      const place = room.current?.querySelector<HTMLElement>("[data-search-place]");
      if (!room.current || !place) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const style = getComputedStyle(h);
      const bar = h.getBoundingClientRect();
      const left = bar.left + parseFloat(style.paddingLeft);
      const right = bar.right - parseFloat(style.paddingRight);
      const at = place.getBoundingClientRect();
      const centre = at.left + at.width / 2;
      const max = OPEN_FIELD_REM * rem;
      const width = Math.floor(Math.max(at.width, Math.min(max, 2 * Math.min(centre - left, right - centre))));
      const space = room.current.getBoundingClientRect();
      const crowded = centre - width / 2 < space.left - 0.5 || centre + width / 2 > space.right + 0.5;
      // Crowded, both sides are faded out and the field has the bar to itself - so it sits in the middle of the
      // BAR, not of the room it came from (which the breadcrumb and the cluster made off-centre), and is as wide
      // as the bar allows, up to the cap. `shift` is how far that middle is from where the field sits closed.
      const next = crowded
        ? { width: Math.floor(Math.max(at.width, Math.min(max, right - left))), crowded, shift: Math.round((left + right) / 2 - centre) }
        : { width, crowded, shift: 0 };
      setFit((prev) => (prev?.width === next.width && prev.crowded === next.crowded && prev.shift === next.shift ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(h);
    return () => observer.disconnect();
  }, [open, header, room]);
  return fit;
}

// The sticky application top bar: the drawer button and breadcrumb context on the left, global search in the
// middle, and on the right the clock, the rest of the chrome, then the quick-create "+". This gives every page
// consistent chrome and one-step access to the common create flows.
//
// On a phone this bar is the app's whole navigation chrome - there is no bottom bar. The drawer button is the
// leftmost control, where a hamburger is expected, and the two controls that START something bracket the
// right-hand controls: search opens them, create closes them against the user menu. The rest of the desktop
// cluster still drops away below `md`: support folds into the create menu, and the clock back to the Dashboard
// and Attendance page it mirrors - because nine 36px targets at 390px leave the breadcrumb no room at all.
// (The theme switch is in the user menu at EVERY width - see UserMenu.)
export function TopBar({
  me,
  page,
  sub,
  onOpenSearch,
  onOpenMenu,
  menuOpen,
}: {
  me: Me;
  page: string;
  sub?: string;
  onOpenSearch: () => void;
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  const crumb = navBreadcrumb(page, sub);
  const { org } = useOrg();
  // Below `md` the support button is not rendered, so the create menu is where that action has to be
  // reachable from. `useMedia` rather than a CSS fork because the two menus differ in CONTENT, not in layout -
  // mounting the dropdown twice would double every action in the accessibility tree.
  const docked = useMedia("(min-width: 768px)");
  // "Support" gets its own icon-only top-bar affordance: a get-unstuck-anywhere entry point. The dropdown
  // raises a ticket (reusing the new-ticket quick action) or jumps to the full Support page. Gated on the
  // presence of the new-ticket action, which is itself employee-only.
  const newTicket = visibleQuickActions(me).find((a) => a.id === TICKET_ACTION_ID);
  // Absent when the build has no Sentry: there would be no recording to attach, which is the only thing that
  // makes this different from raising a ticket.
  const reportProblem = visibleQuickActions(me).find((a) => a.id === REPORT_PROBLEM_ACTION_ID);
  // Reading the queue is its own grant: somebody who may raise a ticket but not list them gets the raise
  // entry without a link to a page the router would wall off anyway.
  const canSeeTickets = usePermission("tickets.read");
  // What THIS page creates comes first. The page's own create button is in its header, which on a phone is
  // several screens up as soon as the list is scrolled - so from anywhere but the top, the fastest route to
  // "add one of these" was a scroll back up or a hunt through twenty unrelated actions. Promoted rather than
  // duplicated: an action listed here is removed from the group it would otherwise repeat in.
  const onThisPage = visibleQuickActions(me).filter((a) => a.route === page);
  const promoted = new Set(onThisPage.map((a) => a.id));
  // Raise a ticket and report a problem own the Support button from `md` up; below it that button is not
  // rendered, and `resolveQuickMenu` keeps every STANDALONE id out of the configurable menu, so without this
  // they would be reachable on a phone only through ⌘K. Folded in as their own group there.
  const standalone = docked
    ? []
    : [newTicket, reportProblem].filter((a) => a && !promoted.has(a.id)) as NonNullable<typeof newTicket>[];
  const groups = [
    ...(onThisPage.length ? [{ id: "__page__", label: "On this page", actions: onThisPage }] : []),
    ...resolveQuickMenu(me, org.quick_actions)
      .map((g) => ({ ...g, actions: g.actions.filter((a) => !promoted.has(a.id)) }))
      .filter((g) => g.actions.length > 0),
    ...(standalone.length ? [{ id: "__standalone__", label: "Also", actions: standalone }] : []),
  ];
  const hasActions = groups.length > 0;
  // While the search field's results are open, how wide the field may grow and whether it crowds out the rest
  // of the bar (useOpenSearchFit).
  const [searching, setSearching] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const openFit = useOpenSearchFit(searching, headerRef, roomRef);
  // Faded out, not removed: the bar keeps its layout, so the field's centre - and with it the open field -
  // stays put, and everything comes back in place when the search closes.
  const crowdedOut = openFit?.crowded ? "pointer-events-none invisible opacity-0" : "";
  return (
    // data-app-top: installed as a PWA this is what the status bar overlaps, so it reserves the top inset
    // (see index.css). h-14 stays the bar's own height either way.
    <header
      ref={headerRef}
      data-app-top
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur standalone:h-auto standalone:min-h-14 sm:gap-3 sm:px-6 lg:px-8"
    >
      {/* The drawer button. Below `md` the sidebar is off-canvas, so this is the only route to every
          destination that is not on the current page - leftmost, where a hamburger is looked for, and gone
          the moment the sidebar docks and makes it redundant. */}
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Menu"
        aria-expanded={menuOpen}
        className={cn(
          "-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-foreground transition-[color,background-color,opacity,visibility] duration-200 hover:bg-accent hover:text-accent-foreground md:hidden",
          crowdedOut,
        )}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* One width on every page from `md` up (w-60, about the mean breadcrumb, which measured 235px across
          the app's 106 pages): search sits in the middle of the room right of this, and a breadcrumb sized to
          its own text moved and resized the field on every navigation. A shorter one leaves the rest blank, a
          longer one truncates its last segment. Still allowed to shrink below that, so a narrow bar squeezes
          the breadcrumb before anything overlaps. Fades out while an open search needs its room (crowdedOut). */}
      <nav
        aria-label="Breadcrumb"
        className={cn("flex min-w-0 items-center gap-1.5 text-sm transition-[opacity,visibility] duration-200 md:w-60", crowdedOut)}
      >
        {crumb ? (
          <>
            {/* group › workspace › active-tab. The leaf links to its own route base, so on a detail page
                (e.g. employees/:id) it drops the id and returns to the list - a free "up" affordance. */}
            <span className="hidden whitespace-nowrap text-muted-foreground sm:inline">{crumb.group}</span>
            <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground/50 sm:inline" />
            <span className={cn("whitespace-nowrap", crumb.sub ? "hidden text-muted-foreground sm:inline" : "truncate font-semibold text-foreground")}>
              {crumb.label}
            </span>
            {crumb.sub && (
              <>
                <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground/50 sm:inline" />
                {/* A 14px line of text makes a 20px-tall link. This is the way back up from a detail page,
                    so it takes the touch floor without the type changing size: the box grows around it. */}
                <a href={`/${page}`} className="inline-flex items-center truncate rounded font-semibold text-foreground hover:text-primary coarse:min-h-9">
                  {crumb.sub}
                </a>
              </>
            )}
          </>
        ) : (
          <span className="truncate font-semibold text-foreground">{humanize(page)}</span>
        )}
      </nav>

      {/* Global search: the most-reached control here and the only one that goes ANYWHERE. It takes all the
          room between the breadcrumb and the clock and sits in the middle of it. That room is a container, and
          what is drawn in it depends on its width:
          - from 11rem up, the search itself as a field (InlineSearch, at most 36rem) whose results drop down
            under it, with a placeholder sized to the room (see InlineSearch). Open, it grows evenly on both
            sides to as much as 64rem (useOpenSearchFit), and only if that takes it past this room does it fade
            out both sides of the bar - the breadcrumb and the cluster together - to have the width;
          - under 11rem, where even "Search…" will not fit beside the ⌘K chip, a compact button - the magnifier
            plus the chip, which teaches the shortcut - that opens the modal palette instead; on a phone, where it
            sits against the cluster, the icon alone.
          Both are mounted and the container query picks one, so the switch costs no measuring; ⌘K asks which one
          is on screen (CommandPalette).
          The min-width is the compact button's own: a container's content cannot size it, so without one a
          long breadcrumb would squeeze the room to nothing and the button would spill over its neighbours.
          From `md` the room keeps a margin inside each edge (px-4), so a field that fills it still stands clear of
          the breadcrumb and of the clock pill rather than butting up against either; the same on both sides, so it
          is still centred between them. */}
      <div ref={roomRef} className="@container flex min-w-9 flex-1 justify-end sm:min-w-[5.5rem] md:min-w-[7.5rem] md:justify-center md:px-4">
        <InlineSearch
          me={me}
          isMac={isMac}
          onOpenChange={setSearching}
          openWidth={openFit?.width}
          openShift={openFit?.shift}
          className="hidden w-full max-w-xl @min-[11rem]:block"
        />
        <button
          onClick={onOpenSearch}
          aria-label="Search"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          title={`Search (${isMac ? "⌘" : "Ctrl"} K)`}
          className="flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground sm:w-auto sm:px-2.5 @min-[11rem]:hidden"
        >
          <Search className="h-4 w-4 shrink-0" />
          <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            {isMac ? "⌘" : "Ctrl"} K
          </kbd>
        </button>
      </div>

      {/* Right-side chrome cluster: the clock, alerts, quick-create, you. Tighter on a phone, where each 36px
          target plus its gap is a tenth of a 390px row - and where the clock is not rendered at all. */}
      <div className={cn("flex items-center gap-1.5 transition-[opacity,visibility] duration-200 sm:gap-2", crowdedOut)}>
        <ClockChip />

        {/* Mounted here rather than on the Tickets page because the whole point is that it opens without
            leaving the page you are on - and the top bar is the one thing rendered on all of them. That also
            makes the "report-problem" intent reachable from the command palette and the phone create menu,
            which fire it from wherever the user is.
            Inside the chip cluster specifically because it renders the "Recording · 0:47" countdown, which
            belongs beside the clock rather than after it: while a demonstration is running the dialog is
            hidden on purpose, and that chip is the only thing on screen saying so. The dialog itself portals
            to the body, so this placement does not constrain it. */}
        {/* Not gated on the report action: a recording can also be started from a ticket, and the chip is
            what stops it. Renders nothing unless a window is running. */}
        <RecordingChip />
        {reportProblem && <ReportProblemDialog />}

        {/* Splits the clock from the row of icons that follows. From `md` up only: on a phone the clock is not
            in the bar, so there is nothing before the icons to split off. */}
        <div aria-hidden className="mx-1 hidden h-6 w-px bg-border md:block" />

        {newTicket && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Support"
                title="Support"
                className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:flex"
              >
                <LifeBuoy className="h-4 w-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {/* First, above "Raise a ticket": the two read as the same thing until you have needed one of
                  them, and the broken-right-now case is the one that cannot wait while somebody decides which
                  it is. It opens in place - no navigate() - so the screen being reported stays on screen. */}
              {reportProblem && (
                <DropdownMenuItem onClick={() => runQuickAction(reportProblem)}>
                  <Bug className="h-4 w-4" />
                  Report a problem
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => runQuickAction(newTicket)}>
                <LifeBuoy className="h-4 w-4" />
                Raise a ticket
              </DropdownMenuItem>
              {canSeeTickets && (
                <DropdownMenuItem onClick={() => navigate("tickets")}>
                  <Ticket className="h-4 w-4" />
                  My tickets
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* The app lock (lib/appLock.ts), at every width: a phone left on a table needs it as much as a laptop
            left open. Next to the bell, with the other controls that are about the person rather than the page. */}
        <LockButton mac={isMac} />

        {/* Last of the icons, so its unread badge sits against the New button rather than between two icons. */}
        <NotificationBell />

        {/* Theme is not here at any width: a preference belongs with the person, so it is the segmented
            Appearance control inside UserMenu. */}

        {/* Create. Last in the cluster, next to the user menu, because it is the one control here that
            WRITES - the rest read - and this is the only "+" on a phone.
            Bordered card, not the filled primary: a brand-coloured button here read as the page's main action
            from across the room, which is never what it is - the page's own create button is in its header.
            From `sm` up it carries the word and a chevron, since it opens a menu rather than creating one thing. */}
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center gap-1.5 rounded-lg border bg-card text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:w-auto sm:pl-2.5 sm:pr-2"
              >
                <Plus className="h-4 w-4 shrink-0" />
                {/* `sr-only` on a phone rather than dropped: there the button's whole content is an aria-hidden
                    icon, and without the word it is announced as "button". Not an aria-label either - the name
                    is what every test and every voice command says, so it is the same visible word at every width. */}
                <span className="sr-only sm:not-sr-only">New</span>
                <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70dvh] w-56 overflow-y-auto">
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
        )}

        <UserMenu me={me} />
      </div>

    </header>
  );
}

// Punch from any page with a cursor: from `md` up the clock lives in the chrome, not only on the Attendance
// page. Phone: not in the chrome at all. Punching is a once-or-twice-a-day act, and the Dashboard's own clock
// card and the Attendance page are both one tap from there - so that row spends its 36px on the controls that
// are wanted from ANY page instead. Same `lib/clock` state either way.
//
// Two shapes, one per state. Off the clock it is the bar's one filled button: "Clock in" is the thing the day
// starts with, and nothing else here asks to be pressed. On the clock it becomes a status pill - a dot and the
// time on the clock, read at a glance without hovering - with "Clock out" as a quiet button inside it, so the
// state is what the eye lands on and the action is there when it is wanted.
// The button is held back until the open-session fetch lands, so it never flashes the wrong state; its slot
// is not (see below).
//
// The clock sits in a fixed-width slot, sized to the clocked-in pill at its widest (175px with "99h 59m" from
// `lg`, where it carries its words - measured; the dot and an icon below that), and each state keeps its own
// natural width inside it, right-aligned. Search is centred in the room left of the clock, so a clock that grew
// on punching in would shrink that room and slide the field left under the cursor; the slot keeps the room one
// width, and the spare space beside the narrower "Clock in" is just more of the middle. Because the slot holds
// still, the time inside the pill can be as wide as it is, with "Clock out" right after it.
function ClockChip() {
  const clock = useClock();
  const elapsed = useElapsedMinutes(clock.mine?.clock_in);
  if (!clock.enabled) return null;
  return (
    // data-clock-slot: wide.spec.ts measures the field's centring against this edge.
    // The slot is there from the first render - `enabled` is known from the caller alone - and stays empty
    // until the open-session fetch lands: a slot that arrived with the fetch narrowed the search room a moment
    // after the page drew, and slid the field under the cursor on every load.
    <div data-clock-slot className="hidden shrink-0 justify-end md:flex md:w-[4.25rem] lg:w-44">
      {!clock.ready ? null : clock.mine ? <OnTheClock clock={clock} elapsed={elapsed} /> : <ClockInButton clock={clock} />}
    </div>
  );
}

const busyIcon = <Loader2 className="h-4 w-4 shrink-0 animate-spin" />;

function ClockInButton({ clock }: { clock: ReturnType<typeof useClock> }) {
  return (
    <button
      onClick={() => void clock.punch("clockIn")}
      disabled={clock.busy}
      aria-busy={clock.busy || undefined}
      aria-label="Clock in"
      title="Clock in"
      className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 lg:px-3.5"
    >
      {clock.busy ? busyIcon : <LogIn className="h-4 w-4 shrink-0" />}
      <span className="hidden lg:inline">Clock in</span>
    </button>
  );
}

// The time it shows is the DAY's: everything worked today so far - the sessions closed earlier (`workedToday`)
// plus this one - with the breaks between them left out, which is the number a person tracks their day by. This
// session alone is in the tooltip. Until the earlier sessions are read the time is left off rather than shown as
// this session's and then jumping.
function OnTheClock({ clock, elapsed }: { clock: ReturnType<typeof useClock>; elapsed: number }) {
  const session = fmtDuration(elapsed);
  const today = clock.workedToday === null ? null : fmtDuration(clock.workedToday + elapsed);
  return (
    <div
      title={today === null ? `This session ${session}` : `Worked ${today} today - this session ${session}`}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 pl-3 pr-1 text-success"
    >
      {/* Still, not pulsing, and toned down (half strength): the pill's colour already says "on the clock", so the
          dot only marks it - anything that moves or shouts in the bar pulls the eye all day long. */}
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-success/50" />
      {/* As wide as the time is, so "Clock out" follows it closely; the slot it sits in is what holds still. */}
      {today !== null && <span className="hidden shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums lg:inline">{today}</span>}
      <button
        onClick={() => void clock.punch("clockOut")}
        disabled={clock.busy}
        aria-busy={clock.busy || undefined}
        aria-label={today === null ? `Clock out (this session ${session})` : `Clock out (worked ${today} today)`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium transition-colors hover:bg-success/20 disabled:opacity-60"
      >
        {clock.busy ? busyIcon : <LogOut className="h-4 w-4 shrink-0 lg:hidden" />}
        <span className="hidden lg:inline">Clock out</span>
      </button>
    </div>
  );
}
