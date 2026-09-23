import { useEffect, useMemo, useState } from "react";
import { navigateTab, useRoute } from "@/router";
import { useNotifications } from "@/lib/notifications";

// Shared plumbing for a page whose internal tabs should be (a) deep-linkable from a notification and (b) badged
// with unread counts. A notification's `link` is `<pageKey>/<subTab>` (e.g. "leave-requests/history"); clicking
// it navigates to that route, and this hook reads the sub-tab off the route to drive a CONTROLLED <Tabs>, and
// exposes `badge(sub)` = unread notifications pointing at that sub-tab. Pages just spread `{ value, onValueChange }`
// onto <Tabs> and call `badge("history")` on the trigger. Replaces per-page tab wiring so it works everywhere.
//
// The URL is the single source of truth for which tab is open: picking a tab WRITES it to the hash, the way a
// deep link or a KPI card's `navigateTab` does. Keeping the choice in component state alone let the URL drift
// out of sync, which broke both directions - a metric card pointing at the tab named by the stale URL asked for
// a route already on screen and so did nothing, and a page couldn't tell which tab is open to mark that card
// active.
export function useRoutedTabs(pageKey: string, tabKeys: string[], defaultTab: string) {
  const route = useRoute();
  const onPage = route.page === pageKey;
  // A path with NO tab segment (`/leave-requests`) names the default tab - it is the address the page starts
  // on and the one Back returns to after a tab was picked. Reading that as "the URL says nothing" left the
  // component on the tab the reader had just stepped away from, so Back visibly did nothing. A segment that is
  // neither a tab nor absent is a record id (see the note on onValueChange) and leaves the tab state alone.
  const fromRoute = !onPage ? null : !route.id ? defaultTab : tabKeys.includes(route.id) ? route.id : null;
  const [tab, setTab] = useState(fromRoute ?? defaultTab);
  useEffect(() => {
    if (fromRoute) setTab(fromRoute);
  }, [fromRoute]);
  // State moves too, not just the URL: a page mounted under a route whose `id` is something else (a record
  // id, say) still needs its tabs to work, and the URL write is a no-op there.
  const onValueChange = (next: string) => {
    setTab(next);
    if (onPage) navigateTab(pageKey, next);
  };

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

  return { value: tab, onValueChange, badge: (sub: string) => unreadBySub[sub] ?? 0 };
}

// The tab a page is currently showing, read straight off the route - for a page that hands its tabs to a shared
// shell (RequestsHistoryTabs) but still needs to know the open tab, e.g. to mark the metric card that points at
// it active. Safe because `useRoutedTabs` writes every tab change to the URL.
export function useRoutedTab(pageKey: string, defaultTab: string) {
  const route = useRoute();
  return route.page === pageKey && route.id ? route.id : defaultTab;
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
