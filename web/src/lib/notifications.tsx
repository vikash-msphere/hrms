import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCollection, type LoadState } from "@/hooks/useCollection";
import { patch, invoke, getAllPages } from "@/api";
import { idOf } from "@/lib/utils";
import { usePermission } from "@/lib/perm";
import { toast } from "@/components/ui/use-toast";
import { categoryOf } from "@/lib/notificationMeta";
import { publish, subscribeTopic } from "@/lib/crossTabBus";
import { broadcastInvalidation, invalidateCollections } from "@/lib/resourceStore";
import type { Notification } from "@/types";

/**
 * The PAGE KEY a notification's `link` points at.
 *
 * `link` is documented as "Web route to open (page key, optional /id)", and rows written before the app moved
 * off hash routes may still carry a leading `#/` or `/`. `router.navigate` strips either deliberately, so
 * CLICKING one has always worked; the two readers that split the string did not, and both failed silently:
 * `unreadByPage` bucketed them under `"#"`, which no nav item carries, so they badged nothing, and the
 * leave-a-page sweep compared `"#" === "settings"`, so they were never auto-marked-read and sat unread in the
 * bell indefinitely. Normalising here means all three readers agree whichever form the row holds.
 */
const pageOfLink = (link: string): string => link.replace(/^#?\//, "").split("/")[0] ?? "";

/** Row ceiling for the snoozed walk. Bounded because each page is a request; high enough that the wake timer
 *  and the list are right for anybody's real snooze pile, and `truncated` is what says when it was not. */
const SNOOZED_CAP = 500;

// Priority ordering + presentation. urgent/high float to the top of the bell + list and get visual emphasis.
const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
export const priorityMeta: Record<string, { label: string; dot: string; ring?: string }> = {
  urgent: { label: "Urgent", dot: "bg-red-500", ring: "ring-1 ring-red-500/30" },
  high: { label: "High", dot: "bg-amber-500" },
  normal: { label: "", dot: "bg-primary" },
  low: { label: "", dot: "bg-muted-foreground/40" },
};
// CTA label for an action notification (e.g. a document that must be signed).
export const actionLabel = (action?: string): string | null =>
  action === "sign" ? "Review & sign" : action === "acknowledge" ? "Acknowledge" : action === "respond" ? "Respond" : null;
// Compact relative time ("now", "5m", "3h", "2d", else a short date). Elapsed time reads better than an
// absolute stamp on a feed; the date is the fallback for anything older than a week.
export function timeAgo(iso?: string): string {
  if (!iso) return "";
  const then = +new Date(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Sort: unread before read, then priority (urgent->low), then newest first.
export function sortNotifications(a: Notification, b: Notification): number {
  if (!!a.read !== !!b.read) return a.read ? 1 : -1;
  const pr = (PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1);
  if (pr) return pr;
  return +new Date(b.create_time ?? 0) - +new Date(a.create_time ?? 0);
}

// A run of notifications that share a category + actor (e.g. one person's kudos burst), so a long list can
// collapse them into a single "Priya and 2 others" style row. Consecutive-only: the list is pre-sorted, so a
// burst lands adjacent; unrelated items each become a group of one.
export type NotifGroup = { key: string; items: Notification[] };
const groupKeyOf = (n: Notification): string | null => (n.actor ? `${categoryOf(n.type)}::${n.actor}` : null);
export function groupNotifications(list: Notification[]): NotifGroup[] {
  const out: NotifGroup[] = [];
  for (const n of list) {
    const gk = groupKeyOf(n);
    const last = out[out.length - 1];
    if (gk && last && last.key === gk) last.items.push(n);
    else out.push({ key: gk ?? n.path, items: [n] });
  }
  return out;
}

// Preset snooze options offered in the row menu. Each yields an absolute wake time from "now".
export const SNOOZE_PRESETS: { label: string; ms: number }[] = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "Until tomorrow", ms: 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
];

// Session-wide in-app notifications. Fetched once on load, and refreshed on window-focus (throttled) so coming
// back to the tab surfaces anything that arrived while you were away - the stack has no realtime, and a polling
// timer would just burn requests. Mutations (read/unread/dismiss/snooze) update local state in place so the
// bell badge + panel stay in sync without a refetch. `available` is false when the caller has no read access
// (the list 403s) - the bell hides itself then.
type NotificationsState = {
  notifications: Notification[];
  unread: number;
  // Unread count keyed by the notification's target page (the first segment of `link`, e.g. "leave-requests").
  // Drives the per-nav-item / per-tab badges that mirror the bell's total down to each destination.
  unreadByPage: Record<string, number>;
  // Resource paths (notification `subject`) with activity in the last 24h - drives the per-row "New" marker.
  // Recency-based, NOT read-based: a row stays "New" for a day even after the unread badge is cleared on view.
  newSubjects: Set<string>;
  available: boolean;
  // The feed's own load state. Without it a consumer cannot tell "you have no notifications" from "the
  // notifications have not arrived yet", and the page said the first while the second was true.
  state: LoadState;

  // Currently-snoozed rows (wake time still in the future) - NOT part of the live feed, so lazily fetched
  // (a separate `?snoozed=true` read) the first time the Snoozed view is opened. `loadSnoozed` is idempotent.
  snoozed: Notification[];
  snoozedLoaded: boolean;
  loadSnoozed: () => void;
  // How many rows are currently snoozed - drives the Snoozed badge. Accurate from first load: rides along on the
  // feed read as `snoozed_count` (see below) until the full list is opened, then tracks the loaded array.
  snoozedCount: number;

  markRead: (n: Notification) => Promise<void>;
  /** A set of rows in one go: one local update, one refresh - not one of each per row. */
  markManyRead: (ns: Notification[]) => Promise<void>;
  markUnread: (n: Notification) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (n: Notification) => Promise<void>;
  snooze: (n: Notification, untilMs: number) => Promise<void>;
  unsnooze: (n: Notification) => Promise<void>;
  reload: () => void;
};

const NEW_WINDOW_MS = 24 * 60 * 60 * 1000; // a row stays "New" for one day after the event
const REFOCUS_THROTTLE_MS = 30 * 1000; // don't refetch on focus more than once every 30s

// Cross-tab sync over the shared crossTabBus. Every mutation is already applied optimistically to local state;
// the acting tab broadcasts the same delta so sibling tabs of the same user mirror it in place - no extra
// network read - instead of drifting stale until their next focus-refetch. `reminded` also dedupes the wake
// toast so a snooze coming due alerts once, not once per open tab. Best-effort: absent BroadcastChannel, tabs
// just fall back to focus-refetch as before.
const NOTIF_TOPIC = "notif";
type BusMsg =
  | { op: "read" | "unread" | "dismiss"; path: string }
  | { op: "snooze"; path: string; until: string; row: Notification }
  | { op: "unsnooze"; path: string }
  | { op: "markAllRead" }
  | { op: "reminded"; path: string };

/**
 * Mark a reminder as already toasted, without letting the mark set climb for the life of the tab.
 *
 * Marks leave on a re-snooze and on a sibling tab's message, so what accumulates is reminders nobody snoozed
 * again - which is most of them, in a tab left open all week. A Set keeps insertion order, so the oldest go
 * first, and a mark old enough to be dropped describes a reminder that came due hundreds of notifications
 * ago: re-toasting one of those costs a toast, while an unbounded set costs memory nothing reclaims.
 *
 * Module scope so its identity is stable - it is called from inside a `useCallback` (the bus handler), and a
 * per-render closure there would have to join that callback's dependency list.
 */
const MAX_REMINDED = 500;
function markReminded(set: Set<string>, path: string): void {
  set.add(path);
  while (set.size > MAX_REMINDED) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

const noop = async () => {};
const EMPTY: NotificationsState = {
  // "ready" outside a provider: there is nothing loading, so a consumer of the default should render its
  // zero state rather than wait forever for a feed that is never coming.
  notifications: [], unread: 0, unreadByPage: {}, newSubjects: new Set(), available: false, state: "ready",
  snoozed: [], snoozedLoaded: false, loadSnoozed: () => {}, snoozedCount: 0,
  markRead: noop, markManyRead: noop, markUnread: noop, markAllRead: noop, dismiss: noop, snooze: noop, unsnooze: noop, reload: () => {},
};
const NotificationsContext = createContext<NotificationsState>(EMPTY);
export const useNotifications = () => useContext(NotificationsContext);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { rows, setRows, state, reload, meta } = useCollection<Notification>("notifications");
  // No read capability -> useCollection never fetches and settles "ready"+empty, so the error check alone
  // would leave the bell visible with a forever-empty panel. The capability is the real gate.
  const canRead = usePermission("notifications.read");
  const available = canRead && state !== "error";
  const unread = useMemo(() => rows.filter((n) => !n.read).length, [rows]);
  // Count of still-sleeping rows piggybacked on the feed read (see listNotifications). The source of truth for
  // the Snoozed badge until the full list is opened, after which the loaded array is authoritative.
  const metaSnoozedCount = typeof meta?.snoozed_count === "number" ? (meta.snoozed_count as number) : undefined;

  // Snoozed rows live outside the feed - fetched lazily (once) when the Snoozed view is first opened.
  const [snoozed, setSnoozed] = useState<Notification[]>([]);
  const [snoozedLoaded, setSnoozedLoaded] = useState(false);
  const [snoozedTruncated, setSnoozedTruncated] = useState(false);
  // THE CURSOR IS WALKED, because a page of this collection is not a subset of it in any useful order. The
  // server clamps any page size to 100 (http/pagination.ts) and says so only through `next_page_token` - this
  // asked for 200 and read the answer as the whole set, which is the same mistake four other files carry a
  // comment about having fixed. It matters twice here: the Snoozed badge dropped to 100 the moment the tab was
  // opened (a count that gets LESS accurate when you look at it), and the wake timer below aims at the soonest
  // pending snooze while these rows are ordered by create_time DESC - so the next wake due is not
  // preferentially in the first page, and a busy approver's reminder simply never armed.
  // A GENERATION COUNTER, because this walks the cursor (several sequential round-trips) and is invoked
  // directly from three places that can overlap: the Snoozed view opening, every snooze/unsnooze write, and the
  // wake timer firing. There is no effect cleanup to hang a flag on. Without the guard a slower earlier walk
  // resolves last and repaints the list with rows the user has already woken - and re-arms the wake timer off
  // that stale set, so the next reminder aims at a snooze that no longer exists.
  const reqSeq = useRef(0);
  const loadSnoozed = useCallback(() => {
    setSnoozedLoaded(true);
    const seq = ++reqSeq.current;
    void getAllPages<Notification>("notifications?snoozed=true&max_page_size=100", SNOOZED_CAP)
      .then(({ results, truncated }) => {
        if (seq !== reqSeq.current) return;
        setSnoozed(results);
        setSnoozedTruncated(truncated);
      })
      .catch(() => { if (seq === reqSeq.current) setSnoozedLoaded(false); });
  }, []);

  // Proactive wake: a single-shot timer to the SOONEST pending snooze so an idle open tab actually surfaces a
  // reminder at its due moment (the focus-refetch only fires when the user returns). Not polling - one timer to
  // one known instant, replaced whenever an earlier wake appears. On fire: pull the woken row into the feed
  // (the toast effect below re-alerts) and refresh the snoozed set so the next wake re-arms.
  const wakeTimer = useRef<number | null>(null);
  const wakeAt = useRef<number | null>(null);
  const scheduleWake = useCallback((atMs: number) => {
    const now = Date.now();
    if (!Number.isFinite(atMs) || atMs <= now) return;
    if (wakeAt.current !== null && wakeAt.current <= atMs) return; // an equal-or-sooner wake is already armed
    if (wakeTimer.current !== null) clearTimeout(wakeTimer.current);
    wakeAt.current = atMs;
    wakeTimer.current = window.setTimeout(() => {
      wakeTimer.current = null;
      wakeAt.current = null;
      reload();
      loadSnoozed();
    }, Math.min(atMs - now, 2_147_483_647)); // clamp to the setTimeout max (~24.8 days)
  }, [reload, loadSnoozed]);
  useEffect(() => () => { if (wakeTimer.current !== null) clearTimeout(wakeTimer.current); }, []);

  // Re-arm the timer whenever the snoozed set changes (loaded, woken, re-snoozed): aim at the earliest future wake.
  useEffect(() => {
    const now = Date.now();
    const next = snoozed.map((n) => +new Date(n.snooze_until_time ?? 0)).filter((t) => t > now).sort((a, b) => a - b)[0];
    if (next) scheduleWake(next);
  }, [snoozed, scheduleWake]);

  const unreadByPage = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of rows) {
      if (n.read || !n.link) continue;
      const page = pageOfLink(n.link);
      if (!page) continue;
      m[page] = (m[page] ?? 0) + 1;
    }
    return m;
  }, [rows]);
  const newSubjects = useMemo(() => {
    const now = Date.now();
    const s = new Set<string>();
    for (const n of rows) {
      if (!n.subject || !n.create_time) continue;
      if (now - +new Date(n.create_time) < NEW_WINDOW_MS) s.add(n.subject);
    }
    return s;
  }, [rows]);

  // Refetch when the tab regains focus (throttled). Surfaces notifications that arrived while away without a
  // background polling timer.
  const lastFetch = useRef(Date.now());
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetch.current < REFOCUS_THROTTLE_MS) return;
      lastFetch.current = Date.now();
      reload();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  // Toast on state changes across refetches: snooze reminders coming due, and fresh high/urgent arrivals.
  const seen = useRef<Set<string> | null>(null);
  // "Already toasted this one." Entries leave on a re-snooze and on a sibling tab's message, so the only ones
  // that accumulate are reminders nobody snoozed again - which is most of them, in a tab left open all week.
  // BOUNDED for that reason: a Set keeps insertion order, so the oldest marks go first, and a mark old enough
  // to be dropped describes a reminder that came due hundreds of notifications ago. Re-toasting one of those
  // costs a toast; letting the set climb for the life of the tab costs memory nothing ever reclaims.
  const reminded = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = Date.now();
    // Reminders (A): a row whose wake time has passed reappears in the feed still carrying a PAST
    // snooze_until_time. That's a "remind me later" coming due - re-alert once at ANY priority (the user
    // explicitly asked to be reminded), then (C) clear the stamp server-side so it settles into a normal unread
    // row and can be re-snoozed. Runs even on the first load, so opening the app surfaces anything already due.
    const woken = rows.filter((n) => n.snooze_until_time && +new Date(n.snooze_until_time) <= now && !reminded.current.has(n.path));
    for (const n of woken) markReminded(reminded.current, n.path);
    if (woken.length === 1) toast({ title: `Reminder: ${woken[0]!.title}`, description: woken[0]!.body || undefined });
    else if (woken.length > 1) toast({ title: `${woken.length} snoozed reminders`, description: "Open the bell to review them." });
    if (woken.length) {
      const wokenPaths = new Set(woken.map((n) => n.path));
      setRows((prev) => prev.map((r) => (wokenPaths.has(r.path) ? { ...r, snooze_until_time: undefined } : r)));
      // `skipInvalidation` on each, then ONE invalidation when they settle - the shape `markManyRead` below
      // documents at length. Without it every cleared stamp ran `withInvalidation`, which forces a re-read of
      // the whole feed for a provider that is always subscribed, and `patchRows` stamps `patchedAt`, so a
      // forced read already in flight when the next write lands fails resourceStore's `patchedAt >= startedAt`
      // check and is discarded and rescheduled rather than adopted. N due reminders were N reads and N retries.
      for (const n of woken) publish(NOTIF_TOPIC, { op: "reminded", path: n.path } satisfies BusMsg); // tell sibling tabs: don't re-toast
      void Promise.allSettled(
        woken.map((n) => patch(`notifications/${idOf(n.path)}`, { snooze_until_time: null }, undefined, { skipInvalidation: true })),
      ).then((results) => {
        // A failure reloads rather than invalidating: the local rows above already say the stamp is gone, so
        // the feed has to be re-read to find out which ones really are. Same recovery `markManyRead` uses.
        if (results.some((r) => r.status === "rejected")) reload();
        else broadcastInvalidation(invalidateCollections(["notifications"]));
      });
    }

    // Fresh arrivals: high/urgent only, and never a woken reminder (guarded by the snooze stamp). Skips the very
    // first load so returning to the tab announces only what's genuinely new.
    const ids = new Set(rows.map((n) => n.path));
    if (seen.current === null) {
      seen.current = ids;
      return;
    }
    const fresh = rows.filter((n) => !seen.current!.has(n.path) && !n.read && !n.snooze_until_time && (n.priority === "urgent" || n.priority === "high"));
    seen.current = ids;
    if (fresh.length === 1) toast({ title: fresh[0]!.title, description: fresh[0]!.body || undefined });
    else if (fresh.length > 1) toast({ title: `${fresh.length} new notifications`, description: "Open the bell to review them." });
  }, [rows, setRows, reload]);

  // Cross-tab bus. Each mutation broadcasts its delta; sibling tabs replay the SAME local transform (no network)
  // so all tabs of this user stay consistent. Sender never receives its own message, so applying here can't loop.
  const post = useCallback((msg: BusMsg) => publish(NOTIF_TOPIC, msg), []);
  const applyRemote = useCallback((msg: BusMsg) => {
    switch (msg.op) {
      case "read":
        setRows((prev) => prev.map((r) => (r.path === msg.path ? { ...r, read: true } : r)));
        break;
      case "unread":
        setRows((prev) => prev.map((r) => (r.path === msg.path ? { ...r, read: false } : r)));
        break;
      case "dismiss":
        setRows((prev) => prev.filter((r) => r.path !== msg.path));
        break;
      case "markAllRead":
        setRows((prev) => prev.map((r) => ({ ...r, read: true })));
        break;
      case "snooze":
        setRows((prev) => prev.filter((r) => r.path !== msg.path));
        // Apply the delta live (mirror unsnooze) instead of invalidating: only when the list is already loaded,
        // else stay lazy - the true total arrives when the view is first opened.
        setSnoozed((prev) => (snoozedLoaded ? [msg.row, ...prev.filter((r) => r.path !== msg.path)] : prev));
        reminded.current.delete(msg.path);
        scheduleWake(+new Date(msg.until));
        break;
      case "unsnooze":
        setSnoozed((prev) => prev.filter((r) => r.path !== msg.path));
        break;
      case "reminded":
        // A sibling already alerted for this wake - suppress our toast + skip our redundant clear-patch, and drop
        // the stale snooze stamp locally.
        markReminded(reminded.current, msg.path);
        setRows((prev) => prev.map((r) => (r.path === msg.path ? { ...r, snooze_until_time: undefined } : r)));
        break;
    }
  }, [setRows, scheduleWake, snoozedLoaded]);
  useEffect(() => subscribeTopic<BusMsg>(NOTIF_TOPIC, applyRemote), [applyRemote]);

  /**
   * Every write below sends NO `If-Match`, deliberately - the one place in this app where that is right.
   *
   * A version guard exists to stop one writer's edit from silently replacing another's. These rows have a
   * single reader and writer (the recipient), and each write sets ONE flag to the value that person just
   * chose: read, dismissed, snoozed-until. There is nothing of anybody else's to lose, so "last write wins"
   * is exactly the intent - the last thing they did.
   *
   * What the guard DID do was fail: `n.etag` is the version the FEED was read at, and the feed is written from
   * several places at once - a sibling tab through the bus, the leave-a-page sweep marking a batch read, the
   * snooze timer clearing a stamp. Any of those moves the row's version under the list, and the next flag
   * write answered 409, reverted the person's click and refetched the whole feed. Opening the bell and
   * walking two pages was enough to produce it.
   */
  const markRead = useCallback(
    async (n: Notification) => {
      if (n.read) return;
      setRows((prev) => prev.map((r) => (r.path === n.path ? { ...r, read: true } : r)));
      post({ op: "read", path: n.path });
      try {
        await patch(`notifications/${idOf(n.path)}`, { read: true });
      } catch {
        reload();
      }
    },
    [setRows, reload, post],
  );

  /**
   * Mark a SET of notifications read as one unit: rows applied locally once, writes sent together, and the
   * collection refreshed ONCE when they settle.
   *
   * Leaving a page marks every unread notification for it read, which through `markRead` was one PATCH plus one
   * FORCED list read each - `withInvalidation` re-reads every cached key with a live subscriber, and the
   * provider wraps the whole app so `notifications` always has one. Worse, `patchRows` stamps `patchedAt`, so a
   * forced read still in flight when the next write landed failed `e.patchedAt >= startedAt` and scheduled yet
   * another read instead of adopting its answer. On an app whose primary constraint is request count, a storm
   * on every navigation is the wrong shape.
   */
  const markManyRead = useCallback(
    async (ns: Notification[]) => {
      const unreadOnes = ns.filter((n) => !n.read);
      if (!unreadOnes.length) return;
      const paths = new Set(unreadOnes.map((n) => n.path));
      setRows((prev) => prev.map((r) => (paths.has(r.path) ? { ...r, read: true } : r)));
      for (const n of unreadOnes) post({ op: "read", path: n.path });
      const results = await Promise.allSettled(
        unreadOnes.map((n) => patch(`notifications/${idOf(n.path)}`, { read: true }, undefined, { skipInvalidation: true })),
      );
      // One refresh for the batch - the debt `skipInvalidation` incurs. A failure inside it reloads, which is
      // the same recovery a single `markRead` does.
      if (results.some((r) => r.status === "rejected")) reload();
      else broadcastInvalidation(invalidateCollections(["notifications"]));
    },
    [setRows, reload, post],
  );

  const markUnread = useCallback(
    async (n: Notification) => {
      if (!n.read) return;
      setRows((prev) => prev.map((r) => (r.path === n.path ? { ...r, read: false } : r)));
      post({ op: "unread", path: n.path });
      try {
        await patch(`notifications/${idOf(n.path)}`, { read: false });
      } catch {
        reload();
      }
    },
    [setRows, reload, post],
  );

  const markAllRead = useCallback(async () => {
    if (!rows.some((n) => !n.read)) return;
    setRows((prev) => prev.map((r) => ({ ...r, read: true })));
    post({ op: "markAllRead" });
    try {
      await invoke("notifications", "markAllRead");
    } catch {
      reload();
    }
  }, [rows, setRows, reload, post]);

  // Dismiss (archive) a row out of the feed. Optimistically drops it locally; the server filters it thereafter.
  const dismiss = useCallback(
    async (n: Notification) => {
      setRows((prev) => prev.filter((r) => r.path !== n.path));
      post({ op: "dismiss", path: n.path });
      try {
        await patch(`notifications/${idOf(n.path)}`, { dismissed: true });
      } catch {
        reload();
      }
    },
    [setRows, reload, post],
  );

  // Snooze a row until `untilMs`; it drops from the feed now and resurfaces (unread) after a later refetch.
  // Arms the wake timer so an idle tab is reminded at the due moment, clears any prior reminder mark (so a
  // re-snooze re-reminds), and invalidates the lazily-fetched snoozed list so reopening the view refetches it.
  const snooze = useCallback(
    async (n: Notification, untilMs: number) => {
      const until = new Date(untilMs).toISOString();
      const row: Notification = { ...n, snooze_until_time: until };
      setRows((prev) => prev.filter((r) => r.path !== n.path));
      // Apply the delta live (mirror unsnooze) so the Snoozed badge/count updates without a refetch. Only when
      // the list is already loaded, else stay lazy - the true total is fetched when the view is first opened.
      setSnoozed((prev) => (snoozedLoaded ? [row, ...prev.filter((r) => r.path !== n.path)] : prev));
      reminded.current.delete(n.path);
      scheduleWake(untilMs);
      post({ op: "snooze", path: n.path, until, row });
      try {
        await patch(`notifications/${idOf(n.path)}`, { snooze_until_time: until });
        toast({ title: "Snoozed", description: "We'll bring it back later." });
      } catch {
        reload();
      }
    },
    [setRows, reload, scheduleWake, post, snoozedLoaded],
  );

  // Wake a snoozed row now: clear its snooze so it rejoins the live feed. Drops from the snoozed list locally,
  // and reloads the feed so the woken row reappears there.
  const unsnooze = useCallback(
    async (n: Notification) => {
      setSnoozed((prev) => prev.filter((r) => r.path !== n.path));
      post({ op: "unsnooze", path: n.path });
      try {
        await patch(`notifications/${idOf(n.path)}`, { snooze_until_time: null });
        reload();
      } catch {
        loadSnoozed();
      }
    },
    [reload, loadSnoozed, post],
  );

  // Once the list is opened IN FULL, the loaded array is truth (kept live by the snooze/unsnooze deltas).
  // Before that - and when the walk hit its ceiling - the server's own count is the better number: a badge
  // that drops to the page size the moment somebody opens the tab is worse than one that stays approximate.
  const snoozedCount = snoozedLoaded && !snoozedTruncated ? snoozed.length : (metaSnoozedCount ?? snoozed.length);
  const value = useMemo<NotificationsState>(
    () => ({ notifications: rows, unread, unreadByPage, newSubjects, available, state, snoozed, snoozedLoaded, loadSnoozed, snoozedCount, markRead, markManyRead, markUnread, markAllRead, dismiss, snooze, unsnooze, reload }),
    [rows, unread, unreadByPage, newSubjects, available, state, snoozed, snoozedLoaded, loadSnoozed, snoozedCount, markRead, markManyRead, markUnread, markAllRead, dismiss, snooze, unsnooze, reload],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

// Clear notification badges on NAVIGATE-AWAY, never on arrival. While you're on a page its unread badge and the
// per-row "New" dots stay visible (so you can actually see what's new); when you leave it - clicking another
// menu/tab, or any route change - the page you just left gets its notifications marked read, so the badge is
// gone next time. Marking read reduces the count everywhere it shows (bell total, sidebar nav item,
// workspace/sub tabs - all read the same rows). Render once inside the provider with the current route page.
export function NotificationClearOnLeave({ page }: { page: string }) {
  const { notifications, markManyRead } = useNotifications();
  const prev = useRef(page);
  useEffect(() => {
    if (prev.current === page) return; // same page (a re-render, not a navigation) - leave the badge alone
    const left = prev.current;
    prev.current = page;
    // Collected first and sent as ONE batch: a per-row `markRead` cost a forced re-read of the whole feed per
    // notification (see `markManyRead`).
    const leaving = notifications.filter((n) => !n.read && n.link && pageOfLink(n.link) === left);
    if (leaving.length) void markManyRead(leaving);
  }, [page, notifications, markManyRead]);
  return null;
}
