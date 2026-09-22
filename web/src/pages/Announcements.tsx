import { useMemo, useRef, useState, useEffect } from "react";
import { Megaphone, Plus, Pencil, Trash2, MessageCircle, SmilePlus, Eye, EyeOff, ChevronDown, Trophy, Award, BarChart3, MessageSquare, Send, CalendarClock, Pin, PinOff, Link2, Maximize2, X, CheckCheck, Users, Mail, BellOff, Search, ArrowUp, ArrowLeft, ChevronUp, FilterX, Loader2 } from "lucide-react";
import { patch, invoke, get, ApiError } from "@/api";
import { navigate, recordUrl, pagePath } from "@/router";
import { useCollection, type LoadState } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { useKudosLevels, useKudosCategories } from "@/lib/kudosLevels";
import { cn, colorFromString, formatDate, idOf, relativeFuture } from "@/lib/utils";
import { todayStr, thisMonthStr } from "@/lib/orgDay";
import type { Announcement, Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { FilterChip } from "@/components/common/FilterChips";
import { Chart, ChartCard } from "@/components/common/Chart";
import { useChartFocus } from "@/lib/chartFocus";
import { monthlyTotals, topSlices } from "@/lib/chartTheme";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { KudosCardBody } from "@/components/common/KudosCardBody";
import { PostCardBody } from "@/components/common/PostCardBody";
import { PollBlock } from "@/components/common/PollBlock";
import { RichText } from "@/lib/richText";
import { PostComposer, type Kind } from "@/components/common/PostComposer";
import { FEED_WIDTH, kudosTier } from "@/lib/boardCard";
import { boardTime, byBoardOrder } from "@/lib/boardOrder";
import { kudosCardArtUrl } from "@/lib/kudosArt";
import { readLocalJson, writeLocalJson, userKey } from "@/lib/localPref";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { useMentions } from "@/components/common/MentionPicker";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { AccessItem } from "@/components/access/AccessItem";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { EmojiPicker } from "@/components/common/EmojiPicker";

const thisMonth = () => thisMonthStr();
const monthName = () => new Date().toLocaleString(undefined, { month: "long" });

// How many posts the board reads at a time. The feed grows by another page each time the reader reaches its
// foot (see useInfiniteScroll), so this is the cost of opening the page, not a cap on what can be read. Turn it
// up for fewer round trips, down for a cheaper cold open; the server caps a page at 100 either way.
const FEED_PAGE_SIZE = 20;

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
  const t = boardTime(a);
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
  const posted = boardTime(a);
  return !!posted && Date.now() - posted < 24 * 60 * 60 * 1000;
};
// A post counts as read once it has stayed on screen this long - reading the feed clears its "New" dot.
const READ_DWELL_MS = 2500;

// Written but not sent: a draft, or a post scheduled for later. Only people who can post ever receive one from
// the server, so this is a presentation split, not an access decision.
//
// A WITHDRAWN POST IS NOT A DRAFT, whoever withdrew it. `disabled` is the column both the `:unpublish`/hide
// path and a moderator's decision write, and a post carrying it has been taken DOWN - which is a different
// thing from one its author has not finished. Read as a draft it turned up on the Drafts strip looking like
// unfinished work, so a post that moderation had deliberately hidden sat in the same list as tomorrow's
// announcement, inviting somebody to publish it back. Withdrawn posts belong to the surface that withdrew
// them: the moderation queue's "Already decided" view, where the decision and the way back are.
const isDraft = (a: Announcement) => a.published === false && a.disabled !== true;

/** Taken down rather than unfinished: off the board entirely, in either list. */
const isWithdrawn = (a: Announcement) => a.disabled === true;

// What each kind is called and what it looks like, wherever the page offers to start one (the header button,
// its menu, the starter row). The composer names them the same way.
const KIND_LABELS: Record<Kind, string> = { announcement: "Announcement", post: "Post", poll: "Poll", kudos: "Kudos" };
const KIND_ICONS: Record<Kind, typeof Megaphone> = { announcement: Megaphone, post: MessageSquare, poll: BarChart3, kudos: Award };

