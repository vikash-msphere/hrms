import { useEffect, useMemo, useState } from "react";
import { useRoute } from "@/router";
import { useNotifications } from "@/lib/notifications";

// Shared plumbing for a page whose internal tabs should be (a) deep-linkable from a notification and (b) badged
// with unread counts. A notification's `link` is `<pageKey>/<subTab>` (e.g. "leave-requests/history"); clicking
// it navigates to that hash, and this hook reads the sub-tab off the route to drive a CONTROLLED <Tabs>, and
// exposes `badge(sub)` = unread notifications pointing at that sub-tab. Pages just spread `{ value, onValueChange }`
// onto <Tabs> and call `badge("history")` on the trigger. Replaces per-page tab wiring so it works everywhere.
export function useRoutedTabs(pageKey: string, tabKeys: string[], defaultTab: string) {
  const route = useRoute();
  const fromRoute = route.page === pageKey && route.id && tabKeys.includes(route.id) ? route.id : null;
  const [tab, setTab] = useState(fromRoute ?? defaultTab);
  useEffect(() => {
    if (fromRoute) setTab(fromRoute);
  }, [fromRoute]);

  const { notifications } = useNotifications();
  const unreadBySub = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notifications) {
      if (n.read || !n.link) continue;
      const [p, sub] = n.link.split("/");
      if (p === pageKey && sub) m[sub] = (m[sub] ?? 0) + 1;
    }
    return m;
  }, [notifications, pageKey]);

  return { value: tab, onValueChange: setTab, badge: (sub: string) => unreadBySub[sub] ?? 0 };
}

// Small unread pill for a tab trigger.
export function TabBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
}
