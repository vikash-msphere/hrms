import { Menu, Search, ChevronRight, Plus, Sparkles, LifeBuoy, Ticket } from "lucide-react";
import { navBreadcrumb } from "@/nav";
import { navigate } from "@/router";
import { cn, humanize } from "@/lib/utils";
import { resolveQuickMenu, visibleQuickActions, runQuickAction, KUDOS_ACTION_ID } from "@/lib/quickActions";
import { useOrg } from "@/lib/org";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { UserMenu } from "@/components/layout/UserMenu";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Me } from "@/types";

// Modifier hint for the search shortcut (⌘ on Mac, Ctrl elsewhere).
const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

// The sticky application top bar: breadcrumb context on the left; a quick-create "+" menu and global search
// on the right. On mobile it also carries the hamburger that opens the off-canvas sidebar. This gives every
// page consistent chrome and one-step access to the common create flows from anywhere.
export function TopBar({
  me,
  page,
  sub,
  onOpenMenu,
  onOpenSearch,
}: {
  me: Me;
  page: string;
  sub?: string;
  onOpenMenu: () => void;
  onOpenSearch: () => void;
}) {
  const crumb = navBreadcrumb(page, sub);
  const { org } = useOrg();
  const groups = resolveQuickMenu(me, org.quick_actions);
  // "Give kudos" gets its own always-visible top-bar item (not buried in the "+" menu); the rest stay there.
  const kudos = visibleQuickActions(me).find((a) => a.id === KUDOS_ACTION_ID);
  // "Support" gets its own icon-only top-bar affordance: a get-unstuck-anywhere entry point. The dropdown
  // raises a ticket (reusing the new-ticket quick action) or jumps to the full Support page. Gated on the
  // presence of the new-ticket action, which is itself employee-only.
  const newTicket = visibleQuickActions(me).find((a) => a.id === "new-ticket");
  const hasActions = groups.length > 0;
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button
        className="-ml-1 rounded-md p-2 text-foreground hover:bg-accent md:hidden"
        onClick={onOpenMenu}
        aria-label="Open menu"
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
                <a href={`#/${page}`} className="truncate rounded font-semibold text-foreground hover:text-primary">
                  {crumb.sub}
                </a>
              </>
            )}
          </>
        ) : (
          <span className="truncate font-semibold text-foreground">{humanize(page)}</span>
        )}
      </nav>

      {/* Right-side chrome cluster: quick-create, theme switch, global search. */}
      <div className="ml-auto flex items-center gap-2">
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
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
            className="flex h-9 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="hidden lg:inline">Kudos</span>
          </button>
        )}

        {newTicket && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Support"
                title="Support"
                className="flex h-9 items-center justify-center rounded-lg border bg-card px-2.5 text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <LifeBuoy className="h-4 w-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => runQuickAction(newTicket)}>
                <LifeBuoy className="h-4 w-4" />
                Raise a ticket
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate("tickets")}>
                <Ticket className="h-4 w-4" />
                My tickets
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <NotificationBell />

        <ThemeToggle />

        <button
          onClick={onOpenSearch}
          aria-label="Search"
          className="flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-36 lg:w-44"
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
