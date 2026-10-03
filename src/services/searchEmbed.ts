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
// READS. Both halves read only the collections that could have changed since a tick last finished them
// (`search_vector_marks`, see `readMarks`). Comparing the full sets on every tick read about five rows per
// indexed record, every ten minutes, to learn on nearly every tick that nothing had changed. An idle tick now
// reads one row per indexable collection, twice over, plus one per distinct collection in the index.
//
// BUDGET. Bounded per tick by `BUDGET.embedsPerDrain` and by the daily neuron ceiling in services/ai.ts, so a
// first-run backfill of a large database spreads over several ticks instead of spending the day in one.
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { BUDGET, INDEXABLE, MODELS, isIndexable } from "../domain/aiPolicy";
import { aiEmbed, aiFeatureOn } from "./ai";
import { chunk, ID_CHUNK } from "../lib/dbBatch";
import { vectorIdOf } from "../lib/vector";
import { embedText } from "../domain/semanticSearch";

export type EmbedDrainResult = { embedded: number; removed: number; pending: number; skipped?: string };

/** One reconciliation pass. Never throws: this runs inside the cron dispatch, where one subtask failing must
 *  not take the tick down, and a search index that is a few minutes behind is not an incident. */
export async function drainSearchEmbeddings(deps: Deps, opts: { fullSweep?: boolean } = {}): Promise<EmbedDrainResult> {
  if (!deps.ai || !deps.vectors) return { embedded: 0, removed: 0, pending: 0, skipped: "no ai or vector binding" };
  const collections = [...INDEXABLE];
  // Taken BEFORE anything is read, because a mark says "every write stamped before this was reconciled". A
  // time taken after the reads would also cover writes that landed while this tick was running.
  const tickAt = deps.clock.now();
  const marks = await readMarks(deps, collections);

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
  const removed = await removeOrphans(deps, marks, tickAt);

  // The org's switch gates the INDEXING, not just the searching. Embedding every row of the directory for a
  // feature nobody turned on would be the opt-in in name only: the text would already have been through a
  // model and be sitting in a vector store before anyone decided it could be.
  if (!(await aiFeatureOn(deps, "search.semantic"))) return { embedded: 0, removed, pending: 0, skipped: "search.semantic is off" };
  if (collections.length === 0) return { embedded: 0, removed, pending: 0 };

  const { embedded, pending } = await embedPending(deps, collections, marks.embedDue, tickAt, opts.fullSweep === true);
  return { embedded, removed, pending };
}

/** How long after a collection's last write its rows stay due - the same margin, for the same race, as
 *  services/moderation.ts `QUIET_MARGIN_MS`. */
const QUIET_MARGIN_MS = 5 * 60_000;

/** Rows per `search_vector_marks` upsert. Each row binds up to three parameters, and D1 caps a statement near 100. */
const MARK_CHUNK = Math.floor(ID_CHUNK / 3);

type Marks = {
  /** Indexable collections whose rows may be waiting to be embedded. */
  embedDue: string[];
  /** Indexable collections whose vectors may have lost their row. */
  pruneDue: string[];
  /** Collections the index holds vectors for that are no longer indexable. Every vector in them is an orphan. */
  revoked: string[];
  /** Mark rows for collections no longer indexable. */
  retired: string[];
};

/**
 * Which collections each half of the drain has to read on this tick.
 *
 * A collection is due when its `collection_versions` stamp, plus the quiet margin, is later than the tick that
 * last finished it. A `search_docs` row is rewritten only by triggers on its own source table, and those same
 * writes bump that collection's stamp (db/changeDdl.ts), so a stamp that has not moved means text that has not
 * changed. A collection with no stamp row, or no mark, is due: it has never been written, or never finished.
 *
 * The margin keeps a collection due for five minutes after its last write, so a write that lands just
 * before a tick finishes is still read on the next one. A row stamped checked inside the margin is still due
 * by `embedPending`'s own filter, so the rows and their collection come back together.
 *
 * `revoked` comes from the index itself rather than from the marks: vectors written before the marks existed
 * have no mark row, and revoking a collection has to remove those too.
 */
