import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listAnnouncements, createAnnouncement, updateAnnouncement, markAnnouncementRead, readsFor, toggleReaction,
  reactionsFor, addReply, repliesFor, castVote, pollDataFor, setPinned, markAllAnnouncementsRead, readersVisibleTo,
  type AnnouncementInput,
} from "../services/announcements";
import { toAnnouncementResource } from "../http/serialize";
import { accessHint, withAccess } from "../http/accessHint";
import { WRAP_MODES } from "../domain/illustration";

const COL = "announcements";

// Everything a board card carries beyond its own row: the caller's read receipt, the reaction groups, the reply
// thread and the poll tallies - one query each per PAGE, not per card. `_readers` is the receipt list minus the
// author, since an author is not a reader of their own post; `serialize` hands it out only to those who may see
// it. The factory applies this to the list, the item read and every write response alike.
const decorateAnnouncements = async (deps: Deps, actor: AppUser, rows: any[]) => {
  const ids = rows.map((r) => r.uuid);
  const me = actor.employeeId ?? null;
  const [readMap, reactMap, replyMap, pollMap] = await Promise.all([
    readsFor(deps, ids),
    reactionsFor(deps, ids, me),
    repliesFor(deps, ids, me),
    pollDataFor(deps, ids, me),
  ]);
  return rows.map((row) => {
    const readers = (readMap.get(row.uuid) ?? []).filter((id) => id !== row.authorEmployeeId);
    const isAuthor = !!row.authorEmployeeId && row.authorEmployeeId === me;
    return Object.assign(row, {
      _readers: readers,
      // An author has read their own post, so it never shows up as unread to them. `_read` drives the
      // dashboard's unread widget.
      _read: isAuthor || (!!me && readers.includes(me)),
      _reactions: reactMap.get(row.uuid) ?? [],
      _replies: replyMap.get(row.uuid) ?? [],
      _poll: pollMap.get(row.uuid),
    });
  });
};

// The "Read by" list is exposed ONLY to the post's author or to someone who may edit it. That second half is a
// question about what the CALLER MAY DO, so it is answered from `can` - the access hint the factory computes
// BEFORE serializing - not by a second access decision here. Reader identities never reach any other viewer.
// read_by uses `employees/<id>` refs, which the outbound wire-id codec encodes like any other ref.
const serializeAnnouncement = (row: any, user?: AppUser, can?: string[]) => {
  const res = toAnnouncementResource(row) as Record<string, unknown>;
  const readers = row._readers as string[] | undefined;
  if (readers && readersVisibleTo(row, user?.employeeId, can)) {
    res.read_by = readers.map((id) => `employees/${id}`);
    res.read_count = readers.length;
  }
  return res;
};

// One freshly written row, answered the way the factory answers one: decorate, hint, serialize, attach. The
// collection-level custom methods below are their own routes (they are gated by their own verbs, not by the
// collection's write level), so they compose the same three steps rather than repeating the shape.
const respondOne = async (c: Context<AppEnv>, row: { uuid: string; code: string | null }) => {
  const user = c.get("user");
  const [decorated] = await decorateAnnouncements(c.get("deps"), user, [row]);
  const grant = c.get("objectGrant");
  const hint = accessHint(user, COL, row.code, grant);
  return c.json(withAccess(serializeAnnouncement(decorated, user, hint.can) as object, user, COL, row.code, grant, undefined, hint));
};

