// The Vectorize transport for semantic search.
//
// WHY A SEPARATE DATASTORE AT ALL, when this app keeps everything in D1 and the AI plan originally argued for
// holding vectors there too. That argument was wrong, and it is worth writing down why rather than quietly
// changing course.
//
// A brute-force cosine scan in the Worker has to READ EVERY VECTOR in the caller's collections on every
// query. At 384 dimensions that is roughly 1.5 KB per row before encoding, so a twenty-thousand row corpus is
// tens of megabytes of D1 reads per keystroke. D1 bills rows read, and the entire reason `search_docs` and
// its FTS5 index exist (see db/searchDdl.ts) is that the `LIKE '%q%'` fan-out they replaced scaled with the
// size of the database. Putting vectors in D1 would reintroduce exactly that cost in a worse form. Vectorize
// answers the same question as an index lookup.
//
// WHAT THIS COSTS IN PRIVACY, stated plainly because it is the price of the above: an embedding is a lossy
// but partially invertible projection of its source text, so this index holds derived personal data in a
// store outside the main tables. Two things keep that bounded. The text embedded is only the title and
// subtitle `search_docs` already holds - what a directory listing shows - because domain/aiPolicy.ts decides
// what may be indexed at all. And the metadata carries the collection and nothing else, so the index cannot
// be read as a staff directory even by someone holding it.
//
// SCOPE IS NOT ENFORCED HERE. The collection filter is a pre-filter to keep topK useful, not an access
// decision: Vectorize metadata cannot express `applyScope`'s department prefixes and owner columns, and an
// access rule that is approximated is an access rule that is wrong. services/semanticSearch.ts takes the ids
// this returns and re-decides them in SQL against `search_docs` with the same predicate the FTS path uses.
import type { VectorIndex } from "../ports";

/** Vectorize caps topK at 100 when metadata is not returned. We never need it returned - the id carries
 *  everything, and the row is read from D1 anyway. */
const MAX_TOP_K = 100;

/** Upsert batch size. Vectorize accepts more, but a batch is also one subrequest against the invocation's
 *  budget, and the embed drain is already bounded by the daily neuron ceiling. */
const UPSERT_BATCH = 100;

export function makeVectorIndex(index: VectorizeIndex): VectorIndex {
  return {
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
        const slice = vectors.slice(i, i + UPSERT_BATCH);
        await index.upsert(slice.map((v) => ({ id: v.id, values: v.values, metadata: { collection: v.collection } })));
      }
    },

    async query(vector, { topK, collections }) {
      if (collections.length === 0) return [];
      const res = await index.query(vector, {
        topK: Math.min(topK, MAX_TOP_K),
        returnValues: false,
        returnMetadata: "none",
        // A pre-filter, not a permission check - see the header. `$in` over the collections the caller may
        // list keeps topK from being filled entirely by rows the SQL re-check would then throw away.
        filter: { collection: { $in: collections } },
      });
      return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
    },

    async fetch(ids) {
      const out = new Map<string, number[]>();
      if (ids.length === 0) return out;
      for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
        const got = await index.getByIds(ids.slice(i, i + UPSERT_BATCH));
        for (const v of got) {
          // `values` is optional on the returned shape and absent for an index that stores no values. Skipping
          // rather than defaulting: a zero vector would be a silent wrong answer, nearest to nothing.
          if (v.values) out.set(v.id, Array.from(v.values as ArrayLike<number>));
        }
      }
      return out;
    },

    async remove(ids) {
      if (ids.length === 0) return;
      for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
        await index.deleteByIds(ids.slice(i, i + UPSERT_BATCH));
      }
    },
  };
}

/** The index id for one indexed row. `search_docs` is unique on (collection, recordId), so this is already a
 *  key and needs no side table to decode. Both halves are generated identifiers or registry names, neither of
 *  which contains a colon, so the split below is unambiguous. */
export const vectorIdOf = (collection: string, recordId: string): string => `${collection}:${recordId}`;

/** Inverse of `vectorIdOf`. Returns null for anything that is not one of our ids, so a stale or foreign entry
 *  in the index is dropped rather than turned into a lookup for a record that does not exist. */
export function parseVectorId(id: string): { collection: string; recordId: string } | null {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  return { collection: id.slice(0, at), recordId: id.slice(at + 1) };
}
