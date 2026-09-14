import { Search, ChevronRight, Plus, Sparkles, LifeBuoy, Ticket, LogIn, CircleDot, Bug } from "lucide-react";
import { navBreadcrumb } from "@/nav";
import { navigate } from "@/router";
import { cn, humanize } from "@/lib/utils";
import { resolveQuickMenu, visibleQuickActions, runQuickAction, KUDOS_ACTION_ID, TICKET_ACTION_ID, REPORT_PROBLEM_ACTION_ID } from "@/lib/quickActions";
import { ReportProblemDialog } from "@/components/common/ReportProblemDialog";
import { RecordingChip } from "@/components/common/RecordingChip";
import { useOrg } from "@/lib/org";
import { useClock, useElapsedMinutes } from "@/lib/clock";
import { usePermission } from "@/lib/perm";
import { fmtDuration } from "@/lib/attendance";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { UserMenu } from "@/components/layout/UserMenu";
import { Button } from "@/components/ui/button";
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

// The sticky application top bar: breadcrumb context on the left; a quick-create "+" menu and global search
// on the right. This gives every page consistent chrome and one-step access to the common create flows.
//
// On a phone the bar is deliberately thin. The full desktop cluster is nine controls, which at 390px leaves
// the breadcrumb no room at all and puts a row of 36px targets under the hand that is holding the phone. What
// stays is what has to be reachable from any page: where you are, the clock, search, alerts, and you. Create
// moves to the bottom bar's raised "+", the drawer to its Menu tab, kudos and support into that create menu,
// and the theme switch into the user menu - each one still one tap away, just not all in the same row.
export function TopBar({
  me,
  page,
  sub,
  onOpenSearch,
}: {
  me: Me;
  page: string;
  sub?: string;
  onOpenSearch: () => void;
}) {
  const crumb = navBreadcrumb(page, sub);
  const { org } = useOrg();
  const groups = resolveQuickMenu(me, org.quick_actions);
  // "Give kudos" gets its own always-visible top-bar item (not buried in the "+" menu); the rest stay there.
  // Icon-only, like Support beside it: this is the recognise-someone-from-anywhere entry point, and the
  // pre-filled path is the button on a person's profile, which already knows who is being praised.
  const kudos = visibleQuickActions(me).find((a) => a.id === KUDOS_ACTION_ID);
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
  const hasActions = groups.length > 0;
  return (
    // data-app-top: installed as a PWA this is what the status bar overlaps, so it reserves the top inset
    // (see index.css). h-14 stays the bar's own height either way.
    <header
      data-app-top
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur standalone:h-auto standalone:min-h-14 sm:px-6 lg:px-8"
    >
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
                <a href={`#/${page}`} className="inline-flex items-center truncate rounded font-semibold text-foreground hover:text-primary coarse:min-h-9">
                  {crumb.sub}
                </a>
              </>
            )}
          </>
        ) : (
          <span className="truncate font-semibold text-foreground">{humanize(page)}</span>
        )}
      </nav>

      {/* Right-side chrome cluster: the clock, quick-create, theme switch, global search. */}
      <div className="ml-auto flex items-center gap-2">
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

        {/* Create: the bottom bar's raised "+" owns this on a phone, so the top-bar copy starts at `md`. */}
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="hidden gap-1.5 md:inline-flex">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New</span>
              </Button>
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

        {kudos && (
          <button
            onClick={() => runQuickAction(kudos)}
            aria-label="Give kudos"
            title="Give kudos"
            className="hidden h-9 w-9 items-center justify-center rounded-lg border bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground md:flex"
          >
            <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
          </button>
        )}

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

        {/* Theme: a preference, not a page action. On a phone it lives in the user menu instead (UserMenu). */}
        <div className="hidden md:block">
          <ThemeToggle />
        </div>

        <button
          onClick={onOpenSearch}
          aria-label="Search"
          className="flex h-9 w-9 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-36 sm:justify-start sm:px-3 lg:w-44"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Search…</span>
          <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            {isMac ? "⌘" : "Ctrl"} K
          </kbd>
        </button>

        <UserMenu me={me} />
      </div>

    </header>
  );
}

// Punch from anywhere: the clock lives in the chrome, not only on the Attendance page. The label is the
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
        "flex h-9 items-center gap-2 rounded-lg border px-2.5 text-sm font-medium shadow-sm transition-colors disabled:opacity-60",
        on ? "border-success/40 bg-success/10 text-success hover:bg-success/20" : "bg-card text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {on ? <CircleDot className="h-4 w-4 shrink-0 animate-pulse" /> : <LogIn className="h-4 w-4 shrink-0" />}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
