// Stocktake: the arithmetic of one walk-through of the inventory.
//
// A stocktake owns no sightings of its own - `:verify` stamps them on the asset row (`verified_at`,
// `verified_by`, `last_stocktake_id`), so a scan stays one write. Everything here is therefore a question
// asked of the asset rows plus the session's declared scope, and it is pure so the missing-list rule and the
// snapshot shape are unit-testable without a database.

import type { AssetCondition, AssetStatus } from "./assetCustody";

/** Every status a count may be asked to cover. `retired` is included only because an org may want to prove a
 *  retired thing is still in the cupboard; the UI's default preset leaves it out. */
export const COUNTABLE_STATUSES: AssetStatus[] = ["pending_verification", "in_stock", "pending_ack", "assigned", "repair", "retired"];

/**
 * What this walk expects to sight: an explicit status list and/or a category list (internal ids). An empty
 * list means "no filter on that axis" - `{}` is a count of the whole inventory.
 *
 * The client's presets ("in the office") are resolved to a status list BEFORE they are stored, so the server
 * never has to share a definition of a preset with the client - it filters on what the row says.
 */
export type StocktakeScope = { statuses?: string[]; categories?: string[] };

/** A scan that matched no asset. Kept verbatim: the raw payload is the only evidence of what was found.
 *  Absent fields are OMITTED rather than nulled - this object is stored as JSON and served as-is. */
export type FoundEntry = {
  scan_time: string; // ISO
  by?: string; // employees/<id>
  raw?: string; // the scanned payload, exactly as scanned
  note?: string;
};

/** One row of a closed count's missing list, frozen as it read at the moment of closing. */
export type MissingRow = {
  asset: string; // assets/<id>
  asset_tag?: string | null;
  name: string;
  category?: string | null; // asset-categories/<id>
  status: string;
  assigned_to?: string | null; // employees/<id>
  last_verified_time?: string | null;
};

/**
 * One row of a closed count's SIGHTED list - what this walk actually saw, frozen the same way the missing list
 * is.
 *
 * It cannot be recovered later: `last_stocktake_id` on the asset names the count that claimed the LATEST
 * sighting, so the next walk overwrites it and an older count would silently lose its evidence. A count that
 * can only say what it failed to find is half an audit record - "prove you saw these 480 things" is the more
 * common question - so the proof travels with the count.
 *
 * `scanned` is the part that matters most: a scan means somebody stood next to the thing, a hand-tick means
 * somebody said so.
 */
export type SightedRow = {
  asset: string; // assets/<id>
  asset_tag?: string | null;
  name: string;
  category?: string | null; // asset-categories/<id>
  status: string; // the status it ended the sighting in (a check-in leaves it `in_stock`)
  assigned_to?: string | null; // employees/<id>
  sighted_time?: string | null;
  sighted_by?: string | null; // employees/<id>
  scanned: boolean;
  condition?: string | null; // what the scanner reported: good / damaged / missing_parts
};

export type StocktakeCounts = {
  scope_total: number;
  sighted: number;
  scanned: number; // sightings proved by a scan
  unscanned: number; // ticked off by hand (destroyed sticker etc.)
  flagged: number; // sighted, but reported damaged / missing parts
  missing: number;
  found: number; // scans that matched no asset
};

/** The frozen artefact `:close` writes. `missing_truncated` is set when the missing list is longer than the
 *  snapshot cap, so a truncated report never reads as a complete one. */
export type StocktakeResult = {
  counts: StocktakeCounts;
  missing: MissingRow[];
  missing_truncated?: number;
  /** What the walk saw. Absent on counts closed before the sighted list was frozen. */
  sighted?: SightedRow[];
  sighted_truncated?: number;
  found: FoundEntry[];
  /** Assigned missing assets whose holder was NOT notified because the per-asset event cap was hit. */
  notify_truncated?: number;
};

/** Snapshot caps. A count over a huge inventory still closes; what it drops, it says it dropped. */
export const MISSING_SNAPSHOT_CAP = 500;
export const SIGHTED_SNAPSHOT_CAP = 500;
export const MISSING_EVENT_CAP = 100;

/** Parse a stored `scope_json`, tolerating anything (an old or hand-edited row must not break a close). */
export function parseScope(json: string | null | undefined): StocktakeScope {
  if (!json) return {};
  try {
    return normalizeScope(JSON.parse(json));
  } catch {
    return {};
  }
}

/** Keep only known statuses and non-empty category ids, deduped. Unknown values are dropped rather than
 *  rejected: a scope is a filter, and a filter naming something that cannot exist is just noise. */
export function normalizeScope(raw: unknown): StocktakeScope {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown, keep?: (s: string) => boolean) => {
    if (!Array.isArray(v)) return undefined;
    const out = [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))].filter((x) => !keep || keep(x));
    return out.length ? out : undefined;
  };
  const scope: StocktakeScope = {};
  const statuses = list(o.statuses, (s) => (COUNTABLE_STATUSES as string[]).includes(s));
  const categories = list(o.categories);
  if (statuses) scope.statuses = statuses;
  if (categories) scope.categories = categories;
  return scope;
}

/** The asset shape both the scope filter and the snapshot need. Internal ids, straight off the row. */
export type CountableAsset = {
  uuid: string;
  assetTag?: string | null;
  name: string;
  categoryId?: string | null;
  status: string;
  assignedTo?: string | null;
  verifiedAt?: Date | number | null;
  verifiedBy?: string | null;
  verifiedScanned?: boolean | null;
  custodyState?: string | null;
  deleteTime?: Date | number | null;
};

/** Is this asset one this walk is expected to sight? */
export function inScope(scope: StocktakeScope, a: CountableAsset): boolean {
  if (a.deleteTime) return false;
  if (scope.statuses && !scope.statuses.includes(a.status)) return false;
  if (scope.categories && !scope.categories.includes(a.categoryId ?? "")) return false;
  return true;
}

const ms = (d: Date | number | null | undefined) => (d == null ? null : d instanceof Date ? +d : +new Date(d));

/**
 * Was this asset sighted during the count?
 *
 * The test is the sighting TIME, not "does it carry this count's stamp": an asset whose holder acknowledged it
 * mid-walk was physically seen, and reporting it missing would be the less truthful answer. The stamp
 * (`last_stocktake_id`) records which count claimed the sighting, which is a different question.
 */
export function sightedIn(session: { startedAt: Date | number }, a: CountableAsset): boolean {
  const seen = ms(a.verifiedAt);
  return seen !== null && seen >= ms(session.startedAt)!;
}

/** The conditions that make a sighting worth a second look: seen, but not in one piece. */
export const FLAGGED_CONDITIONS: string[] = (["damaged", "missing_parts"] satisfies AssetCondition[]).slice();
const FLAGGED = FLAGGED_CONDITIONS;

/**
 * Score a count over the assets it can see: which are missing, and the numbers that summarise the walk.
 * `found` is the session's unexpected-scan log, carried through so the caller writes one snapshot.
 */
export function scoreStocktake(
  session: { startedAt: Date | number; scope: StocktakeScope },
  assets: CountableAsset[],
  found: FoundEntry[],
): { missing: CountableAsset[]; sighted: CountableAsset[]; counts: StocktakeCounts } {
  const scoped = assets.filter((a) => inScope(session.scope, a));
  const sighted = scoped.filter((a) => sightedIn(session, a));
  const scanned = sighted.filter((a) => a.verifiedScanned === true).length;
  return {
    missing: scoped.filter((a) => !sightedIn(session, a)),
    sighted,
    counts: {
      scope_total: scoped.length,
      sighted: sighted.length,
      scanned,
      unscanned: sighted.length - scanned,
      flagged: sighted.filter((a) => FLAGGED.includes(a.custodyState ?? "")).length,
      missing: scoped.length - sighted.length,
      found: found.length,
    },
  };
}

/** One missing asset, as the snapshot records it. Refs are internal ids - the outbound wire edge tokenizes them. */
export function missingRow(a: CountableAsset): MissingRow {
  const seen = ms(a.verifiedAt);
  return {
    asset: `assets/${a.uuid}`,
    asset_tag: a.assetTag ?? null,
    name: a.name,
    category: a.categoryId ? `asset-categories/${a.categoryId}` : null,
    status: a.status,
    assigned_to: a.assignedTo ? `employees/${a.assignedTo}` : null,
    last_verified_time: seen === null ? null : new Date(seen).toISOString(),
  };
}

/** One sighted asset, as the snapshot records it. Internal ids, like missingRow - the wire edge tokenizes. */
export function sightedRow(a: CountableAsset): SightedRow {
  const seen = ms(a.verifiedAt);
  return {
    asset: `assets/${a.uuid}`,
    asset_tag: a.assetTag ?? null,
    name: a.name,
    category: a.categoryId ? `asset-categories/${a.categoryId}` : null,
    status: a.status,
    assigned_to: a.assignedTo ? `employees/${a.assignedTo}` : null,
    sighted_time: seen === null ? null : new Date(seen).toISOString(),
    sighted_by: a.verifiedBy ? `employees/${a.verifiedBy}` : null,
    scanned: a.verifiedScanned === true,
    condition: a.custodyState ?? null,
  };
}

/** Parse a stored `found_json` (never throws - a broken log must not block a close). */
export function parseFound(json: string | null | undefined): FoundEntry[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((e) => e && typeof e === "object") as FoundEntry[]) : [];
  } catch {
    return [];
  }
}
