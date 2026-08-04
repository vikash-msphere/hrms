import { useMemo, useRef, useState, useEffect } from "react";
import { Megaphone, Plus, Pencil, Trash2, MessageCircle, SmilePlus, Eye, ChevronDown, Trophy, Award, BarChart3, MessageSquare, Send, CalendarClock, Pin, PinOff, Link2, X, CheckCheck } from "lucide-react";
import { patch, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { useKudosLevels, useKudosCategories } from "@/lib/kudosLevels";
import { cn, colorFromString, formatDate, idOf, relativeFuture } from "@/lib/utils";
import type { Announcement, Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { KudosCardBody } from "@/components/common/KudosCardBody";
import { PostCardBody } from "@/components/common/PostCardBody";
import { PollBlock } from "@/components/common/PollBlock";
import { RichText } from "@/lib/richText";
import { PostComposer, type Kind } from "@/components/common/PostComposer";
import { FEED_WIDTH, kudosTier } from "@/lib/boardCard";
import { kudosCardArtUrl } from "@/lib/kudosArt";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { useMentions } from "@/components/common/MentionPicker";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { EmojiPicker } from "@/components/common/EmojiPicker";

const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthName = () => new Date().toLocaleString(undefined, { month: "long" });

// A body long enough that its card would swallow the feed - drawn collapsed with a "Read more" fade instead.
// Announcements and posts only: kudos are short by nature, and a clamped poll could hide its own options.
const LONG_BODY_CHARS = 700;

// Exact date + time, for the hover tooltip.
const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

// Compact relative time ("just now", "5m ago", "3h ago", "2d ago", "3w ago"); past ~a month it falls back to
// the absolute date so old items don't read "52w ago".
function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const then = +new Date(iso);
  if (isNaN(then)) return "";
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.round(day / 7)}w ago`;
  return formatDate(iso);
}
// relativeFuture (the mirror of relativeTime, "in 20m" / "on 4 Aug") comes from lib/utils - PollBlock
// shares it for poll deadlines.

// Which stretch of the feed a post belongs to - drawn as a divider when it changes while mapping. Pinned
// posts sort first (see `feed`), so they always form the leading group.
function sectionOf(a: Announcement): string {
  if (a.pin_time) return "Pinned";
  const t = +new Date(a.publish_time ?? a.create_time ?? 0);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 7 * 864e5) return "This week";
  if (t >= startOfToday - 30 * 864e5) return "This month";
  return "Earlier";
}

// An edit bumps update_time well past create_time; reactions/replies/reads do not touch it. Returns the edit
// time when the post was edited after creation, else null.
function editedAt(a: Announcement): string | null {
  if (!a.update_time || !a.create_time) return null;
  return +new Date(a.update_time) - +new Date(a.create_time) > 1000 ? a.update_time : null;
}

// A post is "new" on the board when the API reports no read receipt for the caller; when read tracking is
// absent (no markRead grant) the marker falls back to 24h board recency so fresh posts still glow.
const postedRecently = (a: Announcement) => {
  const posted = a.publish_time ?? a.create_time;
  return !!posted && Date.now() - +new Date(posted) < 24 * 60 * 60 * 1000;
};
// A post counts as read once it has stayed on screen this long - reading the feed clears its "New" dot.
const READ_DWELL_MS = 2500;

// Written but not sent: a draft, or a post scheduled for later. Only people who can post ever receive one from
// the server, so this is a presentation split, not an access decision.
const isDraft = (a: Announcement) => a.published === false;

// What each kind is called and what it looks like, wherever the page offers to start one (the header button,
// its menu, the starter row). The composer names them the same way.
const KIND_LABELS: Record<Kind, string> = { announcement: "Announcement", post: "Post", poll: "Poll", kudos: "Kudos" };
const KIND_ICONS: Record<Kind, typeof Megaphone> = { announcement: Megaphone, post: MessageSquare, poll: BarChart3, kudos: Award };

export default function Announcements({ me, openId }: { me: Me; openId?: string }) {
  const { rows, setRows, state, error, reload, hasMore, loadMore } = useCollection<Announcement>("announcements");
  // A deep link (`#/announcements/<id>` - a copied card link, a search hit, the activity feed) shows the
  // post: switch to the list it lives in, scroll, highlight. Editing stays behind the pencil.
  useDeepOpen(openId, rows, openView);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const sd = useSoftDelete("announcements", "post", reload);
  const canAnnounce = usePermission("announcements.write"); // HR/admin: post official announcements, moderate
  const canPost = usePermission("announcements.post"); // anyone granted the board-post gate
  const canGiveKudos = usePermission("announcements.giveKudos"); // give peer recognition (kind="kudos")
  const canMarkAllRead = usePermission("announcements.markAllRead"); // clear own unread state in one call
  const canCompose = canAnnounce || canPost || canGiveKudos;
  const levels = useKudosLevels();
  const kudosCategories = useKudosCategories();
  const myEmp = me.employee_id ? `employees/${me.employee_id}` : "";

  // The composer (PostComposer) owns its own form; the page only says whether it is open and on what.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [composeKind, setComposeKind] = useState<Kind>("announcement");
  // One post unfolded at a time (accordion); reply drafts keyed by post path so a draft survives folding.
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  // Posts whose read receipt this session recorded (by dwell or by unfolding). Held locally so the "New" dot
  // fades out at once without refetching the board, and so a receipt that the server already has still reads
  // as read here after a fade.
  const [readHere, setReadHere] = useState<Set<string>>(() => new Set());
  // A draft is nobody's unread: it hasn't been announced to anyone, and its author reading their own staging
  // copy is not a read receipt worth recording.
  const isUnread = (a: Announcement) => !isDraft(a) && (a.read === undefined ? postedRecently(a) : a.read === false) && !readHere.has(a.path);

  // The card dates are relative ("3m ago"), computed at render - re-render once a minute so a tab left
  // open doesn't sit on stale times.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Every board verb hands back the post it just changed, fully reserialized (reactions, replies, tallies,
  // reads). Folding that row in is exact and costs nothing - which is why those verbs are mapped to "invalidate
  // nothing" in resourceStore: no board refetch per reaction, reply, vote or scroll-past.
  const fold = (updated: Announcement) => setRows((prev) => prev.map((r) => (r.path === updated.path ? { ...r, ...updated } : r)));

  // Record the caller's read receipt for a post: clear the dot locally, then fire the (idempotent) server call
  // and fold its reserialized row back in (keeps the read-by count honest without refetching the board). A
  // missing markRead grant - or any failure - restores the dot rather than lying about the receipt.
  function markRead(path: string) {
    setReadHere((s) => (s.has(path) ? s : new Set(s).add(path)));
    invoke<Announcement>("announcements/" + idOf(path), "markRead")
      .then(fold)
      .catch(() =>
        setReadHere((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        })
      );
  }

  // Fold / unfold a post in place (opening one folds any other). Expanding it the first time records the
  // caller's read receipt (clears the unread mark); a missing markRead grant just leaves it unread (non-fatal).
  function toggleExpand(a: Announcement) {
    setExpandedPath((cur) => {
      if (cur === a.path) return null;
      if (a.read === false) markRead(a.path);
      return a.path;
    });
  }

  // Toggle the caller's reaction on a post, or on one of its replies when `replyId` is given (add if absent,
  // remove if present; one reaction per viewer per target).
  async function toggleReact(a: Announcement, emoji: string, replyId?: string) {
    try {
      fold(await invoke<Announcement>("announcements/" + idOf(a.path), "react", undefined, replyId ? { emoji, reply: replyId } : { emoji }));
    } catch (e) {
      toast({ title: "Couldn't react", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Cast / change / clear the caller's vote on a poll option (single-choice replaces; multi-choice toggles).
  async function castVote(a: Announcement, option: string) {
    try {
      fold(await invoke<Announcement>("announcements/" + idOf(a.path), "vote", undefined, { option }));
    } catch (e) {
      toast({ title: "Couldn't vote", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Close a poll early (deadline -> now) or reopen it (deadline cleared). Uses the normal update gate.
  async function setPollClosed(a: Announcement, close: boolean) {
    try {
      fold(await patch<Announcement>("announcements/" + idOf(a.path), { closes_time: close ? new Date().toISOString() : null }, a.etag));
    } catch (e) {
      toast({ title: "Couldn't update poll", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Pin the post to the top of the board / take it down (moderation - the :pin/:unpin verb grants). The
  // response is the reserialized row; folding it in re-sorts the feed locally.
  async function togglePin(a: Announcement) {
    try {
      fold(await invoke<Announcement>("announcements/" + idOf(a.path), a.pin_time ? "unpin" : "pin"));
    } catch (e) {
      toast({ title: "Couldn't pin", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Clear the whole board's unread state. A collection verb, so it is addressed by the collection alone;
  // it stamps receipts server-side and hands back a count, and its side-effect entry refetches the board.
  const [markingAll, setMarkingAll] = useState(false);
  async function markAllRead() {
    setMarkingAll(true);
    try {
      const { marked } = await invoke<{ marked: number }>("announcements", "markAllRead");
      setReadHere(new Set(feed.map((a) => a.path))); // fade the dots now; the refetch confirms it
      toast({ title: marked ? `Marked ${marked} ${marked === 1 ? "post" : "posts"} read` : "Nothing left unread" });
    } catch (e) {
      toast({ title: "Couldn't mark all read", description: (e as Error).message, variant: "destructive" });
    } finally {
      setMarkingAll(false);
    }
  }

  // Send a draft out: the publish verb is what notifies everyone, so this is the one moment the post becomes
  // real for the rest of the company.
  async function publishDraft(a: Announcement) {
    try {
      const updated = await invoke<Announcement>("announcements/" + idOf(a.path), "publish", a.etag);
      fold(updated);
      setFilter("all");
      setTargetPath(updated.path); // it just moved lists - say where it went
      toast({ title: "Published", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't publish", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function submitReply(a: Announcement) {
    const text = (replyDrafts[a.path] ?? "").trim();
    if (!text) return;
    try {
      const updated = await invoke<Announcement>("announcements/" + idOf(a.path), "reply", undefined, { body: text });
      setReplyDrafts((d) => ({ ...d, [a.path]: "" }));
      fold(updated);
    } catch (e) {
      toast({ title: "Couldn't reply", description: (e as Error).message, variant: "destructive" });
    }
  }

  const empByPath = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const empName = useMemo(() => {
    return (ref?: string) => { const e = ref ? empByPath.get(idOf(ref)) : undefined; return e ? `${e.first_name} ${e.last_name}` : "Someone"; };
  }, [empByPath]);
  const deptByPath = useMemo(() => new Map(departments.map((d) => [idOf(d.path), d])), [departments]);
  const deptName = useMemo(() => {
    return (ref?: string) => { const d = ref ? deptByPath.get(idOf(ref)) : undefined; return d?.display_name ?? "A team"; };
  }, [deptByPath]);

  // One unified board feed - announcements / posts / polls / kudos are all announcement rows now, newest first.
  // Drafts are held back: the board is what is LIVE, and a post nobody else can see doesn't belong between two
  // that everybody can. They get their own list (see `drafts`), which only the people who can post ever see -
  // the server doesn't send unpublished rows to anyone else.
  const feed = useMemo(() => {
    const ts = (a: Announcement) => +new Date(a.publish_time ?? a.create_time ?? 0);
    // Pinned posts lead (most recently pinned first), the rest keep their newest-first order.
    const pin = (a: Announcement) => (a.pin_time ? +new Date(a.pin_time) : 0);
    return rows.filter((a) => !isDraft(a)).sort((x, y) => pin(y) - pin(x) || ts(y) - ts(x));
  }, [rows]);
  // Not-yet-published posts, soonest-scheduled first and undated ones last: a staging list reads by when things
  // are due to go out, not by when they were written.
  const drafts = useMemo(() => {
    const due = (a: Announcement) => (a.publish_time ? +new Date(a.publish_time) : Infinity);
    return rows.filter(isDraft).sort((x, y) => due(x) - due(y) || +new Date(y.create_time ?? 0) - +new Date(x.create_time ?? 0));
  }, [rows]);

  // Feed filter: by kind, plus "Unread" (receipt-backed only - posts without read tracking never count) and
  // "Drafts" (only ever non-empty for someone who can post).
  const [filter, setFilter] = useState<"all" | "unread" | "drafts" | Kind>("all");
  // Clicking an author (their avatar or name) narrows any list to their posts - a transient extra filter
  // with its own clear-chip, stacked on top of the kind chips rather than replacing them.
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const kindOf = (a: Announcement): Kind => (a.kind as Kind) ?? "announcement";
  const unreadCount = useMemo(() => feed.filter((a) => a.read === false && !readHere.has(a.path)).length, [feed, readHere]);
  const kindCounts = useMemo(() => {
    const c: Record<Kind, number> = { announcement: 0, post: 0, poll: 0, kudos: 0 };
    for (const a of feed) c[kindOf(a)]++;
    return c;
  }, [feed]);
  const visibleFeed = useMemo(() => {
    const byAuthor = (list: Announcement[]) => (authorFilter ? list.filter((a) => a.author === authorFilter) : list);
    if (filter === "all") return byAuthor(feed);
    if (filter === "drafts") return byAuthor(drafts);
    // Posts read here stay in the Unread list (they'd otherwise vanish under the reader mid-scroll); their dot
    // fades instead, and the next visit drops them.
    if (filter === "unread") return byAuthor(feed.filter((a) => a.read === false || readHere.has(a.path)));
    return byAuthor(feed.filter((a) => kindOf(a) === filter));
  }, [feed, drafts, filter, readHere, authorFilter]);

  // Dwell-based read receipts: an unread card that stays mostly on screen for READ_DWELL_MS counts as read, so
  // scrolling the board clears its "New" dot the way reading it does - no need to unfold every post. Scrolling
  // past quickly cancels the timer, so a card that only flashed by stays unread. Keyed by the unread paths so
  // the observer is rebuilt only when that set changes.
  const unreadKey = visibleFeed.filter(isUnread).map((a) => a.path).join(",");
  useEffect(() => {
    if (!unreadKey) return;
    const tracked = new Map(visibleFeed.map((a) => [a.path, a.read !== undefined]));
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const path = (e.target as HTMLElement).dataset.postPath;
          if (!path) continue;
          // Mostly on screen, or - for a card taller than the viewport - filling half of it.
          const inView = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= window.innerHeight * 0.5);
          if (inView) {
            if (timers.has(path)) continue;
            timers.set(path, setTimeout(() => {
              timers.delete(path);
              // No read tracking for this viewer (no markRead grant): fade the dot locally, skip the call.
              if (tracked.get(path)) markRead(path);
              else setReadHere((s) => (s.has(path) ? s : new Set(s).add(path)));
            }, READ_DWELL_MS));
          } else {
            const t = timers.get(path);
            if (t) {
              clearTimeout(t);
              timers.delete(path);
            }
          }
        }
      },
      { threshold: [0, 0.5] }
    );
    for (const el of document.querySelectorAll<HTMLElement>("[data-post-path]")) io.observe(el);
    return () => {
      io.disconnect();
      for (const t of timers.values()) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey]);

  // Most-recognized people this month (top 3 by points; a kudos with no level still counts as 1).
  const leaderboard = useMemo(() => {
    const m = thisMonth();
    const by = new Map<string, number>();
    for (const a of rows) if (a.kind === "kudos" && a.recipient && (a.create_time ?? "").slice(0, 7) === m) by.set(a.recipient, (by.get(a.recipient) ?? 0) + (a.points || 1));
    return [...by.entries()].map(([e, n]) => ({ employee: e, count: n })).sort((a, b) => b.count - a.count).slice(0, 3);
  }, [rows]);

  // What a fresh composer opens on when nobody said: HR defaults to an announcement (they can switch to a post);
  // a plain poster posts; kudos-only -> kudos.
  const defaultKind: Kind = canAnnounce ? "announcement" : canPost ? "post" : "kudos";
  // Which kinds this viewer may start - the same rule the composer's own switcher uses, kept here so the menu
  // offers exactly what the dialog would.
  const composableKinds = ([
    canAnnounce && "announcement",
    (canPost || canAnnounce) && "post",
    (canPost || canAnnounce) && "poll",
    canGiveKudos && "kudos",
  ].filter(Boolean) as Kind[]);
  function openComposer(kind: Kind) {
    setEditing(null);
    setComposeKind(kind);
    setOpen(true);
  }
  const openCreate = () => openComposer(defaultKind);
  const openKudos = () => openComposer("kudos");
  // Global quick actions: "Post to the board" opens the composer; "Give kudos" opens it in kudos mode.
  useIntent("new-post", openCreate);
  useIntent("give-kudos", openKudos);
  // Deep-link from the dashboard ("open-post"): scroll to, highlight, and expand a specific post once the board
  // (and its feed) has mounted. The effect re-runs when `feed` populates, so it lands even on a cold navigation.
  const [targetPath, setTargetPath] = useState<string | null>(null);
  useIntent("open-post", (arg) => { const p = arg as string; if (p) setTargetPath(p); });
  useEffect(() => {
    if (!targetPath) return;
    const el = document.getElementById(`post-${idOf(targetPath)}`);
    if (!el) return; // not rendered yet - the effect re-runs when the visible list changes
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Expand only when there's a conversation to reveal; a reply-less post just gets the scroll + highlight.
    const row = visibleFeed.find((a) => a.path === targetPath);
    if (row && (row.reply_count ?? 0) > 0) setExpandedPath(targetPath);
    const t = setTimeout(() => setTargetPath(null), 2500);
    return () => clearTimeout(t);
  }, [targetPath, visibleFeed]);
  function openEdit(a: Announcement) {
    setEditing(a);
    setComposeKind((a.kind ?? "announcement") as Kind);
    setOpen(true);
  }
  // Show a post: switch to the list it lives in (a deep-linked draft sits in Drafts), then scroll + flash.
  function openView(a: Announcement) {
    setFilter(isDraft(a) ? "drafts" : "all");
    setAuthorFilter(null);
    setTargetPath(a.path);
  }
  // A card's shareable address - the same `#/announcements/<id>` deep link search results and the activity
  // feed use, so the recipient lands on the post scrolled-to and highlighted.
  function copyLink(a: Announcement) {
    const url = `${location.origin}${location.pathname}${location.search}#/announcements/${idOf(a.path)}`;
    navigator.clipboard.writeText(url).then(
      () => toast({ title: "Link copied" }),
      () => toast({ title: "Couldn't copy link", variant: "destructive" }),
    );
  }
  // Back from the composer. The write already refreshed the board (api.ts invalidates the collection), so this
  // only has to say where the thing went: switch to the list it landed in, then scroll to it and flash it -
  // otherwise a post saved as a draft looks like a post that vanished.
  function onComposed(saved?: Announcement) {
    if (!saved) return;
    setFilter(isDraft(saved) ? "drafts" : "all");
    setTargetPath(saved.path);
  }

  // The board makes four different things, and picking which one is the composer's first question - so the
  // button answers it up front for anyone who already knows. The main half is the default kind; the caret names
  // all of them. One button when there is only one kind to make.
  const newBtn = canCompose && (
    <AccessAction collection="announcements" verb="post" label="Post to the board">
      {composableKinds.length > 1 ? (
        <div className="flex">
          <Button onClick={openCreate} className="rounded-r-none"><Plus className="h-4 w-4" /> {KIND_LABELS[defaultKind]}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="rounded-l-none border-l border-primary-foreground/25 px-2" aria-label="Choose what to post">
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {composableKinds.map((k) => {
                const Icon = KIND_ICONS[k];
                return (
                  <DropdownMenuItem key={k} onClick={() => openComposer(k)}>
                    <Icon className="h-4 w-4" /> {KIND_LABELS[k]}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <Button onClick={openCreate}><Plus className="h-4 w-4" /> {KIND_LABELS[defaultKind]}</Button>
      )}
    </AccessAction>
  );

  // The one-line way in, at the top of the feed where the writing goes. It opens the same composer - the box is
  // a door, not a second editor: two places to type the same post is how the two drift apart.
  const starter = canCompose && (
    <Card className="flex items-center gap-3 p-3">
      {me.employee_id ? (
        <PhotoAvatar employeeId={me.employee_id} name={empName(myEmp)} photo={empByPath.get(me.employee_id)?.photo} className="h-9 w-9" />
      ) : (
        <InitialBubble name={empName(myEmp)} className="h-9 w-9" />
      )}
      <button
        type="button"
        onClick={openCreate}
        className="min-w-0 flex-1 truncate rounded-full border bg-muted/40 px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        Share something with the team…
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {composableKinds.filter((k) => k !== defaultKind).map((k) => {
          const Icon = KIND_ICONS[k];
          return (
            <Tooltip key={k}>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground" onClick={() => openComposer(k)}>
                  <Icon className="h-4 w-4" />
                  <span className="hidden text-xs sm:inline">{KIND_LABELS[k]}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{KIND_LABELS[k]}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </Card>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div>
      <PageHeader
        title="Feed"
        description="Company news, posts, polls and peer recognition."
        actions={<>{newBtn}<PageSettings me={me} host="announcements" /></>}
      />

      {leaderboard.length > 0 && (
        <Card className="mb-4 p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <p className="flex items-center gap-1.5 text-sm font-medium"><Trophy className="h-4 w-4 text-amber-500" /> Most recognized in {monthName()}</p>
            <button type="button" onClick={() => { setFilter("kudos"); setAuthorFilter(null); }} className="ml-auto text-xs font-medium text-primary hover:underline">
              View all kudos
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {leaderboard.map((l, i) => { const e = l.employee ? empByPath.get(idOf(l.employee)) : undefined; return (
              <span key={l.employee} className="inline-flex items-center gap-2 rounded-full border bg-muted/40 py-1 pl-1 pr-3 text-sm">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? "bg-amber-400 text-amber-950 dark:bg-amber-500" : i === 1 ? "bg-zinc-300 text-zinc-700 dark:bg-zinc-400 dark:text-zinc-900" : "bg-orange-300 text-orange-900 dark:bg-orange-400 dark:text-orange-950"}`}>{i + 1}</span>
                <PhotoAvatar employeeId={l.employee ? idOf(l.employee) : ""} name={empName(l.employee)} photo={e?.photo} className="h-5 w-5" />
                {empName(l.employee)} <Badge variant="secondary" className="tabular-nums">{l.count}</Badge>
              </span>
            ); })}
          </div>
        </Card>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {feed.length === 0 && drafts.length === 0 ? (
          <EmptyState icon={Megaphone} title="Nothing on the feed yet" description="Share company news, updates and shout-outs here." action={newBtn} />
        ) : (
          <div className="mx-auto space-y-5" style={{ maxWidth: FEED_WIDTH }}>
            {starter}
            {/* The filter chips ride along under the top bar (h-14) so switching lists never needs a
                scroll back to the top of a long feed. */}
            <div className="sticky top-14 z-20 -mx-1 -my-2 flex flex-wrap items-center gap-1.5 bg-background/95 px-1 py-2 backdrop-blur">
              {([
                ["all", "All", feed.length],
                ...(unreadCount > 0 ? [["unread", "Unread", unreadCount] as const] : []),
                ...(drafts.length > 0 ? [["drafts", "Drafts", drafts.length] as const] : []),
                ["announcement", "Announcements", kindCounts.announcement],
                ["post", "Posts", kindCounts.post],
                ["poll", "Polls", kindCounts.poll],
                ["kudos", "Kudos", kindCounts.kudos],
              ] as const)
                .filter(([k, , n]) => k === "all" || n > 0)
                .map(([k, label, n]) => (
                  <button
                    key={k}
                    onClick={() => setFilter(k as typeof filter)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      filter === k ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted dark:hover:bg-muted"
                    }`}
                  >
                    {label} <span className="tabular-nums opacity-70">{n}</span>
                  </button>
                ))}
              {authorFilter && (
                <button
                  onClick={() => setAuthorFilter(null)}
                  className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
                  title="Clear the author filter"
                >
                  by {empName(authorFilter)} <X className="h-3 w-3" />
                </button>
              )}
              {/* Catching up post by post is the slow way through a backlog - one call clears the lot. Shown
                  only while something IS unread, next to the chip that counts it. */}
              {unreadCount > 0 && canMarkAllRead && (
                <div className="ml-auto">
                  <AccessAction collection="announcements" verb="markAllRead" label="Mark the whole board read">
                    <button
                      onClick={markAllRead}
                      disabled={markingAll}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-60"
                    >
                      <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                    </button>
                  </AccessAction>
                </div>
              )}
            </div>
            {visibleFeed.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {filter === "drafts" ? "No drafts. Anything you save for later lands here." : "Nothing matches this filter."}
              </p>
            )}
            {visibleFeed.map((a, idx) => {
              // Time separators ("Pinned / Today / This week / ..."): drawn where the section changes while
              // mapping. Not in Drafts - that list is ordered by when things go OUT, not when they landed.
              const section = filter === "drafts" ? null : sectionOf(a);
              const prevSection = section !== null && idx > 0 ? sectionOf(visibleFeed[idx - 1]!) : null;
              const divider = section !== null && section !== prevSection ? (
                <div className="flex items-center gap-3 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {section === "Pinned" && <Pin className="h-3 w-3" aria-hidden />}
                  {section}
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </div>
              ) : null;
              const isAnn = (a.kind ?? "announcement") === "announcement";
              const isKudos = (a.kind ?? "") === "kudos";
              const draft = isDraft(a);
              const can = a.access?.can ?? [];
              const isOpen = expandedPath === a.path;
              const isTarget = a.path === targetPath; // deep-linked from the dashboard - flash a highlight ring
              const replies = a.replies ?? [];
              // Kudos accent: level -> tier (index into configured levels, clamped); recipient may be a person or a whole team.
              const kt = kudosTier(levels, a.level);
              const recipName = a.recipient ? empName(a.recipient) : a.recipient_department ? deptName(a.recipient_department) : "";
              const recipEmp = a.recipient ? empByPath.get(idOf(a.recipient)) : undefined;
              // Card art: whatever the author picked, on every kind alike - no art means no art. (A kudos gets one
              // suggested from its category when it is written, but that is a real stored pick the giver can remove,
              // not a silent fallback here.) A path naming no file just fails the <img> load and hides itself
              // (onError), so the card degrades cleanly.
              const art = a.illustration ? kudosCardArtUrl(a.illustration) : "";
              // "New" marker: unread until the caller reads the post - a few seconds on screen (or unfolding it)
              // records the receipt, and the dot fades out in place. `wasNew` keeps it mounted through the fade.
              // Independent of the personal bell.
              const isNew = isUnread(a);
              const wasNew = isNew || readHere.has(a.path);
              const newDot = wasNew ? (
                <span
                  className={cn("inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500 transition-all duration-700 dark:bg-blue-400", !isNew && "w-0 opacity-0")}
                  aria-hidden={!isNew}
                  aria-label="New"
                  title={a.read === false ? "New · you haven't opened this yet" : "New"}
                />
              ) : null;
              // A draft says so on the card itself, and says when it is due if it is going out on its own. The
              // "New" dot is meaningless here (nobody has been shown it yet), so the badge takes that slot.
              const scheduledFor = draft && a.publish_time && +new Date(a.publish_time) > Date.now() ? a.publish_time : null;
              const pinned = !draft && !!a.pin_time;
              const headerMark = draft ? (
                <Badge variant="secondary" className="gap-1 font-normal">
                  {scheduledFor ? <><CalendarClock className="h-3 w-3" /> Scheduled</> : "Draft"}
                </Badge>
              ) : (
                <>
                  {pinned && (
                    <Badge variant="secondary" className="gap-1 font-normal text-primary">
                      <Pin className="h-3 w-3" /> Pinned
                    </Badge>
                  )}
                  {newDot}
                </>
              );
              const authorName = empName(a.author);
              const authorEmp = a.author ? empByPath.get(idOf(a.author)) : undefined;
              // Long announcements/posts start folded to a fixed height with a "Read more" fade; opening the
              // card (the same click that reveals replies) shows the rest. Kudos are short by design, and a
              // clamped poll could hide its own options - both stay full-height.
              const clamped = !isKudos && a.kind !== "poll" && !isOpen && (a.body_text ?? a.body ?? "").length > LONG_BODY_CHARS;
              const card = (
                <div id={`post-${idOf(a.path)}`} data-post-path={isNew ? a.path : undefined} className="scroll-mt-24 flex gap-3">
                  <PostAuthor kind={a.kind} name={authorName} employee={authorEmp} onSelect={a.author ? () => setAuthorFilter(a.author!) : undefined} />
                  {/* A draft is drawn as one: dashed edge, no accent tint. It has to read as "not out there yet"
                      from across the list, not only from the badge in its header. */}
                  <Card onClick={() => toggleExpand(a)} className={cn("relative min-w-0 flex-1 cursor-pointer overflow-hidden p-5 transition-shadow hover:shadow-md", isAnn && !draft && "border-primary/30 bg-primary/[0.025]", isKudos && kt.card, draft && "border-dashed bg-muted/20", isTarget && "ring-2 ring-primary ring-offset-2")}>
                    {/* Actions float in the top-right corner so the body (and the kudos recipient hero) can span the
                        full card width. They sit above the body's own layer (z-10), or the text would cover all but
                        the top few pixels of these buttons and swallow the clicks. */}
                    <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {draft && can.includes("publish") && (
                          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => publishDraft(a)}>
                            <Send className="h-3 w-3" /> Publish
                          </Button>
                        )}
                        {!draft && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copyLink(a)} aria-label="Copy link" title="Copy link to this post">
                            <Link2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {!draft && can.includes(pinned ? "unpin" : "pin") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => togglePin(a)} aria-label={pinned ? "Unpin" : "Pin"} title={pinned ? "Unpin from the top" : "Pin to the top of the board"}>
                            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {can.includes("update") && (
                          <AccessAction collection="announcements" objectPath={a.path} can={can} label={a.title}>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(a)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                          </AccessAction>
                        )}
                        {can.includes("delete") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => sd.softDelete(a)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                        )}
                      </div>
                      <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden />
                    </div>
                    {/* On a phone the author rail beside the card is hidden (it would cost a fifth of the
                        width) - the author moves into the card's own header instead. */}
                    <div className="mb-2 flex items-center gap-2 pr-14 sm:hidden">
                      {isAnn ? (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden>
                          <Megaphone className="h-3.5 w-3.5" />
                        </span>
                      ) : authorEmp ? (
                        <PhotoAvatar employeeId={idOf(authorEmp.path)} name={authorName} photo={authorEmp.photo} className="h-6 w-6" />
                      ) : (
                        <InitialBubble name={authorName} className="h-6 w-6 text-[10px]" />
                      )}
                      {a.author ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setAuthorFilter(a.author!); }}
                          className="truncate text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          {authorName}
                        </button>
                      ) : (
                        <span className="truncate text-xs font-medium text-muted-foreground">{authorName}</span>
                      )}
                    </div>
                    {isKudos ? (
                      // Same component the composer previews with, so what a giver is shown before posting is what
                      // lands on the wall. The header is right-padded here to clear this card's corner actions.
                      <KudosCardBody
                        recipientName={recipName}
                        recipientId={a.recipient ? idOf(a.recipient) : ""}
                        recipientPhoto={recipEmp?.photo}
                        recipientFirstName={recipEmp?.first_name}
                        recipientLastName={recipEmp?.last_name}
                        message={a.body ?? ""}
                        artUrl={art}
                        stickerLayout={a.illustration_layout}
                        recipientLayout={a.recipient_layout}
                        iconClassName={kt.icon}
                        bodyValign={a.body_valign}
                        headerExtra={headerMark}
                        headerClassName="pr-14"
                      />
                    ) : (
                      <div className={cn(clamped && "relative max-h-80 overflow-hidden")}>
                        <PostCardBody
                          title={a.title}
                          titleAlign={a.title_align}
                          body={a.body}
                          artUrl={art}
                          stickerLayout={a.illustration_layout}
                          bodyValign={a.body_valign}
                          headerExtra={headerMark}
                          headerClassName="pr-14"
                          // A poll's question and options are short enough to share their line with a picture.
                          wrapAll={a.kind === "poll"}
                          below={a.poll && <PollBlock poll={a.poll} canVote={can.includes("vote")} canManage={can.includes("update")} onVote={(opt) => castVote(a, opt)} onSetClosed={(close) => setPollClosed(a, close)} />}
                        />
                        {clamped && (
                          <div className="absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-gradient-to-t from-card via-card/80 to-transparent pb-1">
                            <span className="text-xs font-medium text-primary">Read more</span>
                          </div>
                        )}
                      </div>
                    )}
                  {/* Reactions + counts group on the left; the date anchors right. */}
                  <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                    <ReactionBar reactions={a.reactions} canReact={can.includes("react")} onToggle={(emoji) => toggleReact(a, emoji)} nameOf={empName} />
                    {/* Reply-less posts invite the first reply by name instead of a bare zero (when the viewer may reply). */}
                    <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> {a.reply_count || (can.includes("reply") ? "Reply" : 0)}</span>
                    {a.read_count !== undefined && <ReadIndicator count={a.read_count} names={(a.read_by ?? []).map((r) => empName(r))} />}
                    {/* A draft's own date is meaningless to the reader it hasn't reached; what matters is when
                        (or whether) it is due to go out. */}
                    <span className="ml-auto">
                      {draft ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex items-center gap-1">
                              <CalendarClock className="h-3.5 w-3.5" />
                              {scheduledFor ? `Goes out ${relativeFuture(scheduledFor)}` : "Not scheduled"}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {scheduledFor ? `Publishes ${dateTime(scheduledFor)}` : "Publish it by hand, or set a time when you edit it."}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <PostDate display={a.publish_time ?? a.create_time} created={a.create_time} edited={editedAt(a)} />
                      )}
                    </span>
                  </div>

                  {isOpen && (
                    <div className="-mx-5 -mb-5 mt-4 border-t bg-muted/60 px-5 py-4">
                      <div>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {a.reply_count ? `${a.reply_count} ${a.reply_count === 1 ? "reply" : "replies"}` : "Replies"}
                        </p>
                        {replies.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No replies yet. Start the conversation.</p>
                        ) : (
                          <div className="space-y-4">
                            {replies.map((rep, i) => {
                              const nm = rep.author ? empName(rep.author) : rep.author_email ?? "Someone";
                              const re = rep.author ? empByPath.get(idOf(rep.author)) : undefined;
                              return (
                                <div key={rep.id ?? i} className="flex gap-3">
                                  {re ? (
                                    <PhotoAvatar employeeId={idOf(re.path)} name={nm} photo={re.photo} className="mt-1 h-8 w-8" />
                                  ) : (
                                    <InitialBubble name={nm} className="mt-1 h-8 w-8" />
                                  )}
                                  <div className="min-w-0 flex-1 rounded-lg bg-card px-3 py-2 shadow-sm">
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-sm font-medium">{nm}</span>
                                      <RelativeTime iso={rep.create_time} className="text-xs text-muted-foreground" />
                                    </div>
                                    <RichText source={rep.body} className="mt-0.5 text-sm text-foreground/90" />
                                    <ReactionBar className="mt-1.5" reactions={rep.reactions} canReact={can.includes("react") && !!rep.id} onToggle={(emoji) => toggleReact(a, emoji, rep.id)} nameOf={empName} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {can.includes("reply") && (
                          <ReplyBox
                            value={replyDrafts[a.path] ?? ""}
                            onChange={(next) => setReplyDrafts((d) => ({ ...d, [a.path]: next }))}
                            onSubmit={() => submitReply(a)}
                            employees={employees}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  </Card>
                </div>
                );
                return (
                  <div key={a.path} className="space-y-5">
                    {divider}
                    <AccessItem collection="announcements" objectPath={a.path} can={a.access?.can} why={a.access?.why} label="Announcement" iconClassName="absolute right-2 top-10 z-20">
                      {/* One universal card for every post kind - only the body slot forks (announcement / poll / kudos). */}
                      {card}
                    </AccessItem>
                  </div>
                );
            })}
            {/* The server caps a list page; older posts exist past the cursor. Admit it and offer them,
                rather than silently ending the board at the page edge. */}
            {hasMore && filter !== "drafts" && (
              <div className="pb-2 text-center">
                <Button variant="outline" size="sm" onClick={() => loadMore()}>Load older posts</Button>
              </div>
            )}
          </div>
        )}
      </DataState>

      <PostComposer
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        initialKind={composeKind}
        employees={employees}
        departments={departments}
        levels={levels}
        kudosCategories={kudosCategories}
        canAnnounce={canAnnounce}
        canPost={canPost}
        canGiveKudos={canGiveKudos}
        myEmp={myEmp}
        onSaved={onComposed}
      />

      </div>
    </TooltipProvider>
  );
}

// Emoji reaction chips for a post plus an "add reaction" picker. Chips toggle the caller's reaction; they are
// read-only (counts only) when the caller lacks the `react` grant. One reaction per viewer, so the add button
// shows only until they react and reappears once they clear it. stopPropagation so a chip click on a feed card
// toggles the reaction instead of opening the post.
function ReactionBar({
  reactions,
  canReact,
  onToggle,
  nameOf,
  align = "start",
  className,
}: {
  reactions?: Announcement["reactions"];
  canReact: boolean;
  onToggle: (emoji: string) => void;
  nameOf: (ref: string) => string; // resolves an employee ref for the "who reacted" hover list
  align?: "start" | "end";
  className?: string;
}) {
  const items = reactions ?? [];
  const hasMine = items.some((r) => r.reacted);
  if (!items.length && !canReact) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} onClick={(e) => e.stopPropagation()}>
      {items.map((r) => {
        // The server names up to a dozen reactors; anyone past that is left to the count.
        const named = (r.reactors ?? []).map(nameOf);
        const others = r.count - named.length;
        return (
        <Tooltip key={r.emoji}>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!canReact}
              onClick={() => onToggle(r.emoji)}
              className={cn(
                "flex items-center gap-1 rounded-full px-2.5 py-1 leading-none transition-colors",
                r.reacted ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30" : "bg-muted text-foreground/80",
                canReact ? "cursor-pointer hover:bg-primary/10" : "cursor-default",
              )}
            >
              <span className="text-base">{r.emoji}</span>
              <span className="text-xs font-medium tabular-nums">{r.count}</span>
            </button>
          </TooltipTrigger>
          {!!named.length && (
            <TooltipContent className="max-w-xs">
              <div className="space-y-0.5">
                {named.map((n, i) => (
                  <div key={i}>{n}</div>
                ))}
                {others > 0 && <div className="text-background/70">and {others} {others === 1 ? "other" : "others"}</div>}
              </div>
            </TooltipContent>
          )}
        </Tooltip>
        );
      })}
      {canReact && !hasMine && (
        <EmojiPicker onPick={onToggle} align={align}>
          <button type="button" aria-label="Add reaction" className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent">
            <SmilePlus className="h-4 w-4" />
          </button>
        </EmojiPicker>
      )}
    </div>
  );
}

// The post's leading avatar. A generic post shows the author's photo (batched through the shared photo
// cache, initials as its own fallback); an announcement shows the megaphone mark instead, so the kind reads
// at a glance with no separate badge.
function PostAvatar({ kind, name, employee }: { kind?: Announcement["kind"]; name: string; employee?: Employee }) {
  if ((kind ?? "announcement") === "announcement") {
    return (
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm ring-2 ring-background" aria-label="Announcement">
        <Megaphone className="h-6 w-6" />
      </span>
    );
  }
  if (employee) return <PhotoAvatar employeeId={idOf(employee.path)} name={name} photo={employee.photo} className="h-12 w-12 shrink-0 shadow-sm ring-2 ring-background" />;
  return <InitialBubble name={name} className="h-12 w-12 text-base" />;
}

// The author column beside a post: the avatar with the first name below it, and the full name on hover.
// Hidden on a phone (the card shows the author inline there instead - see the feed). With `onSelect` the
// whole column is a button that filters the feed to this author's posts.
function PostAuthor({ kind, name, employee, onSelect }: { kind?: Announcement["kind"]; name: string; employee?: Employee; onSelect?: () => void }) {
  const first = name.split(/\s+/)[0] || name;
  const isAnn = (kind ?? "announcement") === "announcement";
  return (
    <div className="hidden w-14 shrink-0 flex-col items-center text-center sm:flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            disabled={!onSelect}
            className={cn("flex max-w-full flex-col items-center gap-1.5", onSelect ? "cursor-pointer" : "cursor-default")}
            aria-label={onSelect ? `Show posts by ${name}` : name}
          >
            <PostAvatar kind={kind} name={name} employee={employee} />
            <span className="max-w-full truncate text-xs font-medium leading-tight text-muted-foreground/80">{first}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="text-center">
          {isAnn ? (
            <>
              <div className="font-semibold">Announcement</div>
              <div className="text-background/70">by {name}</div>
            </>
          ) : (
            name
          )}
          {onSelect && <div className="text-background/70">Click for their posts</div>}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Post date: short date inline (with an "edited" hint when applicable); exact posted/edited times on hover.
function PostDate({ display, created, edited }: { display?: string | null; created?: string | null; edited?: string | null }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums">
          {relativeTime(display)}
          {edited ? " · edited" : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div>Posted {dateTime(created ?? display)}</div>
        {edited && <div>Edited {dateTime(edited)}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

// A timestamp shown as compact relative time, with the exact date + time on hover.
function RelativeTime({ iso, className }: { iso?: string | null; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("tabular-nums", className)}>{relativeTime(iso)}</span>
      </TooltipTrigger>
      <TooltipContent>{dateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

// Read receipts as a compact eye + count (author/HR only); reader names on hover.
function ReadIndicator({ count, names }: { count: number; names: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1" aria-label={`Read by ${count}`}>
          <Eye className="h-3.5 w-3.5" /> {count}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {count === 0 ? (
          "No reads yet"
        ) : (
          <div className="space-y-0.5">
            {names.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// The reply composer under an opened post. Its own component because it owns a hook (the @mention picker),
// which a row inside the feed's map cannot.
function ReplyBox({ value, onChange, onSubmit, employees }: { value: string; onChange: (next: string) => void; onSubmit: () => void; employees: Employee[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ value, onChange, textareaRef: ref, employees });
  return (
    <div className="mt-4 flex items-end gap-2" onClick={(e) => e.stopPropagation()}>
      <div className="relative flex-1">
        <Textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => { onChange(e.target.value); mentions.sync(); }}
          placeholder="Write a reply…  (Enter to send, Shift+Enter for a new line)"
          className="max-h-40 min-h-9 resize-none bg-card py-2"
          onKeyUp={mentions.sync}
          onClick={mentions.sync}
          // The mention menu gets first refusal on Enter (it picks the highlighted person); only a keystroke
          // it did NOT take sends the reply.
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
        />
        {mentions.menu}
      </div>
      <Button size="sm" onClick={onSubmit} disabled={!value.trim()}>Reply</Button>
    </div>
  );
}

// A small circular initials avatar - the fallback where no employee record backs a name (an email-only
// reply author, a missing directory row); anyone resolvable gets their photo via PhotoAvatar instead.
function InitialBubble({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span
      style={{ backgroundColor: colorFromString(name) }}
      className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-background", className)}
    >
      {initials}
    </span>
  );
}