// Where the sticker sits on the card, as fractions of the card's width - see normalizeIllustrationLayout, which
// clamps them. Absent/null means the default inline placement; all four are required together, since a partial
// placement has no reading.
const illustrationLayout = z.object({ x: z.number(), y: z.number(), size: z.number(), opacity: z.number(), wrap: z.enum(WRAP_MODES).optional() }).strict().nullable().optional();
const titleAlign = z.enum(["left", "center", "right"]).nullable().optional();
// Where the words sit vertically in a card that is taller than they are - see the schema note.
const bodyValign = z.enum(["top", "middle", "bottom"]).nullable().optional();
// Kudos only: where the recipient block sits and how big it is, as fractions of the card's width. No opacity -
// see normalizeRecipientLayout.
const recipientLayout = z.object({ x: z.number(), y: z.number(), size: z.number(), wrap: z.enum(WRAP_MODES).optional() }).strict().nullable().optional();
// Poll authoring fields, shared by the write-gated create and the `post` gate. `options` (>=2) makes it a poll.
const pollFields = {
  options: z.array(z.string().min(1)).min(2).optional(),
  multiple: z.boolean().optional(),
  closes_time: z.string().datetime({ offset: true }).nullable().optional(),
};
const writeSchema = z.object({
  title: z.string().min(1).optional(),
  // Empty is allowed through: a poll's description is optional, so clearing it is an edit like any other. Which
  // kinds may actually go without one is decided per kind in the service (create and update both), not here -
  // this schema cannot see the row's kind on a PATCH.
  body: z.string().optional(),
  kind: z.enum(["announcement", "post", "poll"]).optional(),
  author: z.string().nullable().optional(),
  // A malformed timestamp would make an Invalid-Date publishTime, which the scheduler's `lte` never matches -
  // a draft scheduled with one would silently never go out. Rejected here instead.
  publish_time: z.string().datetime({ offset: true }).nullable().optional(),
  // Create only - see the note on AnnouncementInput.published. `updateAnnouncement` deliberately ignores it, so
  // going live is always the `:publish` verb: one gate, one broadcast, one audit line.
  published: z.boolean().optional(),
  // Kudos recognition meta, editable after the fact: fixing the level or category (or picking better art) is not a
  // rewrite of who was recognized. Null clears any of them. `points` stays server-derived from `level` - see
  // updateAnnouncement - so an edit can no more inflate recognition than the original giveKudos could. The
  // recipient is deliberately absent: recognition has already been announced and notified to that person, so
  // redirecting it would mean a new kudo, not an edit.
  category: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  // Card art, on any kind - see normalizeIllustration. Null clears it (and its placement with it).
  illustration: z.string().max(120).nullable().optional(),
  illustration_layout: illustrationLayout,
  recipient_layout: recipientLayout,
  title_align: titleAlign,
  body_valign: bodyValign,
  // Who it is for, and whether it also goes out as email. Both are about reach, not access - see the schema
  // note on audience_department_id - and both are settable only while the post is still a draft.
  audience_scope: z.enum(["everyone", "department", "none"]).optional(),
  audience_department: z.string().nullable().optional(),
  email_audience: z.boolean().optional(),
  ...pollFields,
}).strict();
// Generic board post (or poll): title + body, optionally poll options. The kind is forced to "post"/"poll" and
// the author to the caller, so the `post` verb (grantable to anyone via the ACL) can't be used to forge an
// announcement or another author. A poll's body is optional.
const postSchema = z.object({ title: z.string().min(1), body: z.string().min(1).optional(), illustration: z.string().max(120).nullable().optional(), illustration_layout: illustrationLayout, title_align: titleAlign, body_valign: bodyValign, ...pollFields }).strict();

// Collection-level custom method `announcements:post` (mounted at the full path in index.ts, like
// employees:upcomingCelebrations). Authz resolves it to the `announcements.post` verb - the "anyone can post"
// gate, separate from the write-gated create (announcements).
export const announcementPost = new Hono<AppEnv>().post("/", zValidator("json", postSchema), async (c) => {
  const { title, body, options, multiple, closes_time, illustration, illustration_layout, title_align, body_valign } = c.req.valid("json");
  // Options present -> a poll; otherwise a generic post. Either way the kind/author are forced server-side.
  const kind = options && options.length ? "poll" : "post";
  return respondOne(c, await createAnnouncement(c.get("deps"), c.get("user"), { title, body, kind, options, multiple, closes_time, illustration, illustration_layout, title_align, body_valign }));
});

