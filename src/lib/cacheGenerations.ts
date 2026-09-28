// Long-held server caches that still see every change within a few seconds.
//
// THE PROBLEM WITH A TTL. Every cache here lives in ONE Worker instance's memory, and Cloudflare runs many. A short
// TTL is the only way a plain cache learns about a change another instance made, and it barely caches at all: the
// SPA does not poll, so two page loads are usually more than a few seconds apart, and each one re-read every role's
// rules (hundreds of rows) from a database that bills per row.
//
// COUNTERS INSTEAD. `cache_generations` (db/schema.ts) is one row with a counter per kind of cached data, and a
// trigger on each source table bumps its counter in the same transaction as the write (migration 0003). So every
// writer is covered - a service, a cron, the code cascade, a migration, hand-run SQL - and no code path has to
// remember to clear anything. A cached value is held for HOLD_MS and remembers the counters it was loaded under;
// each read compares them with the current row, which an instance re-reads at most every CHECK_MS, and reloads
// only when one of ITS counters has moved. The row is the only thing every instance re-reads, and it is one row.
//
// WHY IT CANNOT SERVE A CHANGE LATE, given D1 read replicas:
//   - The counters are read BEFORE the data, in the same request's D1 session, whose reads never go back in
//     time. So the data is at least as new as the counters it is filed under. (Filed the other way round, a
//     lagging replica could label old rows with a new counter, and they would be held for the whole HOLD_MS.)
//   - Counters only go up, so a replica that answers the check with an older row just keeps the entry - it can
//     never make a change look older than the copy it replaced. No clock is involved anywhere.
//   - A change reaches every instance within CHECK_MS plus replica lag: the same bound the plain 5s TTL gave.
//
// FAIL-SAFE. When the row cannot be read (the migration has not run, or the row was deleted) every cached value
// falls back to expiring after CHECK_MS, which is exactly the old behaviour: more reads, never staler data.
import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { cached } from "./cache";

const t = schema.cacheGenerations;

/** Every counter, by the name the code uses for it. The column list lives here once. */
const COUNTERS = {
  roleRules: t.roleRules,
  aclRules: t.aclRules,
  userRoles: t.userRoles,
  policy: t.policy,
  roles: t.roles,
  org: t.org,
  codes: t.codes,
  automations: t.automations,
} as const;

export type Generation = keyof typeof COUNTERS;
export type Generations = Record<Generation, number>;

/** How often an instance re-reads the counters: the bound on how long a change takes to reach it. */
export const CHECK_MS = 5000;
/** How long a cached value is held while its counters stand still. Correctness never depends on it. */
export const HOLD_MS = 30 * 24 * 60 * 60_000;
/** The key the current counters are held under. Clearing it is what CHECK_MS passing amounts to. */
export const CURRENT_KEY = "cacheGenerations";

// The message of an error and of everything it wraps: drizzle reports a failed query as "Failed query: ..." and
// keeps the driver's own message ("no such table: ...") on `cause`.
function messages(e: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    parts.push(String((cur as { message?: unknown }).message ?? cur));
  }
  return parts.join(" | ");
}

let reportedMissing = false;

/** The counters as they stand, or null when there is no row to read (see FAIL-SAFE above). */
export async function readGenerations(deps: Deps): Promise<Generations | null> {
  try {
    const row = (await deps.db.select(COUNTERS).from(t).where(eq(t.id, 1)).limit(1))[0];
    if (row) return row;
  } catch (e) {
    if (!/no such table/i.test(messages(e))) throw e;
  }
  if (!reportedMissing) {
    reportedMissing = true;
    console.error("[cacheGenerations] no cache_generations row - server caches expire after 5s until migration 0003 is applied");
  }
  return null;
}

/** The counters this instance compares against, re-read at most every CHECK_MS. */
export const currentGenerations = (deps: Deps): Promise<Generations | null> => cached(CURRENT_KEY, CHECK_MS, () => readGenerations(deps));

type Held<T> = { at: Generations | null; loadedAt: number; value: T };

/**
 * `load()`'s value, held under `key` until one of the counters in `on` moves.
 *
 * `load` must read only data those counters cover, or a change to the rest will not reload it.
 */
export async function generational<T>(deps: Deps, key: string, on: readonly Generation[], load: () => Promise<T>): Promise<T> {
  const current = await currentGenerations(deps);
  const held = await cached<Held<T>>(
    key,
    HOLD_MS,
    async () => {
      // FIRST, and in this request's session - see "WHY IT CANNOT SERVE A CHANGE LATE".
      const at = await readGenerations(deps);
      return { at, loadedAt: Date.now(), value: await load() };
    },
    (h) => {
      const at = h.at;
      if (current === null || at === null) return Date.now() - h.loadedAt >= CHECK_MS;
      return on.some((g) => current[g] > at[g]);
    },
  );
  return held.value;
}

/**
 * Move every counter, so every instance reloads everything it holds within CHECK_MS.
 *
 * An upsert, so a deleted row comes back (and the instances leave the 5s fallback) rather than the flush
 * silently doing nothing.
 */
export async function bumpAllGenerations(deps: Deps): Promise<void> {
  const plusOne = Object.fromEntries(Object.entries(COUNTERS).map(([name, col]) => [name, sql`${col} + 1`])) as Record<Generation, ReturnType<typeof sql>>;
  const ones = Object.fromEntries(Object.keys(COUNTERS).map((name) => [name, 1])) as Generations;
  await deps.db.insert(t).values({ id: 1, ...ones }).onConflictDoUpdate({ target: t.id, set: plusOne });
}
