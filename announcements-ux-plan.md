# Announcements board - UX plan

The board (web/src/pages/Announcements.tsx) is one unified feed: announcements, posts, polls and kudos are
all `announcements` rows. This file tracks the UX work on it. Everything below is SHIPPED.

## Reading the board

- **Pinned posts** - `pinned_at` column, `:pin`/`:unpin` verbs (HR/moderation, via the existing
  `announcements.**` allow), `pin_time` on the wire. The feed sorts pinned first (most recently pinned
  leading), each pinned card carries a Pinned badge, and a draft cannot be pinned.
- **Load older posts** - the feed uses `hasMore`/`loadMore` instead of silently ending at the 100-row page cap.
- **Long-post clamp** - announcement/post bodies over 700 chars fold to a fixed height with a "Read more"
  fade; the expand click (the same one that opens replies) shows the rest. Kudos and polls never clamp.
- **Sticky filter chips** (top-14, under the top bar), so switching lists never needs a scroll to the top.
- **Time separators** - Pinned / Today / This week / This month / Earlier dividers, drawn where the section
  changes. Not in Drafts, which is ordered by when things go OUT.
- **Mark all read** - `announcements:markAllRead`, a collection verb every employee holds (in
  BOARD_SOCIAL_ALLOW next to `markRead`). Two reads and one batched insert whatever the board's size; skips
  the caller's own posts and honours the same visibility the list endpoint binds, so an editor's pass also
  covers the drafts they can see. Shown next to the Unread chip while anything is unread.
- **Author filter** - clicking an author (rail or inline name) narrows the current list to their posts, with
  a clear-chip. **Copy link** on every card writes the `#/announcements/<id>` deep link, and a deep link
  now SHOWS the post (switch list, scroll, flash) instead of opening the editor.
- **Poll countdown** - an open poll with a deadline reads "closes in 2h" (`relativeFuture`, shared from
  lib/utils), exact moment on hover.
- Relative times re-render every minute; the leaderboard is titled "Most recognized in <month>" and links
  to the kudos list.

## People on the board

- **Photo avatars** - author rail, replies and the composer starter use PhotoAvatar (batched photo cache);
  InitialBubble remains the fallback where no employee record backs a name.
- **Mobile** - the author rail hides below `sm`; a compact avatar + name strip renders inside the card.
- **Reaction hover names** - reaction groups carry `reactors` (employee refs, capped at 12 by MAX_REACTORS -
  `count` stays authoritative and the tooltip closes with "and N others"). Reactions are public acts, so no
  privacy change; poll answers stay anonymous.
- **@mentions** - `[@Name](employees/<wire-token>)` in a body or a reply (domain/mentions.ts). The name is in
  the source, so the chip needs no lookup and `richToPlain` already reduces it to "@Name" for search,
  excerpts and exports. The ref carries the WIRE token, never an internal id; the server decodes it when it
  decides whom to notify, so a rotated WIRE_ID_KEY degrades mentions to plain names rather than leaking ids.
  Notified on create-published, on `:publish` (a draft's mentions wait for it), on the scheduled-publish
  tick, on a reply, and on an edit for NEWLY named people only. Capped at MAX_MENTIONS (10) per body, never
  the author naming themselves, never a deleted employee. A mention is a notification, not a grant - the
  board is readable by every employee already. The composer body and the reply box both offer the directory
  on `@` (components/common/MentionPicker.tsx: caret-derived run, keyboard nav, menu under the field).

Tests: test/boardEngagement.test.ts (pinning, mark-all-read, reaction groups, mention parsing + every
notify path).

## Fixed along the way

`notifications.markAllRead` was seeded with a `match_code`, which files a rule in the per-object lane - a
lane a collection verb carrying no object id never reaches - so the bell's "Mark all read" was denied for
everyone but super. Both generators now encode it broad, exactly as compileGrant encodes a 2-token verb
pattern. Relatedly, authz.ts computed the list scope from the raw first path segment, so a COLLECTION-level
custom method (`announcements:markAllRead`) would have scoped against a resource named
"announcements:markAllRead"; the verb is now split off before `scopeFor`.

## Deliberately skipped

- Board-local search: global ⌘K already FTS-indexes announcements (2-row reads).
- Realtime "N new posts" toast: needs polling; fights D1 read minimization.
- Post expiry/auto-archive: unclear value; pinning + time separators cover recency.
- Keyboard j/k navigation: niche.
