import { invoke } from "@/api";
import type { AccessRule } from "./permMatrix";

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

export type CloneResult = {
  added: number;
  skipped: number;
  failed: number;
  source_total: number;
  /** Groups every audit entry the copy wrote - the whole copy replays as ONE act in the activity feed. */
  correlation_id: string;
  first_error?: string;
};

/**
 * Copy every rule one subject holds onto another, through `access-rules:clone` - ONE request, one act.
 *
 * The server still authors each rule through the normal create path (same validation, same four-eyes queue,
 * one audit entry per rule), and parks a single correlation id on all of them. This used to be a client loop
 * of N creates, which made a 40-rule copy 40 unrelated requests: 40 audit entries with nothing tying them
 * together, 40 notifications, and no way to answer "who copied HR onto this role, and when" from the trail.
 *
 * Additive: nothing on the target is removed, and a rule it already holds comes back counted as skipped, so
 * copying twice is safe.
 */
export async function cloneAccessRules(
  from: { kind: "role" | "user"; subject: string },
  to: { kind: "role" | "user"; subject: string },
): Promise<CloneResult> {
  return invoke<CloneResult>("access-rules", "clone", undefined, {
    from: { subject_kind: from.kind, subject: from.subject },
    to: { subject_kind: to.kind, subject: to.subject },
  });
}
