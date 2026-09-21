import { eq, and, or, ne, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { audit, createdMeta, diffMeta, noteMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import { keysetPage } from "./keysetPage";
import { searchFilter } from "./searchFilter";
import { runBatch, insertBatches, byIdChunks } from "../lib/dbBatch";
import { assertNotLocked } from "./lifecycle";
import { getSettingValue } from "./settings";
import { notify, notifyAudience, audienceEmployeeIds, type Audience } from "./notifications";
import { renderEmail, loadEmailBrand, textParagraphs } from "../lib/emailLayout";
import { fanOutEmail } from "./emailFanOut";
import { emitEvent } from "./eventBus";
import { scanSoon } from "./moderation";
import { DEFAULT_KUDOS_CONFIG, pointsForLevel } from "../domain/kudos";
import { normalizeIllustration, normalizeIllustrationLayout, normalizeRecipientLayout, type RecipientLayout, type IllustrationLayout } from "../domain/illustration";
import { richExcerpt, richToPlain } from "../domain/richText";
import { notifyMentions } from "./mentions";
import { notHeld } from "./withheld";
import { moderationGate, moderationGateOn, setHeld } from "./moderation";
import { boardPostLink, postedTitle, boardOrderSql, boardOrderValue } from "../domain/board";
import { checkEtag, updateAtVersion } from "./versionGuard";

// Where a board mention lands and which category it is filed under. Named once because four call sites
// (publish, scheduled publish, edit, reply) all mean the same thing by it: the post that named you, opened
// on its own page.
const announcementMention = (id: string) => ({ link: boardPostLink(id), subject: `announcements/${id}`, type: "announcement.mention" }) as const;

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
  // Who gets NOTIFIED: everyone (the default), one department, or nobody. An audience, not a permission - the
  // board stays readable by whoever can read the board on all three.
  audience_scope?: "everyone" | "department" | "none";
  audience_department?: string | null; // required by, and only meaningful for, audience_scope: "department"
  // Send it as email to that same audience when it goes live. Off unless asked for; refused with
  // audience_scope: "none", because an email is a notification.
  email_audience?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/**
 * Resolve the notification audience from a write, refusing the two combinations that would be a lie.
 *
 * "One department" without a department would silently notify the whole company, and an email under "notify
 * nobody" would be the loudest notification of all. Both are rejected rather than quietly corrected: the caller
 * asked for something specific, and guessing which half they meant is how a post ends up in 300 inboxes.
 */
function resolveAudience(input: { audience_scope?: "everyone" | "department" | "none"; audience_department?: string | null; email_audience?: boolean }) {
  const scope = input.audience_scope ?? (input.audience_department ? "department" : "everyone");
  const deptId = scope === "department" ? idFromPath(input.audience_department) ?? null : null;
  if (scope === "department" && !deptId) throw invalidArgument("audience_department is required when the audience is one department");
  if (scope === "none" && input.email_audience) throw invalidArgument("an email is a notification: turn the audience back on, or don't email it");
  return { audienceScope: scope, audienceDepartmentId: deptId, emailAudience: scope === "none" ? false : !!input.email_audience };
}

// The rows a caller may see on the board, as SQL. Visibility was DECIDED in the middleware (scopeFor over the
// grant plus the manifest's state rule); this only binds it to columns: the caller's scope, minus soft-deleted,
// and - unless they may see restricted rows (an editor) - only what is live. One predicate, so the board list
// and :markAllRead cannot drift on what "visible" means.
function visibleWhere(scope: ListScope, showDeleted = false, deletedOnly = false): SQL | undefined {
  const conds = [applyScope(scope, schema.announcements.code, schema.announcements.authorEmployeeId)];
  conds.push(deleteStateFilter(schema.announcements.deleteTime, showDeleted, deletedOnly));
  if (!scope.seeRestricted) conds.push(and(eq(schema.announcements.published, true), eq(schema.announcements.disabled, false)));
  // UNCONDITIONAL, unlike the line above it. `seeRestricted` is what lets an editor see drafts and disabled
  // posts; a post the moderation gate is holding is not an editorial state and is shown to nobody here -
  // it appears on the Flagged posts queue and nowhere else. See services/withheld.ts.
  conds.push(notHeld(schema.announcements));
  return and(...(conds.filter(Boolean) as SQL[]));
}

// Who may see a post's READERS. Its author (their own post's receipts) or anyone who may edit it (moderation);
// nobody else, because a read receipt names a person. `can` is the caller's allowed verbs on this row - the
// access hint the factory computes before serializing - so the question asked is what the caller MAY DO, not
// which role they hold, and a per-object share that lifts someone to editor lifts this with it.
export function readersVisibleTo(
  row: { authorEmployeeId?: string | null },
  viewerEmployeeId: string | null | undefined,
  can?: string[],
): boolean {
  if (row.authorEmployeeId && row.authorEmployeeId === viewerEmployeeId) return true;
  return !!can?.includes("update");
}

export async function listAnnouncements(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  pageToken?: string,
  showDeleted = false,
  q?: string,
  kind?: "announcement" | "post" | "poll" | "kudos",
  deletedOnly = false,
  authorFilter?: string,
  repliedByFilter?: string,
) {
  // Server-side text filter (FTS over title, body, category, kind). It ANDs onto the visibility above and can
  // never widen it, so an author still finds their own drafts and nobody else starts seeing them.
  const textMatch = await searchFilter(deps, "announcements", q, schema.announcements.uuid);
  const visible = visibleWhere(scope, showDeleted, deletedOnly);
  // One author, as `employees/{employee_id}` (the edge decoded the token, so this is an internal id) - what the
  // profile's Posts tab asks for. It ANDs onto `visible` like every other filter here, so it narrows and never
  // widens: somebody's unpublished drafts stay theirs (state_visibility), and a reader who may not see the
  // board sees nothing through this either.
  const authorId = idFromPath(authorFilter);
  // Posts this person REPLIED to - the other half of "what they wrote on the board", and the reason it is a
  // filter on announcements rather than its own endpoint: a reply is not a wire collection (it hangs off its
  // post, like ticket_comments), and the thread already rides along on the post it belongs to. So the row a
  // profile shows is the CONVERSATION, which is also the thing worth clicking through to. Reusing this list
  // means it reuses `announcements.read` and the visibility above: a reply on a post the caller may not see
  // does not drag that post into view.
  const repliedById = idFromPath(repliedByFilter);
  const repliedTo = repliedById
    ? inArray(
        schema.announcements.uuid,
        deps.db.select({ id: schema.announcementReplies.announcementId }).from(schema.announcementReplies).where(eq(schema.announcementReplies.authorId, repliedById)),
      )
    : undefined;
  // `?kind=kudos` narrows the board to one kind. The board itself is a FEED - a window by design - but the
  // recognition rollups beside it (a month's podium, six months of who was recognized, twelve months of how
  // often) are aggregates, and an aggregate folded over whatever the feed happens to have loaded redraws as
  // the reader scrolls. This is what lets them be their own bounded read instead.
  const where = and(
    visible,
    textMatch ?? undefined,
    kind ? eq(schema.announcements.kind, kind) : undefined,
    authorId ? eq(schema.announcements.authorEmployeeId, authorId) : undefined,
    repliedTo,
  );
  // Paged in the board's OWN order (pinned first, then when the post went live), not by when the row was
  // written: a feed that pages on one key and is read in another can put an "older" page's post at the top of
  // the board and hide a pinned post behind the cursor. See domain/board.ts - the web mirrors this key.
  return keysetPage(deps, schema.announcements, "announcements", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: boardOrderSql(schema.announcements), value: boardOrderValue },
  });
}

