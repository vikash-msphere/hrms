// Suggest a ticket's servicing department, category and priority from the resolved tickets nearest to it,
// and surface the open ones that look like duplicates.
//
// THERE IS NO GENERATION IN THIS FILE, and that is the design rather than an economy. The whole feature is a
// nearest-neighbour lookup over vectors the search drain already produced, plus a majority vote. That makes
// it three things a generated answer could not be: explainable (the panel can name the tickets that voted),
// free (one neuron for the embed the drain already paid, none at triage time), and incapable of inventing a
// department that does not exist - the vote can only return values that are already on real tickets.
//
// SCOPE IS RE-DECIDED IN SQL, exactly as services/globalSearch.ts does for semantic search, and for the same
// reason: the vector index knows nothing about who may read a ticket. Neighbour ids come back from the index
// and the ROWS are read under `applyScope(scope, tickets.code, tickets.employeeId)` - the identical predicate
// `listTickets` binds. A ticket the caller could not have listed must not appear as a duplicate link, and
// must not appear as a NUMBER either: it cannot be one of the "4 of 7" the suggestion cites, because it never
// reaches the vote.
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { vectorIdOf, parseVectorId } from "../lib/vector";
import { MODELS } from "../domain/aiPolicy";
import { aiFeatureOn } from "./ai";

/** Neighbours asked of the index. Generous because the SQL re-check throws most of them away for a caller
 *  with narrow breadth, and a thin candidate set produces no suggestion at all. */
const TOP_K = 30;

/** Below this many agreeing neighbours, no suggestion for that field. A vote of one is not evidence, it is
 *  the nearest ticket wearing a hat. */
const MIN_VOTES = 2;

/** How close an OPEN neighbour has to be to be called a possible duplicate. Deliberately high: a false
 *  duplicate wastes an agent's time and, worse, teaches them to ignore the panel. */
const DUPLICATE_SCORE = 0.85;

const RESOLVED_STATES = new Set(["RESOLVED", "CLOSED"]);
const OPEN_STATES = new Set(["OPEN", "IN_PROGRESS"]);

export type TriageVote<T> = { value: T; votes: number; of: number };

export type TicketTriage = {
  department: TriageVote<string> | null; // department uuid
  category: TriageVote<string> | null;
  priority: TriageVote<string> | null;
  /** The resolved neighbours the vote was taken over, best first - what the panel cites. */
  /**
   * The resolved neighbours the vote was taken over, best first - what the panel cites.
   *
   * `path` is a REF (`tickets/<id>`), not a bare id. The outbound wire edge only tokenizes strings shaped
   * `<collection>/<id>` (middleware/encodeWireIds.ts), so a bare `id` here went over the wire as an INTERNAL
   * id and then matched nothing on the client, whose every ticket path is tokenized - the panel compared the
   * two and silently rendered every neighbour as plain text instead of a link. Returning the ref fixes both
   * halves at once.
   */
  basis: { path: string; subject: string; score: number }[];
  /** Open neighbours close enough to be the same problem. */
  duplicates: { path: string; subject: string; score: number; state: string }[];
};

/**
 * Compute the triage suggestion for one ticket, or null when there is nothing worth saying.
 *
 * Null rather than an empty suggestion is the honest answer for every one of: no index bound, the ticket not
 * embedded yet (the drain runs every five minutes, so a ticket filed seconds ago is normally absent), no
 * neighbours the caller may read, and no field reaching the vote floor. The panel renders nothing in all of
 * them, which is better than a confident shrug.
 */
