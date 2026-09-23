// A `VectorIndex` backed by D1, so semantic search can be exercised without a Vectorize index.
// Development and the browser suite only.
//
// THIS IS NOT A REVERSAL OF lib/vector.ts, and the two headers have to be read together or they look like a
// contradiction. That file argues - correctly - that vectors do not belong in D1: a brute-force cosine scan
// reads EVERY vector in the caller's collections on every query, D1 bills rows read, and at 384 dimensions a
// twenty-thousand-row corpus is tens of megabytes of reads per keystroke. That argument is entirely about
// production economics, and none of it survives contact with a local seed database, where reads cost nothing
// and the corpus is a few hundred rows. The same scan that would be a billing incident on the edge is a
// millisecond here.
//
// WHY IT EXISTS AT ALL: Miniflare's Vectorize plugin has no local implementation. It builds a remote proxy
// client, so a `VEC` binding in `wrangler dev` is production's index or an error - there is no third option
// and no flag that makes one. Without this file, "test semantic search locally" means writing vectors into
// the real index under local record ids, which is the same class of mistake as staging sharing production's
// index (see docs/deploy-ai.md).
//
// `dev_vectors` IS DELIBERATELY NOT IN src/db/migrations. It is created lazily, by a constructor that only
// runs when a loopback-verified AI_LOCAL_URL is set (deps.ts), so it cannot come into existence in a deployed
// database - and keeping it out of db/schema.ts keeps it out of the change-DDL classification the drift gate
// holds, which is honest rather than evasive: a table that only a dev stack can create is not part of the
// schema the app ships.
//
// The alternative was an in-memory Map, and it is worse. `wrangler dev` reloads the worker on every save, so
// the index would empty while `search_vectors` still recorded those rows as embedded - and the drain, which
// only re-embeds rows whose text has CHANGED, would correctly do nothing. Semantic search would answer
// nothing, forever, and look like a bug in the drain.
import { sql } from "drizzle-orm";
import type { DB } from "../deps";
import type { VectorIndex } from "../ports";
import { chunk, ID_CHUNK } from "./dbBatch";
import { cosine } from "./aiLocal";

/**
 * Rows per upsert statement.
 *
 * Three bound parameters each (id, collection, values) against D1's ~100 per statement, so 30 leaves room and
 * stays well clear of the cap that has already broken the embed drain's rotation stamp once by binding 200
 * ids in one statement.
 */
const UPSERT_ROWS = 30;

/**
 * Is this the "table is gone" error, anywhere in the chain?
 *
 * DOWN THE `cause` CHAIN, not on the top-level message, and the difference is not pedantic: drizzle wraps a
 * D1 failure in a `DrizzleQueryError` whose own message is `Failed query: insert or replace into ...` and
 * whose SQLITE text lives two `cause` links below. Tested against `String(e)` the retry below never fired at
 * all, and the symptom was identical to having no retry - which is how a recovery path comes to be written,
 * shipped, and never once executed.
 */
function missingTable(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    if (String((x as Error)?.message ?? x).includes("no such table: dev_vectors")) return true;
  }
  return false;
}

/** Vectorize caps topK at 100; matched here so a local run cannot pass on a topK the real index would clamp. */
const MAX_TOP_K = 100;

// `vals`, not `values`: VALUES is a reserved word in SQLite, so aliasing the column to it fails the whole
// statement with `near "values": syntax error` - which reads as a bug in the query being built rather than in
// the name it was given.
type Row = { id: string; collection: string; vals: string };

export function makeLocalVectorIndex(db: DB): VectorIndex {
  // One create per isolate, reused rather than issued per call: `CREATE TABLE IF NOT EXISTS` is cheap but it
  // is still a statement, and the query path runs on a request.
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => (ready ??= (async () => {
    await db.run(sql`create table if not exists dev_vectors (
      id text primary key,
      collection text not null,
      values_json text not null
    )`);
    await db.run(sql`create index if not exists dev_vectors_collection_idx on dev_vectors (collection)`);
  })());

  /**
   * Run `fn`, creating the table first, and once more if the table turns out to have gone away.
   *
   * THE RETRY IS NOT DEFENSIVENESS, it is the memo above being wrong about one real environment. Caching the
   * create assumes that a table made once stays made, which holds for a dev stack and does NOT hold under
   * `@cloudflare/vitest-pool-workers`: `isolatedStorage` rolls the database back between tests while module
   * state survives, so the second test in a file found `ready` already resolved and the table gone. It failed
   * as `D1_ERROR: no such table: dev_vectors` from inside the embed drain - which reads like a broken drain
   * rather than a broken cache.
   *
   * Clearing the memo rather than just re-creating is what makes it self-healing instead of once-lucky.
   */
  async function withTable<T>(fn: () => Promise<T>): Promise<T> {
    await ensure();
    try {
      return await fn();
    } catch (e) {
      if (!missingTable(e)) throw e;
      ready = undefined;
      await ensure();
      return fn();
    }
  }

  const parse = (r: Row): number[] => JSON.parse(r.vals) as number[];

  return {
    async upsert(vectors) {
      if (vectors.length === 0) return;
      await withTable(async () => {
        for (const group of chunk(vectors, UPSERT_ROWS)) {
          const values = sql.join(
            group.map((v) => sql`(${v.id}, ${v.collection}, ${JSON.stringify(v.values)})`),
            sql`, `,
          );
          await db.run(sql`insert or replace into dev_vectors (id, collection, values_json) values ${values}`);
        }
      });
    },

    async query(vector, { topK, collections }) {
      if (collections.length === 0) return [];
      // The collection pre-filter, exactly as lib/vector.ts uses Vectorize metadata for: it keeps topK from
      // being filled by rows the SQL re-check would throw away. It is NOT an access decision here either -
      // services/globalSearch.ts re-decides every id against `search_docs` with the same predicate the FTS
      // path uses.
      const rows = await withTable(async () => {
        const found: Row[] = [];
        for (const group of chunk(collections, ID_CHUNK)) {
          const list = sql.join(group.map((c) => sql`${c}`), sql`, `);
          found.push(...await db.all<Row>(sql`select id, collection, values_json as vals from dev_vectors where collection in (${list})`));
        }
        return found;
      });
      return rows
        .map((r) => ({ id: r.id, score: cosine(vector, parse(r)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(topK, MAX_TOP_K));
    },

    async fetch(ids) {
      const out = new Map<string, number[]>();
      if (ids.length === 0) return out;
      await withTable(async () => {
        for (const group of chunk(ids, ID_CHUNK)) {
          const list = sql.join(group.map((i) => sql`${i}`), sql`, `);
          const rows = await db.all<Row>(sql`select id, collection, values_json as vals from dev_vectors where id in (${list})`);
          // A row the drain has not reached yet is simply absent, which is a normal state and not an error -
          // the same contract the Vectorize adapter keeps.
          for (const r of rows) out.set(r.id, parse(r));
        }
      });
      return out;
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await withTable(async () => {
        for (const group of chunk(ids, ID_CHUNK)) {
          const list = sql.join(group.map((i) => sql`${i}`), sql`, `);
          await db.run(sql`delete from dev_vectors where id in (${list})`);
        }
      });
    },
  };
}
