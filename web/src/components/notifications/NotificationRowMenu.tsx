import { MoreHorizontal, Check, Undo2, Clock, X } from "lucide-react";
import { useNotifications, SNOOZE_PRESETS } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Notification } from "@/types";

// The per-row overflow menu: mark read/unread, snooze (preset wake times), and dismiss. Self-contained - reads
// the actions off the provider so both the bell and the full page drop it in the same way. Clicks are stopped
// from bubbling so acting on a row never also opens/navigates it.
export function NotificationRowMenu({ n, className }: { n: Notification; className?: string }) {
  const { markRead, markUnread, dismiss, snooze } = useNotifications();
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={stop}
          aria-label="Notification actions"
          className={cn("flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stop} className="w-44">
        {n.read ? (
          <DropdownMenuItem onClick={() => void markUnread(n)}>
            <Undo2 className="h-4 w-4" /> Mark unread
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => void markRead(n)}>
            <Check className="h-4 w-4" /> Mark read
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> Snooze
        </DropdownMenuLabel>
        {SNOOZE_PRESETS.map((p) => (
          <DropdownMenuItem key={p.label} onClick={() => void snooze(n, Date.now() + p.ms)} className="pl-8">
            {p.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void dismiss(n)} className="text-destructive focus:text-destructive">
          <X className="h-4 w-4" /> Dismiss
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
