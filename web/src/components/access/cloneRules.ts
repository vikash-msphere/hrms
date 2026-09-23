import { create, invoke } from "@/api";
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

/**
 * Put back rules a failed edit has already deleted. Returns how many of them are in force again.
 *
 * WHY THIS EXISTS. Setting a cell is delete-then-create, and it has to be: the API keys one rule per
 * (subject, collection, scope), so the old rule must be gone before the replacement can exist. That makes a
 * failure BETWEEN the two halves a REMOVAL - the deletes are committed whether or not the create that
 * justifies them lands - and the surfaces that do this used to answer such a failure with "Could not update",
 * which reads as "nothing happened" while the subject has in fact just lost the access they had.
 *
 * An "already exists" refusal COUNTS AS RESTORED, and that is what makes this correct under four-eyes
 * approval as well as without it. With approval on, a delete only parks the rule as `pending_delete` and it
 * keeps working until a second admin approves, so nothing was removed and the re-create collides with the
 * rule that is still there. Reading that collision as success means this needs to know nothing about which
 * mode the org is in - the answer from the server is the same question, asked the only way that cannot go
 * stale.
 *
 * Best-effort by construction: it is called from a catch block that already has a failure to report, so a
 * rule that cannot be put back is counted rather than thrown, and the caller says how many are outstanding.
 */
export async function restoreAccessRules(rules: AccessRule[]): Promise<number> {
  let restored = 0;
  for (const r of rules) {
    try {
      await create("access-rules", ruleBody(r));
      restored++;
    } catch (e) {
      if (/already exists/i.test(String((e as Error).message))) restored++;
    }
  }
  return restored;
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
