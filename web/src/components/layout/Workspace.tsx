import * as React from "react";
import { cn } from "@/lib/utils";
import type { NavTab } from "@/nav";
import { useNotifications } from "@/lib/notifications";
import { useTabActivity, markTabSeen } from "@/lib/tabActivity";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useScrollActiveIntoView } from "@/hooks/useScrollActiveIntoView";

// Renders a workspace's tab bar above the active page. Tabs are plain links to each sibling route, so
// switching between related pages (e.g. Attendance → Overtime) is one click instead of a sidebar hunt, and
// deep links / back-forward keep working. The bar is suppressed when the caller can see at most one tab.
// In access-management mode each tab that maps to a collection carries its own "manage access" key (right on
// the tab), so access is managed from here rather than from each page's heading.
export function Workspace({
  tabs,
  active,
  children,
}: {
  tabs: NavTab[];
  active: string;
  children: React.ReactNode;
}) {
  const { unreadByPage } = useNotifications();
  const activity = useTabActivity(tabs);
  // Viewing a tab clears its badge and advances the reference the next visit measures "new" from.
  React.useEffect(() => {
    markTabSeen(active);
  }, [active]);
  // A workspace can carry ten tabs (Payroll, Settings); on a phone that strip is several screens wide, so the
  // tab you are on has to be brought into view rather than left off the right-hand edge.
  const bar = React.useRef<HTMLDivElement>(null);
  useScrollActiveIntoView(bar);
  if (tabs.length <= 1) return <>{children}</>;
  return (
    <div>
      {/* scroll-shadow-x: the only cue that the strip continues past the edge, since there is no scrollbar
          (no-scrollbar) and no hover on touch. See index.css. */}
      {/* A landmark, because that is what it is: a set of links between sibling pages, not a tab widget over
          panels in this document. Naming it lets a screen-reader user jump to it instead of arrowing down
          through the page to find out how to get to the next section. */}
      <nav
        ref={bar}
        aria-label="Sections in this workspace"
        className="scroll-shadow-x no-scrollbar mb-6 flex items-center gap-1 overflow-x-auto border-b"
      >
        {tabs.map((t) => {
          const on = t.key === active;
          // Notification badge takes priority (an actionable, per-recipient signal). With none, fall back to the
          // "new content since last seen" count. Both suppressed on the active tab (you're looking at it).
          const unread = on ? 0 : unreadByPage[t.key] ?? 0;
          const fresh = on || unread > 0 ? 0 : activity[t.key] ?? 0;
          const link = (
            <a
              href={`/${t.key}`}
              aria-current={on ? "page" : undefined}
              className={cn(
                // min-h-11 on touch: a 40px tab in a scrolling strip is a target you miss, and missing it
                // drags the strip instead.
                // shrink-0: without it a flex item shrinks below its content width, and since the label is
                // nowrap the text spills out of the box and over the next tab instead of the strip scrolling.
                "-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors coarse:min-h-11",
                on
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {t.label}
              {unread > 0 ? (
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary-foreground">
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : fresh > 0 ? (
                // "New" content marker: subtler than the notification pill (an FYI, not an action item).
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary">
                  {fresh > 99 ? "99+" : fresh}
                </span>
              ) : null}
            </a>
          );
          // Pair the tab with its access key as a sibling (an anchor can't contain the AccessTarget button).
          return t.collection ? (
            <span key={t.key} className="inline-flex shrink-0 items-center">
              {link}
              <AccessTarget target={{ collection: t.collection, label: t.label }} className="-ml-1 h-5 w-5" />
            </span>
          ) : (
            <React.Fragment key={t.key}>{link}</React.Fragment>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
