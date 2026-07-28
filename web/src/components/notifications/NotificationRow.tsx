import { useNotifications, priorityMeta, actionLabel } from "@/lib/notifications";
import { NotificationLead } from "@/components/notifications/NotificationLead";
import { NotificationRowMenu } from "@/components/notifications/NotificationRowMenu";
import { navigate } from "@/router";
import { cn } from "@/lib/utils";
import type { Notification } from "@/types";

// One full-width notification row for the Notifications page (and inside expanded groups). Shows the actor
// avatar / category icon, an unread accent, priority badge, optional CTA, the "when" label, and the overflow
// menu. Clicking marks it read and opens its linked page.
export function NotificationRow({ n, when, indent }: { n: Notification; when: string; indent?: boolean }) {
  const { markRead } = useNotifications();
  const open = () => {
    void markRead(n);
    if (n.link) navigate(n.link);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        !n.read && "bg-primary/5",
        indent && "pl-12",
      )}
    >
      {!n.read && <span className={cn("absolute left-0 top-0 h-full w-0.5", priorityMeta[n.priority]?.dot ?? "bg-primary")} />}
      {!indent && <NotificationLead n={n} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn("text-sm", n.read ? "font-normal" : "font-semibold")}>{n.title}</span>
            {n.actor && <span className="text-xs text-muted-foreground">{n.actor}</span>}
            {priorityMeta[n.priority]?.label && (
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", n.priority === "urgent" ? "bg-red-500/15 text-red-600 dark:text-red-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400")}>
                {priorityMeta[n.priority]!.label}
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
        </span>
        {n.body && <span className="mt-0.5 block text-sm text-muted-foreground">{n.body}</span>}
        {actionLabel(n.action) && (
          <span className="mt-1.5 inline-block rounded bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{actionLabel(n.action)} →</span>
        )}
      </span>
      <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <NotificationRowMenu n={n} />
      </div>
    </div>
  );
}