async function readMarks(deps: Deps, collections: string[]): Promise<Marks> {
  const m = schema.searchVectorMarks;
  const cv = schema.collectionVersions;
  const vecs = schema.searchVectors;
  const [markRows, stampRows, inIndex] = await Promise.all([
    deps.db.select().from(m),
    collections.length ? deps.db.select({ collection: cv.collection, at: cv.at }).from(cv).where(inArray(cv.collection, collections)) : [],
    // The distinct collections in the index, one index seek each instead of a scan of every vector: each step
    // asks the `(collection, record_id)` index for the next collection name after the last one found.
    deps.db.all<{ collection: string }>(sql`
      with recursive c(collection) as (
        select (select min(${vecs.collection}) from ${vecs})
        union all
        select (select min(${vecs.collection}) from ${vecs} where ${vecs.collection} > c.collection) from c where c.collection is not null
      )
      select collection from c where collection is not null`),
  ]);
  const markOf = new Map(markRows.map((r) => [r.collection, r]));
  const stampOf = new Map(stampRows.map((r) => [r.collection, +r.at]));
  const due = (collection: string, finishedAt: Date | null | undefined) => {
    const stamp = stampOf.get(collection);
    return finishedAt == null || stamp === undefined || stamp + QUIET_MARGIN_MS > +finishedAt;
  };
  const indexable = new Set(collections);
  return {
    embedDue: collections.filter((c) => {
      const mark = markOf.get(c);
      return mark?.model !== MODELS.embed || due(c, mark.embeddedAt);
    }),
    pruneDue: collections.filter((c) => due(c, markOf.get(c)?.prunedAt)),
    revoked: inIndex.map((r) => r.collection).filter((c) => !indexable.has(c)),
    retired: markRows.map((r) => r.collection).filter((c) => !indexable.has(c)),
  };
}

