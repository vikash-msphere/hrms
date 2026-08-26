import { useEffect, useRef, useState } from "react";
import { Bell, BellRing, CheckCheck, Clock, Inbox } from "lucide-react";
import { useNotifications, sortNotifications, priorityMeta, actionLabel, timeAgo } from "@/lib/notifications";
import { NotificationLead } from "@/components/notifications/NotificationLead";
import { NotificationRowMenu } from "@/components/notifications/NotificationRowMenu";
import { PushEnrollButton } from "@/components/notifications/PushEnrollButton";
import { navigate } from "@/router";
import { cn } from "@/lib/utils";
import { AccessAction } from "@/components/access/AccessAction";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Notification } from "@/types";

// Top-bar notification bell: unread badge + a dropdown of recent notifications with an All/Unread/Snoozed toggle.
// Each row carries the actor's avatar (or the category icon), a hover overflow menu (mark/snooze/dismiss), and
// opens its linked page on click. The badge pulses briefly when the unread count rises. Hidden when the caller
// has no read access (the list 403s) so it never shows a dead bell. Wrapped in <AccessAction> so access mode
// can grant/revoke `notifications` from here like every other surface.
export function NotificationBell() {
  const { notifications, unread, available, snoozed, snoozedLoaded, loadSnoozed, snoozedCount, unsnooze, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread" | "snoozed">("all");

  // Snoozed rows sit outside the live feed - fetch them the first time that view is opened.
  useEffect(() => {
    if (open && tab === "snoozed" && !snoozedLoaded) loadSnoozed();
  }, [open, tab, snoozedLoaded, loadSnoozed]);

  // Pulse the bell when the unread count increases (something arrived).
  const [pulse, setPulse] = useState(false);
  const prevUnread = useRef(unread);
  useEffect(() => {
    if (unread > prevUnread.current) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 900);
      prevUnread.current = unread;
      return () => clearTimeout(t);
    }
    prevUnread.current = unread;
  }, [unread]);

  if (!available) return null;

  const open_ = (n: Notification) => {
    void markRead(n);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const isSnoozed = tab === "snoozed";
  // Row click: a live row opens (and marks read); a snoozed row just navigates - it stays asleep until woken.
  const rowClick = (n: Notification) => {
    if (isSnoozed) { setOpen(false); if (n.link) navigate(n.link); return; }
    open_(n);
  };
  // Relative wake time for a snoozed row ("in 40m", "in 3h", "in 2d").
  const untilLabel = (iso?: string | null): string => {
    if (!iso) return "";
    const m = Math.max(0, Math.round((+new Date(iso) - Date.now()) / 60000));
    if (m < 1) return "now";
    if (m < 60) return `in ${m}m`;
    const h = Math.round(m / 60);
    return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
  };
  // Priority-then-recency ordered, capped at 8 in the dropdown (the full list lives on the Notifications page).
  // The snoozed view instead orders by wake time, soonest first - what resurfaces next reads top.
  const recent = isSnoozed
    ? [...snoozed].sort((a, b) => +new Date(a.snooze_until_time ?? 0) - +new Date(b.snooze_until_time ?? 0)).slice(0, 8)
    : [...(tab === "unread" ? notifications.filter((n) => !n.read) : notifications)].sort(sortNotifications).slice(0, 8);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <AccessAction collection="notifications" label="Notifications">
        <DropdownMenuTrigger asChild>
          <button
            aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
            title="Notifications"
            className="relative flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Bell className={cn("h-4 w-4", pulse && "animate-bounce")} />
            {unread > 0 && (
              <span className={cn("absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground transition-transform", pulse && "scale-125")}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
      </AccessAction>

      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="inline-flex rounded-md border bg-card p-0.5 text-xs">
            <button onClick={() => setTab("all")} className={cn("rounded px-2 py-1 font-medium transition-colors", tab === "all" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground")}>
              All
            </button>
            <button onClick={() => setTab("unread")} className={cn("rounded px-2 py-1 font-medium transition-colors", tab === "unread" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground")}>
              Unread{unread > 0 && <span className="ml-1 text-muted-foreground">{unread}</span>}
            </button>
            <button onClick={() => setTab("snoozed")} className={cn("rounded px-2 py-1 font-medium transition-colors", tab === "snoozed" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground")}>
              Snoozed{snoozedCount > 0 && <span className="ml-1 text-muted-foreground">{snoozedCount}</span>}
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {unread > 0 && (
              <AccessAction collection="notifications" verb="markAllRead" label="Mark all read">
                <button onClick={() => void markAllRead()} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                </button>
              </AccessAction>
            )}
            {/* Enrol this browser for push. Self-hiding unless it is the one thing left to do, so the header
                stays a filter row in the common case. */}
            <PushEnrollButton />
          </div>
        </div>

        {recent.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
            {isSnoozed ? <Clock className="h-6 w-6 opacity-50" /> : <Inbox className="h-6 w-6 opacity-50" />}
            {isSnoozed
              ? snoozedLoaded ? "Nothing snoozed" : "Loading…"
              : tab === "unread" ? "No unread notifications" : "You're all caught up"}
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto py-1">
            {recent.map((n) => (
              <div
                key={n.path}
                role="button"
                tabIndex={0}
                onClick={() => rowClick(n)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rowClick(n); } }}
                className={cn(
                  "group relative flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  !isSnoozed && !n.read && "bg-primary/5",
                  !isSnoozed && !n.read && (n.priority === "urgent" || n.priority === "high") && priorityMeta[n.priority]?.ring,
                )}
              >
                {!isSnoozed && !n.read && <span className={cn("absolute left-0 top-0 h-full w-0.5", priorityMeta[n.priority]?.dot ?? "bg-primary")} />}
                <NotificationLead n={n} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-sm", !isSnoozed && !n.read ? "font-semibold" : "font-normal")}>{n.title}</span>
                    {isSnoozed ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground"><Clock className="h-3 w-3" />{untilLabel(n.snooze_until_time)}</span>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(n.create_time)}</span>
                    )}
                  </span>
                  {n.actor && <span className="text-xs text-muted-foreground">{n.actor}</span>}
                  {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
                  {actionLabel(n.action) && (
                    <span className="mt-1 inline-block rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">{actionLabel(n.action)}</span>
                  )}
                </span>
                {isSnoozed ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); void unsnooze(n); }}
                    title="Wake now"
                    aria-label="Wake now"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <BellRing className="h-4 w-4" />
                  </button>
                ) : (
                  <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <NotificationRowMenu n={n} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => { setOpen(false); navigate("notifications"); }}
          className="block w-full border-t px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          View all
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
