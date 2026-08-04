import { eq, and, inArray, isNull, lte } from "drizzle-orm";
import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { runBatch, chunk } from "../lib/dbBatch";
import { assertNotLocked } from "./lifecycle";
import { getSettingValue } from "./settings";
import { notify, notifyAudience } from "./notifications";
import { emitEvent } from "./eventBus";
import { DEFAULT_KUDOS_CONFIG, pointsForLevel } from "../domain/kudos";
import { normalizeIllustration, normalizeIllustrationLayout, normalizeRecipientLayout, type RecipientLayout, type IllustrationLayout } from "../domain/illustration";
import { richExcerpt, richToPlain } from "../domain/richText";
import { notifyMentions } from "./mentions";
import { postedTitle } from "../domain/board";

export type AnnouncementInput = {
  title?: string;
  body?: string;
  kind?: "announcement" | "post" | "poll" | "kudos";
  author?: string | null;
  // When the post goes (or went) live. On create it doubles as the SCHEDULE: a future time on an unpublished
  // row is what publishDueAnnouncements waits for.
  publish_time?: string | null;
  // Create only: `false` makes a draft - no notification, and invisible to everyone but the editors who can see
  // restricted rows (see listAnnouncements). Going live is the `:publish` verb, which is where the broadcast
  // lives, so a post can never notify twice or notify without being visible.
  published?: boolean;
  // Poll creation (kind="poll"): the choices (>=2), whether multiple may be picked, and an optional deadline.
  options?: string[];
  multiple?: boolean;
  closes_time?: string | null;
  // Kudos (kind="kudos"): the recognized employee + recognition meta. `message` is the kudo text (stored in
  // `body`). `points` is NOT accepted from the client - it's snapshotted server-side from `level`.
  recipient?: string | null;
  recipient_department?: string | null; // dept kudo: recognize a whole department instead of one employee
  message?: string;
  value?: string | null;
  category?: string | null;
  level?: string | null;
  illustration?: string | null;
  illustration_layout?: IllustrationLayout | null;
  recipient_layout?: RecipientLayout | null; // kudos only: where the giver dragged the recipient block
  title_align?: "left" | "center" | "right" | null;
  body_valign?: "top" | "middle" | "bottom" | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export async function listAnnouncements(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, showDeleted = false) {
  // Visibility was decided in the middleware (scopeFor over the grant + the manifest state rule); here we
  // only bind it to columns: editors (scope.seeRestricted) see everything, everyone else only live posts.
  const all = visibleByDelete(await deps.db.select().from(schema.announcements), showDeleted)
    .filter((a) => scope.seeRestricted || (a.published && !a.disabled))
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getAnnouncement(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("announcement not found");
  return row;
}

export async function createAnnouncement(deps: Deps, actor: AppUser, input: AnnouncementInput, id?: string) {
  // A generic board post is `kind: "post"`, a poll is `kind: "poll"`, a kudo is `kind: "kudos"` (a post ABOUT
  // a recipient), everything else is an announcement.
  const kind = input.kind === "post" ? "post" : input.kind === "poll" ? "poll" : input.kind === "kudos" ? "kudos" : "announcement";
  const isKudos = kind === "kudos";
  // Kudos carry the message in `body` + a recipient, and have no title; every other kind needs a title.
  if (!isKudos && !input.title) throw invalidArgument("title is required");
  const message = isKudos ? (input.message ?? input.body ?? "").trim() : "";
  if (isKudos && !message) throw invalidArgument("a kudo message is required");
  // A kudo recognizes EITHER one employee OR a whole department - exactly one, never both, never neither.
  const recipientId = isKudos ? idFromPath(input.recipient) : undefined;
  const recipientDeptId = isKudos ? idFromPath(input.recipient_department) : undefined;
  if (isKudos && !!recipientId === !!recipientDeptId) throw invalidArgument("a kudo needs exactly one of a recipient or a department");
  // The author defaults to the caller (the giver, for kudos) unless an explicit author ref is given.
  const authorId = idFromPath(input.author) ?? actor.employeeId ?? null;
  // Nobody recognizes themselves. Two ways that could happen, so both are closed: the giver naming themselves
  // as the recipient, and a caller with create-on-behalf rights posting a kudo TO themselves under someone
  // else's name (author != recipient, so the first check alone would wave it through).
  if (isKudos) {
    if (!authorId) throw invalidArgument("only an employee can give kudos");
    if (recipientId && authorId === recipientId) throw invalidArgument("you can't give kudos to yourself");
    if (recipientId && actor.employeeId && recipientId === actor.employeeId) throw invalidArgument("you can't give kudos to yourself");
  }
  // A poll's body (description) is optional; announcements and posts still require one (kudos use the message).
  if (!input.body?.trim() && kind !== "poll" && !isKudos) throw invalidArgument("body is required");
  // Validate poll options up front (trimmed, non-empty, at least two) so we never persist a degenerate poll.
  const options = kind === "poll" ? (input.options ?? []).map((o) => o.trim()).filter(Boolean) : [];
  if (kind === "poll" && options.length < 2) throw invalidArgument("a poll needs at least two options");
  const publishTime = input.publish_time ? new Date(input.publish_time) : null;
  // A draft: stored, not broadcast, not on anyone else's board until `:publish` (by hand, or by the cron once
  // its `publish_time` arrives). Kudos are never drafted - recognition is sent, not staged.
  const published = isKudos ? true : input.published !== false;
  const pollClosesAt = kind === "poll" && input.closes_time ? new Date(input.closes_time) : null;
  // Recognition points are resolved server-side from the configured level (never trusted from the client), so
  // a giver can't inflate their recognition. Blank/unknown level => 0 points.
  const level = isKudos ? (input.level?.trim() || null) : null;
  const points = isKudos ? pointsForLevel(await getSettingValue(deps, "kudos", DEFAULT_KUDOS_CONFIG), level) : 0;
  // Author-owned code so the giver/poster can self-scope edit + soft-delete their own item (owner_refs.author).
  const code = authorId ? await allocOwnedCode(deps, schema.announcements, schema.announcements.authorEmployeeId, authorId) : await allocFlatCode(deps, schema.announcements);
  const row = (await deps.db
    .insert(schema.announcements)
    .values({ code, ...(id ? { id } : {}), kind, published, title: isKudos ? "" : input.title!, body: isKudos ? message : (input.body ?? ""), bodyText: richToPlain(isKudos ? message : input.body), titleAlign: input.title_align ?? null, bodyValign: input.body_valign ?? null, authorEmployeeId: authorId, publishTime, pollMultiple: kind === "poll" ? !!input.multiple : false, pollClosesAt, recipientEmployeeId: recipientId ?? null, recipientDepartmentId: recipientDeptId ?? null, value: isKudos ? (input.value?.trim() || null) : null, category: isKudos ? (input.category?.trim() || null) : null, level, points, illustration: normalizeIllustration(input.illustration), illustrationLayout: normalizeIllustrationLayout(input.illustration_layout), recipientLayout: isKudos ? normalizeRecipientLayout(input.recipient_layout) : null })
    .returning())[0]!;
  if (kind === "poll") {
    await deps.db.insert(schema.announcementPollOptions).values(options.map((label, i) => ({ announcementId: row.uuid, label, position: i })));
  }
  await audit(deps, actor, `${kind}.create`, "announcements", row.uuid, undefined, row);
  // Tell the recognized party (the board is the link target): one recipient, or every member of the
  // department (fanned out, excluding the giver if they're in it).
  if (isKudos && recipientId) await notify(deps, { recipient: recipientId, type: "kudos.received", title: "You received kudos", body: richExcerpt(message, 200), link: "announcements", subject: `announcements/${row.uuid}`, actorId: authorId });
  else if (isKudos && recipientDeptId) await notifyAudience(deps, { kind: "department", department: recipientDeptId }, { type: "kudos.received", title: "Your team received kudos", body: richExcerpt(message, 200), link: "announcements", subject: `announcements/${row.uuid}`, actorId: authorId }, authorId);
  // A plain board post (announcement / post / poll) notifies everyone (bar the author), so it surfaces in the
  // bell and lights the "New" marker on its card - the same recognition-board treatment, for every post type.
  // A draft notifies nobody: its broadcast happens once, when it is published.
  else if (published) await notifyAudience(deps, { kind: "everyone" }, { type: "announcement.posted", title: postedTitle(kind), body: input.title!, link: "announcements", subject: `announcements/${row.uuid}` }, authorId);
  // Anyone the body names hears about it directly, on top of whatever broadcast this kind does - being named
  // is addressed at you, which a company-wide "new post" is not. A draft stays silent until it is published.
  if (published) await notifyMentions(deps, actor, { announcementId: row.uuid, body: row.body, title: row.title });
  return row;
}

// The other half of scheduling: a draft whose `publish_time` has arrived goes live on the next 5-minute tick.
// Run from cron.ts with no actor.
//
// The flip is a guarded update (published = 0 -> 1 in one conditional write) and the broadcast only happens for
// rows this call actually claimed, so two overlapping ticks - or a tick racing an HR "Publish now" - can never
// announce the same post twice.
//
// `publish_time` is deliberately left as the author set it: it is when the post says it went out, it is what the
// feed sorts by, and rewriting it to "whenever the tick happened to fire" would move a 9:00 announcement to 9:03.
export async function publishDueAnnouncements(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const due = await deps.db
    .select()
    .from(schema.announcements)
    .where(and(eq(schema.announcements.published, false), isNull(schema.announcements.deleteTime), lte(schema.announcements.publishTime, now)));
  let published = 0;
  for (const row of due) {
    if (row.disabled) continue;
    const claimed = await deps.db
      .update(schema.announcements)
      .set({ published: true, updatedAt: new Date() })
      .where(and(eq(schema.announcements.uuid, row.uuid), eq(schema.announcements.published, false)))
      .returning();
    if (!claimed.length) continue;
    await audit(deps, "system", `${row.kind}.publish`, "announcements", row.uuid, { scheduled: true }, claimed[0]!);
    await notifyAudience(
      deps,
      { kind: "everyone" },
      { type: "announcement.posted", title: postedTitle(row.kind), body: row.title, link: "announcements", subject: `announcements/${row.uuid}` },
      row.authorEmployeeId,
    );
    await emitEvent(deps, null, "announcement.published", { subject: `announcements/${row.uuid}`, payload: { title: row.title } });
    // A scheduled post's mentions land when it does. The "actor" is the post's own author, not the tick: it
    // is their words that named someone, and naming yourself still notifies nobody.
    await notifyMentions(deps, { employeeId: row.authorEmployeeId } as AppUser, { announcementId: row.uuid, body: row.body, title: row.title });
    published++;
  }
  return published;
}

export async function updateAnnouncement(deps: Deps, actor: AppUser, id: string, patch: AnnouncementInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("announcement not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof AnnouncementInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("title")) set.title = patch.title;
  // The stripped mirror is re-derived here rather than sent, so it can never disagree with the body itself.
  // A poll's body is its optional description, so an edit may clear it; every other kind IS its body - a kudos
  // has nothing else, and an announcement with only a heading is not an announcement - so emptying one is
  // refused here rather than silently stored, the same rule create holds new rows to.
  if (has("body")) {
    if (!patch.body?.trim() && row.kind !== "poll") throw invalidArgument("body is required");
    set.body = patch.body;
    set.bodyText = richToPlain(patch.body);
  }
  // Re-pointing the author is the one way an edit could manufacture a self-kudo that create refuses: the
  // recipient is fixed at creation, so setting the author to that same employee would leave a row where the
  // giver and the recognized person are one. Held to the same rule as create, whoever is editing.
  if (has("author")) {
    const nextAuthorId = idFromPath(patch.author) ?? null;
    if (row.kind === "kudos" && nextAuthorId && nextAuthorId === row.recipientEmployeeId) {
      throw invalidArgument("a kudo's author can't be its recipient");
    }
    set.authorEmployeeId = nextAuthorId;
  }
  if (has("publish_time")) set.publishTime = patch.publish_time ? new Date(patch.publish_time) : null;
  // A poll's deadline can be moved, set, or cleared - this is how a poll is closed early (set to now) or
  // reopened (cleared). Options and the single/multi mode stay fixed at creation.
  if (has("closes_time") && row.kind === "poll") set.pollClosesAt = patch.closes_time ? new Date(patch.closes_time) : null;
  // Card art is editable on every kind: swapping the sticker changes nothing about what the post says. Null clears
  // it outright - no art, a kudos included. The placement is a separate field on purpose, so swapping the picture
  // leaves it where the author put it.
  if (has("illustration")) set.illustration = normalizeIllustration(patch.illustration);
  if (has("illustration_layout")) set.illustrationLayout = normalizeIllustrationLayout(patch.illustration_layout);
  // Only a kudos has a recipient block to move; on any other kind the field is meaningless and ignored.
  if (has("recipient_layout") && row.kind === "kudos") set.recipientLayout = normalizeRecipientLayout(patch.recipient_layout);
  if (has("title_align")) set.titleAlign = patch.title_align ?? null;
  if (has("body_valign")) set.bodyValign = patch.body_valign ?? null;
  // Recognition meta belongs to a kudos row only; on any other kind these are meaningless, so they are ignored
  // rather than stored. `points` is re-derived from the new level exactly as it was at creation - never taken from
  // the client - so correcting a level moves the leaderboard honestly and a blank/unknown level scores 0.
  if (row.kind === "kudos") {
    if (has("category")) set.category = patch.category?.trim() || null;
    if (has("value")) set.value = patch.value?.trim() || null;
    if (has("level")) {
      const level = patch.level?.trim() || null;
      set.level = level;
      set.points = pointsForLevel(await getSettingValue(deps, "kudos", DEFAULT_KUDOS_CONFIG), level);
    }
  }
  const updated = (await deps.db.update(schema.announcements).set(set).where(eq(schema.announcements.uuid, id)).returning())[0]!;
  await audit(deps, actor, "announcement.update", "announcements", id, diffMeta(row, updated, set), updated);
  // An edit notifies the people it NEWLY names (the old body is the baseline, so nobody hears about the same
  // mention twice). A draft stays silent - publishing is what tells anyone anything about it.
  if (updated.published) await notifyMentions(deps, actor, { announcementId: id, body: updated.body, previousBody: row.body, title: updated.title });
  return updated;
}

export async function deleteAnnouncement(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.announcements, "announcement", "announcements", id, ifMatch);
}

export async function restoreAnnouncement(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.announcements, "announcement", "announcements", id);
}

export async function purgeAnnouncement(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.announcements, "announcement", "announcements", id, ifMatch);
}