/** Record that every write to `collections` stamped before `at` has been reconciled by one half of the drain. */
async function markFinished(deps: Deps, collections: string[], set: { embeddedAt: Date; model: string } | { prunedAt: Date }): Promise<void> {
  const m = schema.searchVectorMarks;
  for (const group of chunk(collections, MARK_CHUNK)) {
    await deps.db.insert(m).values(group.map((collection) => ({ collection, ...set }))).onConflictDoUpdate({ target: m.collection, set });
  }
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Rows that need embedding: indexable, not deleted, not restricted, and either never embedded or embedded
 * from different text or by a different model.
 *
 * `deleted` and `restricted` are the same two flags the FTS path already honours. A restricted row is one
 * whose state makes it non-public per `STATE_VISIBILITY`, and indexing it would put text in the semantic
 * index that the keyword index deliberately leaves out.
 *
 * Only the `due` collections are read for that (see `readMarks`). The hourly full sweep adds the rows
 * checked longest ago from any indexable collection, which is what notices a change no row write explains:
 * a deploy that changes how `embedText` builds the text. The rotation only reaches rows that already have a
 * vector. A deploy that changes WHICH rows get embedded has to clear `search_vector_marks` as well, so every
 * collection is read in full again.
 */
async function embedPending(deps: Deps, collections: string[], due: string[], tickAt: Date, fullSweep: boolean): Promise<{ embedded: number; pending: number }> {
  const docs = schema.searchDocs;
  const vecs = schema.searchVectors;
  const cv = schema.collectionVersions;
  const limit = BUDGET.embedsPerDrain;
  const columns = {
    collection: docs.collection,
    recordId: docs.recordId,
    title: docs.title,
    subtitle: docs.subtitle,
    vectorId: vecs.uuid,
    knownHash: vecs.textHash,
    knownModel: vecs.model,
  };
  const embeddable = [
    // LITERAL zeros, not `eq(..., false)`, and the rotation below depends on it. With the flags bound as
    // parameters D1 plans the rotation as a scan of `search_docs` and a sort of every row; with literals it
    // walks `search_vectors_checked_idx` and stops at the limit (test/searchEmbedRowsRead.test.ts measures
    // both: about 7,500 rows read against 28 on that test's index).
    sql`${docs.deleted} = 0`,
    sql`${docs.restricted} = 0`,
    // Rows with no title are excluded HERE rather than skipped in the loop below, and that is not a
    // tidying. They are never-embedded, so they sort to the front of every window, and skipping them in JS
    // left them occupying the window forever: a collection with enough untitled rows would fill the tick
    // with work that can never complete and starve everything behind it. Same failure as the missing
    // ORDER BY, reached a different way. The TITLE, not title-or-subtitle: `embedText` embeds nothing for a
    // row without one, so this is that same rule said in SQL.
    sql`trim(coalesce(${docs.title}, '')) <> ''`,
  ];

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
  const dueRows = due.length === 0 ? [] : await deps.db
    .select(columns)
    .from(docs)
    .leftJoin(vecs, and(eq(vecs.collection, docs.collection), eq(vecs.recordId, docs.recordId)))
    .where(and(
      inArray(docs.collection, due),
      ...embeddable,
      // ONLY ROWS THAT COULD HAVE CHANGED: never embedded, embedded by another model, or in a collection
      // written since the row was last checked. This narrows what the tick hashes, not what it reads: the
      // comparison runs on rows already read, which is why `due` narrows the collections first. Without it
      // the rotation hashed and re-stamped a full window every tick, which was CPU the free plan's 10ms limit
      // could not spare. A collection with no stamp row reads as changed.
      or(
        isNull(vecs.uuid),
        ne(vecs.model, MODELS.embed),
        sql`${vecs.checkedAt} < coalesce((select ${cv.at} from ${cv} where ${cv.collection} = ${docs.collection}), ${Number.MAX_SAFE_INTEGER}) + ${QUIET_MARGIN_MS}`,
      )!,
    ))
    // Never-embedded first, then longest-unchecked. No `nulls first` clause: the case expression already puts
    // the un-joined rows ahead of everything, and NULLS FIRST is a newer SQLite grammar than this needs.
    .orderBy(sql`case when ${vecs.uuid} is null then 0 else 1 end`, sql`${vecs.checkedAt} asc`)
    .limit(limit);

  // The full sweep's rotation, driven from `search_vectors_checked_idx` so it reads the rows it returns and
  // stops. The unary `+` keeps the collection list from being used as an index: with it usable, a database
  // without planner statistics seeks every indexable collection's rows and sorts them all for the first few.
  const rotation = !fullSweep || dueRows.length >= limit ? [] : await deps.db
    .select(columns)
    .from(vecs)
    .innerJoin(docs, and(eq(docs.collection, vecs.collection), eq(docs.recordId, vecs.recordId)))
    .where(and(inArray(sql`+${vecs.collection}`, collections), ...embeddable))
    .orderBy(vecs.checkedAt)
    .limit(limit - dueRows.length);
  const inDue = new Set(dueRows.map((r) => r.vectorId));
  const window = [...dueRows, ...rotation.filter((r) => !inDue.has(r.vectorId))];
  // A due query that came back short of the limit returned every due row of every due collection, so once
  // they are reconciled those collections are finished as of this tick. A full one may have left some behind.
  const finished = due.length > 0 && dueRows.length < limit;
  const finish = () => (finished ? markFinished(deps, due, { embeddedAt: tickAt, model: MODELS.embed }) : Promise.resolve());

  const stale: { collection: string; recordId: string; text: string; hash: string; vectorId: string | null }[] = [];
  const examined: string[] = []; // bookkeeping ids to stamp as checked, so the rotation advances
  for (const r of window) {
    const text = embedText(r.collection, r.title, r.subtitle);
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
  if (stale.length === 0) {
    await finish();
    return { embedded: 0, pending: 0 };
  }

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
  await finish();
  return { embedded: stale.length, pending: 0 };
}

/**
 * Entries whose row is gone, whose row has lost its title, or whose collection is no longer indexable.
 *
 * The last is the one that is easy to forget and matters most: taking a collection OUT of `INDEXABLE` is a
 * privacy decision, and it has to actually remove what is already in the index rather than only stopping new
 * writes. Without this, revoking a collection would leave its text embedded indefinitely. It is checked on
 * every tick, from the index's own list of collections (`Marks.revoked`), so it does not depend on a mark.
 *
 * A row with no title is one `embedText` no longer embeds, so a vector still held for it (written before
 * that rule, or before the title was cleared) is an orphan too - the embed pass skips it and would never
 * replace it.
 *
 * The first three only happen through a write to the row's source table, so only `pruneDue` collections are
 * looked at for them.
 */
async function removeOrphans(deps: Deps, marks: Marks, tickAt: Date): Promise<number> {
  const docs = schema.searchDocs;
  const vecs = schema.searchVectors;
  const limit = BUDGET.embedsPerDrain;
  const columns = { uuid: vecs.uuid, collection: vecs.collection, recordId: vecs.recordId };

  const lost = marks.pruneDue.length === 0 ? [] : await deps.db
    .select(columns)
    .from(vecs)
    .leftJoin(docs, and(eq(docs.collection, vecs.collection), eq(docs.recordId, vecs.recordId)))
    .where(and(
      inArray(vecs.collection, marks.pruneDue),
      sql`(${isNull(docs.recordId)} or ${docs.deleted} = 1 or ${docs.restricted} = 1 or trim(coalesce(${docs.title}, '')) = '')`,
    ))
    .limit(limit);
  const revoked = marks.revoked.length === 0 || lost.length >= limit ? [] : await deps.db
    .select(columns)
    .from(vecs)
    .where(inArray(vecs.collection, marks.revoked))
    .limit(limit - lost.length);
  const gone = [...lost, ...revoked];
  // Same rule as the embed half: a query that came back short of the limit found every orphan there was.
  const finish = async () => {
    if (marks.pruneDue.length > 0 && lost.length < limit) await markFinished(deps, marks.pruneDue, { prunedAt: tickAt });
    // A mark outliving its collection's place in INDEXABLE would let the collection skip its first full read
    // if it were ever added back.
    if (marks.retired.length > 0) await deps.db.delete(schema.searchVectorMarks).where(inArray(schema.searchVectorMarks.collection, marks.retired));
  };

  if (gone.length === 0) {
    await finish();
    return 0;
  }

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
  await finish();
  return gone.length;
}

/** What gets embedded for a row - defined in domain/semanticSearch.ts, re-exported for this module's callers. */
export { embedText };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `isIndexable` agrees the collection may be embedded. Re-exported so callers do not reach past
 *  this module into the policy for a decision this module owns the consequences of. */
export const mayIndex = isIndexable;
