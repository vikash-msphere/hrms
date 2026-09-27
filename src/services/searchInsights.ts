// Daily ⌘K usage counters (schema.searchInsights) - the evidence for tuning search: which queries find nothing
// (a missing synonym or noun), where in the list people find what they open (whether ranking works), and
// whether Ask answers. COUNTERS, never a log: one row per (day, kind, label), incremented in place, and nothing
// that names who searched.
//
// Best-effort everywhere. A counter that fails to land costs a number on a chart; a search that fails because
// its counter did would cost the search. Every entry point swallows its own error.
import { lt, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { genId } from "../lib/idCodec";
import { scrubIdentifiers } from "../domain/aiPolicy";

export type InsightKind = "zero" | "open" | "ask";

const RETAIN_DAYS = 30;
const MAX_LABEL = 60;
const OPEN_SOURCES = new Set(["keyword", "related", "local"]);
const ASK_OUTCOMES = new Set(["answered", "empty"]);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The label a zero-result query is counted under, or null when it must not be kept at all.
 *
 * A query is text somebody typed, and it can be a name, an email or a pasted id. Queries that found NOTHING
 * are rarely a colleague's name (every employee is indexed), but they can still be an outsider's, so the
 * conservative rules: no digits runs or statutory ids (the same scrub the AI layer uses), no email, short
 * enough to be a search rather than a paste, and folded to lower case with spaces collapsed.
 */
export function zeroLabel(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, " ");
  if (q.length < 3 || q.length > MAX_LABEL) return null;
  if (scrubIdentifiers(q) !== q || /@/.test(q)) return null;
  return q.toLowerCase();
}

/** `<source>:<bucket>` for an opened result - the position bucketed, so the counters stay few. */
export function openLabel(source: string, position: number): string | null {
  if (!OPEN_SOURCES.has(source) || !Number.isInteger(position) || position < 0) return null;
  const bucket = position === 0 ? "1" : position < 3 ? "2-3" : position < 10 ? "4-10" : "11+";
  return `${source}:${bucket}`;
}

export const askLabel = (outcome: string): string | null => (ASK_OUTCOMES.has(outcome) ? outcome : null);

/** Count one event. Never throws. */
export async function recordInsight(deps: Deps, kind: InsightKind, label: string | null): Promise<void> {
  if (!label) return;
  try {
    const now = deps.clock.now();
    await deps.db
      .insert(schema.searchInsights)
      .values({ uuid: genId(), day: dayOf(now.getTime()), kind, label, count: 1, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.searchInsights.day, schema.searchInsights.kind, schema.searchInsights.label],
        set: { count: sql`${schema.searchInsights.count} + 1`, updatedAt: now },
      });
  } catch (e) {
    console.error("search insight not recorded", e);
  }
}

/** Drop counters older than the retention window. Nightly; never throws. */
export async function pruneInsights(deps: Deps): Promise<number> {
  try {
    const cutoff = dayOf(deps.clock.now().getTime() - RETAIN_DAYS * 86_400_000);
    const gone = await deps.db.delete(schema.searchInsights).where(lt(schema.searchInsights.day, cutoff)).returning({ uuid: schema.searchInsights.uuid });
    return gone.length;
  } catch (e) {
    console.error("search insights prune failed", e);
    return 0;
  }
}