// Pin a post to the top of the board, or take it back down. Who may pin is entirely the middleware's
// :pin/:unpin verb grant (HR/moderation via announcements.**); this only flips the timestamp. Idempotent:
// re-pinning a pinned post refreshes its pin time (moves it to the front of the pinned group), unpinning an
// unpinned post is a no-op.
export async function setPinned(deps: Deps, actor: AppUser, id: string, pinned: boolean) {
  const row = await getAnnouncement(deps, actor, id);
  if (pinned && !row.published) throw invalidArgument("a draft can't be pinned - publish it first");
  const updated = (await deps.db
    .update(schema.announcements)
    .set({ pinnedAt: pinned ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.announcements.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, `announcement.${pinned ? "pin" : "unpin"}`, "announcements", id, undefined, updated);
  return updated;
}

// Record that the caller opened a board item. Idempotent (no-op when a row already exists, or when the actor
// has no employee record). Returns the announcement row so the route can re-serialize with the read flag.
export async function markAnnouncementRead(deps: Deps, actor: AppUser, id: string) {
  const row = await getAnnouncement(deps, actor, id);
  // The author is not a reader of their own post - never record a receipt for them.
  if (actor.employeeId && actor.employeeId !== row.authorEmployeeId) {
    const existing = (await deps.db
      .select({ uuid: schema.announcementReads.uuid })
      .from(schema.announcementReads)
      .where(and(eq(schema.announcementReads.announcementId, id), eq(schema.announcementReads.employeeId, actor.employeeId)))
      .limit(1))[0];
    if (!existing) await deps.db.insert(schema.announcementReads).values({ announcementId: id, employeeId: actor.employeeId });
  }
  return row;
}

// Mark every post the caller can see as read, in one pass - the "Mark all read" action behind the board's
// Unread chip. `scope` is the SAME visibility the list endpoint binds (editors see drafts too), so this can
// only touch posts the caller was already shown. Own posts are skipped like markAnnouncementRead skips them.
//
// Two reads and one batched write, whatever the board's size: the whole table, the caller's own receipts,
// then the missing rows inserted as one atomic D1 batch (chunked for the bound-param cap).
export async function markAllAnnouncementsRead(deps: Deps, actor: AppUser, scope: ListScope) {
  if (!actor.employeeId) throw invalidArgument("a read receipt needs an employee identity");
  const me = actor.employeeId;
  const visible = visibleByDelete(await deps.db.select().from(schema.announcements), false)
    .filter((a) => scope.seeRestricted || (a.published && !a.disabled))
    .filter((a) => a.authorEmployeeId !== me);
  const already = new Set(
    (await deps.db
      .select({ id: schema.announcementReads.announcementId })
      .from(schema.announcementReads)
      .where(eq(schema.announcementReads.employeeId, me))).map((r) => r.id),
  );
  const missing = visible.filter((a) => !already.has(a.uuid));
  if (!missing.length) return { marked: 0 };
  // Two bound params per row (announcement + employee), so ~8 rows a statement stays clear of D1's 100.
  await runBatch(
    deps.db,
    chunk(missing, 8).map((rows) => deps.db.insert(schema.announcementReads).values(rows.map((a) => ({ announcementId: a.uuid, employeeId: me })))),
  );
  // No audit line, for the same reason markAnnouncementRead writes none: a read receipt is the caller's own
  // state, not an accountability event (see NO_AUDIT_VERBS).
  return { marked: missing.length };
}

// Set the caller's reaction on a post. One reaction per viewer: reacting with the emoji they already chose
// clears it (toggle off); reacting with a different emoji replaces the previous one. Returns the announcement
// row so the route can re-serialize with reaction counts.
export async function toggleReaction(deps: Deps, actor: AppUser, id: string, emoji: string, replyId?: string | null) {
  const glyph = (emoji ?? "").trim();
  if (!glyph) throw invalidArgument("emoji is required");
  const row = await getAnnouncement(deps, actor, id);
  if (!actor.employeeId) throw invalidArgument("a reaction needs an employee identity");
  // The target is the post (reply_id null) or a specific reply. One reaction per viewer per target.
  const rx = schema.announcementReactions;
  const target = and(
    eq(rx.announcementId, id),
    replyId ? eq(rx.replyId, replyId) : isNull(rx.replyId),
    eq(rx.employeeId, actor.employeeId),
  );
  const mine = await deps.db.select({ emoji: rx.emoji }).from(rx).where(target);
  // Clear any existing reaction by this viewer on this target, then re-add unless they tapped the same one.
  if (mine.length) await deps.db.delete(rx).where(target);
  if (!mine.some((m) => m.emoji === glyph)) await deps.db.insert(rx).values({ announcementId: id, replyId: replyId ?? null, employeeId: actor.employeeId, emoji: glyph });
  return row;
}

// How many reactors a group names. A reaction is a public act (the chip already says how many), so WHO
// reacted is shown on hover - but a company-wide 👍 would otherwise put every employee id on the wire for
// every card in the page. Past the cap the count carries the rest ("and 12 others").
const MAX_REACTORS = 12;

export type ReactionGroup = { emoji: string; count: number; reacted: boolean; reactors: string[] };

// Group raw reaction rows into { emoji, count, reacted, reactors } lists keyed by `key` (a post id or a
// reply id), ordered by count desc then emoji so the chips render stably. `reacted` = the given viewer
// reacted; `reactors` = up to MAX_REACTORS employee ids behind the count, for the chip's hover list.
function groupReactions(rows: { key: string; e: string; emoji: string }[], viewerEmployeeId: string | null) {
  const byKey = new Map<string, Map<string, { count: number; reacted: boolean; reactors: string[] }>>();
  for (const r of rows) {
    const perEmoji = byKey.get(r.key) ?? new Map();
    const cur = perEmoji.get(r.emoji) ?? { count: 0, reacted: false, reactors: [] as string[] };
    cur.count += 1;
    if (viewerEmployeeId && r.e === viewerEmployeeId) cur.reacted = true;
    if (cur.reactors.length < MAX_REACTORS) cur.reactors.push(r.e);
    perEmoji.set(r.emoji, cur);
    byKey.set(r.key, perEmoji);
  }
  const out = new Map<string, ReactionGroup[]>();
  for (const [k, perEmoji] of byKey) {
    out.set(k, [...perEmoji.entries()].map(([emoji, v]) => ({ emoji, count: v.count, reacted: v.reacted, reactors: v.reactors })).sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)));
  }
  return out;
}

