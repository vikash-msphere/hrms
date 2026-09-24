// Conditional GET for collection lists: `ETag` on the way out, `If-None-Match` on the way back, and a 304 that
// costs one indexed row instead of a page of them.
//
// WHY, given `GET /v1/changes` already exists. The change feed answers the question ONCE PER PAGE LOAD: the
// client asks what has been written since it last looked, keeps everything else, and pays nothing for it. What
// it does not cover is the rest of the session. Inside a page life every cached list has a freshness window
// (20 seconds for anything transactional, a minute for the directory, five for the reference catalogs), and
// when that window lapses the client re-reads the collection - up to a hundred rows - almost always to be told
// the same thing it already had. That is the single largest remaining source of D1 row reads in ordinary use.
//
// WHY THE STAMP IS GLOBAL. The obvious etag is the collection's own change stamp, and it is not safe: a list
// response is not only its own rows. `decorate` folds in fields computed from other collections (an employee's
// profile flags), route-level list hooks join across tables, and `extra` carries aggregates. Keyed on one
// collection's stamp, a 304 would serve a payload whose enriched half had moved on - and there is no honest way
// to enumerate the contributing collections per route without a second registry to drift.
//
// So the question this etag actually asks is "has ANYTHING been written since I fetched this", answered by
// `max(at)` over the ~70 stamp rows (indexed, so one row). That under-caches in a busy org, which is the right
// direction to be wrong in: it can never serve a payload that a write has invalidated.
//
// WHY THE TIME BUCKET. Some list hooks answer relative to now (what is upcoming, what is due today), so their
// answer can change with no write at all. The bucket caps how long a 304 can be served for such a list, and is
// sized to the freshness windows this exists to serve: five minutes covers many revalidations of a
// twenty-second collection, and bounds a date-boundary answer to the same five minutes.
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { authzVersion } from "../domain/authzVersion";
import { fnv1a64 } from "../lib/fnv";

const WINDOW_MS = 5 * 60_000;

/**
 * What was ASKED FOR: the path, plus every query parameter sorted - page size, cursor, the soft-delete view,
 * and each collection's own filters.
 *
 * The path is in it because without it two collections asked the same question mint the same validator:
 * `/v1/tickets?max_page_size=100` and `/v1/leave-requests?max_page_size=100` differ in nothing else, so a
 * validator that ever reached the wrong route would earn a 304 and leave the caller holding one collection's
 * rows as another's.
 *
 * Hashed 64-bit (lib/fnv.ts): the whole point of this key is that two different questions cannot mint the same
 * validator, and a 304 is the answer "you already hold this" - so a collision here is precisely the wrong-rows
 * outcome the paragraph above describes, reached by chance instead of by a routing mistake.
 */
function requestKey(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return fnv1a64([u.pathname, ...params.map(([k, v]) => `${k}=${v}`)].join("&"));
}

/** When anything in the database was last written. One row, off the `at` index. */
export async function lastWriteAt(deps: Deps, now = Date.now()): Promise<number> {
  const rows = (await deps.db
    .select({ at: sql<number | null>`max(${schema.collectionVersions.at})` })
    .from(schema.collectionVersions)) as { at: number | null }[];
  const at = rows[0]?.at ?? 0;
  // A stamp in the future (a clock that moved backwards) would pin the etag until real time caught up.
  return at > now ? now : at;
}

/**
 * The etag for this list request. Weak, because the bytes are re-serialized per caller and only their MEANING
 * is being compared.
 *
 * `authzVersion` is in it because a serialized row carries the per-object access hints and the field
 * redactions computed for whoever asked: the same rows, unchanged, are a different answer to someone whose
 * permissions have moved.
 */
export function listEtag(lastWrite: number, user: AppUser, url: string, now = Date.now()): string {
  return `W/"${lastWrite}-${Math.floor(now / WINDOW_MS)}-${authzVersion(user.grant, user.employeeCode, user.policy.redacted_fields)}-${requestKey(url)}"`;
}

/**
 * Whether the caller already holds this exact answer. Handles the list form (`a, b`) and `*`, and compares
 * ignoring the weak marker, as RFC 9110 requires for a GET.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (s: string) => s.trim().replace(/^W\//, "");
  const want = strip(etag);
  return header.split(",").some((candidate) => {
    const c = strip(candidate);
    return c === "*" || c === want;
  });
}
