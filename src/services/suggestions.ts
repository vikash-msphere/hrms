import { allocOwnedCode } from "./codeAlloc";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notify, notifyMany } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { purgeRow } from "./softDelete";

// Suggestion box: employee ideas, optionally anonymous, peer-upvoted, HR-responded. NO access control here
// (middleware gates by path + grants; private by default, open box = grant read/write to `everyone`). Owned by
// the submitter. Upvotes live in the internal suggestion_votes table (folded into the serialize via decorate).
const STATUSES = ["new", "under_review", "planned", "implemented", "declined"] as const;
type Status = (typeof STATUSES)[number];

// Roles that hold `suggestions.*.respond` (see grants.ts) - the reviewers who triage the box.
const SUGGESTION_REVIEWER_ROLES = ["hr_admin", "super_admin"];

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

export async function listSuggestions(deps: Deps, scope: ListScope, maxPageSize: number, opts: { pageToken?: string; status?: string; category?: string; showDeleted?: boolean; actor?: AppUser } = {}) {
  const conds = [applyScope(scope, schema.suggestions.code, schema.suggestions.submitterId)];
  if (opts.status) conds.push(eq(schema.suggestions.status, opts.status as Status));
  if (opts.category) conds.push(eq(schema.suggestions.category, opts.category));
  if (!opts.showDeleted) conds.push(isNull(schema.suggestions.deleteTime)); // soft-delete filter, now in SQL
  const { items, nextPageToken } = await keysetPage<typeof schema.suggestions.$inferSelect>(
    deps, schema.suggestions, "suggestions", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken: opts.pageToken },
  );
  return { items: await decorate(deps, opts.actor, items), nextPageToken };
}

export async function getSuggestion(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  return (await decorate(deps, actor, [row]))[0];
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
    link: "suggestions",
    subject: `suggestions/${row.uuid}`,
    actorId: input.anonymous ? undefined : submitterId,
  });
  return (await decorate(deps, actor, [row]))[0];
}

export async function updateSuggestion(deps: Deps, actor: AppUser, id: string, patch: SuggestionInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof SuggestionInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (has("title")) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be empty"); set.title = t; }
  if (has("body")) { const b = (patch.body ?? "").trim(); if (!b) throw invalidArgument("body cannot be empty"); set.body = b; }
  if (has("category")) set.category = patch.category?.trim() || null;
  if (has("anonymous")) set.anonymous = !!patch.anonymous;
  const updated = (await deps.db.update(schema.suggestions).set(set).where(eq(schema.suggestions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "suggestion.update", "suggestions", id, diffMeta(row, updated, set), updated);
  return (await decorate(deps, actor, [updated]))[0];
}

// HR triage: set status + an optional public response. Separate from the owner's plain edit.
export async function respondSuggestion(deps: Deps, actor: AppUser, id: string, input: { status?: string; response?: string | null }) {
  const row = (await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("suggestion not found");
  const set: Record<string, unknown> = { updatedAt: new Date(), respondedById: actor.uuid };
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status as Status)) throw invalidArgument("invalid status");
    set.status = input.status;
  }
  if (input.response !== undefined) set.response = input.response?.trim() || null;
  const updated = (await deps.db.update(schema.suggestions).set(set).where(eq(schema.suggestions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "suggestion.respond", "suggestions", id, { status: set.status });
  // The submitter owns the suggestion (anonymity hides them from peers, not from themselves), so they get the response.
  await notify(deps, { recipient: row.submitterId, type: "suggestion.responded", title: "Your suggestion got a response", body: updated.response || `Status: ${updated.status}`, link: "suggestions", subject: `suggestions/${id}`, actorId: actor.employeeId });
  return (await decorate(deps, actor, [updated]))[0];
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
  return (await decorate(deps, actor, [row]))[0];
}

export async function purgeSuggestion(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await deps.db.delete(schema.suggestionVotes).where(eq(schema.suggestionVotes.suggestionId, id));
  await purgeRow(deps, actor, schema.suggestions, "suggestion", "suggestions", id, ifMatch);
}
