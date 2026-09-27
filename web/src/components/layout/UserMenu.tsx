import { KeyRound, LogOut, ShieldCheck, ChevronDown, Sun, Moon, Monitor, Lock, LockKeyhole } from "lucide-react";
import { useAppLock, lockNow } from "@/lib/appLock";
import { openAppLockSettings } from "@/components/lock/AppLockSheet";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/roles";
import { useTheme, type Theme } from "@/lib/theme";
import { purgeAll, draftCount } from "@/lib/clientStore";
import { useConfirm, type ConfirmFn } from "@/components/common/confirm";
import { useEmployee } from "@/hooks/useEmployee";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Me } from "@/types";

// The signed-in user's avatar + menu, anchored in the top bar. Opens (downward) with the profile link, the
// appearance control, sign-out, and - for those who may manage access - the access-management mode toggle and
// a shortcut to manage WHO can manage access. Avatar-only trigger to stay compact next to the rest of the
// top-bar chrome.

// Sign-out is mode-agnostic: the server clears its own session (a no-op cookie delete under Cloudflare
// Access) and says where signing in again happens - the Google login route, or Access's edge logout. If the
// call itself fails, still leave the app; landing on "/" unauthenticated shows the sign-in screen.
//
// It also takes this person's data off the machine. Signing out used to end the session and leave everything
// behind: the cached rows of every collection they had opened, their colleagues' faces, the org's configuration,
// their drafts - all of it still on disk, under their identity, indefinitely, on what may well be a shared
// computer. So the purge is part of signing out, and it is awaited: navigating first would abandon it.
//
// It ASKS FIRST when there is unsaved writing on the device, and only then - a confirm on every sign-out is
// noise, and noise is what teaches people to click through the dialogs that matter. The `draft` class holds
// real work (a review write-up and its ratings grid, an announcement being composed, an unsent bulk delivery)
// that exists nowhere else, and every other place this data can be lost asks before dropping it: the
// composer's discard prompt, `useDialogGuard`, PhotoAvatar's crop. Sign-out was the one door with no sign on
// it, sitting directly under "View my profile".
async function signOut(confirm: ConfirmFn) {
  const drafts = draftCount();
  if (
    drafts > 0 &&
    !(await confirm({
      title: "Sign out?",
      description: `${drafts} unsaved draft${drafts === 1 ? "" : "s"} on this device ${drafts === 1 ? "is" : "are"} deleted when you sign out - ${drafts === 1 ? "it is" : "they are"} not saved on the server.`,
      confirmLabel: "Sign out",
      destructive: true,
    }))
  ) {
    return;
  }
  await purgeAll();
  try {
    const res = await fetch("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } });
    const { signin_url } = (await res.json()) as { signin_url?: string };
    window.location.href = signin_url || "/";
  } catch {
    window.location.href = "/";
  }
}
// All three modes offered explicitly rather than cycled, so "System" - follow the device - stays selectable
// instead of being the state you land on by accident.
const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function UserMenu({ me }: { me: Me }) {
  const am = useAccessMode();
  const lock = useAppLock();
  const confirm = useConfirm();
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
          <a href="/profile">View my profile</a>
        </DropdownMenuItem>
        {/* The app lock: lock now when a PIN is set, and the person's own settings either way. */}
        {lock.config?.enabled && (
          <DropdownMenuItem onClick={() => void lockNow()}>
            <Lock className="h-4 w-4" />
            Lock now
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => openAppLockSettings()}>
          <LockKeyhole className="h-4 w-4" />
          App lock settings
        </DropdownMenuItem>
        {/* Appearance, at every width - this is the only theme control in the app. A preference, not a page
            action: it belongs with the person rather than in a row of per-page chrome, and a dedicated top-bar
            button spent a permanent 36px on a choice most people make once.
            A three-position segmented control rather than three list rows, because the options are mutually
            exclusive and the whole set is worth seeing at once: the current mode is the filled segment, so
            what is on and what else is available read in one glance instead of a tick to hunt for. */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
          // The track. Inset from the menu's own padding so the control reads as one object rather than as
          // three rows that happen to sit in a line.
          // `bg-background` + a border, NOT `bg-muted`: this control sits on a POPOVER, and `--muted` is the
          // same neutral-800 as `--popover` in the dark palette, so a muted track is invisible there. The two
          // tokens used here are a step apart in both palettes, and the border carries the edge either way.
          className="mx-1 mb-1 flex items-stretch gap-1 rounded-lg border bg-background p-1"
        >
          {THEMES.map((t) => (
            <DropdownMenuRadioItem
              key={t.value}
              value={t.value}
              // Keep the menu open: picking a theme is a preview-and-adjust choice, and re-opening the menu
              // to try the next one is three gestures for a decision that takes one.
              onSelect={(e) => e.preventDefault()}
              className={cn(
                "flex-1 flex-col justify-center gap-1 rounded-md px-1 py-1.5 text-[11px] font-medium text-muted-foreground",
                // The selection IS the raised segment. `data-[state=checked]` is Radix's own flag, so it
                // tracks the group's value rather than a second copy of it kept in this file.
                // `bg-card` sits one step LIGHTER than the track in both palettes (white on neutral-50,
                // neutral-900 on neutral-950), so "raised" means the same thing in dark as in light - which a
                // `bg-background` fill did not: it was darker than its own surroundings in the dark theme.
                "data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:shadow-sm",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut(confirm)}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
