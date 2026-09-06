import { KeyRound, LogOut, ShieldCheck, ChevronDown, Sun, Moon, Monitor, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/roles";
import { useTheme, type Theme } from "@/lib/theme";
import { purgeAll } from "@/lib/clientStore";
import { useEmployee } from "@/hooks/useEmployee";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Me } from "@/types";

// The signed-in user's avatar + menu, anchored in the top bar. Opens (downward) with the profile link, sign-out,
// and - for those who may manage access - the access-management mode toggle and a shortcut to manage WHO can
// manage access. Avatar-only trigger to stay compact next to the rest of the top-bar chrome.

// Sign-out is mode-agnostic: the server clears its own session (a no-op cookie delete under Cloudflare
// Access) and says where signing in again happens - the Google login route, or Access's edge logout. If the
// call itself fails, still leave the app; landing on "/" unauthenticated shows the sign-in screen.
//
// It also takes this person's data off the machine. Signing out used to end the session and leave everything
// behind: the cached rows of every collection they had opened, their colleagues' faces, the org's configuration,
// their drafts - all of it still on disk, under their identity, indefinitely, on what may well be a shared
// computer. So the purge is part of signing out, and it is awaited: navigating first would abandon it.
async function signOut() {
  await purgeAll();
  try {
    const res = await fetch("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } });
    const { signin_url } = (await res.json()) as { signin_url?: string };
    window.location.href = signin_url || "/";
  } catch {
    window.location.href = "/";
  }
}
// Same three options as the top bar's ThemeToggle, listed rather than cycled so "System" stays selectable.
const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function UserMenu({ me }: { me: Me }) {
  const am = useAccessMode();
  const { theme, setTheme } = useTheme();
  // Prefer the real employee name + photo over the raw email handle ("write2vkas"); fall back to a tidied
  // handle for accounts with no employee record.
  const { emp } = useEmployee(me.employee_id);
  const name = emp
    ? `${emp.first_name} ${emp.last_name}`.trim()
    : (me.email.split("@")[0] ?? me.email).replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={`${name} · ${roleLabel(me.role)}`}
        // The avatar is 32px, which is the right visual weight in a 56px bar and two thirds of a fingertip.
        // The box takes the floor without the avatar changing size - this is the only route to sign out,
        // switch theme and reach a profile, so it is not a control to miss.
        className="flex items-center justify-center gap-1.5 rounded-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-accent coarse:min-h-9 coarse:min-w-9"
      >
        <PhotoAvatar employeeId={me.employee_id ?? ""} name={name} photo={emp?.photo} className="h-8 w-8 shrink-0" />
        <ChevronDown className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{me.email}</span>
            <span className="text-xs font-normal text-muted-foreground">{roleLabel(me.role)}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {am.available && (
          <>
            <DropdownMenuItem onClick={am.toggle}>
              <KeyRound className="h-4 w-4" />
              Access management
              <span
                className={cn(
                  "ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold",
                  am.enabled ? "bg-amber-500 text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {am.enabled ? "ON" : "OFF"}
              </span>
            </DropdownMenuItem>
            {am.enabled && (
              <DropdownMenuItem onClick={() => am.open({ collection: "access-rules", label: "Access management" })}>
                <ShieldCheck className="h-4 w-4" />
                Who can manage access
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <a href="#/profile">View my profile</a>
        </DropdownMenuItem>
        {/* Appearance. The top bar carries a dedicated theme button from `md` up; on a phone that row is
            reserved for things that must be reachable per page, so the preference lives here instead. */}
        <div className="md:hidden">
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Appearance</DropdownMenuLabel>
          {THEMES.map((t) => (
            <DropdownMenuItem
              key={t.value}
              onClick={(e) => {
                // Keep the menu open: picking a theme is a preview-and-adjust choice, and re-opening the
                // menu to try the next one is three taps for a decision that takes one.
                e.preventDefault();
                setTheme(t.value);
              }}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
              <Check className={cn("ml-auto h-4 w-4", theme === t.value ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
