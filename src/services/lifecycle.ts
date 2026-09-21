// Generic item lifecycle shared across resources: enable/disable (exclude from use),
// lock/unlock (protect from edits), and publish/unpublish (draft state).
//
// Who may call these verbs is decided ENTIRELY by the middleware (the :enable/:disable/:lock/:unlock/
// :publish/:unpublish grant, code-scoped). This service only performs the state transition and writes
// audit - it makes NO access decision. The `locked` precondition itself lives in services/lockGuard.ts and is
// re-exported below, so the write paths that only need to REFUSE an edit don't import this module's graph.
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notifyMany, activeEmployeeIds, audienceEmployeeIds } from "./notifications";
import { emailAnnouncement } from "./announcements";
import type * as schema from "../db/schema";
import { emitEvent } from "./eventBus";
import { notFound } from "../lib/errors";
import { assertNotLocked } from "./lockGuard";
import { boardPostLink, postedTitle } from "../domain/board";
import { notifyMentions } from "./mentions";
import { isModeratable } from "../domain/moderation";
import { moderationGate, moderationGateOn, scanSoon } from "./moderation";

type Table = any;
type Row = {
  uuid: string;
  locked?: boolean | null;
  lockedBy?: string | null;
  [k: string]: unknown;
};

async function fetchRow(deps: Deps, table: Table, id: string): Promise<Row | undefined> {
  return (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0] as Row | undefined;
}

// Lives in services/lockGuard.ts (a leaf) so crud.ts / softDelete.ts can enforce it without importing this
// module's notification + event-bus graph. Re-exported here because callers have always found it at this path.
export { assertNotLocked };

async function set(deps: Deps, table: Table, id: string, fields: Record<string, unknown>) {
  // `.returning()` rather than an UPDATE followed by a SELECT. The write already knows the row it produced, so
  // reading it back was a second subrequest for bytes the database had just handed over - and this is the
  // shared lane for :enable/:disable/:lock/:unlock across ~60 collections, so it is three subrequests per verb
  // (fetch, update, refetch) against a per-invocation budget of 50 that this codebase counts carefully
  // everywhere else. `setPublished` below already writes this way.
  //
  // Same answer on the empty case: zero rows means the row was hard-purged between the fetch above and this
  // write, and `undefined` is exactly what the re-read returned for it.
  return ((await deps.db.update(table).set({ ...fields, updatedAt: new Date() }).where(eq(table.uuid, id)).returning()) as Row[])[0];
}

// The three lifecycle verbs below record no meta, and that is the decision rather than an oversight: each
// flips ONE boolean whose name is already the action ("disabled", "locked", "published"), so a diff would say
// `disabled: false → true` under an entry that already reads "disabled". The snapshot is still passed, because
// that is what gives the entry its point-in-time label.
export async function setDisabled(deps: Deps, actor: AppUser, table: Table, singular: string, collection: string, id: string, disabled: boolean) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  assertNotLocked(row);
  const out = await set(deps, table, id, { disabled });
  await audit(deps, actor, `${singular}.${disabled ? "disable" : "enable"}`, collection, id, undefined, out ?? row);
  return out;
}

export async function setLocked(deps: Deps, actor: AppUser, table: Table, singular: string, collection: string, id: string, locked: boolean) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  // Authority to lock/unlock is the verb grant the middleware already enforced; we just record who locked
  // it (audit) and toggle the flag. No rank/owner check here - that would be access control in the service.
  const out = locked
    ? await set(deps, table, id, { locked: true, lockedBy: actor.uuid })
    : await set(deps, table, id, { locked: false, lockedBy: null });
  await audit(deps, actor, `${singular}.${locked ? "lock" : "unlock"}`, collection, id, undefined, out ?? row);
  return out;
}

