import { allocOwnedCode } from "./codeAlloc";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notify, notifyMany } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted, oneOf } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { purgeRow } from "./softDelete";

// Suggestion box: employee ideas, optionally anonymous, peer-upvoted, HR-responded. NO access control here
// (middleware gates by path + grants; private by default, open box = grant read/write to `everyone`). Owned by
// the submitter. Upvotes live in the internal suggestion_votes table (folded into the serialize via decorate).
const STATUSES = ["new", "under_review", "planned", "implemented", "declined"] as const;
type Status = (typeof STATUSES)[number];

// Roles that hold `suggestions.*.respond` (see grants.ts) - the reviewers who triage the box.
const SUGGESTION_REVIEWER_ROLES = ["hr_admin", "super_admin"];

// Where a bell about one suggestion lands: that suggestion alone, on its own page (`#/suggestions/<id>/view`),
// not the box it sits in - a notification is about a specific idea, so the click has to arrive AT it. The
// leading `suggestions/<id>` is what the outbound wire-id encoder rewrites, so no internal id reaches a client.
const suggestionLink = (id: string) => `suggestions/${id}/view`;

// Employee ids of the suggestion reviewers to notify about a new submission (excluding the actor).
async function suggestionReviewerIds(deps: Deps, excludeEmployeeId?: string): Promise<string[]> {
  const users = await deps.db.select({ employeeId: schema.users.employeeId, role: schema.users.role }).from(schema.users);
  return users
    .filter((u) => u.employeeId && u.employeeId !== excludeEmployeeId && SUGGESTION_REVIEWER_ROLES.includes(u.role))
    .map((u) => u.employeeId as string);
}

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
  const votes = await deps.db.select().from(schema.suggestionVotes).where(inArray(schema.suggestionVotes.suggestionId, ids));
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

export async function listSuggestions(deps: Deps, scope: ListScope, maxPageSize: number, opts: { pageToken?: string; status?: string; category?: string; showDeleted?: boolean } = {}) {
  const conds = [applyScope(scope, schema.suggestions.code, schema.suggestions.submitterId)];
  if (opts.status) conds.push(eq(schema.suggestions.status, opts.status as Status));
  if (opts.category) conds.push(eq(schema.suggestions.category, opts.category));
  if (!opts.showDeleted) conds.push(isNull(schema.suggestions.deleteTime)); // soft-delete filter, now in SQL
  const { items, nextPageToken } = await keysetPage<typeof schema.suggestions.$inferSelect>(
    deps, schema.suggestions, "suggestions", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken: opts.pageToken },
  );
  return { items, nextPageToken };
}

export async function createSuggestion(deps: Deps, actor: AppUser, input: SuggestionInput) {
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  if (!title) throw invalidArgument("title is required");
  if (!body) throw invalidArgument("body is required");
  const submitterId = actor.employeeId;
  if (!submitterId) throw invalidArgument("only an employee can submit a suggestion");
  const row = (await deps.db
    .insert(schema.suggestions)
    .values({ code: await allocOwnedCode(deps, schema.suggestions, schema.suggestions.submitterId, submitterId), submitterId, anonymous: !!input.anonymous, category: input.category?.trim() || null, title, body })
    .returning())[0]!;
  await audit(deps, actor, "suggestion.create", "suggestions", row.uuid, undefined, row);
  await emitEvent(deps, actor, "suggestion.submitted", { subject: `suggestions/${row.uuid}`, employeeId: submitterId, payload: { anonymous: !!input.anonymous, category: row.category } });
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
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof SuggestionInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: SetOf<typeof schema.suggestions> = { updatedAt: new Date() };
  if (has("title")) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be empty"); set.title = t; }
  if (has("body")) { const b = (patch.body ?? "").trim(); if (!b) throw invalidArgument("body cannot be empty"); set.body = b; }
  if (has("category")) set.category = patch.category?.trim() || null;
  if (has("anonymous")) set.anonymous = !!patch.anonymous;
  const updated = (await deps.db.update(schema.suggestions).set(set).where(eq(schema.suggestions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "suggestion.update", "suggestions", id, diffMeta(row, updated, set), updated);
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
    await deps.db.insert(schema.suggestionVotes).values({ suggestionId: id, employeeId: actor.employeeId, value: dir });
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
  await audit(deps, actor, "suggestion.merge", "suggestions", id, { into: targetId, votesMoved: moving.length });
  // The submitter hears what happened to their words, and where to follow the idea now.
  if (row.submitterId !== actor.employeeId)
    await notify(deps, { recipient: row.submitterId, type: "suggestion.merged", title: "Your suggestion was merged", body: `Folded into “${target.title}”, along with your votes.`, link: suggestionLink(targetId), subject: `suggestions/${targetId}`, actorId: actor.employeeId });
  return updated;
}

export async function purgeSuggestion(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await deps.db.delete(schema.suggestionVotes).where(eq(schema.suggestionVotes.suggestionId, id));
  await purgeRow(deps, actor, schema.suggestions, "suggestion", "suggestions", id, ifMatch);
}
