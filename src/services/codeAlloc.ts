// Code allocation at the persistence boundary: fetch the sibling codes in scope, then compose the next
// code via the pure domain core (domain/codes.ts). Tables are loosely typed (`any`) to avoid Drizzle's
// generic gymnastics; every resource table has a `.code` column (schema.ts). The internal `code` is the
// matching/scoping key (docs/archive/plan.txt section 0); it is never on the wire.
//
// CONCURRENCY: a leaf comes from the scope's counter (schema `code_sequences`), taken with one atomic
// statement, so two creates at the same moment take different values rather than composing the same one. The
// UNIQUE index on `code` remains the backstop - it is what makes a stale counter fail safe instead of minting
// a duplicate - and `withFreshCode` below turns that into a record anyway: the loser takes the counter again,
// which has moved on. A collision that survives every attempt surfaces as the retryable 409 in
// middleware/errorHandler.ts.
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { childCodeAt, maxChildSeg, nextChildCode } from "../domain/codes";
import { chunk } from "../lib/dbBatch";
import { isCodeCollision } from "../lib/errors";

export const CODE_WIDTH = { dept: 2, employee: 3, owned: 3, flat: 2 } as const;

/**
 * Reserve `count` consecutive sequence values for a scope, as ONE indexed statement.
 *
 * This is what stops allocation costing a read of every sibling. `SELECT code FROM <table>` is fine on a
 * bounded table and ruinous on an append-only one: `event_log` is written by essentially every action and is
 * never pruned, so composing one code came to mean reading every event ever recorded - per action, on a
 * platform that bills rows read.
 *
 * `seed` is only called on a scope's FIRST touch, and is the old whole-scope read: it establishes the
 * high-water mark of whatever is already stored (a seeded database, or this counter being introduced over a
 * live one). After that the scope is pure arithmetic. See the note on schema `codeSequences`.
 *
 * Returns the FIRST value of the reserved run; the run is `[value, value + count - 1]`.
 */
async function reserve(deps: Deps, scope: string, count: number, seed: () => Promise<number>): Promise<number> {
  // The steady state: the counter exists, so one indexed update hands back the end of the reserved run.
  const [bumped] = await deps.db
    .update(schema.codeSequences)
    .set({ next: sql`${schema.codeSequences.next} + ${count}` })
    .where(eq(schema.codeSequences.scope, scope))
    .returning();
  if (bumped) return bumped.next - count + 1;
  // First touch of this scope. `onConflictDoUpdate` rather than a plain insert because two creates can reach
  // here at the same moment: the loser takes the run after the winner's instead of colliding with it.
  const from = (await seed()) + 1;
  const [created] = await deps.db
    .insert(schema.codeSequences)
    .values({ scope, next: from + count - 1 })
    .onConflictDoUpdate({ target: schema.codeSequences.scope, set: { next: sql`${schema.codeSequences.next} + ${count}` } })
    .returning();
  return created!.next - count + 1;
}

/** The scope key for a table's flat namespace, and for one owner's namespace within a table. */
const tableName = (table: any) => getTableConfig(table).name;
const ownedScope = (table: any, ownerUuid: string) => `${tableName(table)}:${ownerUuid}`;

// Flat resources (holidays, leave-types, pay-periods, announcements, payroll-runs, users): one namespace.
export async function allocFlatCode(deps: Deps, table: any, minWidth: number = CODE_WIDTH.flat): Promise<string> {
  return (await allocFlatCodes(deps, table, 1, minWidth))[0]!;
}

// `count` flat codes from ONE statement, for a create that makes many rows in a single act (a box of twenty
// adapters, a pasted list of serials). Allocating in a loop would take the counter n times, which the
// subrequest budget cannot afford (see lib/dbBatch.ts).
export async function allocFlatCodes(deps: Deps, table: any, count: number, minWidth: number = CODE_WIDTH.flat): Promise<string[]> {
  const from = await reserve(deps, tableName(table), count, async () => {
    const rows = await deps.db.select({ code: table.code }).from(table);
    return maxChildSeg(rows.map((r: { code: string | null }) => r.code), null);
  });
  return Array.from({ length: count }, (_, i) => childCodeAt(null, from + i, minWidth));
}