// One row by id. Not exported: the collection factory's generic get answers the item read (services/crud.ts);
// this is the internal fetch the verbs below share.
async function getAnnouncement(deps: Deps, id: string) {
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
  // `publish_time` is a DRAFT's schedule, nothing else. A post going out NOW is placed on the board by when it
  // was written (the feed reads a missing publish_time as exactly that), so accepting one here would be a
  // backdate: the post lands mid-feed, or ahead of posts that came after it. Both spellings are refused rather
  // than quietly ignored, so an author finds out where their post will be BEFORE it goes out. See
  // domain/board.ts for the order this protects.
  if (publishTime) {
    if (published) throw invalidArgument("publish_time is only for a draft - a post going out now is dated when it was written");
    if (isNaN(+publishTime) || +publishTime <= +deps.clock.now()) throw invalidArgument("a scheduled publish time must be in the future");
  }
  const pollClosesAt = kind === "poll" && input.closes_time ? new Date(input.closes_time) : null;
  // Recognition points are resolved server-side from the configured level (never trusted from the client), so
  // a giver can't inflate their recognition. Blank/unknown level => 0 points.
  const level = isKudos ? (input.level?.trim() || null) : null;
  const points = isKudos ? pointsForLevel(await getSettingValue(deps, "kudos", DEFAULT_KUDOS_CONFIG), level) : 0;
  // Author-owned code so the giver/poster can self-scope edit + soft-delete their own item (owner_refs.author).
  const code = authorId ? await allocOwnedCode(deps, schema.announcements, schema.announcements.authorEmployeeId, authorId) : await allocFlatCode(deps, schema.announcements);
  // THE GATE, and it starts at the INSERT rather than after it. With moderation on, the row is written
  // already held - invisible to every read path (services/withheld.ts) - so there is no instant at which a
  // post is both public and unread. Cleared a moment later by `moderationGate` if a model has no objection.
  // ...and only for a post that is GOING PUBLIC. A draft is nobody's to read yet, so gating it would spend
  // a model call on text that may never be posted and would hold a row its author is still writing. The
  // draft meets the gate when it is published, which is the moment it becomes a post.
  const gated = published && (await moderationGateOn(deps));
  const heldAt = gated ? deps.clock.now() : null;
  // AND IT GOES IN UNPUBLISHED, not merely held. Two reasons, and the second is the important one: a held
  // row that is already `published` would go live the instant the hold cleared, with nobody told; leaving
  // it unpublished means RELEASING it is the ordinary publish verb, which audits, tells the audience, sends
  // the email and fires the mentions. One path out, whether the model cleared it a second later or a person
  // did on Monday.
  const publishedNow = published && !gated;
  const row = (await deps.db
    .insert(schema.announcements)
    // `uuid` is the primary key; `{ id }` named no column, so a caller-specified id was silently dropped.
    .values({ code, ...(id ? { uuid: id } : {}), kind, published: publishedNow, heldAt, title: isKudos ? "" : input.title!, body: isKudos ? message : (input.body ?? ""), bodyText: richToPlain(isKudos ? message : input.body), titleAlign: input.title_align ?? null, bodyValign: input.body_valign ?? null, authorEmployeeId: authorId, publishTime, pollMultiple: kind === "poll" ? !!input.multiple : false, pollClosesAt, recipientEmployeeId: recipientId ?? null, recipientDepartmentId: recipientDeptId ?? null, ...(isKudos ? {} : resolveAudience(input)), value: isKudos ? (input.value?.trim() || null) : null, category: isKudos ? (input.category?.trim() || null) : null, level, points, illustration: normalizeIllustration(input.illustration), illustrationLayout: normalizeIllustrationLayout(input.illustration_layout), recipientLayout: isKudos ? normalizeRecipientLayout(input.recipient_layout) : null })
    .returning())[0]!;
  if (kind === "poll") {
    // `insertBatches`, not one statement: a poll option row binds six parameters (uuid, announcement_id, label,
    // position, created_at, updated_at), so a single multi-row insert runs out of D1's hundred somewhere past
    // sixteen options. The schema caps the list well below that; this keeps the two from having to agree.
    await runBatch(deps.db, insertBatches(options.map((label, i) => ({ announcementId: row.uuid, label, position: i })), (group) =>
      deps.db.insert(schema.announcementPollOptions).values(group)));
  }
  await audit(deps, actor, `${kind}.create`, "announcements", row.uuid, createdMeta(row, "announcements"), row);
  // Read it before anybody hears about it. Held means the post stays invisible and NOTHING below runs: no
  // bell, no email, no mention. A notification about a post nobody can open is the one thing worse than the
  // delay - and if the post is later released, the release sends the broadcast then.
  if (gated && !(await moderationGate(deps, "announcements", row.uuid))) return { ...row, heldAt };
  // Cleared. A post the author wanted live now goes live through the publish verb, which is the same road a
  // release takes - so the broadcast below stays the responsibility of exactly one path.
  if (gated && published) {
    const { setPublished } = await import("./lifecycle");
    return await setPublished(deps, actor, schema.announcements, "announcement", "announcements", row.uuid, true, true) as typeof row;
  }
  // Tell the recognized party (the kudos post itself is the link target): one recipient, or every member of
  // the department (fanned out, excluding the giver if they're in it).
  if (isKudos && recipientId) await notify(deps, { recipient: recipientId, type: "kudos.received", title: "You received kudos", body: richExcerpt(message, 200), link: boardPostLink(row.uuid), subject: `announcements/${row.uuid}`, actorId: authorId });
  else if (isKudos && recipientDeptId) await notifyAudience(deps, { kind: "department", department: recipientDeptId }, { type: "kudos.received", title: "Your team received kudos", body: richExcerpt(message, 200), link: boardPostLink(row.uuid), subject: `announcements/${row.uuid}`, actorId: authorId }, authorId);
  // A plain board post (announcement / post / poll) notifies everyone (bar the author), so it surfaces in the
  // bell and lights the "New" marker on its card - the same recognition-board treatment, for every post type.
  // A draft notifies nobody: its broadcast happens once, when it is published.
  // A post aimed at one department tells that department, not the company: the board still carries it, but 300
  // people do not get a bell for something that says "Engineering" on the front. And "notify nobody" sends
  // nothing at all - the post is on the board for whoever goes looking, which is the whole point of it.
  else if (published && audienceOf(row)) await notifyAudience(deps, audienceOf(row)!, { type: "announcement.posted", title: postedTitle(kind), body: input.title!, link: boardPostLink(row.uuid), subject: `announcements/${row.uuid}` }, authorId);
  if (published) await emailAnnouncement(deps, row);
  // Anyone the body names hears about it directly, on top of whatever broadcast this kind does - being named
  // is addressed at you, which a company-wide "new post" is not. A draft stays silent until it is published.
  if (published) await notifyMentions(deps, actor, { ...announcementMention(row.uuid), body: row.body, title: row.title });
  // With the gate OFF, the same read still happens - just after the fact and without the power to withhold
  // anything, which is what the feature was before an org asked for a gate. Deferred past the response.
  if (!gated) await scanSoon(deps, "announcements", row.uuid);
  return row;
}