// Post-level reactions (reply_id IS NULL) for a set of announcements, grouped per post.
export async function reactionsFor(deps: Deps, announcementIds: string[], viewerEmployeeId: string | null) {
  if (!announcementIds.length) return new Map<string, ReactionGroup[]>();
  const rx = schema.announcementReactions;
  const rows = await deps.db
    .select({ key: rx.announcementId, e: rx.employeeId, emoji: rx.emoji })
    .from(rx)
    .where(and(inArray(rx.announcementId, announcementIds), isNull(rx.replyId)));
  return groupReactions(rows, viewerEmployeeId);
}

// Append a reply to a post. Returns the announcement row so the route can re-serialize with the new thread.
export async function addReply(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("reply body is required");
  const row = await getAnnouncement(deps, actor, id);
  assertNotLocked(row);
  await deps.db.insert(schema.announcementReplies).values({ announcementId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "announcement.reply", "announcements", id);
  // Notify the post's author that someone replied (skip replying to your own post).
  if (row.authorEmployeeId && row.authorEmployeeId !== actor.employeeId)
    await notify(deps, { recipient: row.authorEmployeeId, type: "announcement.reply", title: "New reply to your post", body: richExcerpt(text, 120), link: "announcements", subject: `announcements/${id}`, actorId: actor.employeeId });
  // Someone named in the reply hears about it too - that is how a thread pulls in the person who can answer.
  await notifyMentions(deps, actor, { announcementId: id, body: text, title: row.title });
  return row;
}

// Replies for a set of announcements, grouped oldest-first by announcement id (one query for a whole page),
// each with its own grouped reactions attached (`_reactions`) for the reply-level reaction bars.
export async function repliesFor(deps: Deps, announcementIds: string[], viewerEmployeeId: string | null) {
  const map = new Map<string, (typeof schema.announcementReplies.$inferSelect)[]>();
  if (!announcementIds.length) return map;
  const rows = await deps.db
    .select()
    .from(schema.announcementReplies)
    .where(inArray(schema.announcementReplies.announcementId, announcementIds))
    .orderBy(schema.announcementReplies.createdAt);
  const replyIds = rows.map((r) => r.uuid);
  const rx = schema.announcementReactions;
  const reactRows = replyIds.length
    ? await deps.db.select({ key: rx.replyId, e: rx.employeeId, emoji: rx.emoji }).from(rx).where(inArray(rx.replyId, replyIds))
    : [];
  const byReply = groupReactions(reactRows.map((r) => ({ key: r.key as string, e: r.e, emoji: r.emoji })), viewerEmployeeId);
  for (const r of rows) {
    (r as any)._reactions = byReply.get(r.uuid) ?? [];
    const list = map.get(r.announcementId) ?? [];
    list.push(r);
    map.set(r.announcementId, list);
  }
  return map;
}

// A poll is closed (no more voting) when its post is locked or its deadline has passed.
export function pollClosed(row: { locked?: boolean | null; pollClosesAt?: Date | null }): boolean {
  return !!row.locked || (!!row.pollClosesAt && Date.now() > +new Date(row.pollClosesAt));
}

// Cast / change / clear the caller's vote on a poll. Single-choice: selecting an option replaces any prior
// choice; re-selecting the same one clears it. Multi-choice: each call toggles that one option. Blocked once
// the poll is closed. Returns the announcement row so the route can re-serialize with the tallies.
export async function castVote(deps: Deps, actor: AppUser, id: string, optionId: string) {
  const row = await getAnnouncement(deps, actor, id);
  if (row.kind !== "poll") throw invalidArgument("not a poll");
  if (pollClosed(row)) throw aborted("poll is closed");
  if (!actor.employeeId) throw invalidArgument("a vote needs an employee identity");
  const opt = (await deps.db
    .select({ uuid: schema.announcementPollOptions.uuid })
    .from(schema.announcementPollOptions)
    .where(and(eq(schema.announcementPollOptions.uuid, optionId), eq(schema.announcementPollOptions.announcementId, id)))
    .limit(1))[0];
  if (!opt) throw invalidArgument("unknown poll option");
  const pv = schema.announcementPollVotes;
  const mine = await deps.db.select({ optionId: pv.optionId }).from(pv).where(and(eq(pv.announcementId, id), eq(pv.employeeId, actor.employeeId)));
  const already = mine.some((m) => m.optionId === optionId);
  if (row.pollMultiple) {
    // Toggle just this option.
    if (already) await deps.db.delete(pv).where(and(eq(pv.announcementId, id), eq(pv.employeeId, actor.employeeId), eq(pv.optionId, optionId)));
    else await deps.db.insert(pv).values({ announcementId: id, optionId, employeeId: actor.employeeId });
  } else {
    // Single choice: clear any prior vote, then add this one unless they tapped their current choice (toggle off).
    if (mine.length) await deps.db.delete(pv).where(and(eq(pv.announcementId, id), eq(pv.employeeId, actor.employeeId)));
    if (!already) await deps.db.insert(pv).values({ announcementId: id, optionId, employeeId: actor.employeeId });
  }
  return row;
}

export type PollData = {
  options: { id: string; label: string; votes: number; voted: boolean }[];
  totalVotes: number; // distinct voters (a multi-choice voter still counts once)
  voted: boolean; // whether the viewer has cast any vote
};

// Poll options + tallies for a set of announcements, keyed by announcement id. Anonymous: only counts and the
// viewer's own selections cross the wire. One pair of queries for a whole page (options, then votes).
export async function pollDataFor(deps: Deps, announcementIds: string[], viewerEmployeeId: string | null) {
  const map = new Map<string, PollData>();
  if (!announcementIds.length) return map;
  const opts = await deps.db
    .select()
    .from(schema.announcementPollOptions)
    .where(inArray(schema.announcementPollOptions.announcementId, announcementIds))
    .orderBy(schema.announcementPollOptions.position);
  if (!opts.length) return map;
  const votes = await deps.db
    .select({ a: schema.announcementPollVotes.announcementId, o: schema.announcementPollVotes.optionId, e: schema.announcementPollVotes.employeeId })
    .from(schema.announcementPollVotes)
    .where(inArray(schema.announcementPollVotes.announcementId, announcementIds));
  const countByOption = new Map<string, number>();
  const myOptions = new Set<string>();
  const votersByAnn = new Map<string, Set<string>>();
  for (const v of votes) {
    countByOption.set(v.o, (countByOption.get(v.o) ?? 0) + 1);
    if (viewerEmployeeId && v.e === viewerEmployeeId) myOptions.add(v.o);
    (votersByAnn.get(v.a) ?? votersByAnn.set(v.a, new Set()).get(v.a)!).add(v.e);
  }
  for (const o of opts) {
    const cur = map.get(o.announcementId) ?? { options: [], totalVotes: votersByAnn.get(o.announcementId)?.size ?? 0, voted: false };
    const voted = myOptions.has(o.uuid);
    cur.options.push({ id: o.uuid, label: o.label, votes: countByOption.get(o.uuid) ?? 0, voted });
    if (voted) cur.voted = true;
    map.set(o.announcementId, cur);
  }
  return map;
}

// Reader employee ids for a set of announcements, grouped by announcement id. Used to attach the "Read by"
// list (author/HR only) and the caller's own read flag in one pair of queries for a whole page.
export async function readsFor(deps: Deps, announcementIds: string[]) {
  const map = new Map<string, string[]>();
  if (!announcementIds.length) return map;
  const rows = await deps.db
    .select({ a: schema.announcementReads.announcementId, e: schema.announcementReads.employeeId })
    .from(schema.announcementReads)
    .where(inArray(schema.announcementReads.announcementId, announcementIds));
  for (const r of rows) {
    const list = map.get(r.a) ?? [];
    list.push(r.e);
    map.set(r.a, list);
  }
  return map;
}