// Children of a department: BOTH sub-departments (parentId) AND employees (departmentId) share the same
// child-segment namespace under a dept, so they never collide (docs/archive/plan.txt section 0 design note).
export async function allocUnderDept(deps: Deps, parentUuid: string | null, minWidth: number): Promise<string> {
  let parentCode: string | null = null;
  if (parentUuid) {
    const d = (await deps.db.select({ code: schema.departments.code }).from(schema.departments).where(eq(schema.departments.uuid, parentUuid)).limit(1))[0];
    parentCode = d?.code ?? null;
  }
  const subDepts = await deps.db
    .select({ code: schema.departments.code })
    .from(schema.departments)
    .where(parentUuid ? eq(schema.departments.parentId, parentUuid) : isNull(schema.departments.parentId));
  const emps = await deps.db
    .select({ code: schema.employees.code })
    .from(schema.employees)
    .where(parentUuid ? eq(schema.employees.departmentId, parentUuid) : isNull(schema.employees.departmentId));
  return nextChildCode([...subDepts, ...emps].map((r) => r.code), parentCode, minWidth);
}

// Employee-owned resources (leave-requests, documents, payslips, leave-balances, holiday-selections):
// code = owner employee's code + own seg, scoped within (this table, this owner).
// The counter is keyed on (table, owner) and holds the LEAF number, not the composed code - so it survives the
// owner moving department. A move rewrites the prefix on their existing rows; the leaf sequence carries on from
// where it was, which is what keeps the new codes clear of the old ones either way.
export async function allocOwnedCode(
  deps: Deps,
  table: any,
  ownerCol: any,
  ownerUuid: string,
  minWidth: number = CODE_WIDTH.owned,
  resync = false,
): Promise<string> {
  return (await allocOwnedCodesFor(deps, table, ownerCol, [ownerUuid], minWidth, undefined, resync)).get(ownerUuid)!;
}

/**
 * ONE owned code for EACH of many owners - the fan-out form of `allocOwnedCode`, and the reason a broadcast
 * does not have to compose codes some other way.
 *
 * A fan-out that reads each owner's existing codes and takes max+1 looks equivalent and is not: it leaves the
 * scope's COUNTER untouched, so every row it writes is a leaf the counter has never heard of. The next single
 * `notify()` for that person then takes a counter value that is already on disk, the unique index refuses it,
 * and four retries only walk the counter forward four places - which is how notifications for a busy person
 * were quietly lost ("[notify] insert failed (non-fatal)"). Both paths have to take numbers from the same
 * place, and this is that place, taken for many owners at once.
 *
 * Cost is what made the divergence tempting, so it is kept: the steady state is ONE batch of indexed counter
 * bumps (one subrequest), and the whole-scope read only happens for owners whose counter does not exist yet.
 */
