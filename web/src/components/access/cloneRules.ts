import { create, invoke, remove } from "@/api";
import { fetchAllAccessRules, type AccessRule } from "./permMatrix";

// One access rule as the API's own create body - the shape export, import, restore and undo all speak, so a
// rule that round-trips through any of them lands identical.
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
    // The guards. Each one only SUBTRACTS from what the pattern grants, so a body without them would be a WIDER
    // rule than the one it was read from: a restore, an undo or an import would put back more access than was
    // taken away.
    ...(r.condition ? { condition: r.condition } : {}),
    ...(r.window ? { window: r.window } : {}),
    ...(r.from_ip ? { from_ip: r.from_ip } : {}),
  };
}

// A value as text with its object keys sorted, so two rule bodies compare equal whatever order they were built in.
export function stableText(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableText(o[k])}`).join(",")}}`;
}

// The parts of a body the server's duplicate check compares (services/accessRules.ts createAccessRule): the
// subject, the pattern those fields compile to, the effect and the approval limit. Level, expiry, fence and
// window are not among them - two rules differing only there are the same rule as far as a create is concerned.
const dedupKey = (b: Record<string, unknown>) =>
  stableText({ subject_kind: b.subject_kind, subject: b.subject, collection: b.collection, scope: b.scope, scope_ref: b.scope_ref ?? null, field: b.field ?? null, verb: b.verb ?? null, effect: b.effect ?? "allow", condition: b.condition ?? null });

const alreadyExists = (e: unknown) => /already exists/i.test(String((e as Error).message));

/**
 * Put back rules a failed edit has already deleted. Returns how many of them are in force again.
 *
 * WHY THIS EXISTS. Setting a cell is delete-then-create, and it has to be: the API keys one rule per
 * (subject, collection, scope), so the old rule must be gone before the replacement can exist. That makes a
 * failure BETWEEN the two halves a REMOVAL - the deletes are committed whether or not the create that
 * justifies them lands - and the surfaces that do this used to answer such a failure with "Could not update",
 * which reads as "nothing happened" while the subject has in fact just lost the access they had.
 *
 * It is correct under four-eyes approval as well as without it, and needs to know nothing about which mode
 * the org is in. With approval on, a delete only parks the rule as `pending_delete` and it keeps working until
 * a second admin decides; re-creating that rule exactly as it stands is the requester taking the removal back,
 * so the server puts the row back to `active` instead of queueing a copy. An "already exists" refusal COUNTS
 * AS RESTORED: the identical rule is in force already, which is what this was for.
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
      if (alreadyExists(e)) restored++;
    }
  }
  return restored;
}

// restoreAccessRules for ONE rule, answering with the rule now in force rather than a count - a caller that
// keeps editing needs the id the rule is back under. Null when it could not be put back.
async function putBack(r: AccessRule): Promise<AccessRule | null> {
  try {
    return await create<AccessRule>("access-rules", ruleBody(r));
  } catch (e) {
    if (!alreadyExists(e)) return null;
    const held = await fetchAllAccessRules({ subject_kind: r.subject_kind, subject: r.subject }).catch(() => [] as AccessRule[]);
    return held.find((x) => stableText(ruleBody(x)) === stableText(ruleBody(r))) ?? r;
  }
}

/** What an edit left in force: the replacement, or - when it failed - the rule as it was, and why. */
export type ReplaceResult =
  | { ok: true; rule: AccessRule }
  // `rule` is the original, possibly back under a new id; null only when it was removed and could not be put back.
  | { ok: false; error: string; rule: AccessRule | null };

/**
 * Edit one rule. There is no PATCH (routes/accessRules.ts says why): an edit is the old rule's removal plus the
 * new rule's create, two auditable events, and this is the order that makes a failure between them harmless.
 *
 * CREATE FIRST. The server checks a body - grammar, the author's own authority, the subject guards - before it
 * looks for a duplicate, so the create doubles as the dry run: a body it refuses comes back refused while the old
 * rule is still untouched, and the reader can fix the form and save again. Only a body that passes AND collides
 * with the rule being edited (one that keeps its pattern: a new level, expiry, fence or window) has to take the
 * old rule out first, and that path puts it back if the create still fails. A collision with some OTHER rule is
 * the answer itself - the subject already holds what the edit asks for - and touches nothing.
 */
export async function replaceAccessRule(old: AccessRule, body: Record<string, unknown>): Promise<ReplaceResult> {
  const message = (e: unknown) => String((e as Error).message);
  let created: AccessRule;
  try {
    created = await create<AccessRule>("access-rules", body);
  } catch (e) {
    if (!alreadyExists(e) || dedupKey(body) !== dedupKey(ruleBody(old))) return { ok: false, error: message(e), rule: old };
    try {
      await remove(old.path, old.etag);
    } catch (e2) {
      return { ok: false, error: message(e2), rule: old };
    }
    try {
      return { ok: true, rule: await create<AccessRule>("access-rules", body) };
    } catch (e3) {
      return { ok: false, error: message(e3), rule: await putBack(old) };
    }
  }
  try {
    await remove(old.path, old.etag);
    return { ok: true, rule: created };
  } catch (e) {
    // The new rule is in and the old one would not come out: take the new one back, so the edit either happened
    // or did not rather than leaving the subject holding both.
    const undone = await remove(created.path, created.etag).then(() => true, () => false);
    return { ok: false, error: undone ? message(e) : `${message(e)} - and the new rule could not be taken back, so both are in place`, rule: old };
  }
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
