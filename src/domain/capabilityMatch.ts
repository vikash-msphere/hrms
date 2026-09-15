// How a capability string is matched against a capability SET, as one implementation.
//
// A dependency-free leaf on purpose. The rule is needed on both sides - the server asks it through
// `domain/access.ts#actorCan` on every coarse check, and the SPA asks it through `web/src/lib/perm.ts` to
// decide which affordances render at all ("hide, never disable") - and it used to exist as two byte-equivalent
// copies, each declaring itself a mirror of the other. Two copies of a rule is a rule that drifts; this one
// fails SAFE on drift (the client copy is UX-only and the server re-decides every request), which is why it
// was the footnote to the money helpers rather than a defect of its own, but there is nothing to buy by
// keeping it. `domain/access.ts` imports `./permissions`, `./manifests` and `../env`, none of which belong in
// the browser bundle - so the shared rule lives here, on its own, and both sides import this.

const LEVELS = new Set(["read", "write", "admin"]);

/**
 * Does `caps` (the server-computed, scope-stripped capability set) cover `capability`?
 *
 * Exact `"collection.action"`, with two wildcards:
 *   - the super_admin wildcard `"**.<action>"` / `"**.**"`, which matches every collection;
 *   - a collection's wildcard-verb rule (an access rule with `verb: "*"`, i.e. "every custom method of this
 *     collection"), which arrives as `"<collection>.**"`. A holder asking about ONE of those verbs must be
 *     answered yes, or the role granted everything sees fewer buttons than a role granted one verb by name.
 *     It says nothing about the read/write/admin ladder, which is a level grant and a separate rule - hence
 *     the `LEVELS` exclusion.
 */
export function hasCapability(caps: string[], capability: string): boolean {
  if (caps.includes(capability)) return true;
  const action = capability.split(".").pop() ?? "";
  if (caps.includes(`**.${action}`) || caps.includes("**.**")) return true;
  const dot = capability.lastIndexOf(".");
  return dot > 0 && !LEVELS.has(action) && caps.includes(`${capability.slice(0, dot)}.**`);
}
