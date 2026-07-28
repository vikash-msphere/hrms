import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listAnnouncements, getAnnouncement, createAnnouncement, updateAnnouncement, deleteAnnouncement, restoreAnnouncement, purgeAnnouncement, markAnnouncementRead, readsFor, toggleReaction, reactionsFor, addReply, repliesFor, castVote, pollDataFor } from "../services/announcements";
import { toAnnouncementResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import type { AppUser } from "../env";
import type { Grant } from "../domain/permissions";
import { WRAP_MODES } from "../domain/illustration";

const COL = "announcements";

// Serialize a board row with its read info. `_read` (the caller's own receipt) drives the dashboard "unread"
// widget. The "Read by" list is exposed ONLY to the post's author or to an editor - decided here NOT by an
// access call but by the access affordance the middleware already produced (access.can includes write-level
// "update"), so reader identities never reach other viewers. read_by uses `employees/<id>` strings, which the
// outbound wire-id codec encodes like any other ref.
function serializeWithReads(user: AppUser, row: any, readers: string[], reactions: { emoji: string; count: number; reacted: boolean }[], replies: any[], poll: import("../services/announcements").PollData | undefined, grant?: Grant) {
  const isAuthor = !!row.authorEmployeeId && row.authorEmployeeId === user.employeeId;
  // The author isn't a reader: drop them from the receipt list, and count them as having read their own post
  // so it never shows up as unread to them.
  const others = readers.filter((id) => id !== row.authorEmployeeId);
  row._read = isAuthor || (!!user.employeeId && others.includes(user.employeeId));
  row._reactions = reactions;
  row._replies = replies;
  row._poll = poll;
  const res = withAccess(toAnnouncementResource(row), user, COL, row?.code, grant);
  if (res.access.can.includes("update") || isAuthor) {
    (res as any).read_by = others.map((id) => `employees/${id}`);
    (res as any).read_count = others.length;
  }
  return res;
}
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
  closes_time: z.string().nullable().optional(),
};
const writeSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  kind: z.enum(["announcement", "post", "poll"]).optional(),
  author: z.string().nullable().optional(),
  publish_time: z.string().nullable().optional(),
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
  const row = await createAnnouncement(c.get("deps"), c.get("user"), { title, body, kind, options, multiple, closes_time, illustration, illustration_layout, title_align, body_valign });
  const user = c.get("user");
  const pollMap = await pollDataFor(c.get("deps"), [row.uuid], user.employeeId ?? null);
  return c.json(serializeWithReads(user, row, [], [], [], pollMap.get(row.uuid), c.get("objectGrant")));
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
  const user = c.get("user");
  const row = await createAnnouncement(c.get("deps"), user, { kind: "kudos", recipient, recipient_department, message, value, category, level, illustration, illustration_layout, recipient_layout, body_valign });
  return c.json(serializeWithReads(user, row, [], [], [], undefined, c.get("objectGrant")));
});

