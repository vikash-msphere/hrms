// Keeping the semantic index in step with `search_docs`, as a reconciliation rather than a notification.
//
// The obvious design is to embed a row when it changes. It cannot work here: `search_docs` is maintained by
// SQL TRIGGERS (db/searchDdl.ts), deliberately, because a trigger is the only place that sees writes from
// services, cron, automations, seeds and manual SQL alike. A trigger cannot call Vectorize, and routing every
// write back through a service would give up the property the trigger design exists for.
//
// So this compares two sets instead, on the five-minute drain:
//
//   MISSING or STALE. A `search_docs` row in an indexable collection whose (collection, recordId) has no
//   `search_vectors` row, or whose text hash differs from the one recorded. Embedded and upserted.
//   ORPHANED. A `search_vectors` row whose `search_docs` row is gone, or whose collection has since been
//   removed from the indexable list. Deleted from Vectorize and from the bookkeeping table.
//
// Reconciliation also makes the index self-healing: a tick that dies halfway, a Vectorize outage, a model
// that was out of budget all afternoon, or a bulk import that bypassed the app entirely all converge on the
// next successful run. Nothing has to have gone right the first time.
//
// BUDGET. Bounded per tick by `BUDGET.embedsPerDrain` and by the daily neuron ceiling in services/ai.ts, so a
// first-run backfill of a large database spreads over several ticks instead of spending the day in one.
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { BUDGET, INDEXABLE, MODELS, isIndexable } from "../domain/aiPolicy";
import { aiEmbed, aiFeatureOn } from "./ai";
import { chunk, ID_CHUNK } from "../lib/dbBatch";
import { vectorIdOf } from "../lib/vector";

export type EmbedDrainResult = { embedded: number; removed: number; pending: number; skipped?: string };

/** One reconciliation pass. Never throws: this runs inside the cron dispatch, where one subtask failing must
 *  not take the tick down, and a search index that is a few minutes behind is not an incident. */
