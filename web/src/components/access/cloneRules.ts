import { create } from "@/api";
import { fetchAllAccessRules, type AccessRule } from "./permMatrix";

// One access rule as the API's own create body - the shape export, import and clone all speak, so a rule that
// round-trips through any of them lands identical.
export function ruleBody(r: AccessRule) {
  return {
    subject_kind: r.subject_kind,
    subject: r.subject,
    collection: r.collection,
    scope: r.scope,
    ...(r.scope_ref ? { scope_ref: r.scope_ref } : {}),
    ...(r.field ? { field: r.field } : {}),
    ...(r.verb ? { verb: r.verb } : r.level ? { level: r.level } : {}),
    ...(r.effect === "deny" ? { effect: "deny" } : {}),
    ...(r.expire_time ? { expire_time: r.expire_time } : {}),
  };
}

/**
 * Copy every rule one subject holds onto another, through the SAME create API (so the same validation,
 * four-eyes queue and audit trail apply - never a direct write). Additive: nothing on the target is removed.
 *
 * A rule the target already has comes back as a conflict; that one is counted as skipped rather than failing
 * the batch, so cloning twice is safe and the caller can report what actually landed.
 */
export async function cloneAccessRules(
  from: { kind: "role" | "user"; subject: string },
  to: { kind: "role" | "user"; subject: string },
  source?: AccessRule[],
): Promise<{ added: number; skipped: number }> {
  const all = source ?? (await fetchAllAccessRules());
  const mine = all.filter((r) => r.subject_kind === from.kind && r.subject === from.subject);
  let added = 0;
  let skipped = 0;
  for (const r of mine) {
    try {
      await create("access-rules", { ...ruleBody(r), subject_kind: to.kind, subject: to.subject });
      added++;
    } catch {
      // Already there, or not grantable to this subject kind. Counted, not thrown: one unrepeatable rule must
      // not abandon the other forty.
      skipped++;
    }
  }
  return { added, skipped };
}
