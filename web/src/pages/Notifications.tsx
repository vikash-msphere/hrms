import { useEffect, useMemo, useState } from "react";
import { Bell, BellOff, BellRing, CheckCheck, ChevronDown, Clock } from "lucide-react";
import { useNotifications, sortNotifications, groupNotifications, actionLabel, type NotifGroup } from "@/lib/notifications";
import { metaForType, categoryOf, CATEGORY_META } from "@/lib/notificationMeta";
import { cn, formatDate } from "@/lib/utils";
import { navigate } from "@/router";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings, SettingsButton } from "@/components/common/SettingsButton";
import { EmptyState } from "@/components/common/EmptyState";
import { CardsSkeleton } from "@/components/common/Skeletons";
import { DataState } from "@/components/common/DataState";
import { AccessAction } from "@/components/access/AccessAction";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { NotificationLead } from "@/components/notifications/NotificationLead";
import { PushEnrollBanner } from "@/components/notifications/PushEnrollBanner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Me, Notification } from "@/types";

type Mode = "all" | "unread" | "snoozed";

// Relative wake time for a snoozed row ("in 40m", "in 3h", "in 2d") - mirrors the bell dropdown.
function untilLabel(iso?: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((+new Date(iso) - Date.now()) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

// Which recency bucket a notification lands in, for the section headers below.
function bucketOf(n: Notification): string {
  const t = new Date(n.create_time ?? 0);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = startOfDay(t);
  if (day >= today) return "Today";
  if (day >= today - 86_400_000) return "Yesterday";
  if (day >= today - 6 * 86_400_000) return "Earlier this week";
  return "Older";
}
const BUCKET_ORDER = ["Today", "Yesterday", "Earlier this week", "Older"];

// Within Today/Yesterday the calendar date is the section header already, so show the clock time instead
// (which actually differentiates the rows); older rows keep the date.
const whenLabel = (n: Notification, bucket: string) =>
  bucket === "Today" || bucket === "Yesterday"
    ? new Date(n.create_time ?? 0).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : formatDate(n.create_time);

// A collapsed run of same-actor-same-category notifications (e.g. a kudos burst). Shows one summary row that
// expands to the individual items. A group of one is just a plain row.
function GroupBlock({ group, bucket }: { group: NotifGroup; bucket: string }) {
  const [open, setOpen] = useState(false);
  if (group.items.length === 1) return <NotificationRow n={group.items[0]!} when={whenLabel(group.items[0]!, bucket)} />;
  const lead = group.items[0]!;
  const anyUnread = group.items.some((n) => !n.read);
  const meta = metaForType(lead.type);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn("group relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent", anyUnread && "bg-primary/5")}
      >
        {anyUnread && <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
        <NotificationLead n={lead} />
        <span className="min-w-0 flex-1">
          <span className={cn("text-sm", anyUnread ? "font-semibold" : "font-normal")}>
            {lead.actor} · {meta.label}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{group.items.length} notifications</span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t bg-muted/20">
          {group.items.map((n) => (
            <NotificationRow key={n.path} n={n} when={whenLabel(n, bucket)} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// A snoozed row on the full page: navigating leaves it asleep (only "Wake now" resurfaces it), and the wake
// time replaces the "when" stamp. Mirrors the bell's snoozed row, full-width.
function SnoozedRow({ n }: { n: Notification }) {
  const { unsnooze } = useNotifications();
  const go = () => { if (n.link) navigate(n.link); };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }}
      className="group relative flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <NotificationLead n={n} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-normal">{n.title}</span>
            {n.actor && <span className="text-xs text-muted-foreground">{n.actor}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground"><Clock className="h-3 w-3" />{untilLabel(n.snooze_until_time)}</span>
        </span>
        {n.body && <span className="mt-0.5 block text-sm text-muted-foreground">{n.body}</span>}
        {actionLabel(n.action) && (
          <span className="mt-1.5 inline-block rounded bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{actionLabel(n.action)} →</span>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); void unsnooze(n); }}
        title="Wake now"
        aria-label="Wake now"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <BellRing className="h-4 w-4" />
      </button>
    </div>
  );
}

// The full notification history (the bell shows only the most recent): filter by read state or category,
// grouped by recency, with same-actor bursts collapsed. A Snoozed view (lazily loaded) lists sleeping rows by
// wake time. Per-row menus mark/snooze/dismiss; the header clears everything and opens self-service preferences.
export default function Notifications({ me }: { me: Me }) {
  const { notifications, unread, markAllRead, snoozed, snoozedLoaded, loadSnoozed, snoozedCount, state, reload } = useNotifications();

  const [mode, setMode] = useState<Mode>("all");
  const [cat, setCat] = useState("all");

  // Lazily fetch the snoozed set the first time the Snoozed view is opened (idempotent).
  useEffect(() => {
    if (mode === "snoozed" && !snoozedLoaded) loadSnoozed();
  }, [mode, snoozedLoaded, loadSnoozed]);

  // Categories actually present, with unread counts - drives the filter chips.
  const cats = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of notifications) {
      const c = categoryOf(n.type);
      count.set(c, (count.get(c) ?? 0) + (n.read ? 0 : 1));
    }
    return [...new Set(notifications.map((n) => categoryOf(n.type)))]
      .filter((c) => CATEGORY_META[c])
      .sort((a, b) => (CATEGORY_META[a]!.label > CATEGORY_META[b]!.label ? 1 : -1))
      .map((c) => ({ key: c, unread: count.get(c) ?? 0 }));
  }, [notifications]);

  const filtered = useMemo(
    () => notifications.filter((n) => (mode !== "unread" || !n.read) && (cat === "all" || categoryOf(n.type) === cat)),
    [notifications, mode, cat],
  );

  // Bucket by recency (sorted), then collapse same-actor bursts inside each bucket.
  const groups = useMemo(() => {
    const by = new Map<string, Notification[]>();
    for (const n of [...filtered].sort(sortNotifications)) {
      const k = bucketOf(n);
      by.set(k, [...(by.get(k) ?? []), n]);
    }
    return BUCKET_ORDER.filter((k) => by.has(k)).map((k) => ({ label: k, groups: groupNotifications(by.get(k)!) }));
  }, [filtered]);

  // Snoozed rows ordered soonest-wake first, filtered by the same category chip.
  const snoozedRows = useMemo(
    () => snoozed
      .filter((n) => cat === "all" || categoryOf(n.type) === cat)
      .sort((a, b) => +new Date(a.snooze_until_time ?? 0) - +new Date(b.snooze_until_time ?? 0)),
    [snoozed, cat],
  );

  const isSnoozed = mode === "snoozed";

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `${unread} unread. Everything that's happened on your requests, recognition, and approvals.` : "Everything that's happened on your requests, recognition, and approvals."}
        actions={
          <div className="flex items-center gap-2">
            <PageSettings me={me} host="notifications" />
            {me.employee_id && <SettingsButton me={me} settingKey="notification-prefs" />}
            {unread > 0 && (
              <AccessAction collection="notifications" verb="markAllRead" label="Mark all read">
                <Button size="sm" variant="outline" onClick={() => void markAllRead()}>
                  <CheckCheck className="h-4 w-4" /> Mark all read
                </Button>
              </AccessAction>
            )}
          </div>
        }
      />
      {/* Above the empty-state branch on purpose: someone with no notifications yet is exactly who benefits
          most from enrolling, and they would never see a prompt rendered only alongside a populated list. */}
      <PushEnrollBanner />
      {/* An empty feed and an unarrived one are different things, and this page said the first while the
          second was true - "You're all caught up" is a claim, and it was being made before anything had been
          read. The feed's own load state now decides. */}
      {state === "loading" && notifications.length === 0 ? (
        <CardsSkeleton count={5} />
      ) : state === "error" && notifications.length === 0 ? (
        // A failed feed read looked exactly like an empty one, so the page told the reader they were up to
        // date when it had not managed to ask.
        <DataState state="error" error={null} onRetry={reload}><div /></DataState>
      ) : notifications.length === 0 && !isSnoozed ? (
        <EmptyState illustration="inbox" icon={Bell} title="No notifications" description="You're all caught up. New activity will show up here." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-card p-0.5">
              <Button size="sm" variant={mode === "all" ? "secondary" : "ghost"} className="h-7" onClick={() => setMode("all")}>
                All <span className="ml-1 text-xs text-muted-foreground">{notifications.length}</span>
              </Button>
              <Button size="sm" variant={mode === "unread" ? "secondary" : "ghost"} className="h-7" onClick={() => setMode("unread")}>
                Unread <span className="ml-1 text-xs text-muted-foreground">{unread}</span>
              </Button>
              <Button size="sm" variant={mode === "snoozed" ? "secondary" : "ghost"} className="h-7" onClick={() => setMode("snoozed")}>
                Snoozed {snoozedCount > 0 && <span className="ml-1 text-xs text-muted-foreground">{snoozedCount}</span>}
              </Button>
            </div>
            {cats.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={cat === "all"} onClick={() => setCat("all")}>All types</Chip>
                {cats.map(({ key, unread: u }) => {
                  const meta = CATEGORY_META[key]!;
                  const Icon = meta.icon;
                  return (
                    <Chip key={key} active={cat === key} onClick={() => setCat(key)}>
                      <Icon className="h-3.5 w-3.5" /> {meta.label}
                      {u > 0 && <span className="rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{u}</span>}
                    </Chip>
                  );
                })}
              </div>
            )}
          </div>
          {isSnoozed ? (
            !snoozedLoaded ? (
              // A wait is not an empty state: an EmptyState here drew a dashed box, a "nothing to see"
              // illustration and a sentence, for something that was on its way.
              <CardsSkeleton count={3} />
            ) : snoozedRows.length === 0 ? (
              <EmptyState
                icon={Clock}
                title={cat === "all" ? "Nothing snoozed" : "Nothing matches this filter"}
                description={cat === "all" ? "Snoozed notifications resurface at their wake time and show up here until then." : "Try a different type, or clear the filter."}
                action={cat === "all" ? undefined : <Button size="sm" variant="outline" onClick={() => setCat("all")}>Show all types</Button>}
              />
            ) : (
              <Card>
                <CardContent className="divide-y p-0 sm:p-0">
                  {snoozedRows.map((n) => <SnoozedRow key={n.path} n={n} />)}
                </CardContent>
              </Card>
            )
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={BellOff}
              title={mode === "unread" ? "No unread notifications" : "Nothing matches this filter"}
              description={mode === "unread" ? "You've read everything. New activity will show up here." : "Try a different type, or clear the filter."}
              action={<Button size="sm" variant="outline" onClick={() => { setMode("all"); setCat("all"); }}>Show all notifications</Button>}
            />
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <div key={g.label}>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
                  <Card>
                    <CardContent className="divide-y p-0 sm:p-0">
                      {g.groups.map((grp) => (
                        <GroupBlock key={grp.key + (grp.items[0]?.path ?? "")} group={grp} bucket={g.label} />
                      ))}
                    </CardContent>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A filter pill.
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // coarse:min-h-9 - a 26px pill is a miss on touch, and these are how the list gets filtered.
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 coarse:px-3.5",
        active ? "border-primary bg-primary/10 text-primary" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
