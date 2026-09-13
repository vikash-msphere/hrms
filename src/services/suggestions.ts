import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import { byIdChunks } from "../lib/dbBatch";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta } from "../lib/audit";
import { notify, notifyMany } from "./notifications";
import { holdsVerbForAnyone, roleHolderEmployeeIds } from "./capabilityHolders";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted, oneOf } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { purgeRow, type PurgeCascade } from "./softDelete";
import { checkEtag, updateAtVersion } from "./versionGuard";

// Suggestion box: employee ideas, optionally anonymous, peer-upvoted, HR-responded. NO access control here
// (middleware gates by path + grants; private by default, open box = grant read/write to `everyone`). Owned by
// the submitter. Upvotes live in the internal suggestion_votes table (folded into the serialize via decorate).
const STATUSES = ["new", "under_review", "planned", "implemented", "declined"] as const;
type Status = (typeof STATUSES)[number];


// Where a bell about one suggestion lands: that suggestion alone, on its own page (`#/suggestions/<id>/view`),
// not the box it sits in - a notification is about a specific idea, so the click has to arrive AT it. The
// leading `suggestions/<id>` is what the outbound wire-id encoder rewrites, so no internal id reaches a client.
const suggestionLink = (id: string) => `suggestions/${id}/view`;

// Employee ids of the suggestion reviewers to notify about a new submission (excluding the actor).
//
// ASKED OF THE GRANT - the reviewers are whoever holds `suggestions.*.respond`, which is a thing the ACL can
// say and a hardcoded `["hr_admin", "super_admin"]` cannot. The literal was wrong in both directions and
// quietly: grant the verb to a custom triage role and nobody on it was ever told an idea had come in; revoke
// it from hr_admin and they were still told. It also read the whole `users` table to answer, on a write path.
// See services/capabilityHolders.ts - and `holdsVerbForAnyone` rather than the coarse capability test, because
// "may respond to somebody's suggestion" is the question, not "may respond to my own".
const suggestionReviewerIds = (deps: Deps, excludeEmployeeId?: string): Promise<string[]> =>
  roleHolderEmployeeIds(deps, holdsVerbForAnyone("suggestions.*", "respond"), excludeEmployeeId);

export type SuggestionInput = {
  category?: string | null;
  title?: string;
  body?: string;
  anonymous?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Attach up/down counts + the caller's own vote direction, in one read for the whole page (like reactions).
// Exported as the collection spec's `decorate`, so a single row read answers with the same counts a page does.
export async function decorate(deps: Deps, actor: AppUser | undefined, rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.uuid);
  // `byIdChunks`: a full page is 100 ids, which is D1's ENTIRE parameter allowance for one statement - so this
  // worked only while nothing else was bound to it, and the next predicate anyone adds turns a full page into
  // `D1_ERROR: too many SQL variables` (and only a full page, so it ships looking fine).
  const votes = await byIdChunks(ids, (group) => deps.db.select().from(schema.suggestionVotes).where(inArray(schema.suggestionVotes.suggestionId, group)));
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  const mine = new Map<string, number>();
  for (const v of votes) {
    const m = v.value < 0 ? down : up;
    m.set(v.suggestionId, (m.get(v.suggestionId) ?? 0) + 1);
    if (actor?.employeeId && v.employeeId === actor.employeeId) mine.set(v.suggestionId, v.value < 0 ? -1 : 1);
  }
  return rows.map((r) => ({ ...r, upCount: up.get(r.uuid) ?? 0, downCount: down.get(r.uuid) ?? 0, myVote: mine.get(r.uuid) ?? 0, own: !!actor?.employeeId && r.submitterId === actor.employeeId }));
}

export async function listSuggestions(deps: Deps, scope: ListScope, maxPageSize: number, opts: { pageToken?: string; status?: string; category?: string; showDeleted?: boolean; q?: string } = {}) {
  const conds = [applyScope(scope, schema.suggestions.code, schema.suggestions.submitterId)];
  // Server-side text filter over the whole collection (FTS, the same index global search uses). It only ever
  // narrows the caller's scope. This is what makes the composer's duplicate guard worth anything: the
  // suggestion somebody is about to re-file was filed BEFORE, which is precisely what a twenty-row feed
  // window does not contain - and an absent warning reads as "no clash", not as "not checked".
  const textMatch = await searchFilter(deps, "suggestions", opts.q, schema.suggestions.uuid);
  if (textMatch) conds.push(textMatch);
  if (opts.status) conds.push(eq(schema.suggestions.status, opts.status as Status));
  if (opts.category) conds.push(eq(schema.suggestions.category, opts.category));
  if (!opts.showDeleted) conds.push(isNull(schema.suggestions.deleteTime)); // soft-delete filter, now in SQL
  const { items, nextPageToken } = await keysetPage<typeof schema.suggestions.$inferSelect>(
    deps, schema.suggestions, "suggestions", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken: opts.pageToken },
  );
  return { items, nextPageToken };
}

/**
 * The actor an audit entry may name for a suggestion: nobody, when the submitter asked to be anonymous and the
 * act is their own. A string actor writes the row with no `actor_id` (lib/audit.ts), so the act is still
 * recorded against the suggestion - which is what the trail is for - without naming the person the whole
 * feature exists not to name. Acts by OTHER people (HR responding, a peer voting) name them as normal:
 * anonymity protects the submitter, not everyone who touches the row.
 */
const anonymousActor = (actor: AppUser, row: { anonymous: boolean; submitterId: string }): AppUser | string =>
  row.anonymous && actor.employeeId === row.submitterId ? "system" : actor;

export async function createSuggestion(deps: Deps, actor: AppUser, input: SuggestionInput) {
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  if (!title) throw invalidArgument("title is required");
  if (!body) throw invalidArgument("body is required");
  const submitterId = actor.employeeId;
  if (!submitterId) throw invalidArgument("only an employee can submit a suggestion");
  // Allocated inside the retry, so two people submitting at once both get a suggestion (codeAlloc.ts).
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.suggestions)
    .values({ code: await allocOwnedCode(deps, schema.suggestions, schema.suggestions.submitterId, submitterId), submitterId, anonymous: !!input.anonymous, category: input.category?.trim() || null, title, body })
    .returning()))[0]!;
  // ANONYMITY REACHES THE TRAIL TOO. The feature strips the submitter from every surface a person can see -
  // the serializer hides it, the reviewer nudge drops the actor face - and the audit entry is such a surface:
  // `GET /v1/activity?resource=suggestions/<id>` reads `actor_id` back to anyone holding `activity` on the
  // collection, which an admin can grant for ordinary triage visibility without being told it un-anonymizes
  // the box. So an anonymous create is recorded as a system act: the ROW is named, the person is not. The same
  // reason keeps `submitter_id` out of the meta (lib/audit.ts AUDIT_DENY).
  await audit(deps, anonymousActor(actor, row), "suggestion.create", "suggestions", row.uuid, createdMeta(row, "suggestions"), row);
  // ...and out of the event, for the same reason one layer over: `event_log` carries `employee_id`, and an
  // HR-authored automation on `suggestion.submitted` can template `{{employeeId}}` straight out of it.
  await emitEvent(deps, row.anonymous ? null : actor, "suggestion.submitted", {
    subject: `suggestions/${row.uuid}`,
    employeeId: row.anonymous ? null : submitterId,
    payload: { anonymous: !!input.anonymous, category: row.category },
  });
  // Nudge the reviewers so a new idea doesn't sit unseen. Respect anonymity: no actor face on an anonymous
  // submission (the title is the suggestion's own content, which reviewers see regardless).
  await notifyMany(deps, await suggestionReviewerIds(deps, submitterId), {
    type: "suggestion.submitted",
    title: "New suggestion submitted",
    body: row.title,
    link: suggestionLink(row.uuid),
    subject: `suggestions/${row.uuid}`,
    actorId: input.anonymous ? undefined : submitterId,
  });
  return row;
}

export async function updateSuggestion(deps: Deps, actor: AppUser, id: string, patch: SuggestionInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  checkEtag(row, ifMatch);
  const has = (k: keyof SuggestionInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: SetOf<typeof schema.suggestions> = { updatedAt: new Date() };
  if (has("title")) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be empty"); set.title = t; }
  if (has("body")) { const b = (patch.body ?? "").trim(); if (!b) throw invalidArgument("body cannot be empty"); set.body = b; }
  if (has("category")) set.category = patch.category?.trim() || null;
  if (has("anonymous")) set.anonymous = !!patch.anonymous;
  const updated = await updateAtVersion(deps, schema.suggestions, "suggestion", row, set);
  // Same rule as the create: the submitter editing their own anonymous suggestion must not be named by the
  // trail either - an edit entry beside the create would give away exactly what the create no longer does.
  await audit(deps, anonymousActor(actor, updated), "suggestion.update", "suggestions", id, diffMeta(row, updated, set, "suggestions"), updated);
  return updated;
}

// HR triage: set status + an optional public response. Separate from the owner's plain edit.
export async function respondSuggestion(deps: Deps, actor: AppUser, id: string, input: { status?: string; response?: string | null }) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  const set: SetOf<typeof schema.suggestions> = { updatedAt: new Date(), respondedById: actor.uuid };
  if (input.status !== undefined) set.status = oneOf(input.status, STATUSES, "invalid status");
  if (input.response !== undefined) set.response = input.response?.trim() || null;
  const updated = (await deps.db.update(schema.suggestions).set(set).where(eq(schema.suggestions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "suggestion.respond", "suggestions", id, { status: set.status });
  // The submitter owns the suggestion (anonymity hides them from peers, not from themselves), so they get the response.
  await notify(deps, { recipient: row.submitterId, type: "suggestion.responded", title: "Your suggestion got a response", body: updated.response || `Status: ${updated.status}`, link: suggestionLink(id), subject: `suggestions/${id}`, actorId: actor.employeeId });
  return updated;
}

// Cast the caller's vote in a direction (+1 up, -1 down). Same direction as the existing vote clears it;
// the opposite direction flips it. One vote per employee per suggestion.
export async function voteSuggestion(deps: Deps, actor: AppUser, id: string, dir: 1 | -1) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  if (!actor.employeeId) throw invalidArgument("only an employee can vote");
  if (row.submitterId === actor.employeeId) throw invalidArgument("you cannot vote on your own suggestion");
  const existing = (await deps.db.select().from(schema.suggestionVotes).where(and(eq(schema.suggestionVotes.suggestionId, id), eq(schema.suggestionVotes.employeeId, actor.employeeId))).limit(1))[0];
  if (existing) {
    if (existing.value === dir) await deps.db.delete(schema.suggestionVotes).where(eq(schema.suggestionVotes.uuid, existing.uuid));
    else await deps.db.update(schema.suggestionVotes).set({ value: dir }).where(eq(schema.suggestionVotes.uuid, existing.uuid));
  } else {
    // `onConflictDoNothing` against `sugg_vote_uniq`. The index was already there; nothing caught the collision
    // it raises, so a second tap that outran the read above fell to the catch-all and answered 500 - a server
    // fault reported for a double-clicked upvote. Losing the race means the vote already exists, which is what
    // this call wanted, so the right answer is to do nothing.
    await deps.db.insert(schema.suggestionVotes).values({ suggestionId: id, employeeId: actor.employeeId, value: dir }).onConflictDoNothing();
  }
  return row;
}

/**
 * The `merge` verb: fold this suggestion into the one it duplicates.
 *
 * The same idea asked three times reads as three unpopular ideas: fifteen people wanted it, and no single row
 * shows more than six. So the votes move to the target - skipping anyone who already voted there, and skipping
 * the target's own submitter, since nobody may vote for their own - and this row is marked merged and closed.
 *
 * The source stays readable rather than being deleted: its submitter wrote those words and is owed the ability
 * to see where they went. Nothing merges into itself, into something already merged (which would build a
 * chain), or in a circle.
 */
export async function mergeSuggestion(deps: Deps, actor: AppUser, id: string, into?: string | null) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  const targetId = (into ?? "").split("/").pop();
  if (!targetId) throw invalidArgument("into is required");
  if (targetId === id) throw invalidArgument("a suggestion cannot be merged into itself");
  if (row.mergedIntoId) throw invalidArgument("this suggestion has already been merged");
  const target = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, targetId)).limit(1))[0];
  if (!target || target.deleteTime) throw invalidArgument("the suggestion to merge into was not found");
  if (target.mergedIntoId) throw invalidArgument("that suggestion was itself merged into another one - merge into that one instead");

  const [fromVotes, toVotes] = await Promise.all([
    deps.db.select().from(schema.suggestionVotes).where(eq(schema.suggestionVotes.suggestionId, id)),
    deps.db.select().from(schema.suggestionVotes).where(eq(schema.suggestionVotes.suggestionId, targetId)),
  ]);
  const already = new Set(toVotes.map((v) => v.employeeId));
  // One vote per person per suggestion is the rule the unique index enforces, so a voter who backed both keeps
  // the one they already had rather than the merge failing halfway.
  const moving = fromVotes.filter((v) => !already.has(v.employeeId) && v.employeeId !== target.submitterId);
  const writes = [
    ...moving.map((v) => deps.db.update(schema.suggestionVotes).set({ suggestionId: targetId }).where(eq(schema.suggestionVotes.uuid, v.uuid))),
    // Votes that could not move are dropped with the merge: leaving them on a closed row would keep counting
    // support for something nobody can act on.
    ...fromVotes.filter((v) => !moving.includes(v)).map((v) => deps.db.delete(schema.suggestionVotes).where(eq(schema.suggestionVotes.uuid, v.uuid))),
  ];
  if (writes.length) await deps.db.batch(writes as [typeof writes[number], ...typeof writes]);

  const updated = (await deps.db
    .update(schema.suggestions)
    .set({ mergedIntoId: targetId, status: "declined", response: row.response ?? `Merged into “${target.title}”.`, respondedById: actor.uuid, updatedAt: new Date() })
    .where(eq(schema.suggestions.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, "suggestion.merge", "suggestions", id, { into: `suggestions/${targetId}`, votesMoved: moving.length });
  // The submitter hears what happened to their words, and where to follow the idea now.
  if (row.submitterId !== actor.employeeId)
    await notify(deps, { recipient: row.submitterId, type: "suggestion.merged", title: "Your suggestion was merged", body: `Folded into “${target.title}”, along with your votes.`, link: suggestionLink(targetId), subject: `suggestions/${targetId}`, actorId: actor.employeeId });
  return updated;
}

// The votes go with the suggestion; a suggestion MERGED INTO this one keeps its own life with the pointer
// cut. Declared rather than swept by hand beforehand, so the whole teardown is one transaction - and
// `merged_into_id` was missed entirely by the hand-written version, so purging a suggestion that others had
// been folded into deleted its votes and then refused with a foreign-key 409.
export const SUGGESTION_PURGE_CASCADE: PurgeCascade = {
  remove: [{ table: schema.suggestionVotes, column: schema.suggestionVotes.suggestionId }],
  detach: [{ table: schema.suggestions, column: schema.suggestions.mergedIntoId }],
};

export async function purgeSuggestion(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.suggestions, "suggestion", "suggestions", id, ifMatch, undefined, SUGGESTION_PURGE_CASCADE);
}