export async function setPublished(
  deps: Deps,
  actor: AppUser,
  table: Table,
  singular: string,
  collection: string,
  id: string,
  published: boolean,
  withPublishTime = false,
) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  assertNotLocked(row);

  // THE GATE, at the moment a post becomes public - which is what publishing is. A draft is read here
  // rather than when it was written, because until now there was nothing for anybody to see. Held means the
  // flip does not happen at all: the row stays a draft, the broadcast below never runs, and the post is on
  // the Flagged posts queue for somebody to release. `moderationGate` clears the hold when it passes, and
  // the scan bookkeeping makes a second look at unchanged text free, so releasing from the queue does not
  // pay for the check twice.
  if (published && isModeratable(collection) && (await moderationGateOn(deps))) {
    const { setHeld } = await import("./moderation");
    await setHeld(deps, collection, id);
    if (!(await moderationGate(deps, collection, id))) return row;
  }

  const fields: Record<string, unknown> = { published, updatedAt: new Date() };
  if (withPublishTime) fields.publishTime = published ? new Date() : null;
  // Guarded flip: only the call that actually changes the state gets to audit + broadcast. A double-clicked
  // Publish, or one racing the scheduler's own claim, must not notify the whole company twice - and a
  // re-publish of a live post must not rewrite its publishTime (which the feed sorts by). The loser is a
  // clean idempotent no-op: the row is already where the caller asked it to be.
  const claimed = (await deps.db
    .update(table)
    .set(fields)
    .where(and(eq(table.uuid, id), eq(table.published, !published)))
    .returning()) as Row[];
  if (!claimed.length) return row;
  const out = claimed[0]!;
  await audit(deps, actor, `${singular}.${published ? "publish" : "unpublish"}`, collection, id, undefined, out);
  // Publishing an announcement broadcasts an in-app notification to its audience (except the author): the whole
  // company, the one department the post is aimed at, or - for a post whose author asked for no notification -
  // nobody, which leaves it on the board for whoever goes looking.
  if (collection === "announcements" && published) {
    const author = (row as { authorEmployeeId?: string | null }).authorEmployeeId ?? null;
    const scope = (row as { audienceScope?: string | null }).audienceScope ?? "everyone";
    const deptId = (row as { audienceDepartmentId?: string | null }).audienceDepartmentId ?? null;
    const audience = scope === "none" ? []
      : scope === "department" && deptId ? await audienceEmployeeIds(deps, { kind: "department", department: deptId })
      : await activeEmployeeIds(deps);
    const recipients = audience.filter((eid) => eid !== author);
    // The bell names what actually landed: a published poll is a poll, not "a new announcement".
    if (recipients.length)
      await notifyMany(deps, recipients, { type: "announcement.published", title: postedTitle((row as { kind?: string }).kind ?? "announcement"), body: (row as { title?: string }).title ?? undefined, link: boardPostLink(id), subject: `announcements/${id}` });
    await emitEvent(deps, actor, "announcement.published", { subject: `announcements/${id}`, payload: { title: (row as { title?: string }).title ?? null } });
    // The post's @mentions have been silent while it was a draft (edits to a draft notify nobody); going live
    // is when the people it names hear about it.
    await notifyMentions(deps, actor, { subject: `announcements/${id}`, link: boardPostLink(id), type: "announcement.mention", body: (row as { body?: string | null }).body ?? null, title: (row as { title?: string }).title ?? "" });
    // And, when the author asked for it, the same post as email to the same audience - once, guarded by
    // `emailed_at`, so a Publish racing the scheduler's tick still sends one copy.
    await emailAnnouncement(deps, out as typeof schema.announcements.$inferSelect);
  }
  // Going live is the moment the text first reaches a wall, whichever direction the flip went - so it is
  // also the moment it becomes worth reading. Unpublishing needs no scan: the post is off the wall, and
  // `retireOrphans` closes any flag standing over it.
  // Gate OFF only. With it on, the post was read above - before the flip - and a second call here would be
  // two mechanisms answering one question, which is how the two of them drift.
  if (isModeratable(collection) && published && !(await moderationGateOn(deps))) await scanSoon(deps, collection, id);
  return out;
}