export async function allocOwnedCodesFor(
  deps: Deps,
  table: any,
  ownerCol: any,
  ownerUuids: string[],
  minWidth: number = CODE_WIDTH.owned,
  /** The owners' employee codes, when the caller has already read them - a fan-out usually has. */
  ownerCodes?: Map<string, string | null>,
  /**
   * Re-establish each counter against what is actually STORED before taking a number, instead of trusting it.
   *
   * The counter can only be behind if something once wrote codes without it - a table populated by a seed
   * script, or a fan-out that composed its own (which is what this function replaced). A counter that is behind
   * hands out numbers that are already on disk, and the unique index refuses every one of them, so retrying
   * with the same fast path only walks it forward one place per attempt and never catches up. Set on a RETRY
   * (see `withFreshCode`, which passes the attempt number): the first try stays cheap, and a collision pays for
   * the read that makes the scope correct from then on.
   */
  resync = false,
): Promise<Map<string, string>> {
  const owners = [...new Set(ownerUuids.filter(Boolean))];
  const out = new Map<string, string>();
  if (!owners.length) return out;

  // The prefix half of the code: the owner's own employee code. One read for the whole fan-out, skipped when
  // the caller already holds them.
  const parentCode = new Map<string, string | null>(ownerCodes ?? []);
  const unknown = owners.filter((uuid) => !parentCode.has(uuid));
  for (const group of chunk(unknown, IN_CHUNK)) {
    const rows = await deps.db.select({ uuid: schema.employees.uuid, code: schema.employees.code }).from(schema.employees).where(inArray(schema.employees.uuid, group));
    for (const r of rows) parentCode.set(r.uuid, r.code);
  }

  // The leaf half: bump every owner's counter in one batch. A scope with no counter row yet updates nothing,
  // which is exactly how the first-touch set is identified - no extra read to find it.
  const scopes = owners.map((uuid) => ({ uuid, scope: ownedScope(table, uuid) }));
  const seeding: { uuid: string; scope: string }[] = [];
  if (resync) {
    seeding.push(...scopes);
  } else {
    const bumped = await batchRows(
      deps,
      scopes.map(({ scope }) =>
        deps.db.update(schema.codeSequences).set({ next: sql`${schema.codeSequences.next} + 1` }).where(eq(schema.codeSequences.scope, scope)).returning(),
      ),
    );
    scopes.forEach(({ uuid, scope }, i) => {
      const row = (bumped[i] as { next: number }[] | undefined)?.[0];
      if (row) out.set(uuid, childCodeAt(parentCode.get(uuid) ?? null, row.next, minWidth));
      else seeding.push({ uuid, scope });
    });
    if (!seeding.length) return out;
  }

  // Scopes with no counter yet, plus (on a resync) the ones whose counter is not to be trusted: establish the
  // high-water mark from what is actually stored, then take the number past it.
  //
  // `max(stored counter, high-water mark) + 1` in the conflict branch covers both reasons this row may already
  // exist. Two writers reaching a brand-new scope together: the loser takes the number AFTER the winner's
  // rather than colliding with it. A counter that had fallen behind: it jumps to the mark instead of handing
  // out a number that is already on disk again.
  const seen = new Map<string, (string | null)[]>();
  for (const group of chunk(seeding.map((f) => f.uuid), IN_CHUNK)) {
    const rows = (await deps.db.select({ owner: ownerCol, code: table.code }).from(table).where(inArray(ownerCol, group))) as { owner: string; code: string | null }[];
    for (const r of rows) seen.set(r.owner, [...(seen.get(r.owner) ?? []), r.code]);
  }
  const created = await batchRows(
    deps,
    seeding.map(({ uuid, scope }) => {
      const mark = maxChildSeg(seen.get(uuid) ?? [], parentCode.get(uuid) ?? null);
      return deps.db
        .insert(schema.codeSequences)
        .values({ scope, next: mark + 1 })
        .onConflictDoUpdate({ target: schema.codeSequences.scope, set: { next: sql`max(${schema.codeSequences.next}, ${mark}) + 1` } })
        .returning();
    }),
  );
  seeding.forEach(({ uuid }, i) => {
    const row = (created[i] as { next: number }[] | undefined)?.[0];
    if (row) out.set(uuid, childCodeAt(parentCode.get(uuid) ?? null, row.next, minWidth));
  });
  return out;
}

// D1 caps bound params per statement, not per batch - these statements carry two or three each, so the only
// reason to chunk is to keep a single batch a sane size. Reads are chunked at the usual inArray width.
const IN_CHUNK = 90;
const BATCH_STMTS = 90;

/** Run builders as batches and hand back each one's rows, in the order given. */
async function batchRows(deps: Deps, stmts: PromiseLike<unknown>[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const group of chunk(stmts, BATCH_STMTS)) {
    if (group.length === 1) out.push(await group[0]!);
    else out.push(...(await deps.db.batch(group as unknown as Parameters<Deps["db"]["batch"]>[0])));
  }
  return out;
}

// How many times a create re-reads its scope after losing the race above. Four covers the burst a handful of
// simultaneous writers make - each retry reads AFTER the winner committed, so attempts thin out rather than
// pile up - and past that the scope is contended by something a longer wait would not fix.
const CODE_ATTEMPTS = 4;

/** Run an insert that allocates its own code, re-allocating if a simultaneous create took the code first.
 *
 *  The allocation has to happen INSIDE `write` (`code: await allocFlatCode(…)` in the `.values()`, which is
 *  how every call site already spells it), because re-reading the scope is the whole point: the winner has
 *  committed by the time the loser looks again, so the second attempt composes the next code rather than the
 *  same one. What survives every attempt reaches the caller as the retryable 409 middleware/errorHandler.ts
 *  makes of a code collision - the only case a client is ever asked to retry by hand.
 *
 *  `lost` says which collisions are a lost race rather than a fault. It defaults to the code index; a create
 *  that allocates a second number the same way (a card's per-board key) widens it to that index too. */
export async function withFreshCode<R>(
  write: (attempt: number) => Promise<R>,
  lost: (err: unknown) => boolean = isCodeCollision,
  attempts: number = CODE_ATTEMPTS,
): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(attempt);
    } catch (e) {
      if (attempt >= attempts || !lost(e)) throw e;
    }
  }
}