// How many replies an opened post shows before it starts folding the older ones away. A long thread would
// otherwise push the next post off the screen entirely - the newest few are the live conversation.
const REPLY_PEEK = 3;
// Which kind chip the reader last picked, and whose posts they narrowed to, kept per browser so the view they
// curated survives navigating away. Deliberately only the *stable* selections: "Unread" and "Drafts" empty out
// as you work, and coming back to an empty list you did not ask for reads as a broken board.
// Namespaced to the caller: the saved filter can name an AUTHOR (an employee ref), so under a shared key B's
// board opened filtered to a colleague A had picked.
const FILTER_LS_KEY = () => userKey("hrms.board.filter");
type SavedBoardFilter = { kind?: Kind; author?: string };
// A post matches free text on anything the reader can see on the card: its title, its body, who wrote it, and
// (for a kudos) who it was for. The board is one flat feed, so text is the only way to find an old post by hand.
function matchesText(a: Announcement, q: string, empName: (ref?: string) => string, deptName: (ref?: string) => string): boolean {
  const hay = [
    a.title,
    a.body_text ?? a.body,
    a.author ? empName(a.author) : "",
    a.recipient ? empName(a.recipient) : "",
    a.recipient_department ? deptName(a.recipient_department) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

// Move the caller's reaction on a target (a post or one of its replies) in the local copy of the row, so the
// chip answers the tap instead of the round-trip. One reaction per viewer: reacting with a new emoji clears the
// old one, tapping the current one removes it. The server's reserialized row replaces this the moment it lands.
// Written out rather than taken from the wire type because the same shape appears twice there (once on a post,
// once on a reply) and this has to be assignable to both.
type ReactionGroup = { emoji: string; count: number; reacted: boolean; reactors?: string[] };
function applyReaction(groups: ReactionGroup[] | undefined, emoji: string, me: string): ReactionGroup[] {
  const list: ReactionGroup[] = (groups ?? []).map((g) => ({ ...g, reactors: g.reactors ? [...g.reactors] : undefined }));
  const drop = (g: ReactionGroup) => {
    g.count = Math.max(0, g.count - 1);
    g.reacted = false;
    if (g.reactors) g.reactors = g.reactors.filter((r) => idOf(r) !== idOf(me));
  };
  const mine = list.find((g) => g.reacted);
  if (mine) drop(mine);
  if (!mine || mine.emoji !== emoji) {
    const target = list.find((g) => g.emoji === emoji);
    if (target) {
      target.count += 1;
      target.reacted = true;
      if (target.reactors && me) target.reactors = [...target.reactors, me];
    } else {
      list.push({ emoji, count: 1, reacted: true, reactors: me ? [me] : undefined });
    }
  }
  return list.filter((g) => g.count > 0);
}

export default function Announcements({ me, openId, solo }: { me: Me; openId?: string; solo?: boolean }) {
  // `solo` is one post on a page of its own (`/announcements/<id>/view`). The board list is not read at all
  // there - the single row is fetched by id below - so a popped-out post costs one read, not a hundred.
  const { rows, setRows, state, error, reload, hasMore, loadMore } = useCollection<Announcement>("announcements", { enabled: !solo, max: FEED_PAGE_SIZE });
  // For the moderator's own takedown below: hiding somebody else's post is a decision, so it asks first.
  const confirm = useConfirm();
  // Free-text search. Not persisted (a search is a question you are asking now, not a view you curated). A list
  // page caps at 100 rows, so filtering the loaded rows would search a window rather than the board: from two
  // characters up the query goes to the server, which matches the FTS index over the whole collection and hands
  // back its own cached entry with its own cursor. Below that the client pass below still filters what is loaded.
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q.trim(), 250);
  const searching = debouncedQ.length >= 2;
  const srch = useCollection<Announcement>("announcements", { q: debouncedQ, enabled: searching, max: FEED_PAGE_SIZE });
  // While a search is live EVERYTHING follows the search entry: the rows, the optimistic setter (a reaction on a
  // post found by search has to patch the entry that post came from, or the tap would appear to do nothing) and
  // the cursor ("Load older posts" must page the list on screen). `state` / `error` deliberately stay with the
  // unsearched entry, so the skeleton shows on cold load only and a search refines a board already up.
  // ----- One post, on a page of its own -----
  // Solo mode is a SOURCE swap and nothing more: the card, its handlers and the optimistic folding all read and
  // write through `source`/`setSource`, so pointing those at a one-row list gives the whole post - replies,
  // reactions, poll, read receipts - on a page with no board behind it. Fetched by id rather than picked out of
  // the board, because a post older than the list's first page is not in those rows to pick.
  const [soloRows, setSoloRows] = useState<Announcement[]>([]);
  const [soloState, setSoloState] = useState<LoadState>("loading");
  const [soloError, setSoloError] = useState<string | undefined>(undefined);
  const [soloTick, setSoloTick] = useState(0);
  const soloId = solo ? openId ?? null : null;
  useEffect(() => {
    if (!soloId) return;
    let active = true;
    setSoloState("loading");
    setSoloError(undefined);
    get<Announcement>(`announcements/${soloId}`).then(
      (row) => { if (!active) return; setSoloRows([row]); setSoloState("ready"); },
      (e) => { if (!active) return; setSoloError((e as Error).message); setSoloState("error"); },
    );
    return () => { active = false; };
  }, [soloId, soloTick]);

  const source = solo ? soloRows : searching ? srch.rows : rows;
  const setSource = solo ? setSoloRows : searching ? srch.setRows : setRows;
  const more = solo ? false : searching ? srch.hasMore : hasMore;
  const loadMoreSource = searching ? srch.loadMore : loadMore;
  // What DataState shows: the board's load in board mode, this one post's in solo mode.
  const viewState = solo ? soloState : state;
  const viewError = solo ? soloError : error;
  const viewReload = solo ? () => setSoloTick((t) => t + 1) : reload;
  // A deep link (`/announcements/<id>` - a copied card link, a search hit, the activity feed) shows the
  // post on the board: switch to the list it lives in, scroll, highlight. Editing stays behind the pencil.
  // Solo mode is already showing that one post, so there is nothing to scroll to and nothing to switch.
  useDeepOpen(solo ? undefined : openId, source, openView);
  // Feeds the board composer's @-mention picker as well as the author labels - see Tickets.tsx.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { toast } = useToast();
  // Deleting the post a solo page IS leaves nothing to render, so that page goes back to the board.
  const sd = useSoftDelete("announcements", "post", solo ? () => navigate("announcements") : reload);
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
  // A popped-out post opens with its thread already unfolded - reading the conversation is what the page is
  // for. Once per post, not once per render, so folding it stays folded when a reaction re-renders the row.
  const soloExpanded = useRef<string | null>(null);
  useEffect(() => {
    const path = solo ? soloRows[0]?.path : undefined;
    if (!path || soloExpanded.current === path) return;
    soloExpanded.current = path;
    setExpandedPath(path);
  }, [solo, soloRows]);

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
  // nothing" in resourceStore: no board refetch per reaction, reply, vote or scroll-past. The row REPLACES the
  // old one rather than merging over it: a field that is now empty (an unpinned post's pin_time, a reopened
  // poll's closes_time) is absent from the JSON, so merging would keep the stale value and the change would
  // not show until a refetch.
  //
  // FOLDED INTO EVERY SOURCE THIS PAGE HOLDS, not just the active one. The board's verbs are mapped to "no
  // invalidation" precisely because this fold is exact - but that reasoning assumed ONE feed, and there are
  // three (the board's entry, the `q`-keyed search entry, and `soloRows`, which is plain component state
  // outside the store). React to a post found by search and the unsearched entry kept the pre-action row;
  // clearing the search drops the ephemeral `q` entry (`ephemeral()` in resourceStore) and reveals it, so
  // within its 20 s TTL the reaction was simply gone from the card. A reaction taken on a post's own page
  // reached no cached entry at all. Writing to all three is one helper and no extra requests.
  const fold = (updated: Announcement) => {
    const apply = (prev: Announcement[]) => (prev.some((r) => r.path === updated.path) ? prev.map((r) => (r.path === updated.path ? updated : r)) : prev);
    setRows(apply);
    srch.setRows(apply);
    setSoloRows(apply);
  };

  // Record the caller's read receipt for a post: clear the dot locally, then fire the (idempotent) server call
  // and fold its reserialized row back in (keeps the read-by count honest without refetching the board).
  //
  // A TRANSIENT failure restores the dot rather than lying about the receipt, so the next dwell tries again. A
  // REFUSAL does not: 404 is a post somebody deleted while this board was on screen and 403 is a viewer with no
  // markRead grant, and neither becomes true by asking again. Restoring the dot on those made the post unread,
  // which re-armed the dwell observer that had just fired, which asked again - a post deleted under a reader
  // fired :markRead every 2.5 seconds for as long as the page stayed open, each one a console error.
  function markRead(path: string) {
    setReadHere((s) => (s.has(path) ? s : new Set(s).add(path)));
    invoke<Announcement>("announcements/" + idOf(path), "markRead")
      .then(fold)
      .catch((e: unknown) => {
        const status = e instanceof ApiError ? e.status : 0;
        if (status >= 400 && status < 500) return;
        setReadHere((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      });
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
  // remove if present; one reaction per viewer per target). The chip moves FIRST and the request follows: a
  // reaction is a reflex, and a chip that waits a round-trip to answer the tap invites a second tap that undoes
  // the first. The server's reserialized row replaces the guess when it lands; a failure puts the old row back.
  async function toggleReact(a: Announcement, emoji: string, replyId?: string) {
    const before = a;
    setSource((prev) => prev.map((r) => {
      if (r.path !== a.path) return r;
      if (!replyId) return { ...r, reactions: applyReaction(r.reactions, emoji, myEmp) };
      return { ...r, replies: (r.replies ?? []).map((rep) => (rep.id === replyId ? { ...rep, reactions: applyReaction(rep.reactions, emoji, myEmp) } : rep)) };
    }));
    try {
      fold(await invoke<Announcement>("announcements/" + idOf(a.path), "react", undefined, replyId ? { emoji, reply: replyId } : { emoji }));
    } catch (e) {
      fold(before);
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
    const unpinning = !!a.pin_time;
    // UNPINNING IS NOT ASKED ABOUT. It takes a post out of the pinned group and leaves it on the board,
    // which is both reversible and small; a dialog in front of it is the noise that trains people through
    // the dialogs that matter. Pinning is the loud one - it puts a post above everything else for the whole
    // company - so that is the half that asks.
    if (!unpinning) {
      // Whatever is pinned NOW, from the board list rather than the filtered view: a search or a kind chip
      // can hide the pinned post from `source`, and "nothing else is pinned" read off a narrowed list is
      // how somebody ends up with two posts at the top having been told there would be one.
      const pinned = rows.find((r) => r.pin_time && r.path !== a.path);
      const name = (x: Announcement) => (x.title?.trim() ? `"${x.title}"` : "this post");
      const ok = pinned
        ? await confirmDecision(confirm, "pinReplacing", name(a), name(pinned))
        : await confirmDecision(confirm, "pin", name(a));
      if (!ok) return;
      // Unpin the incumbent FIRST, and let a failure stop the whole thing. The other order can leave two
      // posts pinned - which is exactly what the person was told would not happen - and doing it in either
      // order without this guard means a half-applied answer to a question they said yes to once.
      if (pinned) {
        try {
          fold(await invoke<Announcement>("announcements/" + idOf(pinned.path), "unpin"));
        } catch (e) {
          // A GONE incumbent is not a failure to stop for: somebody deleted that post between this page
          // reading the board and the press, so "only one post leads the board" is already true and the
          // pin should go ahead. Anything else - a refused unpin, a conflict - leaves two posts pinned if
          // we carry on, which is not what the dialog said would happen, so that aborts.
          if ((e as ApiError).status !== 404) {
            toast({ title: "Couldn't unpin the current post", description: `${(e as Error).message} - nothing was changed.`, variant: "destructive" });
            return;
          }
        }
      }
    }
    try {
      fold(await invoke<Announcement>("announcements/" + idOf(a.path), unpinning ? "unpin" : "pin"));
    } catch (e) {
      toast({ title: "Couldn't pin", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Take a post off the wall by hand - the moderator's own judgement, no model flag involved.
  //
  // Addressed to `moderation`, not to the post's own collection, because that is where the permission
  // lives: one grant covers the noticeboard, its replies and the suggestion box, and whoever holds it is
  // the same person on all three. The post's path travels as the body's `host`, which the inbound edge
  // decodes like any other ref.
  async function hideByHand(a: Announcement) {
    const subject = a.title?.trim() ? `"${a.title}"` : "this post";
    if (!(await confirmDecision(confirm, "hide", subject))) return;
    try {
      await invoke("moderation", "hide", undefined, { host: a.path });
      toast({ title: "Post hidden", description: "Its author has been told. You can put it back from Flagged posts.", variant: "success" });
      // The row is gone from every board read now, so the page has to re-ask rather than patch a row in.
      reload();
    } catch (e) {
      toast({ title: "Couldn't hide it", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Deleting a post asks first, which `useSoftDelete` deliberately does not do on its own.
  //
  // THE HOOK'S RULE IS RIGHT AND THIS IS A LOCAL EXCEPTION, so it is here rather than in the hook: a soft
  // delete is reversible and carries an Undo on its toast, and a dialog in front of every reversible delete
  // in the app is the noise that teaches people to click through the dialogs that matter. What is different
  // on this card is the NEIGHBOUR. The bin now sits inches from a moderator's Hide, and hiding asks; one of
  // two adjacent buttons asking and the other firing on the click reads as the silent one being the safer -
  // and it is the opposite, because a hide tells the author and comes back from the queue while this takes
  // the post off the board for everybody.
  async function deletePost(a: Announcement) {
    const subject = a.title?.trim() ? `"${a.title}"` : "this post";
    if (!(await confirmDecision(confirm, "deletePost", subject))) return;
    await sd.softDelete(a);
  }

  // The same act on a reply. Its id is the reply's own, under the `announcement-replies` collection - the
  // one the moderation queue addresses it by, and the reason a reply can be taken down without touching the
  // post it sits under.
  async function hideReply(replyId: string) {
    if (!(await confirmDecision(confirm, "hide", "this reply"))) return;
    try {
      await invoke("moderation", "hide", undefined, { host: `announcement-replies/${replyId}` });
      toast({ title: "Reply hidden", description: "Its author has been told. You can put it back from Flagged posts.", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't hide it", description: (e as Error).message, variant: "destructive" });
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

  // `body` arrives from the box in STORED form: the reply composer holds display text (`@Ananya Reddy`) and
  // turns its mentions back into tokens on the way out (see lib/mentionText.ts).
  async function submitReply(a: Announcement, body: string) {
    const text = body.trim();
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
  // The sort key is the SERVER's (lib/boardOrder mirrors src/domain/board.ts), so the rows the cursor brings
  // in land where the server already placed them: pinned posts lead, the rest run newest-first by when they
  // went live. Sorting here as well as there is what lets a `:pin` or a just-written post reorder the board
  // without a refetch.
  // `isWithdrawn` as well as `isDraft`: the server sends a disabled post to anyone who may see restricted
  // rows, and without this it landed in the live feed between two posts everybody can see - an editor
  // reading the board could not tell which of the three had been taken down.
  const feed = useMemo(() => source.filter((a) => !isDraft(a) && !isWithdrawn(a)).sort(byBoardOrder), [source]);
  // Not-yet-published posts, soonest-scheduled first and undated ones last: a staging list reads by when things
  // are due to go out, not by when they were written.
  const drafts = useMemo(() => {
    const due = (a: Announcement) => (a.publish_time ? +new Date(a.publish_time) : Infinity);
    return source.filter(isDraft).sort((x, y) => due(x) - due(y) || +new Date(y.create_time ?? 0) - +new Date(x.create_time ?? 0));
  }, [source]);

  // What the reader last narrowed the board to. Read once, at mount, so a chip clicked here is not fighting a
  // write from the previous page.
  const [saved] = useState((): SavedBoardFilter => {
    const key = FILTER_LS_KEY();
    const raw = key ? readLocalJson<SavedBoardFilter>(key, {}) : {};
    // Anything but a kind this build still knows is dropped, or a stale entry would land the reader on a chip
    // that isn't there and a feed that looks broken.
    return { kind: raw.kind && raw.kind in KIND_LABELS ? raw.kind : undefined, author: raw.author };
  });
  // The kudos the recognition charts and the podium are drawn from.
  //
  // OFF ITS OWN READ, not off the feed. Choosing `rows` over `source` stopped the podium shrinking while you
  // type in the search box and left the real instability in place: `rows` is the FEED WINDOW, twenty posts on
  // a cold open and another twenty per scroll, so a medalled ranking of named colleagues reordered as the
  // reader reached the foot of the page - and on a busy board those twenty mixed posts might hold three
  // kudos. A leaderboard is the one aggregate a window suits least: it is ordinal, it is about people, and the
  // window is biased towards the newest posts, which is exactly the bias a month rollup must not have.
  //
  // Read up here, above the board's own filters, because those filters are what its charts narrow: a chart
  // drawn from the narrowed feed would answer a different question after every press.
  const { rows: kudosRows } = useCollection<Announcement>("announcements", { enabled: !solo, all: true, params: { kind: "kudos" } });
  // The two shapes behind the podium: who is being recognized (six months, so a good month does not read as
  // a reputation) and how often recognition happens at all. Off the same kudos read as the leaderboard - on
  // the feed window the twelve-month chart answered its own "a culture, or a campaign?" with "a campaign" for
  // any board busier than twenty posts a month, because `monthlyTotals` pads the months it cannot see with
  // zeros and absence then looks like data.
  const kudosCharts = useMemo(() => {
    const kudos = kudosRows.filter((a) => a.create_time ?? "");
    const sixMonthsAgo = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
    const recent = kudos.filter((a) => (a.create_time ?? "") >= sixMonthsAgo && a.recipient);
    return {
      total: kudos.length,
      people: topSlices(recent, (a) => empName(a.recipient), (a) => a.points || 1, 8),
      months: monthlyTotals(kudos.map((a) => ({ date: (a.create_time ?? "").slice(0, 10), value: 1 })), 12, todayStr()),
    };
  }, [kudosRows, empName]);
  // Pressing either chart narrows the board to the kudos it counted: one person's, or one month's.
  const cf = useChartFocus<Announcement, "recipient" | "month">({
    recipient: {
      keys: kudosCharts.people.keys,
      label: (k) => `kudos for ${k}`,
      match: (a, k) => !!a.recipient && empName(a.recipient) === k,
    },
    month: {
      keys: kudosCharts.months.keys,
      label: (k) => `kudos in ${kudosCharts.months.labels[kudosCharts.months.keys.indexOf(k)] ?? k}`,
      match: (a, k) => (a.create_time ?? "").slice(0, 7) === k,
    },
  });

  // Feed filter: by kind, plus "Unread" (receipt-backed only - posts without read tracking never count) and
  // "Drafts" (only ever non-empty for someone who can post).
  const [filter, setFilter] = useState<"all" | "unread" | "drafts" | Kind>(saved.kind ?? "all");
  // Clicking an author (their avatar or name) narrows any list to their posts - a transient extra filter
  // with its own clear-chip, stacked on top of the kind chips rather than replacing them.
  const [authorFilter, setAuthorFilter] = useState<string | null>(saved.author ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const kindOf = (a: Announcement): Kind => (a.kind as Kind) ?? "announcement";
  // Persist only the stable selections. "Unread" and "Drafts" drain as you work, so restoring one would drop a
  // returning reader onto an empty board they never asked for.
  useEffect(() => {
    const keep: SavedBoardFilter = {};
    if (filter !== "all" && filter !== "unread" && filter !== "drafts") keep.kind = filter;
    if (authorFilter) keep.author = authorFilter;
    const key = FILTER_LS_KEY();
    if (key) writeLocalJson(key, keep.kind || keep.author ? keep : null);
  }, [filter, authorFilter]);
  // The search text and the author filter are applied FIRST, and the chips count what they left - a chip
  // promising six polls that the search has already excluded sends the reader to an empty list.
  const needle = q.trim().toLowerCase();
  const narrow = useMemo(() => {
    return (list: Announcement[]) => {
      // The chart pick applies here with the rest, so the chips below count what it left rather than
      // promising posts a picked month has already excluded.
      const bySlice = cf.apply(list);
      const byAuthor = authorFilter ? bySlice.filter((a) => a.author === authorFilter) : bySlice;
      // Once the server is doing the matching, do NOT re-filter its rows here: this pass matches different
      // fields (it knows names, the index knows `category` and `kind`), so it would silently drop real hits.
      if (searching) return byAuthor;
      return needle ? byAuthor.filter((a) => matchesText(a, needle, empName, deptName)) : byAuthor;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorFilter, needle, searching, empName, deptName, cf.picked?.dim, cf.picked?.key]);
  const shownFeed = useMemo(() => narrow(feed), [feed, narrow]);
  const shownDrafts = useMemo(() => narrow(drafts), [drafts, narrow]);
  const unreadCount = useMemo(() => shownFeed.filter((a) => a.read === false && !readHere.has(a.path)).length, [shownFeed, readHere]);
  const kindCounts = useMemo(() => {
    const c: Record<Kind, number> = { announcement: 0, post: 0, poll: 0, kudos: 0 };
    for (const a of shownFeed) c[kindOf(a)]++;
    return c;
  }, [shownFeed]);
  const visibleFeed = useMemo(() => {
    // The solo page renders the post it was asked for, full stop - the board's remembered chips and author
    // filter (or the post being an unpublished draft) must not be able to hide it.
    if (solo) return source;
    if (filter === "all") return shownFeed;
    if (filter === "drafts") return shownDrafts;
    // Posts read here stay in the Unread list (they'd otherwise vanish under the reader mid-scroll); their dot
    // fades instead, and the next visit drops them.
    if (filter === "unread") return shownFeed.filter((a) => a.read === false || readHere.has(a.path));
    return shownFeed.filter((a) => kindOf(a) === filter);
  }, [solo, source, shownFeed, shownDrafts, filter, readHere]);
  // Any narrowing at all is on - what the "clear" affordances offer to undo.
  const filtered = filter !== "all" || !!authorFilter || !!needle || !!cf.picked;
  // The board is an infinite feed: reaching the foot of what is loaded pulls the next page, so a reader who
  // keeps scrolling keeps reading. Drafts are a local slice of the loaded rows rather than a server list, so
  // that chip does no paging (as before).
  const { sentinelRef, loading: loadingMore } = useInfiniteScroll({
    hasMore: more,
    loadMore: loadMoreSource,
    enabled: !solo && filter !== "drafts",
  });
  function clearFilters() {
    setFilter("all");
    setAuthorFilter(null);
    setQ("");
    cf.clear();
  }
  // The text index builds from columns, so it matches title / body / category / kind and knows nothing about the
  // author and recipient NAMES the cards show - those are FK ids on the row. Unioning server hits with client
  // name-matches would mean two sources: dedup, counts that disagree and a result set that changes shape at the
  // page boundary. So instead, point at the affordance that already answers "find that thing Priya posted":
  // when the query names someone in the loaded directory, offer their author filter.
  const authorSuggestions = useMemo(() => {
    if (!searching || authorFilter) return [];
    return employees.filter((e) => `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim().toLowerCase().includes(needle)).slice(0, 3);
  }, [searching, authorFilter, employees, needle]);

  // Keyboard walk of the feed, the way a reader app does it: j / k move a cursor down and up (scrolling it into
  // view), Enter unfolds the post under the cursor, "/" jumps to the search box. Typing surfaces and open
  // dialogs keep their keys. `o` is deliberately NOT bound - it is the tail of the shell's `g o` chord.
  const [cursor, setCursor] = useState(-1);
  useEffect(() => setCursor(-1), [filter, authorFilter, needle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((e.key === "j" || e.key === "k") && visibleFeed.length) {
        e.preventDefault();
        const at = cursor < 0 ? (e.key === "j" ? -1 : 0) : cursor;
        const next = e.key === "j" ? Math.min(visibleFeed.length - 1, at + 1) : Math.max(0, at - 1);
        setCursor(next);
        const row = visibleFeed[next];
        if (row) document.getElementById(`post-${idOf(row.path)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (e.key === "Enter" && cursor >= 0) {
        // A focused button owns its own Enter. Taking it here too would activate the button AND fold the post
        // under the cursor - two actions from one keystroke.
        if (el && (el.tagName === "BUTTON" || el.tagName === "A")) return;
        const row = visibleFeed[cursor];
        if (row) { e.preventDefault(); toggleExpand(row); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Deliberately re-bound each render: the handler closes over the cursor and the visible list, and a stale
    // copy of either would step to the wrong post.
  });

  // Threads folded down to the newest few replies unfold in full on demand, per post.
  const [fullThread, setFullThread] = useState<Set<string>>(() => new Set());

  // A long board scrolls a long way from its filter bar. Offer the way back once there is one.
  const [scrolledFar, setScrolledFar] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolledFar(window.scrollY > 900);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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

  const leaderboard = useMemo(() => {
    const m = thisMonth();
    const by = new Map<string, number>();
    for (const a of kudosRows) if (a.recipient && (a.create_time ?? "").slice(0, 7) === m) by.set(a.recipient, (by.get(a.recipient) ?? 0) + (a.points || 1));
    return [...by.entries()].map(([e, n]) => ({ employee: e, count: n })).sort((a, b) => b.count - a.count).slice(0, 3);
  }, [kudosRows]);


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
  // `give-kudos` may carry the person to recognise: a completed goal offers "say well done" and lands here
  // with the owner already filled in, rather than making the giver find them again in a picker.
  // `give-kudos` may carry WHO: a completed goal offers "say well done" and lands here with the owner already
  // filled in, rather than making the giver find them again in a picker.
  const [kudosTo, setKudosTo] = useState<string | undefined>(undefined);
  const openKudos = (arg?: unknown) => {
    setKudosTo(typeof arg === "string" ? arg : undefined);
    openComposer("kudos");
  };
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
  // A card's shareable address - the same `/announcements/<id>` deep link search results and the activity
  // feed use, so the recipient lands on the post scrolled-to and highlighted.
  function copyLink(a: Announcement) {
    navigator.clipboard.writeText(recordUrl("announcements", idOf(a.path))).then(
      () => toast({ title: "Link copied" }),
      () => toast({ title: "Couldn't copy link", variant: "destructive" }),
    );
  }
  // Pop the post out onto a page of its own (`…/<id>/view`): the post and its thread, with no board behind
  // it - a long conversation read on its own. Same tab, so the back button returns to the board.
  function openSolo(a: Announcement) {
    navigate(pagePath("announcements", idOf(a.path)));
  }
  // Back from the composer. The write already refreshed the board (api.ts invalidates the collection), so this
  // only has to say where the thing went: switch to the list it landed in, then scroll to it and flash it -
  // otherwise a post saved as a draft looks like a post that vanished.
  function onComposed(saved?: Announcement) {
    if (!saved) return;
    // On a solo page there is no list to land in: the edited post replaces the one row the page is.
    if (solo) { setSoloRows([saved]); return; }
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
      {/* A post on its own page keeps none of the board's chrome - no composer, no chips, no leaderboard.
          The one thing it owes the reader is the way back to the board it came from. */}
      {solo ? (
        <div className="mx-auto mb-3" style={{ maxWidth: FEED_WIDTH }}>
          <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={() => navigate("announcements")}>
            <ArrowLeft className="h-4 w-4" /> Back to the feed
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Feed"
          description="Company news, posts, polls and peer recognition."
          actions={<>{newBtn}<PageSettings me={me} host="announcements" /></>}
        />
      )}

      {!solo && leaderboard.length > 0 && (
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

      {/* On the kudos view, recognition as a pattern rather than a podium: who is being thanked beyond the
          top three, and whether the giving is a habit or a once-a-quarter burst. Recognition that only ever
          lands on the same two people is the thing this is worth seeing. */}
      {!solo && filter === "kudos" && kudosCharts.total > 2 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Most recognized" description="Kudos points received over the last six months.">
            <Chart
              type="bar"
              height={Math.min(300, Math.max(160, kudosCharts.people.labels.length * 32 + 60))}
              labels={kudosCharts.people.labels}
              datasets={[{ name: "Points", values: kudosCharts.people.values }]}
              ariaLabel="Kudos points received per person over the last six months"
              {...cf.chart("recipient")}
            />
          </ChartCard>
          <ChartCard title="Recognition over time" description="Kudos given each month - a culture, or a campaign.">
            <Chart
              type="line"
              height={180}
              labels={kudosCharts.months.labels}
              datasets={[{ name: "Kudos", values: kudosCharts.months.values }]}
              areaFill
              format={(v) => `${v} kudo${v === 1 ? "" : "s"}`}
              ariaLabel="Kudos given in each of the last twelve months"
              {...cf.chart("month")}
            />
          </ChartCard>
        </div>
      )}

      <DataState state={viewState} error={viewError} onRetry={viewReload} skeleton={<FeedSkeleton />}>
        {/* Only the genuinely empty board gets the "start posting" pitch. A search or a chip that matched
            nothing must NOT take this branch: the search box lives in the other one, so a query with no hits
            would take away the only way to change it. That case is answered inside, next to the input. */}
        {!solo && feed.length === 0 && drafts.length === 0 && !filtered ? (
          <EmptyState icon={Megaphone} title="Nothing on the feed yet" description="Share company news, updates and shout-outs here." action={newBtn} />
        ) : (
          <div className="mx-auto space-y-5" style={{ maxWidth: FEED_WIDTH }}>
            {!solo && starter}
            {/* The search box and filter chips ride along under the top bar (h-14) so narrowing the board
                never needs a scroll back to the top of a long feed. */}
            {!solo && (
            <div className="sticky top-14 z-20 -mx-1 -my-2 flex flex-wrap items-center gap-1.5 bg-background/95 px-1 py-2 backdrop-blur">
              {/* The board is one flat feed with no column to sort by, so text is the only way to find an old
                  post by hand. From two characters up the server matches the whole board (title, body,
                  category, kind); below that it filters the loaded window on what the card shows. */}
              <div className="relative mr-1 w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setQ(""); e.currentTarget.blur(); } }}
                  placeholder="Search the board…"
                  aria-label="Search the board"
                  className="h-8 rounded-full pl-8 pr-8 text-sm"
                />
                {q && (
                  <button
                    type="button"
                    onClick={() => { setQ(""); searchRef.current?.focus(); }}
                    aria-label="Clear the search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {([
                ["all", "All", shownFeed.length],
                ...(unreadCount > 0 ? [["unread", "Unread", unreadCount] as const] : []),
                ...(shownDrafts.length > 0 ? [["drafts", "Drafts", shownDrafts.length] as const] : []),
                ["announcement", "Announcements", kindCounts.announcement],
                ["post", "Posts", kindCounts.post],
                ["poll", "Polls", kindCounts.poll],
                ["kudos", "Kudos", kindCounts.kudos],
              ] as const)
                .filter(([k, , n]) => k === "all" || n > 0)
                .map(([k, label, n]) => (
                  <FilterChip key={k} active={filter === k} count={n} onClick={() => setFilter(k as typeof filter)}>{label}</FilterChip>
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
              {cf.activeLabel && (
                <button
                  onClick={cf.clear}
                  className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
                  title="Clear the recognition filter"
                >
                  {cf.activeLabel} <X className="h-3 w-3" />
                </button>
              )}
              {/* One way out of every narrowing at once, so a reader who stacked a kind, an author and a
                  search does not have to undo them one at a time to see the board again. */}
              {filtered && (
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Show the whole board again"
                >
                  <FilterX className="h-3.5 w-3.5" /> Clear
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
              {/* The names on the cards are not in the text index, so a search for a person finds only the posts
                  that spell their name out. This offers the filter that does know: their posts, by author. */}
              {authorSuggestions.length > 0 && (
                <div className="flex w-full flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Looking for a person?</span>
                  {authorSuggestions.map((e) => (
                    <button
                      key={e.path}
                      onClick={() => { setAuthorFilter(e.path); setQ(""); }}
                      className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      Posts by {[e.first_name, e.last_name].filter(Boolean).join(" ")}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}
            {/* An empty list is a dead end unless it says how to get out of it. On a solo page "empty" means
                the one post asked for is not there - deleted, or never visible to this reader. */}
            {visibleFeed.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {solo
                    ? "This post isn't here any more - it may have been removed."
                    : searching && srch.state === "loading"
                      ? "Searching the board…"
                      : needle
                        ? <>Nothing on the board matches “{q.trim()}”.</>
                        : filter === "drafts"
                          ? "No drafts. Anything you save for later lands here."
                          : "Nothing matches this filter."}
                </p>
                {solo ? (
                  <Button variant="outline" size="sm" onClick={() => navigate("announcements")}>
                    <ArrowLeft className="h-4 w-4" /> Back to the feed
                  </Button>
                ) : filtered && (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    <FilterX className="h-4 w-4" /> Show the whole board
                  </Button>
                )}
              </div>
            )}
            {visibleFeed.map((a, idx) => {
              // Time separators ("Pinned / Today / This week / ..."): drawn where the section changes while
              // mapping. Not in Drafts - that list is ordered by when things go OUT, not when they landed.
              // No "Today / This week" separator above a page that is one post - it groups nothing.
              const section = solo || filter === "drafts" ? null : sectionOf(a);
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
              const atCursor = idx === cursor; // where j / k have walked to - a softer ring than the deep-link flash
              const replies = a.replies ?? [];
              // A thread folds down to its newest few until the reader asks for the rest. One extra hidden reply
              // is not worth a button, so the fold only starts once it actually saves something.
              const hidden = fullThread.has(a.path) || replies.length <= REPLY_PEEK + 1 ? 0 : replies.length - REPLY_PEEK;
              const shownReplies = hidden > 0 ? replies.slice(hidden) : replies;
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
              // Who it was addressed to, when it wasn't everybody. Anyone can still read it (the board is the
              // board), so the chip is the honest way to say "this one is about Engineering" to the other 300
              // people scrolling past it.
              const audienceMark = a.audience_department ? (
                <Badge
                  variant="outline"
                  className="gap-1 font-normal"
                  title={`Only ${deptName(a.audience_department)} was notified about this. It is not restricted - anyone who can see the board can read it.`}
                >
                  <Users className="h-3 w-3" /> For {deptName(a.audience_department)}
                </Badge>
              ) : null;
              const headerMark = draft ? (
                <>
                  <Badge variant="secondary" className="gap-1 font-normal">
                    {scheduledFor ? <><CalendarClock className="h-3 w-3" /> Scheduled</> : "Draft"}
                  </Badge>
                  {audienceMark}
                  {a.audience_scope === "none" && (
                    <Badge variant="outline" className="gap-1 font-normal" title="Nobody will be notified when this publishes. It will simply be on the board.">
                      <BellOff className="h-3 w-3" /> No notification
                    </Badge>
                  )}
                  {a.email_audience && (
                    <Badge variant="outline" className="gap-1 font-normal" title="Will also be emailed to its audience when it publishes">
                      <Mail className="h-3 w-3" /> Emails on publish
                    </Badge>
                  )}
                </>
              ) : (
                <>
                  {pinned && (
                    <Badge variant="secondary" className="gap-1 font-normal text-primary">
                      <Pin className="h-3 w-3" /> Pinned
                    </Badge>
                  )}
                  {audienceMark}
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
                  <Card onClick={() => toggleExpand(a)} className={cn("group relative min-w-0 flex-1 cursor-pointer overflow-hidden p-5 transition-shadow hover:shadow-md", isAnn && !draft && "border-primary/30 bg-primary/[0.025]", isKudos && kt.card, draft && "border-dashed bg-muted/20", isTarget && "ring-2 ring-primary ring-offset-2", atCursor && !isTarget && "ring-2 ring-primary/40 ring-offset-2")}>
                    {/* Actions float in the top-right corner so the body (and the kudos recipient hero) can span the
                        full card width. They sit above the body's own layer (z-10), or the text would cover all but
                        the top few pixels of these buttons and swallow the clicks.
                        Not on a phone, though: there is no hover there, so all five are drawn at once, and five
                        finger-sized buttons is ~250px of a 360px card - laid over the author row, which is the one
                        thing in that corner on a phone. The name was printed underneath the icons. Below `sm` the
                        cluster is therefore in normal flow, right-aligned, as the card's first row; being earlier in
                        the DOM than the author row is what puts it above rather than on top of it. */}
                    <div className="z-20 mb-1 flex items-center justify-end gap-1 sm:absolute sm:right-3 sm:top-3 sm:mb-0">
                      {/* Publishing a draft is that card's whole point, so it stays visible - unlike the icon
                          row below it. */}
                      {draft && can.includes("publish") && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => publishDraft(a)}>
                            <Send className="h-3 w-3" /> Publish
                          </Button>
                        </div>
                      )}
                      {/* The per-post tools are secondary furniture: dimmed, and only drawn while the pointer is
                          on this card (or something inside has focus, so Tab still reaches them). A touch screen
                          has no hover, so below `sm` they stay on. */}
                      <div className="flex items-center gap-1 text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100" onClick={(e) => e.stopPropagation()}>
                        {!draft && (
                          <>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copyLink(a)} aria-label="Copy link" title="Copy link to this post">
                              <Link2 className="h-3.5 w-3.5" />
                            </Button>
                            {/* Not on the solo page itself - it is already the post's own page. */}
                            {!solo && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openSolo(a)} aria-label="Open in its own page" title="Open this post in its own page">
                                <Maximize2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </>
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
                        {/* MODERATION, not editing: the grant is `moderation.hide`, so this appears for a
                            moderator who has no rights over the post itself and stays absent for an author
                            who can edit their own. `AccessAction` reads that from the caller's own
                            capabilities - the page tests nothing. */}
                        <AccessAction collection="moderation" verb="hide" label="Take this post off the wall">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void hideByHand(a)} aria-label="Take off the wall" title="Take this post off the wall (moderation)">
                            <EyeOff className="h-3.5 w-3.5" />
                          </Button>
                        </AccessAction>
                        {can.includes("delete") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => void deletePost(a)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                        )}
                      </div>
                      {/* The whole card is clickable for a mouse, but a click target is not an affordance a
                          keyboard can reach - this chevron is the real control, so the fold is reachable by Tab
                          (and by j/k + Enter) and announces its state. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleExpand(a); }}
                        aria-expanded={isOpen}
                        aria-controls={`thread-${idOf(a.path)}`}
                        aria-label={isOpen ? "Hide this post's replies" : "Show this post's replies"}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          // Same hover-reveal as the tools beside it, except once the fold is open the chevron is
                          // the only way back - it stays put then.
                          "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100",
                          isOpen && "opacity-100",
                        )}
                      >
                        <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} aria-hidden />
                      </button>
                    </div>
                    {/* On a phone the author rail beside the card is hidden (it would cost a fifth of the
                        width) - the author moves into the card's own header instead. */}
                    {/* No right padding any more: the corner cluster it used to dodge is a row of its own above
                        this one on a phone, so the author's name gets the full width. */}
                    <div className="mb-2 flex items-center gap-2 sm:hidden">
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
                        // `?? undefined`: null and absent both mean "the card's own default" - null is what a
                        // merge-patch sends to CLEAR a placement, and it arrives back on the row that way.
                        bodyValign={a.body_valign ?? undefined}
                        headerExtra={headerMark}
                        headerClassName="pr-14"
                      />
                    ) : (
                      <div className={cn(clamped && "relative max-h-80 overflow-hidden")}>
                        <PostCardBody
                          title={a.title}
                          titleAlign={a.title_align ?? undefined}
                          body={a.body}
                          artUrl={art}
                          stickerLayout={a.illustration_layout}
                          bodyValign={a.body_valign ?? undefined}
                          headerExtra={headerMark}
                          headerClassName="pr-14"
                          // A poll's question and options are short enough to share their line with a picture.
                          wrapAll={a.kind === "poll"}
                          below={a.poll && <PollBlock poll={a.poll} canVote={can.includes("vote")} canManage={can.includes("update")} onVote={(opt) => castVote(a, opt)} onSetClosed={(close) => setPollClosed(a, close)} />}
                        />
                        {clamped && (
                          <div className="absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-gradient-to-t from-card via-card/80 to-transparent pb-1">
                            {/* A real button, not a label on the fade: the rest of a clamped post has to be
                                reachable without a mouse. */}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleExpand(a); }}
                              className="rounded-full px-3 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Read more
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  {/* Reactions + counts group on the left; the date anchors right. Wrapping because the four of
                      them state ~350px of min-content on a card that has 288px on a 360px screen (a scheduled
                      draft's "Goes out in 2 days" is the widest of them) - and the card clips its overflow, so
                      without this the date is not pushed off screen, it is gone. */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <ReactionBar reactions={a.reactions} canReact={can.includes("react")} onToggle={(emoji) => toggleReact(a, emoji)} nameOf={empName} />
                    {/* Reply-less posts invite the first reply by name instead of a bare zero (when the viewer may reply). */}
                    <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> {a.reply_count || (can.includes("reply") ? "Reply" : 0)}</span>
                    {/* Read receipts (author + HR only). A zero is on every post the minute it goes out and says
                        nothing the "New" dot doesn't - the eye appears once somebody has actually read it. */}
                    {!!a.read_count && <ReadIndicator count={a.read_count} names={(a.read_by ?? []).map((r) => empName(r))} />}
                    {/* A draft's own date is meaningless to the reader it hasn't reached; what matters is when
                        (or whether) it is due to go out. */}
                    <span className="ml-auto">
                      {draft ? (
                        // tapToOpen: the chip says "goes out in 2 days", the tooltip says which day and time.
                        <Tooltip tapToOpen>
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
                    <div id={`thread-${idOf(a.path)}`} className="-mx-5 -mb-5 mt-4 border-t bg-muted/60 px-5 py-4">
                      <div>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {a.reply_count ? `${a.reply_count} ${a.reply_count === 1 ? "reply" : "replies"}` : "Replies"}
                        </p>
                        {replies.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No replies yet. Start the conversation.</p>
                        ) : (
                          <div className="space-y-4">
                            {/* A long thread renders as the newest few plus a way back through the rest: a
                                fifty-reply post would otherwise push the next post off the screen entirely.
                                The newest are kept because that is where the live conversation is. */}
                            {hidden > 0 && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setFullThread((s) => new Set(s).add(a.path)); }}
                                className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <ChevronUp className="h-3.5 w-3.5" /> Show {hidden} earlier {hidden === 1 ? "reply" : "replies"}
                              </button>
                            )}
                            {shownReplies.map((rep, i) => {
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
                                    <div className="mt-1.5 flex items-center gap-2">
                                      <ReactionBar reactions={rep.reactions} canReact={can.includes("react") && !!rep.id} onToggle={(emoji) => toggleReact(a, emoji, rep.id)} nameOf={empName} />
                                      {/* A reply is the surface that most often needs taking down and the one
                                          hiding the post cannot fix: the thread belongs to its author, and a
                                          commenter's words are not theirs to answer for. Same grant as the
                                          post's own control. */}
                                      {rep.id && (
                                        <AccessAction collection="moderation" verb="hide" label="Take this reply off the thread">
                                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void hideReply(rep.id!)} aria-label="Take off the thread" title="Take this reply off the thread (moderation)">
                                            <EyeOff className="h-3 w-3" />
                                          </Button>
                                        </AccessAction>
                                      )}
                                    </div>
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
                            onSubmit={(body) => submitReply(a, body)}
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
            {/* Foot of the feed: older posts live past the cursor, and crossing this marker fetches them. The
                button behind it is the manual way through - it is what the reader sees for the moment before
                the observer fires, and the whole affordance if that never happens. */}
            {more && filter !== "drafts" && (
              <div ref={sentinelRef} className="pb-2 text-center">
                {loadingMore ? (
                  <p className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> {searching ? "Loading more results…" : "Loading older posts…"}
                  </p>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => loadMoreSource()}>{searching ? "Load more results" : "Load older posts"}</Button>
                )}
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
        initialRecipient={kudosTo}
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

      {/* The board runs long and its filter bar is at the top of it. Once you are far enough down that the way
          back is a scroll rather than a glance, offer it. */}
      {scrolledFar && (
        <Button
          variant="secondary"
          size="icon"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Back to the top of the board"
          title="Back to the top"
          // Lifted clear of the phone's home indicator; back to the corner from `md` up, where there is none.
          className="fixed bottom-[calc(2rem+env(safe-area-inset-bottom))] right-4 z-30 h-10 w-10 rounded-full shadow-lg md:bottom-6 md:right-6"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}

      </div>
    </TooltipProvider>
  );
}

// What the board looks like while it loads: the author rail and two card-shaped blocks, at the feed's own width.
// The generic row-of-bars placeholder describes a table, and this page is not one - a wait that mis-describes
// what is coming makes the arrival feel like a re-layout.
function FeedSkeleton() {
  return (
    <div className="mx-auto space-y-5" style={{ maxWidth: FEED_WIDTH }}>
      <Skeleton className="h-14 w-full rounded-xl" />
      {/* Stands in for the filter-chip row. 64+16+24 on the w-scale is 416px, so on a phone the
          placeholder was wider than the content it is a placeholder for - the loading state pushed the
          page sideways and then the loaded page snapped back. The first chip gives instead. */}
      <div className="flex gap-1.5">
        <Skeleton className="h-8 min-w-0 flex-1 rounded-full sm:w-64 sm:flex-none" />
        <Skeleton className="h-8 w-16 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="hidden w-14 shrink-0 flex-col items-center gap-1.5 sm:flex">
            <Skeleton className="h-12 w-12 rounded-full" />
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="min-w-0 flex-1 space-y-3 rounded-xl border p-5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className={i === 1 ? "h-3 w-2/3" : "h-3 w-1/3"} />
          </div>
        </div>
      ))}
    </div>
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
    // tapToOpen: "3 days ago" is the compact form and the exact timestamp is only here, so without a tap this
    // is a phone reader asking "when exactly?" with no way to find out.
    <Tooltip tapToOpen>
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
    <Tooltip tapToOpen>
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
    // tapToOpen: the count is the summary, the names are the answer - and "who has read this" is exactly the
    // question the author opens the post on their phone to ask.
    <Tooltip tapToOpen>
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
function ReplyBox({ value, onChange, onSubmit, employees }: { value: string; onChange: (next: string) => void; onSubmit: (body: string) => void; employees: Employee[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ value, onChange, textareaRef: ref, employees });
  const send = () => onSubmit(mentions.toWire(value));
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
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        {mentions.menu}
      </div>
      <Button size="sm" onClick={send} disabled={!value.trim()}>Reply</Button>
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