export async function suggestTriage(deps: Deps, scope: ListScope, ticketId: string): Promise<TicketTriage | null> {
  if (!deps.vectors) return null;
  // The org's switch. Off behaves exactly as an absent binding - no suggestion, no panel, nothing read.
  if (!(await aiFeatureOn(deps, "tickets.triage"))) return null;

  // The ticket's OWN vector, fetched rather than recomputed. Re-embedding would cost a neuron per panel open
  // and could quietly disagree with what is actually in the index, which would make the neighbours wrong in a
  // way nothing would ever surface.
  const self = vectorIdOf("tickets", ticketId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([self])).get(self);
  } catch (e) {
    console.error("ticket triage vector fetch failed", e);
    return null;
  }
  if (!vector) return null; // not indexed yet; the drain will reach it

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["tickets"] });
  } catch (e) {
    // An index outage makes the panel absent, never the ticket page broken.
    console.error("ticket triage query failed", e);
    return null;
  }

  const scoreOf = new Map<string, number>();
  for (const m of matches) {
    const parsed = parseVectorId(m.id);
    // Anything that is not one of our ticket ids, and the ticket itself, are dropped before a query is built.
    if (!parsed || parsed.collection !== "tickets" || parsed.recordId === ticketId) continue;
    scoreOf.set(parsed.recordId, m.score);
  }
  if (scoreOf.size === 0) return null;

  // THE ACCESS RE-CHECK. `applyScope` over the ticket's own code and requester, which is precisely what
  // listTickets binds - so these rows are rows the caller's own ticket list would have returned.
  const rows = await byIdChunks([...scoreOf.keys()], (ids) =>
    deps.db
      .select({
        uuid: schema.tickets.uuid,
        subject: schema.tickets.subject,
        state: schema.tickets.state,
        category: schema.tickets.category,
        priority: schema.tickets.priority,
        departmentId: schema.tickets.departmentId,
      })
      .from(schema.tickets)
      .where(and(inArray(schema.tickets.uuid, ids), applyScope(scope, schema.tickets.code, schema.tickets.employeeId))),
  );
  if (rows.length === 0) return null;

  const visible = rows
    .map((r) => ({ ...r, score: scoreOf.get(r.uuid) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  // Only RESOLVED neighbours vote. An open ticket's department is a guess somebody else has not had confirmed
  // yet, and letting those vote would let one mis-routed ticket teach the system to mis-route the next one.
  const resolved = visible.filter((r) => RESOLVED_STATES.has(r.state));
  const duplicates = visible
    .filter((r) => OPEN_STATES.has(r.state) && r.score >= DUPLICATE_SCORE)
    .map((r) => ({ path: `tickets/${r.uuid}`, subject: r.subject, score: r.score, state: r.state }));

  const triage: TicketTriage = {
    department: vote(resolved.map((r) => r.departmentId)),
    category: vote(resolved.map((r) => r.category)),
    priority: vote(resolved.map((r) => r.priority)),
    basis: resolved.map((r) => ({ path: `tickets/${r.uuid}`, subject: r.subject, score: r.score })),
    duplicates,
  };
  // Nothing to say: no field cleared the floor and nothing looks duplicated.
  if (!triage.department && !triage.category && !triage.priority && duplicates.length === 0) return null;

  await recordSuggestion(deps, ticketId, triage);
  return triage;
}

/**
 * A plurality vote with two refusals: too little evidence, and a tie.
 *
 * A tie is refused rather than broken because there is no honest tiebreak here - "the first one alphabetically"
 * would be presented to a human with the same confidence as a real answer. Silence on a field is a suggestion
 * panel with one row instead of two, which costs nothing; a wrong department routed on a coin flip costs a
 * day.
 */
export function vote<T extends string>(values: (T | null)[]): TriageVote<T> | null {
  const counted = values.filter((v): v is T => v !== null && v !== "");
  if (counted.length === 0) return null;
  const tally = new Map<T, number>();
  for (const v of counted) tally.set(v, (tally.get(v) ?? 0) + 1);

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [top, votes] = ranked[0]!;
  if (votes < MIN_VOTES) return null;
  if (ranked.length > 1 && ranked[1]![1] === votes) return null; // tied: say nothing
  return { value: top, votes, of: counted.length };
}

/**
 * Upsert the pending suggestion so `:decide` has something to mark and the accept rate is measurable.
 *
 * A write on a read path, which is worth justifying: the triage panel is an explicit lazy open (the ticket
 * page does not fetch it), not something every list render pays for, and correlating a suggestion with what
 * the human then did is the entire measurement story. Best-effort - failing to record must never cost the
 * caller the suggestion they asked for.
 */
async function recordSuggestion(deps: Deps, ticketId: string, triage: TicketTriage): Promise<void> {
  try {
    const now = deps.clock.now();
    const values = {
      hostCollection: "tickets",
      hostRecordId: ticketId,
      feature: "tickets.triage",
      payloadJson: JSON.stringify(triage),
      model: MODELS.embed,
      basis: triage.basis.length,
    };
    await deps.db
      .insert(schema.aiSuggestions)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.aiSuggestions.hostCollection, schema.aiSuggestions.hostRecordId, schema.aiSuggestions.feature],
        // A recomputation supersedes whatever was there, INCLUDING a decided one: the evidence has changed, so
        // the old verdict is about a suggestion that no longer exists. The decision is cleared with it rather
        // than left attached to different content.
        set: { payloadJson: values.payloadJson, basis: values.basis, model: values.model, state: "pending", decidedBy: null, decidedAt: null, updatedAt: now },
      });
  } catch (e) {
    console.error("ticket triage suggestion record failed", e);
  }
}

/**
 * Record what the human did with the suggestion. Does NOT touch the ticket: if they accepted, the UI has
 * already called `tickets:route` / `tickets:prioritize`, which is what puts the change through the normal
 * service, the normal validation and the normal audit row.
 */
export async function decideTriage(deps: Deps, user: AppUser, ticketId: string, accepted: boolean): Promise<void> {
  await deps.db
    .update(schema.aiSuggestions)
    .set({ state: accepted ? "accepted" : "rejected", decidedBy: user.uuid, decidedAt: deps.clock.now(), updatedAt: deps.clock.now() })
    .where(
      and(
        eq(schema.aiSuggestions.hostCollection, "tickets"),
        eq(schema.aiSuggestions.hostRecordId, ticketId),
        eq(schema.aiSuggestions.feature, "tickets.triage"),
      ),
    );
}
