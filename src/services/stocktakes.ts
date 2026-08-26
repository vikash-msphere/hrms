// Stocktake sessions: a walk-through of the inventory, as a record.
//
// The session holds no sightings. `:verify` stamps those on the asset row it was already updating
// (services/assets.ts), which is what keeps one scan at one write. What lives here is the frame around them -
// who is counting, from when, over what scope - plus the two things a stamp cannot express: the scans that
// matched nothing (`:recordFound`) and the frozen result (`:close`).
//
// NO access control here: the middleware gates the collection by path + grants (private by default), exactly
// as for every other collection. `status === "open"` is a workflow precondition, not a permission.
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { aborted, failedPrecondition, invalidArgument, notFound } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";
import { emitEvent } from "./eventBus";
import {
  FLAGGED_CONDITIONS,
  MISSING_EVENT_CAP,
  MISSING_SNAPSHOT_CAP,
  SIGHTED_SNAPSHOT_CAP,
  missingRow,
  normalizeScope,
  parseFound,
  parseScope,
  scoreStocktake,
  sightedRow,
  type FoundEntry,
  type StocktakeResult,
} from "../domain/stocktake";
import { daysBetween } from "../domain/assetCustody";

export type StocktakeInput = {
  label?: string;
  /** `{ statuses?: string[], categories?: string[] }` - categories arrive as `asset-categories/<id>` refs. */
  scope?: { statuses?: string[]; categories?: string[] } | null;
  notes?: string | null;
};

/** A scan that found something the inventory does not know about. */
export type FoundInput = {
  scan?: string | null;
  note?: string | null;
};

/** How many unexpected finds one walk may log before the list stops being a list. */
const FOUND_CAP = 500;

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Category ids arrive as resource paths (the inbound edge already decoded the token); store bare ids so the
// scope filter compares against `assets.category_id` directly.
const scopeColumns = (raw: StocktakeInput["scope"]) =>
  JSON.stringify(
    normalizeScope({
      statuses: raw?.statuses,
      categories: raw?.categories?.map((c) => idFromPath(c)!).filter(Boolean),
    }),
  );

// One place for the by-id predicate, so the guarded flip in `close` and the plain reads cannot drift.
const eqUuid = (id: string) => eq(schema.stocktakes.uuid, id);

export async function listStocktakes(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = and(showDeleted ? undefined : isNull(schema.stocktakes.deleteTime), applyScope(scope, schema.stocktakes.code, schema.stocktakes.code));
  // Newest first: the count somebody is running (or just ran) is the one they came for.
  return keysetPage(deps, schema.stocktakes, "stocktakes", where, { dir: "desc", max: maxPageSize, pageToken });
}

export async function getStocktake(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.stocktakes).where(eqUuid(id)).limit(1))[0];
  if (!row) throw notFound("stocktake not found");
  return row;
}

/** The open session a sighting may be filed against. Used by assets :verify, which is handed a ref. */
export async function requireOpenStocktake(deps: Deps, id: string) {
  const row = await getStocktake(deps, id);
  if (row.deleteTime) throw failedPrecondition("that stocktake has been deleted");
  if (row.status !== "open") throw failedPrecondition("that stocktake has been closed - start a new count");
  return row;
}

export const stocktakeSpec: CrudSpec<StocktakeInput, typeof schema.stocktakes> = {
  table: schema.stocktakes,
  collection: "stocktakes",
  auditName: "stocktake",
  notFound: "stocktake not found",
  insert: (input, _deps, actor) => {
    const label = input.label?.trim();
    if (!label) throw invalidArgument("label is required");
    return {
      label,
      scopeJson: scopeColumns(input.scope),
      status: "open",
      // Who is walking around. Null for a machine principal (an API key with no employee behind it), which is
      // allowed - the audit row still names the actor.
      startedBy: actor.employeeId ?? null,
      startedAt: new Date(),
      notes: input.notes?.trim() || null,
    };
  },
  // An open count can be renamed, re-scoped and annotated. A CLOSED one is a record: its scope decided what
  // its missing list means, so re-scoping it afterwards would rewrite the meaning of a frozen report.
  patch: (patch, row) => {
    const set: SetOf<typeof schema.stocktakes> = {};
    if (row.status !== "open") {
      if (has(patch, "label") || has(patch, "scope")) throw failedPrecondition("a closed count cannot be re-scoped or renamed");
    }
    if (has(patch, "label")) {
      const label = patch.label?.trim();
      if (!label) throw invalidArgument("label cannot be empty");
      set.label = label;
    }
    if (has(patch, "scope")) set.scopeJson = scopeColumns(patch.scope);
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    return set;
  },
};