/**
 * Who a post notifies: everybody, one department, or nobody. `null` means nobody - the caller skips the
 * broadcast entirely rather than sending it to an audience of zero, which would still cost the reads.
 */
const audienceOf = (row: { audienceScope?: string | null; audienceDepartmentId?: string | null }): Audience | null => {
  if (row.audienceScope === "none") return null;
  if (row.audienceScope === "department" && row.audienceDepartmentId) return { kind: "department", department: row.audienceDepartmentId };
  return { kind: "everyone" };
};

/**
 * Send a published post to its audience as email, once.
 *
 * The board reaches whoever opens the board. Some announcements have to reach people who will not - a policy
 * change, an office closure, a payday notice - and the engine could already email an audience from a workflow
 * rule, so the only thing missing was a checkbox on the post itself.
 *
 * `emailed_at` is the guard: publishing a post twice (a manual publish racing the scheduler tick) sends one
 * email, not two. Failures are per-recipient and non-fatal - a bad address must not stop the other 200 - and the
 * post stays published either way, because the board is the record and email is a copy of it.
 */
export async function emailAnnouncement(deps: Deps, row: typeof schema.announcements.$inferSelect): Promise<number> {
  if (!row.emailAudience || row.emailedAt || row.kind === "kudos") return 0;
  // "Notify nobody" means nobody: an email is the loudest notification there is, so it cannot outlive the
  // decision not to send one. The write path refuses the combination; this is the belt to that braces.
  if (!audienceOf(row)) return 0;
  const claimed = await deps.db
    .update(schema.announcements)
    .set({ emailedAt: new Date(deps.clock.now()) })
    .where(and(eq(schema.announcements.uuid, row.uuid), isNull(schema.announcements.emailedAt)))
    .returning();
  if (!claimed.length) return 0; // somebody else's publish already sent it
  const ids = await audienceEmployeeIds(deps, audienceOf(row)!);
  if (!ids.length) return 0;
  // A post's body is markdown-lite (domain/richText.ts), and `bodyHtml` is raw HTML by contract - so handing
  // the body over as it stands mailed the MARKUP to the whole audience: `**important**` with its asterisks,
  // `[the policy](…)` as literal text, and every newline collapsed into one run-on block. It also put whatever
  // an author had typed in angle brackets into a company-branded email unescaped. The prose goes out as
  // escaped paragraphs instead - the same stripper the search index and every excerpt already read it through,
  // rather than a second markdown parser here that could drift from the one that renders the board.
  const html = renderEmail(
    { heading: row.title, preheader: richExcerpt(row.body, 140), bodyHtml: textParagraphs(richToPlain(row.body)) },
    await loadEmailBrand(deps),
  );
  // BOUNDED, and the remainder is owned by the queue. Every send is an outbound fetch off the same
  // per-invocation subrequest budget as the D1 calls around it, and this runs inside the five-minute tick
  // alongside every other subtask - so an org-wide blast used to run out of budget part way down the roster.
  // The `emailed_at` claim above had already been taken, so the post read as mailed while most of the company
  // had heard nothing, and the per-recipient catch meant nothing anywhere said so. See services/emailFanOut.ts.
  return fanOutEmail(deps, { recipients: ids, subject: row.title, html, label: `announcement ${row.uuid}` });
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
  let failed = 0;
  // Asked once for the whole batch rather than per post: it is one settings read and the answer cannot
  // change inside a tick.
  const gated = await moderationGateOn(deps);
  for (const row of due) {
    if (row.disabled) continue;
    // A SCHEDULED POST MEETS THE GATE AT THE MOMENT IT GOES LIVE, exactly like one published by hand. This
    // is the path it would otherwise have walked round: the post was written days ago, cleared nothing then
    // because a draft is not public, and the tick would have put it on the wall unread. Held means the flip
    // below never happens - it stays a draft, on the queue, and a later tick will not keep re-asking
    // because the scan's hash bookkeeping answers the second look for free.
    if (gated) {
      await setHeld(deps, "announcements", row.uuid);
      if (!(await moderationGate(deps, "announcements", row.uuid))) continue;
    }
    const claimed = await deps.db
      .update(schema.announcements)
      .set({ published: true, updatedAt: new Date() })
      .where(and(eq(schema.announcements.uuid, row.uuid), eq(schema.announcements.published, false)))
      .returning();
    if (!claimed.length) continue;
    published++;
    // The BROADCAST is isolated, the flip is not - and that asymmetry is the point. Unlike the recurring
    // claims elsewhere (services/expenses.ts, services/cards.ts) this claim is the outcome the org asked for:
    // the post is live and the feed is already showing it, so releasing it would un-publish a post people can
    // see, which is not a recovery. What must not happen is one post's fan-out taking the whole tick with it:
    // a single unreachable notification write used to abort the loop, and every LATER scheduled post - a
    // holiday notice, a policy update - simply never went live at all, on a tick that then reported an error
    // about something else entirely. Each post's telling is therefore its own failure.
    try {
      await audit(deps, "system", `${row.kind}.publish`, "announcements", row.uuid, { scheduled: true }, claimed[0]!);
      const audience = audienceOf(row);
      if (audience)
        await notifyAudience(
          deps,
          audience,
          { type: "announcement.posted", title: postedTitle(row.kind), body: row.title, link: boardPostLink(row.uuid), subject: `announcements/${row.uuid}` },
          row.authorEmployeeId,
        );
      // A scheduled post emails when it goes live, not when it was written.
      await emailAnnouncement(deps, claimed[0]!);
      await emitEvent(deps, null, "announcement.published", { subject: `announcements/${row.uuid}`, payload: { title: row.title } });
      // A scheduled post's mentions land when it does. The "actor" is the post's own author, not the tick: it
      // is their words that named someone, and naming yourself still notifies nobody.
      await notifyMentions(deps, { employeeId: row.authorEmployeeId } as AppUser, { ...announcementMention(row.uuid), body: row.body, title: row.title });
      // Gate off: it is on the wall as of now, so it is due a read as of now rather than on whichever later
      // tick the sweep reaches it. Awaited rather than deferred - this IS the tick, and it has the time.
      // With the gate on it was already read, above, before it was allowed to go live at all.
      if (!gated) await scanSoon(deps, "announcements", row.uuid);
    } catch (err) {
      failed++;
      console.error(`[announcements] published ${row.uuid} but could not broadcast it`, err);
    }
  }
  // A post that went live with nobody told is exactly the state somebody has to know about - it looks
  // announced and reached no one - so it goes on the `cron_runs` row rather than only into Workers Logs.
  // Thrown after the loop: the remaining posts still publish.
  if (failed) throw new Error(`${failed} of ${published} scheduled post(s) published but could not be broadcast; they are live and unannounced`);
  return published;
}

export async function updateAnnouncement(deps: Deps, actor: AppUser, id: string, patch: AnnouncementInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("announcement not found");
  assertNotLocked(row);
  checkEtag(row, ifMatch);
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
  // The schedule stays editable while the post is a DRAFT, and only then - the same rule the audience fields
  // below follow, for the same reason: a live post has already gone out, and its date is what the board sorts
  // and prints. Moving it would relocate the post in everyone's feed after they read it. Still future-only,
  // so a draft can't be scheduled into the past to bury it. A no-op patch (the value the row already has, or
  // clearing an absent one) passes: the composer omits the field on a live post, so only a real change is
  // ever refused.
  if (has("publish_time")) {
    const next = patch.publish_time ? new Date(patch.publish_time) : null;
    if (+(next ?? 0) !== +(row.publishTime ?? 0)) {
      if (row.published) throw invalidArgument("a published post's publish time can't be changed");
      if (next && (isNaN(+next) || +next <= +deps.clock.now())) throw invalidArgument("a scheduled publish time must be in the future");
      set.publishTime = next;
    }
  }
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
  // Audience and the email decision stay editable while the post is a DRAFT, and only then: both are about who
  // hears about it, and a live post has already told them. Kudos have a recipient, not an audience.
  //
  // Resolved against the row plus the patch, so changing one of the three fields cannot leave an incoherent
  // combination behind ("one department" with the department cleared, an email with the audience turned off).
  if (row.kind !== "kudos" && !row.published && (has("audience_scope") || has("audience_department") || has("email_audience"))) {
    Object.assign(set, resolveAudience({
      audience_scope: has("audience_scope") ? patch.audience_scope : (row.audienceScope as "everyone" | "department" | "none"),
      audience_department: has("audience_department") ? patch.audience_department : (row.audienceDepartmentId ? `departments/${row.audienceDepartmentId}` : null),
      email_audience: has("email_audience") ? patch.email_audience : row.emailAudience,
    }));
  }
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
  // AN EDIT IS UNREAD TEXT ON A WALL, so the gate has to meet it here too - otherwise it is a gate with a
  // door beside it: post something harmless, wait for it to clear, then edit it into whatever you liked.
  // The hold goes on in the SAME update as the new text, so there is no instant where the edited post is
  // both public and unread. A draft is not gated (nobody can see it); publishing is where it meets this.
  const gated = row.published && (await moderationGateOn(deps));
  if (gated) set.heldAt = deps.clock.now();

  const updated = await updateAtVersion(deps, schema.announcements, "announcement", row, set);
  await audit(deps, actor, "announcement.update", "announcements", id, diffMeta(row, updated, set, "announcements"), updated);

  if (gated && !(await moderationGate(deps, "announcements", id))) {
    // Held: the post is off the wall as of this edit, and the people its new text names are NOT told - a
    // mention pointing at a post nobody can open is worse than silence. The release sends them.
    return { ...updated, heldAt: set.heldAt as Date };
  }

  // An edit notifies the people it NEWLY names (the old body is the baseline, so nobody hears about the same
  // mention twice). A draft stays silent - publishing is what tells anyone anything about it.
  if (updated.published) await notifyMentions(deps, actor, { ...announcementMention(id), body: updated.body, previousBody: row.body, title: updated.title });
  // Gate off: the same read, after the fact and unable to withhold anything. The scan's own hash check makes
  // a no-op edit free either way.
  if (!gated) await scanSoon(deps, "announcements", id);
  return updated;
}

