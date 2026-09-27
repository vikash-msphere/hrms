import { Search, ChevronRight, Plus, LifeBuoy, Ticket, LogIn, CircleDot, Bug, Menu } from "lucide-react";
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

// The sticky application top bar: the drawer button and breadcrumb context on the left; global search, then
// the rest of the chrome, then the quick-create "+" on the right. This gives every page consistent chrome and
// one-step access to the common create flows.
//
// On a phone this bar is the app's whole navigation chrome - there is no bottom bar. The drawer button is the
// leftmost control, where a hamburger is expected, and the two controls that START something bracket the
// cluster: search opens it, create closes it against the user menu. The rest of the desktop
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
  return (
    // data-app-top: installed as a PWA this is what the status bar overlaps, so it reserves the top inset
    // (see index.css). h-14 stays the bar's own height either way.
    <header
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
        className="-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
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

      {/* Right-side chrome cluster: global search, the clock, alerts, quick-create, you. Tighter on a phone,
          where each 36px target plus its gap is a tenth of a 390px row - and where the clock is not rendered
          at all. */}
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        {/* Search leads the cluster. It is the most-reached control here and the only one that goes ANYWHERE,
            so it reads as the start of the chrome rather than as one more icon in a row of them; it is also
            the widest, which gives the eye a fixed landmark to find the rest of the cluster from. */}
        <button
          onClick={onOpenSearch}
          aria-label="Search"
          className="flex h-9 w-9 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-36 sm:justify-start sm:px-3 lg:w-44"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden text-muted-foreground sm:inline">Search…</span>
          <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            {isMac ? "⌘" : "Ctrl"} K
          </kbd>
        </button>

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

        {newTicket && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Support"
                title="Support"
                className="hidden h-9 items-center justify-center rounded-lg border bg-card px-2.5 text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground md:flex"
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

        <NotificationBell />

        {/* The app lock (lib/appLock.ts), at every width: a phone left on a table needs it as much as a laptop
            left open. Next to the bell, with the other controls that are about the person rather than the page. */}
        <LockButton mac={isMac} />

        {/* Theme is not here at any width: a preference belongs with the person, so it is the segmented
            Appearance control inside UserMenu. */}

        {/* Create. Last in the cluster, next to the user menu, because it is the one control here that
            WRITES - the rest read - and this is the only "+" on a phone.
            Carries the cluster's own icon-button style (bordered card, no fill) at every width rather than the
            filled primary: a brand-coloured button here read as the page's main action from across the room,
            which is never what it is - the page's own create button is in its header. */}
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="h-4 w-4 shrink-0" />
                {/* `sr-only` rather than dropped: the button's whole content is an aria-hidden icon, and
                    without the word it is announced as "button". Not an aria-label either - the name is what
                    every test and every voice command says, so it stays the visible word it used to be. */}
                <span className="sr-only">New</span>
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
// page (on a phone it is the Dashboard card and that page instead - see the className). The label is the
// ACTION ("Clock out" while on the clock, "Clock in" when off it) - state is carried by the pulsing dot and
// the success tint, and the elapsed time rides the tooltip, where it informs without competing with the verb.
// Hidden until the open-session fetch lands, so it never flashes the wrong state.
function ClockChip() {
  const clock = useClock();
  const elapsed = useElapsedMinutes(clock.mine?.clock_in);
  if (!clock.enabled || !clock.ready) return null;
  const on = !!clock.mine;
  const label = on ? "Clock out" : "Clock in";
  return (
    <button
      onClick={() => void clock.punch(on ? "clockOut" : "clockIn")}
      disabled={clock.busy}
      aria-label={on ? `${label} (clocked in for ${fmtDuration(elapsed)})` : label}
      title={on ? `Clocked in for ${fmtDuration(elapsed)} - clock out` : label}
      className={cn(
        // Phone: not in the chrome. Punching is a once-or-twice-a-day act, and the Dashboard's own clock
        // card and the Attendance page are both one tap from here - so this row spends its 36px on the
        // controls that are wanted from ANY page instead. Same `lib/clock` state either way.
        "hidden h-9 items-center gap-2 rounded-lg border px-2.5 text-sm font-medium shadow-sm transition-colors disabled:opacity-60 md:flex",
        on ? "border-success/40 bg-success/10 text-success hover:bg-success/20" : "bg-card text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {on ? <CircleDot className="h-4 w-4 shrink-0 animate-pulse" /> : <LogIn className="h-4 w-4 shrink-0" />}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