/**
 * `:recordFound` - something was scanned that the inventory does not know about.
 *
 * This is a finding, not a failure: an untagged laptop in a drawer is exactly what a count is for. The raw
 * payload is kept verbatim (it is the only evidence of what was seen) and rides into the closing snapshot.
 */
export async function recordFound(deps: Deps, actor: AppUser, id: string, input: FoundInput = {}) {
  const raw = input.scan?.trim() || null;
  const note = input.note?.trim() || null;
  if (!raw && !note) throw invalidArgument("say what was found: a scanned code or a note");
  const entry: FoundEntry = {
    scan_time: new Date().toISOString(),
    ...(actor.employeeId ? { by: `employees/${actor.employeeId}` } : {}),
    ...(raw ? { raw } : {}),
    ...(note ? { note } : {}),
  };
  // The append is a read-modify-write of one JSON column, so it is guarded by a compare-and-set on the exact
  // value that was read. Two people walking one count and scanning at the same moment is the NORMAL case for
  // this feature (a count is resumable and multi-scanner by design), and an unguarded write silently drops the
  // loser's find - which is the only record that something unexpected was seen. On a lost race, re-read and
  // append again; the retries are bounded so a pathological hot row fails loudly instead of spinning.
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await requireOpenStocktake(deps, id);
    const found = parseFound(row.foundJson);
    if (found.length >= FOUND_CAP) throw failedPrecondition(`this count already holds ${FOUND_CAP} unexpected finds - close it and start another`);
    const [updated] = await deps.db
      .update(schema.stocktakes)
      .set({ foundJson: JSON.stringify([...found, entry]), updatedAt: new Date() })
      .where(and(eqUuid(id), row.foundJson === null ? isNull(schema.stocktakes.foundJson) : eq(schema.stocktakes.foundJson, row.foundJson)))
      .returning();
    if (updated) {
      await audit(deps, actor, "stocktake.recordFound", "stocktakes", id, { raw, note }, updated);
      return updated;
    }
  }
  throw aborted("several scanners are logging finds against this count at once - try that scan again");
}

/**
 * `:close` - freeze the count.
 *
 * The missing list is computed HERE, over the whole inventory in scope, and stored. A list derived live would
 * rot (assets get retired, reassigned, or scanned a week later), so a closed count would stop being
 * reproducible - the snapshot is the auditable artefact this collection exists to produce.
 *
 * One-way. Re-opening a closed count would let a later scan quietly change a signed-off number; another walk
 * is another row. The flip is guarded (`status = open` in the WHERE), so two people pressing Close race to one
 * winner instead of writing two different snapshots.
 *
 * Nothing is done to the asset rows: not finding something proves nothing about the thing, only about the
 * search. What is owed to the rest of the system is emitted - one `stocktake.closed`, plus
 * `asset.stocktakeMissing` for each missing asset that HAS a holder (somebody who can be asked to look).
 */