// Collection-level custom method `announcements:markAllRead` (mounted at the full path in index.ts, like
// `announcements:post`). Clears the board's unread state in one call - the same self-action as `:markRead`,
// which is why every employee holds it. Returns the count it stamped rather than a resource: nothing about
// any single post changed, and the client refetches the board anyway.
export const announcementMarkAllRead = new Hono<AppEnv>().post("/", async (c) => {
  const { marked } = await markAllAnnouncementsRead(c.get("deps"), c.get("user"), c.get("scope"));
  return c.json({ marked });
});

// Give-kudos input: a recipient + message + optional recognition meta. `points` is NOT accepted (snapshotted
// server-side from `level`).
const giveKudosSchema = z.object({
  // Exactly one target: a single employee (recipient) or a whole department (recipient_department).
  recipient: z.string().min(1).optional(),
  recipient_department: z.string().min(1).optional(),
  message: z.string().min(1),
  value: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  // Art for the card, as a `<category>/<slug>` path into the bundled illustration set. The service pins the
  // shape (see normalizeIllustration); a length cap here keeps a junk body cheap to reject.
  illustration: z.string().max(120).nullable().optional(),
  illustration_layout: illustrationLayout,
  recipient_layout: recipientLayout,
  body_valign: bodyValign,
}).strict().refine((b) => !!b.recipient !== !!b.recipient_department, {
  message: "provide exactly one of recipient or recipient_department",
});

// Collection-level custom method `announcements:giveKudos` (mounted at the full path in index.ts, like
// `announcements:post`). Authz resolves it to the `announcements.giveKudos` verb - the open recognition-wall
// gate, separate from posting/announcing. Forces kind="kudos" + author=caller (the giver).
export const announcementGiveKudos = new Hono<AppEnv>().post("/", zValidator("json", giveKudosSchema), async (c) => {
  const { recipient, recipient_department, message, value, category, level, illustration, illustration_layout, recipient_layout, body_valign } = c.req.valid("json");
  return respondOne(c, await createAnnouncement(c.get("deps"), c.get("user"), { kind: "kudos", recipient, recipient_department, message, value, category, level, illustration, illustration_layout, recipient_layout, body_valign }));
});

// The board: announcements, generic posts, polls and kudos, all one collection. Create and update stay the
// service's own (each kind has its own rules, a create broadcasts, an edit re-derives kudos points), the state
// moves through the shared lifecycle verbs (:publish stamps publish_time and broadcasts), and delete/restore are
// the shared soft-delete lane.
export const announcements = collectionRoutes<AnnouncementInput, typeof schema.announcements>({
  table: schema.announcements,
  collection: COL,
  auditName: "announcement",
  notFound: "announcement not found",
  param: "announcement_id",
  writeSchema,
  publish: true,
  publishTime: true,
  serialize: serializeAnnouncement,
  decorate: decorateAnnouncements,
  overrides: {
    create: (deps, actor, input, id) => createAnnouncement(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateAnnouncement(deps, actor, id, patch, ifMatch),
  },
  // The board's own list: state visibility (drafts and disabled posts are editors-only) is bound in SQL there,
  // alongside the caller's scope.
  list: (c, page) =>
    listAnnouncements(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.req.query("q")),
  verbs: {
    // Idempotent self-action: record that the caller opened this post.
    markRead: { run: (deps, user, id) => markAnnouncementRead(deps, user, id) },
    // Toggle the caller's reaction with the given emoji on the post, or on a reply when `reply` (its id) is given.
    react: {
      schema: z.object({ emoji: z.string().min(1), reply: z.string().optional() }).strict(),
      run: (deps, user, id, b) => toggleReaction(deps, user, id, b.emoji, b.reply ?? null),
    },
    reply: { schema: z.object({ body: z.string().min(1) }).strict(), run: (deps, user, id, b) => addReply(deps, user, id, b.body) },
    // Cast / change / clear the caller's vote on a poll option.
    vote: { schema: z.object({ option: z.string().min(1) }).strict(), run: (deps, user, id, b) => castVote(deps, user, id, b.option) },
    // Pin the post to the top of the board / take it down (moderation - gated by the verb grant).
    pin: { run: (deps, user, id) => setPinned(deps, user, id, true) },
    unpin: { run: (deps, user, id) => setPinned(deps, user, id, false) },
  },
});