export async function drainSearchEmbeddings(deps: Deps): Promise<EmbedDrainResult> {
  if (!deps.ai || !deps.vectors) return { embedded: 0, removed: 0, pending: 0, skipped: "no ai or vector binding" };
  const collections = [...INDEXABLE];

  // DELETION IS NOT A FEATURE; IT IS THE UNDO FOR ONE, so it runs whatever the switch says. Gating it behind
  // `search.semantic` made the off switch stop the cleanup as well as the writing, and two guarantees stated
  // elsewhere quietly stopped holding the moment anybody used it: `removeOrphans`'s own header ("taking a
  // collection OUT of INDEXABLE is a privacy decision, and it has to actually remove what is already in the
  // index") and `aiPolicy.ts`'s stated privacy lever ("the honest interim answer is to turn the feature flags
  // off"). Doing that stranded every existing vector in Vectorize with nothing that would ever collect it -
  // and an embedding is, as that same file says, a lossy but partially invertible projection of the source
  // text, held outside the main tables. A purge, a soft delete or a de-indexing performed after the switch
  // went off left its vector in place for good.
  //
  // The binding check above is still the right guard for both halves: with no index there is nothing to
  // remove from.
  const removed = await removeOrphans(deps, collections);

  // The org's switch gates the INDEXING, not just the searching. Embedding every row of the directory for a
  // feature nobody turned on would be the opt-in in name only: the text would already have been through a
  // model and be sitting in a vector store before anyone decided it could be.
  if (!(await aiFeatureOn(deps, "search.semantic"))) return { embedded: 0, removed, pending: 0, skipped: "search.semantic is off" };
  if (collections.length === 0) return { embedded: 0, removed, pending: 0 };

  const { embedded, pending } = await embedPending(deps, collections);
  return { embedded, removed, pending };
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Rows that need embedding: indexable, not deleted, not restricted, and either never embedded or embedded
 * from different text or by a different model.
 *
 * `deleted` and `restricted` are the same two flags the FTS path already honours. A restricted row is one
 * whose state makes it non-public per `STATE_VISIBILITY`, and indexing it would put text in the semantic
 * index that the keyword index deliberately leaves out.
 */
async function embedPending(deps: Deps, collections: string[]): Promise<{ embedded: number; pending: number }> {
  const docs = schema.searchDocs;
  const vecs = schema.searchVectors;

  // ORDER MATTERS HERE, and getting it wrong is silent.
  //
  // Whether a row needs re-embedding can only be decided by HASHING its text, because `search_docs` is
  // trigger-maintained and carries no updated_at to compare against. That decision therefore happens in JS,
  // after the query - so the query must not hand back an arbitrary window, or the rows it happens to return
  // would be examined forever and the rest of the table never. An earlier version did exactly that: `limit`
  // with no `orderBy`, filtered afterwards, which worked on a small database and would have left most of a
  // real one unindexed with nothing to show for it.
  //
  // So the sweep is ordered: never-embedded rows first (every tick strictly reduces that set, so a backfill
  // always finishes), then the rows checked longest ago, which rotates through the whole table and is what
  // eventually notices an edit. One window per tick, sized to the neuron budget.
  const window = await deps.db
    .select({
      collection: docs.collection,
      recordId: docs.recordId,
      title: docs.title,
      subtitle: docs.subtitle,
      vectorId: vecs.uuid,
      knownHash: vecs.textHash,
      knownModel: vecs.model,
    })
    .from(docs)
    .leftJoin(vecs, and(eq(vecs.collection, docs.collection), eq(vecs.recordId, docs.recordId)))
    .where(and(
      inArray(docs.collection, collections),
      eq(docs.deleted, false),
      eq(docs.restricted, false),
      // Rows with no label at all are excluded HERE rather than skipped in the loop below, and that is not a
      // tidying. They are never-embedded, so they sort to the front of every window, and skipping them in JS
      // left them occupying the window forever: a collection with enough unlabelled rows would fill the tick
      // with work that can never complete and starve everything behind it. Same failure as the missing
      // ORDER BY, reached a different way.
      sql`coalesce(nullif(trim(coalesce(${docs.title}, '')), ''), nullif(trim(coalesce(${docs.subtitle}, '')), '')) is not null`,
    ))
    // Never-embedded first, then longest-unchecked. No `nulls first` clause: the case expression already puts
    // the un-joined rows ahead of everything, and NULLS FIRST is a newer SQLite grammar than this needs.
    .orderBy(sql`case when ${vecs.uuid} is null then 0 else 1 end`, sql`${vecs.checkedAt} asc`)
    .limit(BUDGET.embedsPerDrain);

  const stale: { collection: string; recordId: string; text: string; hash: string; vectorId: string | null }[] = [];
  const examined: string[] = []; // bookkeeping ids to stamp as checked, so the rotation advances
  for (const r of window) {
    const text = embedText(r.title, r.subtitle);
    if (!text) continue; // nothing to embed; a row with no label is not findable by meaning either
    const hash = await sha256Hex(text);
    if (r.knownHash === hash && r.knownModel === MODELS.embed) {
      if (r.vectorId) examined.push(r.vectorId);
      continue;
    }
    stale.push({ collection: r.collection, recordId: r.recordId, text, hash, vectorId: r.vectorId });
  }

  // Rows that were current: stamp them checked so the next tick moves past them. Best-effort, because the
  // cost of failing is a repeated comparison, not a wrong index.
  if (examined.length) {
    try {
      // CHUNKED, and this is not defensive dressing: the window is 200 ids and D1 caps a statement's bound
      // parameters near 100, so a single `in (...)` here failed on every realistic tick. It failed QUIETLY,
      // because the stamp is best-effort - and a stamp that never lands means `checkedAt` never advances,
      // which silently restores the exact starvation this rotation exists to prevent. The suite went green
      // over it; only the stderr showed it.
      for (const group of chunk(examined, ID_CHUNK)) {
        await deps.db.update(vecs).set({ checkedAt: deps.clock.now() }).where(inArray(vecs.uuid, group));
      }
    } catch (e) {
      console.error("search embed rotation stamp failed", e);
    }
  }
  if (stale.length === 0) return { embedded: 0, pending: 0 };

  // ONE batched embed call for the whole tick's work. The daily ceiling is checked inside aiEmbed against the
  // batch size, so an over-large backfill refuses here rather than half-completing.
  // EVERY COLLECTION IN THE BATCH IS DECLARED, so the denylist is asked about each one rather than about
  // nothing. `INDEXABLE` is a curated opt-in and the two lists are meant to be disjoint; declaring the batch
  // is what makes a future entry that is also on `NEVER_TO_MODEL` fail here instead of being embedded.
  const reads = [...new Set(stale.map((s) => s.collection))].map((collection) => ({ collection }));
  const out = await aiEmbed(deps, { feature: "search.embed", reads }, stale.map((s) => s.text));
  if (!out.ok) {
    // Out of budget, no binding, or the model failed. All three are states to sit out and retry next tick:
    // the rows stay stale, the comparison finds them again, and the index catches up when it can.
    return { embedded: 0, pending: stale.length };
  }

  await deps.vectors!.upsert(
    stale.map((s, i) => ({ id: vectorIdOf(s.collection, s.recordId), values: out.value[i]!, collection: s.collection })),
  );

  // Bookkeeping AFTER the upsert, never before: a row recorded as embedded that is not in the index would
  // never be retried, and the record would be permanently invisible to semantic search. The other order costs
  // at worst a repeated embed next tick.
  const now = deps.clock.now();
  for (const s of stale) {
    await deps.db
      .insert(schema.searchVectors)
      .values({ collection: s.collection, recordId: s.recordId, textHash: s.hash, model: MODELS.embed, embeddedAt: now, checkedAt: now })
      .onConflictDoUpdate({
        target: [schema.searchVectors.collection, schema.searchVectors.recordId],
        set: { textHash: s.hash, model: MODELS.embed, embeddedAt: now, checkedAt: now },
      });
  }
  return { embedded: stale.length, pending: 0 };
}

/**
 * Entries whose row is gone, or whose collection is no longer indexable.
 *
 * The second half is the one that is easy to forget and matters most: taking a collection OUT of `INDEXABLE`
 * is a privacy decision, and it has to actually remove what is already in the index rather than only stopping
 * new writes. Without this, revoking a collection would leave its text embedded indefinitely.
 */
async function removeOrphans(deps: Deps, collections: string[]): Promise<number> {
  const docs = schema.searchDocs;
  const vecs = schema.searchVectors;

  const gone = await deps.db
    .select({ uuid: vecs.uuid, collection: vecs.collection, recordId: vecs.recordId })
    .from(vecs)
    .leftJoin(docs, and(eq(docs.collection, vecs.collection), eq(docs.recordId, vecs.recordId)))
    .where(
      sql`${isNull(docs.recordId)} or ${docs.deleted} = 1 or ${docs.restricted} = 1 or ${notInArray(vecs.collection, collections)}`,
    )
    .limit(BUDGET.embedsPerDrain);

  if (gone.length === 0) return 0;

  // Vectorize first, bookkeeping second - the mirror of the embed order, and for the same reason. A
  // bookkeeping row deleted before the vector would leave an entry in the index that nothing knows about, and
  // nothing would ever look for it again.
  await deps.vectors!.remove(gone.map((g) => vectorIdOf(g.collection, g.recordId)));
  // Chunked for the same D1 parameter cap as the rotation stamp above. This one is NOT best-effort - a failed
  // delete would leave bookkeeping for vectors that are gone from the index - so it would have surfaced as a
  // failed tick rather than silently, but it would still have failed on any real backlog.
  for (const group of chunk(gone.map((g) => g.uuid), ID_CHUNK)) {
    await deps.db.delete(vecs).where(inArray(vecs.uuid, group));
  }
  return gone.length;
}

/** What gets embedded: the same title and subtitle the search result renders. Nothing else - see the argument
 *  in domain/aiPolicy.ts for why the embed source is deliberately text already on screen. */
export function embedText(title: string | null, subtitle: string | null): string {
  return [title, subtitle].map((s) => (s ?? "").trim()).filter(Boolean).join(" - ");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `isIndexable` agrees the collection may be embedded. Re-exported so callers do not reach past
 *  this module into the policy for a decision this module owns the consequences of. */
export const mayIndex = isIndexable;
