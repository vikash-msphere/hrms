// Other suggestions that are asking for the same thing.
//
// WHY THIS IS WORTH HAVING. A suggestion box collects the same idea in seven wordings, and the upvote count
// then reads as seven weak asks rather than one strong one - so the thing everybody wants loses to the thing
// one person wrote first. `suggestions:merge` already exists to fold them together; nothing until now told
// anybody WHICH ones to fold, and reading the whole box to find out is the work nobody does.
//
// NO GENERATION. This is the ticket-duplicate primitive pointed at a different wall: fetch the suggestion's
// own vector, ask the index for its neighbours, and re-decide every one of them in SQL. The model's only
// involvement happened days earlier, when the search drain embedded the title and subtitle.
//
// SCOPE IS RE-DECIDED, exactly as it is for search and triage. The index knows nothing about who may read a
// suggestion, so ids come back and the ROWS are read under `applyScope(scope, code, submitterId)` - the same
// predicate `listSuggestions` binds. A suggestion the caller could not have listed is not a neighbour.
//
// ANONYMITY SURVIVES. The wall lets somebody submit without their name, and this answer carries no submitter
// at all - not even for a suggestion that was signed. A "who else asked for this" feature that named people
// would be a different feature, and on a box where anonymity is offered it would be a broken promise for the
// rows that used it.
import { and, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { parseVectorId, vectorIdOf } from "../lib/vector";
import { aiFeatureOn } from "./ai";

/** Neighbours asked of the index before the SQL re-check throws most of them away for a narrow caller. */
const TOP_K = 20;

/**
 * How close counts as "the same ask".
 *
 * Higher than the ticket-duplicate threshold on purpose. A duplicate ticket is a cheap thing to be wrong
 * about - an agent glances and moves on - whereas this feeds a MERGE, which rewrites somebody's suggestion
 * into somebody else's and takes their votes with it. The cost of a false neighbour is therefore asymmetric,
 * and the threshold is set where a moderator is unlikely to be offered two genuinely different asks.
 */
const SAME_ASK_SCORE = 0.88;

/**
 * What the caller gets per neighbour: enough to judge the merge, and nothing about who wrote it.
 *
 * `path` is a REF (`suggestions/<id>`), not a bare id, and that is not cosmetic. The outbound wire edge
 * (middleware/encodeWireIds.ts) only tokenizes strings shaped `<collection>/<id>`; a bare `id` field is
 * passed through untouched, which would both put an internal id on the wire - the thing the id codec exists
 * to prevent - and hand the client a value that matches nothing it holds, since every other path it has is
 * tokenized. Returning the ref means the edge rewrites it like any other and the client can compare it to
 * `suggestion.path` directly.
 */
export type SimilarSuggestion = {
  path: string;
  title: string | null;
  status: string;
  score: number;
  /** Net votes, so a moderator merging can see which way round to do it - the bigger ask should absorb the
   *  smaller one, not the other way about. */
  votes: number;
};

/**
 * Suggestions that look like the same ask as `suggestionId`, best first.
 *
 * Returns [] for every unavailable state rather than throwing: this decorates a page that is useful without
 * it, so no index, no model, the feature switched off, or a suggestion the drain has not embedded yet all
 * mean the panel simply does not appear.
 */
export async function similarSuggestions(
  deps: Deps,
  scope: ListScope,
  suggestionId: string,
): Promise<SimilarSuggestion[]> {
  if (!deps.vectors) return [];
  if (!(await aiFeatureOn(deps, "suggestions.similar"))) return [];

  const self = vectorIdOf("suggestions", suggestionId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([self])).get(self);
  } catch (e) {
    console.error("similar suggestions: vector fetch failed", e);
    return [];
  }
  if (!vector) return []; // not embedded yet; the drain reaches it within a few minutes

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["suggestions"] });
  } catch (e) {
    console.error("similar suggestions: query failed", e);
    return [];
  }

  const scoreOf = new Map<string, number>();
  for (const m of matches) {
    if (m.score < SAME_ASK_SCORE) continue;
    const parsed = parseVectorId(m.id);
    // Anything that is not one of our suggestion ids, and the suggestion itself, are dropped before a query
    // is built.
    if (!parsed || parsed.collection !== "suggestions" || parsed.recordId === suggestionId) continue;
    scoreOf.set(parsed.recordId, m.score);
  }
  if (scoreOf.size === 0) return [];

  // THE ACCESS RE-CHECK. `applyScope` over the suggestion's own code and submitter, which is what
  // `listSuggestions` binds - so these are rows the caller's own list would have returned. Soft-deleted rows
  // are excluded: a merged-away or withdrawn suggestion is not something to merge into.
  const rows = await byIdChunks([...scoreOf.keys()], (ids) =>
    deps.db
      .select({
        uuid: schema.suggestions.uuid,
        title: schema.suggestions.title,
        status: schema.suggestions.status,
      })
      .from(schema.suggestions)
      .where(and(
        inArray(schema.suggestions.uuid, ids),
        isNull(schema.suggestions.deleteTime),
        applyScope(scope, schema.suggestions.code, schema.suggestions.submitterId),
      )),
  );
  if (rows.length === 0) return [];

  const votes = await netVotes(deps, rows.map((r) => r.uuid));
  return rows
    .map((r) => ({
      path: `suggestions/${r.uuid}`,
      title: r.title,
      status: r.status,
      score: scoreOf.get(r.uuid) ?? 0,
      votes: votes.get(r.uuid) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Net vote per suggestion, in one grouped read over the handful of neighbours - the same shape the list's
 *  own decorator uses rather than a second per-row query. */
async function netVotes(deps: Deps, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await byIdChunks(ids, (group) =>
    deps.db
      .select({ suggestionId: schema.suggestionVotes.suggestionId, value: schema.suggestionVotes.value })
      .from(schema.suggestionVotes)
      .where(inArray(schema.suggestionVotes.suggestionId, group)),
  );
  for (const r of rows) out.set(r.suggestionId, (out.get(r.suggestionId) ?? 0) + Number(r.value ?? 0));
  return out;
}
