import { KeyRound, LogOut, ShieldCheck, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/roles";
import { useEmployee } from "@/hooks/useEmployee";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Me } from "@/types";

// The signed-in user's avatar + menu, anchored in the top bar. Opens (downward) with the profile link, sign-out,
// and - for those who may manage access - the access-management mode toggle and a shortcut to manage WHO can
// manage access. Avatar-only trigger to stay compact next to the rest of the top-bar chrome.
export function UserMenu({ me }: { me: Me }) {
  const am = useAccessMode();
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
        className="flex items-center gap-1.5 rounded-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-accent"
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
        <DropdownMenuItem onClick={() => (window.location.href = "/cdn-cgi/access/logout")}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
