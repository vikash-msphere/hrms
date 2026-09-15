// The two questions an access review actually asks, neither of which anything answered before: which rules has
// nobody used, and which org-wide rules could be narrower.
//
// READS A COUNTER, NOT THE TRAIL. `decide()` returns the pattern that authorized a request and lib/audit.ts
// stamps it as `authorized_by` in the audit row's JSON `meta` - but rolling that up means matching inside JSON
// across `audit_log`, which grows with every action in the app. That is the scan docs/authz.md §12.2 rules out.
// So the counter is written beside the audit row instead (db/schema.ts `rule_usage`, one statement, same batch)
// and this reads it: two small indexed tables, whatever the trail's size.
//
// PATTERN GRANULARITY, and the report says so. `via` carries the pattern because by decision time the grant is a
// compiled projection and several rules can collapse into one (permissions.ts Decision.via). Rules are joined
// back to it by `access_rules.pattern`, which is stored VERBATIM as the decision input - so a pattern shared by
// three rules reports all three, and the reviewer narrows it by hand. Claiming per-rule precision here would be
// inventing it.
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { byIdChunks } from "../lib/dbBatch";
import { supportedScopesOf } from "../domain/manifests";
import type { Policy } from "../domain/manifests";

/** How far back "unused" looks. Ninety days is a review cycle; anything shorter reads a quiet month as disuse. */
export const REVIEW_WINDOW_DAYS = 90;

export type UnusedRule = {
  rule: string;
  subject: string;
  subject_kind: "role" | "user";
  pattern: string;
  level: string | null;
  /** When this PATTERN last authorized anything, or null if it never has. */
  last_used: string | null;
};

export type OverBroadRule = {
  rule: string;
  subject: string;
  subject_kind: "role" | "user";
  pattern: string;
  collection: string;
  hits: number;
  self_hits: number;
  dept_hits: number;
  /** The tier the observed usage would have fitted inside: `self` or `dept`. */
  narrower: "self" | "dept";
};

export type AccessReview = {
  window_days: number;
  unused: UnusedRule[];
  over_broad: OverBroadRule[];
  /**
   * What the numbers do NOT cover, carried in the response rather than left to the reader. Routine reads are
   * deliberately unaudited (volume - domain/manifests.ts AUDIT), so a rule with no hits has authorized no WRITE
   * and no SENSITIVE read; it may still be serving ordinary reads all day. That makes this a shortlist to
   * investigate, not a delete list, and a report that did not say so would invite exactly the wrong action.
   */
  caveat: string;
};

const CAVEAT =
  "Routine reads are not audited, so a rule with no recorded use has authorized no writes and no sensitive reads - it may still be serving ordinary reads. Treat these as a shortlist to check, not a delete list. Usage is counted per grant PATTERN, so rules that compile to the same pattern are reported together.";

/**
 * Live, authored ALLOW rules - the population a review is about.
 *
 * Denies are excluded because "this deny was never needed" is not a finding: a deny that never fires is doing
 * its job. Per-object rows (`match_code` set) are excluded too - they are shares on one record, created and
 * revoked by the feature that owns them, and listing thousands of them would bury the handful of scope rules a
 * human can actually act on. Pending rules have never been in force, so their silence means nothing.
 */
async function liveAllowRules(deps: Deps) {
  return deps.db
    .select({
      uuid: schema.accessRules.uuid,
      subject: schema.accessRules.subject,
      subjectKind: schema.accessRules.subjectKind,
      namespace: schema.accessRules.namespace,
      pattern: schema.accessRules.pattern,
      scopeKind: schema.accessRules.scopeKind,
      level: schema.accessRules.level,
    })
    .from(schema.accessRules)
    .where(
      and(
        eq(schema.accessRules.effect, "allow"),
        eq(schema.accessRules.status, "active"),
        eq(schema.accessRules.source, "acl"),
        isNull(schema.accessRules.matchCode),
      ),
    );
}

export async function accessReview(deps: Deps, policy: Policy): Promise<AccessReview> {
  const rules = await liveAllowRules(deps);
  if (!rules.length) return { window_days: REVIEW_WINDOW_DAYS, unused: [], over_broad: [], caveat: CAVEAT };

  // Usage for exactly the patterns in play, chunked over D1's parameter ceiling (lib/dbBatch.ts). Fetching the
  // whole table instead would be simpler and would grow with every pattern the app has ever decided.
  const patterns = [...new Set(rules.map((r) => r.pattern))];
  const usage = new Map<string, { hits: number; selfHits: number; deptHits: number; lastUsedAt: Date }>();
  for (const row of await byIdChunks(patterns, (group) =>
    deps.db.select().from(schema.ruleUsage).where(inArray(schema.ruleUsage.pattern, group)),
  )) {
    usage.set(row.pattern, { hits: row.hits, selfHits: row.selfHits, deptHits: row.deptHits, lastUsedAt: row.lastUsedAt });
  }

  const cutoff = deps.clock.now().getTime() - REVIEW_WINDOW_DAYS * 86_400_000;
  const unused: UnusedRule[] = [];
  const overBroad: OverBroadRule[] = [];

  for (const r of rules) {
    const ref = `access-rules/${r.uuid}`;
    const u = usage.get(r.pattern);
    // Never used, or not used inside the window. Both are the same finding to a reviewer, and the row carries
    // `last_used` so they can tell the two apart without a second call.
    if (!u || u.lastUsedAt.getTime() < cutoff) {
      unused.push({
        rule: ref,
        subject: r.subject,
        subject_kind: r.subjectKind,
        pattern: r.pattern,
        level: r.level,
        last_used: u ? u.lastUsedAt.toISOString() : null,
      });
      continue;
    }
    // Org-wide, on a collection that offers something narrower, and every recorded hit fitted inside it. The
    // `self + dept === hits` test is deliberately strict: a collection-level request classifies nothing and
    // raises `hits` alone, so an unclassifiable request keeps the rule out of this list rather than producing a
    // recommendation the evidence does not support.
    if (r.scopeKind !== "all") continue;
    const tiers = supportedScopesOf(policy, r.namespace);
    const covered = u.selfHits + u.deptHits;
    if (covered === 0 || covered !== u.hits) continue;
    const narrower = u.deptHits === 0 && tiers.includes("self") ? "self" : tiers.includes("dept") ? "dept" : null;
    if (!narrower) continue;
    overBroad.push({
      rule: ref,
      subject: r.subject,
      subject_kind: r.subjectKind,
      pattern: r.pattern,
      collection: r.namespace,
      hits: u.hits,
      self_hits: u.selfHits,
      dept_hits: u.deptHits,
      narrower,
    });
  }

  // Loudest first: the rule with the most recorded use is the one whose breadth is doing the most work, and the
  // longest-idle rule is the one most likely to be stale.
  overBroad.sort((a, b) => b.hits - a.hits);
  unused.sort((a, b) => (a.last_used ?? "").localeCompare(b.last_used ?? ""));
  return { window_days: REVIEW_WINDOW_DAYS, unused, over_broad: overBroad, caveat: CAVEAT };
}