// Pin a post to the top of the board, or take it back down. Who may pin is entirely the middleware's
// :pin/:unpin verb grant (HR/moderation via announcements.**); this only flips the timestamp. Idempotent:
// re-pinning a pinned post refreshes its pin time (moves it to the front of the pinned group), unpinning an
// unpinned post is a no-op.
export async function setPinned(deps: Deps, actor: AppUser, id: string, pinned: boolean) {
  const row = await getAnnouncement(deps, id);
  if (pinned && !row.published) throw invalidArgument("a draft can't be pinned - publish it first");
  const updated = (await deps.db
    .update(schema.announcements)
    .set({ pinnedAt: pinned ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.announcements.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, `announcement.${pinned ? "pin" : "unpin"}`, "announcements", id, { diff: { pinnedAt: { from: row.pinnedAt, to: updated.pinnedAt } } }, updated);
  return updated;
}

// Record that the caller opened a board item. Idempotent (no-op when a row already exists, or when the actor
// has no employee record). Returns the announcement row so the route can re-serialize with the read flag.
export async function markAnnouncementRead(deps: Deps, actor: AppUser, id: string) {
  const row = await getAnnouncement(deps, id);
  // The author is not a reader of their own post - never record a receipt for them.
  if (actor.employeeId && actor.employeeId !== row.authorEmployeeId) {
    const existing = (await deps.db
      .select({ uuid: schema.announcementReads.uuid })
      .from(schema.announcementReads)
      .where(and(eq(schema.announcementReads.announcementId, id), eq(schema.announcementReads.employeeId, actor.employeeId)))
      .limit(1))[0];
    // `onConflictDoNothing` against `ar_ann_emp_uniq`: the pre-read above is the cheap path, and the index is
    // what makes the answer true when two of these run at once. A lost race is the receipt already existing,
    // which is the outcome this wanted anyway - so it is a no-op, never a 500.
    if (!existing) await deps.db.insert(schema.announcementReads).values({ announcementId: id, employeeId: actor.employeeId }).onConflictDoNothing();
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
  // Everything the caller can see and did not write themselves. A post with no author counts as someone else's.
  const visible = await deps.db
    .select({ uuid: schema.announcements.uuid })
    .from(schema.announcements)
    .where(and(visibleWhere(scope), or(isNull(schema.announcements.authorEmployeeId), ne(schema.announcements.authorEmployeeId, me))));
  const already = new Set(
    (await deps.db
      .select({ id: schema.announcementReads.announcementId })
      .from(schema.announcementReads)
      .where(eq(schema.announcementReads.employeeId, me))).map((r) => r.id),
  );
  const missing = visible.filter((a) => !already.has(a.uuid));
  if (!missing.length) return { marked: 0 };
  // Split under D1's bound-parameter cap, measured rather than guessed (see insertBatches).
  const reads = missing.map((a) => ({ announcementId: a.uuid, employeeId: me }));
  await runBatch(deps.db, insertBatches(reads, (rows) => deps.db.insert(schema.announcementReads).values(rows).onConflictDoNothing()));
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
  const row = await getAnnouncement(deps, id);
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
  if (!mine.some((m) => m.emoji === glyph)) await deps.db.insert(rx).values({ announcementId: id, replyId: replyId ?? null, employeeId: actor.employeeId, emoji: glyph }).onConflictDoNothing();
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
//
// Chunked, like every other id-keyed read on this page. A full page is `clampPageSize` = 100 ids, which is the
// D1 bound-parameter cap exactly - no room for the predicate beside it, and none for a caller whose scope binds
// any of its own. See lib/dbBatch.ts ID_CHUNK for why the margin is the point.
export async function reactionsFor(deps: Deps, announcementIds: string[], viewerEmployeeId: string | null) {
  if (!announcementIds.length) return new Map<string, ReactionGroup[]>();
  const rx = schema.announcementReactions;
  const rows = await byIdChunks(announcementIds, (group) =>
    deps.db
      .select({ key: rx.announcementId, e: rx.employeeId, emoji: rx.emoji })
      .from(rx)
      .where(and(inArray(rx.announcementId, group), isNull(rx.replyId))),
  );
  return groupReactions(rows, viewerEmployeeId);
}

// Append a reply to a post. Returns the announcement row so the route can re-serialize with the new thread.
export async function addReply(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("reply body is required");
  const row = await getAnnouncement(deps, id);
  assertNotLocked(row);
  // Written held when the gate is on, for the reason the create path gives: a reply that appears on the
  // thread and is withdrawn a second later has already been read by whoever was looking at it.
  const gated = await moderationGateOn(deps);
  const reply = (await deps.db
    .insert(schema.announcementReplies)
    .values({ announcementId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text, heldAt: gated ? deps.clock.now() : null })
    .returning())[0]!;
  // A reply on the board is read by the whole org, so a snippet in the trail is no wider than the thing it
  // describes - `announcements` is the one collection opted in for that (lib/audit.ts#SNIPPETABLE_NOTES).
  await audit(deps, actor, "announcement.reply", "announcements", id, noteMeta("announcements", text), row);
  // Held: the reply is off the thread and the post's author is told nothing about it. Whoever wrote it hears
  // that it is waiting (holdPost), and the queue decides.
  if (gated && !(await moderationGate(deps, "announcement-replies", reply.uuid))) return row;
  // Notify the post's author that someone replied (skip replying to your own post).
  if (row.authorEmployeeId && row.authorEmployeeId !== actor.employeeId)
    await notify(deps, { recipient: row.authorEmployeeId, type: "announcement.reply", title: "New reply to your post", body: richExcerpt(text, 120), link: boardPostLink(id), subject: `announcements/${id}`, actorId: actor.employeeId });
  // Someone named in the reply hears about it too - that is how a thread pulls in the person who can answer.
  await notifyMentions(deps, actor, { ...announcementMention(id), body: text, title: row.title });
  // A reply is the surface most worth reading promptly: it is the one public text written by somebody other
  // than the post's author, and it is where a thread turns. (Gate off: read after the fact, as before.)
  if (!gated) await scanSoon(deps, "announcement-replies", reply.uuid);
  return row;
}

// Replies for a set of announcements, grouped oldest-first by announcement id (one query for a whole page),
// each with its own grouped reactions attached (`_reactions`) for the reply-level reaction bars.
//
// The reply-reaction read is the one id list on this page that is not bounded by the page size: it binds one
// parameter per REPLY across every post on the page, so a page of twenty posts holding six replies each was
// already past the D1 cap and answered `D1_ERROR: too many SQL variables` - the whole board, not one post.
// Both reads are chunked; the reply rows are re-sorted after the fact because the ordering guarantee is over
// the whole set, not over one chunk.
export async function repliesFor(deps: Deps, announcementIds: string[], viewerEmployeeId: string | null) {
  const map = new Map<string, (typeof schema.announcementReplies.$inferSelect)[]>();
  if (!announcementIds.length) return map;
  const rows = (
    await byIdChunks(announcementIds, (group) =>
      deps.db
        .select()
        .from(schema.announcementReplies)
        // A hidden reply is off the wall for everyone, including the person who wrote it. This is the only
        // read of replies, so it is the only place the moderation stamp has to be honoured - miss it and a
        // moderator's decision changes nothing a reader sees.
        // ...and a HELD reply likewise: it was never on the thread. Both stamps are honoured in the one
        // place replies are read, which is what makes either decision mean anything to a reader.
        .where(and(
          inArray(schema.announcementReplies.announcementId, group),
          isNull(schema.announcementReplies.deleteTime),
          notHeld(schema.announcementReplies),
        ))
        .orderBy(schema.announcementReplies.createdAt),
    )
  ).sort((a, b) => +a.createdAt - +b.createdAt);
  const replyIds = rows.map((r) => r.uuid);
  const rx = schema.announcementReactions;
  const reactRows = await byIdChunks(replyIds, (group) =>
    deps.db.select({ key: rx.replyId, e: rx.employeeId, emoji: rx.emoji }).from(rx).where(inArray(rx.replyId, group)),
  );
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
//
// `nowMs` is passed in rather than read from `Date.now()`: this is the predicate that decides whether a vote
// is accepted, and a decision the app makes about time has to be made against the SAME clock everything else
// runs on (`deps.clock`), or it cannot be pinned to an instant in a test and cannot be moved by one either.
export function pollClosed(row: { locked?: boolean | null; pollClosesAt?: Date | null }, nowMs: number): boolean {
  return !!row.locked || (!!row.pollClosesAt && nowMs > +new Date(row.pollClosesAt));
}

// Cast / change / clear the caller's vote on a poll. Single-choice: selecting an option replaces any prior
// choice; re-selecting the same one clears it. Multi-choice: each call toggles that one option. Blocked once
// the poll is closed. Returns the announcement row so the route can re-serialize with the tallies.
export async function castVote(deps: Deps, actor: AppUser, id: string, optionId: string) {
  const row = await getAnnouncement(deps, id);
  if (row.kind !== "poll") throw invalidArgument("not a poll");
  if (pollClosed(row, +deps.clock.now())) throw aborted("poll is closed");
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
    else await deps.db.insert(pv).values({ announcementId: id, optionId, employeeId: actor.employeeId }).onConflictDoNothing();
  } else {
    // Single choice: clear any prior vote, then add this one unless they tapped their current choice (toggle off).
    if (mine.length) await deps.db.delete(pv).where(and(eq(pv.announcementId, id), eq(pv.employeeId, actor.employeeId)));
    if (!already) await deps.db.insert(pv).values({ announcementId: id, optionId, employeeId: actor.employeeId }).onConflictDoNothing();
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
  const opts = (
    await byIdChunks(announcementIds, (group) =>
      deps.db
        .select()
        .from(schema.announcementPollOptions)
        .where(inArray(schema.announcementPollOptions.announcementId, group))
        .orderBy(schema.announcementPollOptions.position),
    )
  ).sort((a, b) => a.position - b.position);
  if (!opts.length) return map;
  const votes = await byIdChunks(announcementIds, (group) =>
    deps.db
      .select({ a: schema.announcementPollVotes.announcementId, o: schema.announcementPollVotes.optionId, e: schema.announcementPollVotes.employeeId })
      .from(schema.announcementPollVotes)
      .where(inArray(schema.announcementPollVotes.announcementId, group)),
  );
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
  const rows = await byIdChunks(announcementIds, (group) =>
    deps.db
      .select({ a: schema.announcementReads.announcementId, e: schema.announcementReads.employeeId })
      .from(schema.announcementReads)
      .where(inArray(schema.announcementReads.announcementId, group)),
  );
  for (const r of rows) {
    const list = map.get(r.a) ?? [];
    list.push(r.e);
    map.set(r.a, list);
  }
  return map;
}