export const announcements = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listAnnouncements(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const ids = items.map((r) => r.uuid);
    const [readMap, reactMap, replyMap, pollMap] = await Promise.all([readsFor(c.get("deps"), ids), reactionsFor(c.get("deps"), ids, user.employeeId ?? null), repliesFor(c.get("deps"), ids, user.employeeId ?? null), pollDataFor(c.get("deps"), ids, user.employeeId ?? null)]);
    return c.json({ results: items.map((r) => serializeWithReads(user, r, readMap.get(r.uuid) ?? [], reactMap.get(r.uuid) ?? [], replyMap.get(r.uuid) ?? [], pollMap.get(r.uuid))), next_page_token: nextPageToken });
  })
  .get("/:announcement_id", async (c) => {
    const user = c.get("user");
    const row = await getAnnouncement(c.get("deps"), user, c.req.param("announcement_id")!);
    const [readMap, reactMap, replyMap, pollMap] = await Promise.all([readsFor(c.get("deps"), [row.uuid]), reactionsFor(c.get("deps"), [row.uuid], user.employeeId ?? null), repliesFor(c.get("deps"), [row.uuid], user.employeeId ?? null), pollDataFor(c.get("deps"), [row.uuid], user.employeeId ?? null)]);
    return c.json(serializeWithReads(user, row, readMap.get(row.uuid) ?? [], reactMap.get(row.uuid) ?? [], replyMap.get(row.uuid) ?? [], pollMap.get(row.uuid), c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const user = c.get("user");
    const b = c.req.valid("json");
    const row = await createAnnouncement(c.get("deps"), user, b, c.req.query("id"));
    const pollMap = await pollDataFor(c.get("deps"), [row.uuid], user.employeeId ?? null);
    return c.json(serializeWithReads(user, row, [], [], [], pollMap.get(row.uuid), c.get("objectGrant")));
  })
  .patch("/:announcement_id", zValidator("json", writeSchema), async (c) => {
    const user = c.get("user");
    const row = await updateAnnouncement(c.get("deps"), user, c.req.param("announcement_id")!, c.req.valid("json"), c.req.header("If-Match"));
    const [readMap, reactMap, replyMap, pollMap] = await Promise.all([readsFor(c.get("deps"), [row.uuid]), reactionsFor(c.get("deps"), [row.uuid], user.employeeId ?? null), repliesFor(c.get("deps"), [row.uuid], user.employeeId ?? null), pollDataFor(c.get("deps"), [row.uuid], user.employeeId ?? null)]);
    return c.json(serializeWithReads(user, row, readMap.get(row.uuid) ?? [], reactMap.get(row.uuid) ?? [], replyMap.get(row.uuid) ?? [], pollMap.get(row.uuid), c.get("objectGrant")));
  })
  .delete("/:announcement_id", async (c) => {
    const id = c.req.param("announcement_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeAnnouncement(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteAnnouncement(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:announcement_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.announcements, singular: "announcement", collection: "announcements", serialize: toAnnouncementResource, publish: true, publishTime: true });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    const reserialize = async (row: any) => {
      const [readMap, reactMap, replyMap, pollMap] = await Promise.all([readsFor(c.get("deps"), [row.uuid]), reactionsFor(c.get("deps"), [row.uuid], user.employeeId ?? null), repliesFor(c.get("deps"), [row.uuid], user.employeeId ?? null), pollDataFor(c.get("deps"), [row.uuid], user.employeeId ?? null)]);
      return serializeWithReads(user, row, readMap.get(row.uuid) ?? [], reactMap.get(row.uuid) ?? [], replyMap.get(row.uuid) ?? [], pollMap.get(row.uuid), c.get("objectGrant"));
    };
    if (verb === "markRead") {
      // Idempotent self-action: record that the caller opened this post, then re-serialize with read info.
      return c.json(await reserialize(await markAnnouncementRead(c.get("deps"), user, id)));
    }
    if (verb === "react") {
      // Toggle the caller's reaction with the given emoji on the post, or on a reply when `reply` (its id) is
      // given. Then re-serialize with the updated counts.
      const { emoji, reply } = z.object({ emoji: z.string().min(1), reply: z.string().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(await reserialize(await toggleReaction(c.get("deps"), user, id, emoji, reply ?? null)));
    }
    if (verb === "reply") {
      // Append a reply, then re-serialize with the updated thread.
      const { body } = z.object({ body: z.string().min(1) }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(await reserialize(await addReply(c.get("deps"), user, id, body)));
    }
    if (verb === "vote") {
      // Cast / change / clear the caller's vote on a poll option, then re-serialize with the new tallies.
      const { option } = z.object({ option: z.string().min(1) }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(await reserialize(await castVote(c.get("deps"), user, id, option)));
    }
    if (verb !== "restore") return c.notFound();
    const row = await restoreAnnouncement(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toAnnouncementResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });
