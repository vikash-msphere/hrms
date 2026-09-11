// Stocktake helpers for the browser: the scope presets a count is started from, and the one rule that decides
// whether an asset counts as sighted in it.
//
// The presets live HERE and not on the server on purpose. What gets stored on the count is the resolved status
// LIST, so the server never has to share a definition of "in the office" with the client - it filters on what
// the row says. Renaming or re-cutting a preset therefore cannot change what an already-closed count meant.
// The sighted rule is the mirror of src/domain/stocktake.ts#sightedIn and is pinned against it by
// test/stocktakeScope.test.ts.

export type ScopePresetId = "office" | "people" | "active" | "all";

export const SCOPE_PRESETS: { id: ScopePresetId; label: string; hint: string; statuses?: string[] }[] = [
  {
    id: "office",
    label: "In the office",
    hint: "In stock, awaiting check-in, in repair. What you can actually walk up to and scan.",
    statuses: ["in_stock", "pending_verification", "repair"],
  },
  {
    id: "people",
    label: "With people",
    hint: "Assigned kit, including anything still waiting for its holder's scan.",
    statuses: ["pending_ack", "assigned"],
  },
  {
    id: "active",
    label: "Everything in use",
    hint: "Every asset except retired ones.",
    statuses: ["in_stock", "pending_verification", "repair", "pending_ack", "assigned"],
  },
  { id: "all", label: "Everything, retired included", hint: "The whole inventory, retired assets as well." },
];

export const scopeStatuses = (id: ScopePresetId): string[] | undefined => SCOPE_PRESETS.find((p) => p.id === id)?.statuses;

/** Which preset a stored scope matches, for display ("Custom" when somebody set the list by hand or by API). */
export function presetOf(scope: { statuses?: string[]; categories?: string[] } | undefined): string {
  const statuses = scope?.statuses;
  const match = SCOPE_PRESETS.find((p) => {
    if (!p.statuses) return !statuses?.length;
    if (!statuses || statuses.length !== p.statuses.length) return false;
    return p.statuses.every((s) => statuses.includes(s));
  });
  const base = match ? match.label : "Custom scope";
  return scope?.categories?.length ? `${base}, one category` : base;
}

/**
 * Was this asset sighted during the count?
 *
 * The test is the sighting TIME, not "does it carry this count's stamp": an asset whose holder acknowledged it
 * mid-walk was physically seen, and calling it missing would be the less truthful answer. `last_stocktake`
 * records which count claimed the sighting, which is a different question.
 */
export function sightedIn(session: { start_time?: string }, asset: { last_verified_time?: string }): boolean {
  if (!asset.last_verified_time || !session.start_time) return false;
  return Date.parse(asset.last_verified_time) >= Date.parse(session.start_time);
}

/** Wire-side mirror of the server's scope filter, so a walk and its report always describe the same set. */
export function inScopeWire(scope: { statuses?: string[]; categories?: string[] } | undefined, asset: { status?: string | null; category?: string | null }): boolean {
  if (scope?.statuses?.length && !scope.statuses.includes(asset.status ?? "")) return false;
  if (scope?.categories?.length && !scope.categories.includes(asset.category ?? "")) return false;
  return true;
}

export const daysSince = (iso?: string | null): number | null => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)) : null);

/**
 * How well the org actually knows where its things are, independent of any one count.
 *
 * This is the question a stocktake exists to answer and the one no single count can: a count says what
 * happened in one walk, while this says what the inventory as a whole can currently prove. `staleDays` is the
 * org's own window (settings/asset-tags custody.verify_stale_days), so "stale" means what the org said it means.
 */
export function inventoryConfidence(
  assets: { status?: string; last_verified_time?: string; last_verified_scanned?: boolean }[],
  staleDays: number,
): { total: number; fresh: number; stale: number; never: number; scanned: number; freshPct: number; proofPct: number } {
  // Retired kit is not part of "do we know where our things are": it is deliberately out of the inventory.
  const live = assets.filter((a) => a.status !== "retired");
  let fresh = 0;
  let stale = 0;
  let never = 0;
  let scanned = 0;
  for (const a of live) {
    const band = confidenceBand(a, staleDays);
    if (band === "never") never++;
    else if (band === "stale") stale++;
    else {
      fresh++;
      if (band === "proved") scanned++;
    }
  }
  const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
  return { total: live.length, fresh, stale, never, scanned, freshPct: pct(fresh, live.length), proofPct: pct(scanned, fresh) };
}

/** The bands the confidence numbers are made of. `proved` is a subset of fresh: sighted recently AND by a scan. */
export type ConfidenceBand = "proved" | "fresh" | "stale" | "never" | "retired";

/**
 * Which band one asset falls in - the rule the summary counts with AND the rule its drill-down list filters by,
 * so a tile that says 14 can never open a list of 13.
 */
export function confidenceBand(
  a: { status?: string; last_verified_time?: string; last_verified_scanned?: boolean },
  staleDays: number,
): ConfidenceBand {
  if (a.status === "retired") return "retired";
  const d = daysSince(a.last_verified_time);
  if (d === null) return "never";
  if (d > staleDays) return "stale";
  return a.last_verified_scanned !== false ? "proved" : "fresh";
}

/** The count a "since then" question should be asked of: the most recently closed one. */
export function lastClosed<T extends { status?: string; closed_time?: string }>(counts: T[]): T | undefined {
  return counts
    .filter((c) => c.status === "closed" && c.closed_time)
    .sort((a, b) => (b.closed_time ?? "").localeCompare(a.closed_time ?? ""))[0];
}

/** Asset paths a closed count could not find, for annotating the next walk ("missing last time too"). */
export function missingPaths(count: { result?: { missing?: { asset?: string }[] } } | undefined): Set<string> {
  return new Set((count?.result?.missing ?? []).map((m) => m.asset).filter((p): p is string => !!p));
}

export type ReconciledRow<M> = { row: M; sightedAt?: string; stillMissing: boolean };

/**
 * What became of a closed count's missing rows AFTERWARDS.
 *
 * A frozen missing list is the honest record of one walk, but on its own it ages into a list of things that
 * were probably found the next morning. Comparing each row against the asset's CURRENT last sighting turns it
 * back into a live question: these turned up, those are still unaccounted for. Costs nothing extra - the
 * assets are already loaded.
 */
export function reconcileMissing<M extends { asset?: string }>(
  count: { closed_time?: string; result?: { missing?: M[] } },
  assets: { path: string; last_verified_time?: string }[],
): { rows: ReconciledRow<M>[]; turnedUp: number; stillMissing: number } {
  const byPath = new Map(assets.map((a) => [a.path, a]));
  const closedAt = count.closed_time ? Date.parse(count.closed_time) : NaN;
  const rows = (count.result?.missing ?? []).map((row) => {
    const seen = row.asset ? byPath.get(row.asset)?.last_verified_time : undefined;
    // A sighting AFTER the count closed is the answer; one before it is the same stale date the row already has.
    const after = seen && !Number.isNaN(closedAt) && Date.parse(seen) > closedAt;
    return { row, sightedAt: after ? seen : undefined, stillMissing: !after };
  });
  return { rows, turnedUp: rows.filter((r) => !r.stillMissing).length, stillMissing: rows.filter((r) => r.stillMissing).length };
}