export async function closeStocktake(deps: Deps, actor: AppUser, id: string, input: { notes?: string | null } = {}) {
  const row = await requireOpenStocktake(deps, id);
  const scope = parseScope(row.scopeJson);
  const found = parseFound(row.foundJson);
  // Only the columns the scoring and the two snapshots use, and only the rows the count DECLARED - the status
  // and category filters are the session's own, so they belong in the query rather than in a JS filter over the
  // whole inventory (D1 bills rows read). `inScope` still runs over what comes back: it is the one definition of
  // what a count covers, and a closing count must not depend on the query and the predicate agreeing by luck.
  const scoped = [
    scope.statuses?.length ? inArray(schema.assets.status, scope.statuses as (typeof schema.assets.$inferSelect.status)[]) : undefined,
    scope.categories?.length ? inArray(schema.assets.categoryId, scope.categories) : undefined,
  ].filter(Boolean) as SQL[];
  const assets = await deps.db
    .select({
      uuid: schema.assets.uuid,
      assetTag: schema.assets.assetTag,
      name: schema.assets.name,
      categoryId: schema.assets.categoryId,
      status: schema.assets.status,
      assignedTo: schema.assets.assignedTo,
      verifiedAt: schema.assets.verifiedAt,
      verifiedBy: schema.assets.verifiedBy,
      verifiedScanned: schema.assets.verifiedScanned,
      custodyState: schema.assets.custodyState,
    })
    .from(schema.assets)
    .where(scoped.length ? and(...scoped) : undefined);
  const { missing, sighted, counts } = scoreStocktake({ startedAt: row.startedAt, scope }, assets, found);
  const now = new Date();
  // Chase the ones somebody is holding first: those are the rows a notification can actually act on, so if
  // the event cap bites it bites the rows nobody could have chased anyway.
  const chaseable = missing.filter((a) => a.assignedTo);
  const ordered = [...chaseable, ...missing.filter((a) => !a.assignedTo)];
  // The sighted list is frozen too, and cannot be rebuilt afterwards: `last_stocktake_id` on the asset names
  // whichever count claimed the LATEST sighting, so the next walk would quietly take this one's evidence away.
  // Ordered so a truncated snapshot keeps the rows worth re-reading rather than the first five hundred
  // alphabetically. Two axes, one order: how well the sighting is PROVED decides first (a hand-tick is
  // somebody's word, a scan is evidence), and within each proof class a flagged condition comes first (seen,
  // but not in one piece). So: hand-ticked+flagged, hand-ticked, scanned+flagged, scanned.
  const salience = (a: (typeof sighted)[number]) =>
    (a.verifiedScanned === true ? 2 : 0) + (FLAGGED_CONDITIONS.includes(a.custodyState ?? "") ? -1 : 0);
  const bySalience = [...sighted].sort((a, b) => salience(a) - salience(b) || (a.assetTag ?? a.name).localeCompare(b.assetTag ?? b.name));
  const result: StocktakeResult = {
    counts,
    missing: ordered.slice(0, MISSING_SNAPSHOT_CAP).map(missingRow),
    ...(ordered.length > MISSING_SNAPSHOT_CAP ? { missing_truncated: ordered.length - MISSING_SNAPSHOT_CAP } : {}),
    sighted: bySalience.slice(0, SIGHTED_SNAPSHOT_CAP).map(sightedRow),
    ...(bySalience.length > SIGHTED_SNAPSHOT_CAP ? { sighted_truncated: bySalience.length - SIGHTED_SNAPSHOT_CAP } : {}),
    found,
    ...(chaseable.length > MISSING_EVENT_CAP ? { notify_truncated: chaseable.length - MISSING_EVENT_CAP } : {}),
  };
  const [updated] = await deps.db
    .update(schema.stocktakes)
    .set({
      status: "closed",
      closedBy: actor.employeeId ?? null,
      closedAt: now,
      resultJson: JSON.stringify(result),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      updatedAt: now,
    })
    .where(and(eqUuid(id), eq(schema.stocktakes.status, "open")))
    .returning();
  if (!updated) throw failedPrecondition("this count has just been closed by somebody else");
  await audit(deps, actor, "stocktake.close", "stocktakes", id, { counts, missing: counts.missing }, updated);
  await emitEvent(deps, actor, "stocktake.closed", {
    subject: `stocktakes/${id}`,
    payload: { label: updated.label, scopeTotal: counts.scope_total, sighted: counts.sighted, missing: counts.missing, found: counts.found, flagged: counts.flagged },
  });
  for (const a of chaseable.slice(0, MISSING_EVENT_CAP)) {
    await emitEvent(deps, actor, "asset.stocktakeMissing", {
      subject: `assets/${a.uuid}`,
      employeeId: a.assignedTo,
      payload: {
        categoryId: a.categoryId ?? null,
        assetTag: a.assetTag,
        name: a.name,
        label: updated.label,
        days: a.verifiedAt ? daysBetween(new Date(a.verifiedAt), now) : 0,
      },
    });
  }
  return updated;
}
