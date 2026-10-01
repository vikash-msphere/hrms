import { metaForType } from "@/lib/notificationMeta";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { cn, idOf } from "@/lib/utils";
import type { Notification } from "@/types";

// The leading visual of a notification row. When there's an actor (an approver, a kudos-giver, ...) it's their
// avatar with the category glyph as a small corner badge - "who + what" at a glance. System/broadcast events
// (no actor) show the category icon chip on its own. `size` scales for the compact bell vs the full page.
export function NotificationLead({ n, size = "md" }: { n: Notification; size?: "sm" | "md" }) {
  const meta = metaForType(n.type);
  const Icon = meta.icon;
  const box = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const glyph = size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";

  if (n.actor) {
    return (
      <span className="relative inline-block shrink-0">
        <PhotoAvatar employeeId={n.actor_id ? idOf(n.actor_id) : ""} name={n.actor} photo={n.actor_photo} className={cn(box, "text-xs")} />
        <span className={cn("absolute -bottom-1 -right-1 flex items-center justify-center rounded-full p-0.5 ring-2 ring-card", meta.cls)}>
          <Icon className="h-3 w-3" />
        </span>
      </span>
    );
  }
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full", box, meta.cls)}>
      <Icon className={glyph} />
    </span>
  );
}
