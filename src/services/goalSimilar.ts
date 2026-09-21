// Goals that are the same work in different words, and the goal this one probably rolls up under.
//
// THE FAILURE THIS ADDRESSES is the one every OKR set has and nobody can see from inside their own list: two
// teams write "cut onboarding time" and "make the first week faster", both plan a quarter around it, and
// neither finds out until somebody reads all ninety goals side by side. The wording differs, so search
// cannot find it; the index already holds both.
//
// NO GENERATION. Same primitive as ticket and suggestion duplicates: fetch this goal's vector, ask for its
// neighbours, re-decide every one of them in SQL. The only model call happened when the drain embedded the
// title and description.
//
// TWO ANSWERS FROM ONE QUERY, because they are one question asked at two thresholds. A near-identical goal
// owned by somebody else is duplicated effort and wants a conversation; a merely related goal that sits
// above this one in the org is what `parent_id` is for and was never filled in. Both are suggestions on a
// panel - nothing is written, and alignment in particular is a link a person makes deliberately.
//
// SCOPE IS RE-DECIDED. Ids come back from the index and the ROWS are read under the same
// `applyScope(scope, code, employeeId)` predicate `listGoals` binds, so a goal the caller could not have
// listed is never named here - including its title, which on a goal is often the strategy itself.
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { parseVectorId, vectorIdOf } from "../lib/vector";
import { aiFeatureOn } from "./ai";

/** Neighbours asked of the index before the SQL re-check narrows them to what the caller may read. */
const TOP_K = 25;

/**
 * How alike two goals have to be before this says anything at all.
 *
 * Deliberately below the duplicate thresholds used for tickets and suggestions, because the useful answer
 * here is wider: "these two are about the same thing" is worth showing at a similarity where "these are the
 * same request, merge them" would not be. Nothing is merged, nothing is rewritten, and both halves of the
 * answer are read by a person who knows what their team is doing.
 */
const RELATED_SCORE = 0.78;

/** Above this, two goals owned by different people are the same work written twice. */
const OVERLAP_SCORE = 0.88;

export type SimilarGoal = {
  path: string;
  title: string;
  status: string;
  progress: number;
  score: number;
  /** Whose it is, so "the same work twice" can be told from "my own goal, split in two". */
  owner?: string;
  /** A goal a whole department owns, which is usually what a personal goal should be aligning to. */
  department_goal: boolean;
};

export type GoalSimilarity = {
  /** Near-identical goals owned by somebody else: duplicated effort, or a contribution nobody recorded. */
  overlaps: SimilarGoal[];
  /** Related goals this one could roll up under. Empty once the goal has a parent - the question is settled. */
  parent_candidates: SimilarGoal[];
  /** Everything above the floor, for a reader who wants to see the working. */
  related: SimilarGoal[];
};

export async function similarGoals(deps: Deps, scope: ListScope | undefined, goalId: string): Promise<GoalSimilarity | null> {
  if (!deps.vectors) return null;
  // Off must cost nothing, not merely produce nothing: checked before the index is touched.
  if (!(await aiFeatureOn(deps, "goals.similar"))) return null;

  const self = (await deps.db
    .select({
      uuid: schema.goals.uuid,
      employeeId: schema.goals.employeeId,
      parentId: schema.goals.parentId,
      kind: schema.goals.kind,
    })
    .from(schema.goals)
    .where(and(eq(schema.goals.uuid, goalId), isNull(schema.goals.deleteTime)))
    .limit(1))[0];
  if (!self) return null;

  const vectorId = vectorIdOf("goals", goalId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([vectorId])).get(vectorId);
  } catch (e) {
    console.error("similar goals: vector fetch failed", e);
    return null;
  }
  if (!vector) return null; // not embedded yet; the drain reaches it within a few minutes

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["goals"] });
  } catch (e) {
    console.error("similar goals: query failed", e);
    return null;
  }

  const scoreOf = new Map<string, number>();
  for (const m of matches) {
    if (m.score < RELATED_SCORE) continue;
    const parsed = parseVectorId(m.id);
    if (!parsed || parsed.collection !== "goals" || parsed.recordId === goalId) continue;
    scoreOf.set(parsed.recordId, m.score);
  }
  if (scoreOf.size === 0) return null;

  const rows = await byIdChunks([...scoreOf.keys()], (ids) =>
    deps.db
      .select({
        uuid: schema.goals.uuid,
        title: schema.goals.title,
        status: schema.goals.status,
        progress: schema.goals.progress,
        employeeId: schema.goals.employeeId,
        departmentId: schema.goals.departmentId,
        parentId: schema.goals.parentId,
        kind: schema.goals.kind,
        firstName: schema.employees.firstName,
        lastName: schema.employees.lastName,
      })
      .from(schema.goals)
      .leftJoin(schema.employees, eq(schema.employees.uuid, schema.goals.employeeId))
      .where(and(
        inArray(schema.goals.uuid, ids),
        isNull(schema.goals.deleteTime),
        // A finished goal is history: it can neither be duplicated effort nor something to align to. BOTH
        // terminal states, not just `cancelled` - a goal completed last quarter offered as "somebody else is
        // doing this too", or as the objective a live goal should roll up under, is worse than no panel.
        inArray(schema.goals.status, ["not_started", "in_progress"]),
        applyScope(scope, schema.goals.code, schema.goals.employeeId),
      )),
  );
  if (rows.length === 0) return null;

  type Scored = SimilarGoal & { _uuid: string; _employeeId: string; _parentId: string | null; _kind: string };
  const related: Scored[] = rows
    .map((r) => ({
      path: `goals/${r.uuid}`,
      title: r.title,
      status: r.status,
      progress: r.progress,
      score: scoreOf.get(r.uuid) ?? 0,
      ...(r.firstName ? { owner: `${r.firstName} ${r.lastName}`.trim() } : {}),
      department_goal: !!r.departmentId,
      _uuid: r.uuid,
      _employeeId: r.employeeId,
      _parentId: r.parentId,
      _kind: r.kind,
    }))
    .sort((a, b) => b.score - a.score);

  const strip = ({ _uuid, _employeeId, _parentId, _kind, ...rest }: Scored): SimilarGoal => {
    void _uuid; void _employeeId; void _parentId; void _kind;
    return rest;
  };

  const overlaps = related.filter((g) => g.score >= OVERLAP_SCORE && g._employeeId !== self.employeeId).map(strip);

  // A KEY RESULT HANGS OFF ITS OBJECTIVE, so alignment is only ever offered for an objective with no parent
  // yet: a key result already has the only parent it can have, and a goal somebody has already aligned has
  // had this decision made by a person.
  const parent_candidates = self.parentId || self.kind === "key_result"
    ? []
    : related
      .filter((g) => g._kind === "objective" && g._parentId !== goalId)
      // A department's own goal first: that is what a personal goal usually rolls up into, and the whole
      // point of the link is to make a team's plan add up.
      .sort((a, b) => Number(b.department_goal) - Number(a.department_goal) || b.score - a.score)
      .slice(0, 3)
      .map(strip);

  return { overlaps, parent_candidates, related: related.map(strip) };
}
