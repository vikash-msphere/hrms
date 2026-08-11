// Reading a rule back: the ONE place the app turns a stored access rule into words, and the ONE place it
// judges whether a rule actually does anything. The authoring side (which rule to write) lives in
// accessRuleScope.ts; this is the reverse direction - sentences for the fine-rules table, the ACL modal's
// commit line and its conflict warnings, plus the dead-rule lint that flags rules the engine will never use.
// Pure functions over already-loaded rules: no requests, no server truth. The engine still decides; this
// only explains (and warns about) what was authored.
import { relativeFuture } from "@/lib/utils";
import { metaFor } from "./collectionMeta";
import { verbInfo } from "./verbMeta";
import { roleLabel, EVERYONE_ROLE } from "@/lib/roles";
import type { AccessRule } from "./permMatrix";

// Breadth of a scope, narrow -> broad. Only `all` is a true superset of every other tier: `dept` does not
// necessarily contain `self` for every collection, and `exact`/`subtree` are anchored to one object. The
// lint below leans on that conservatism - it would rather miss a dead rule than call a live one dead.
const BREADTH: Record<string, number> = { exact: 0, subtree: 1, self: 2, dept: 3, all: 4 };
const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** What the rule grants, in words: "read", "full (delete + purge)", "the Approve method", "creating". */
export function permPhrase(r: Pick<AccessRule, "collection" | "scope" | "level" | "verb" | "effect">): string {
  if (r.verb) return `the "${verbInfo(r.collection, r.verb).label}" method`;
  if (r.scope === "create") return "creating";
  if (r.effect === "deny") return "any access";
  return r.level === "admin" ? "full access (delete + purge)" : `${r.level ?? "read"} access`;
}

/** Which records the rule reaches, in words: "all leave requests", "their department's leave requests". */
export function wherePhrase(r: Pick<AccessRule, "collection" | "scope" | "scope_ref">): string {
  const meta = metaFor(r.collection);
  switch (r.scope) {
    case "self":
      return `their own ${meta.plural}`;
    case "dept":
      return `their department's ${meta.plural}`;
    case "exact":
      return `one ${meta.singular}`;
    case "subtree":
      return `one ${meta.singular} and everything below it`;
    case "create":
      return `new ${meta.plural}`;
    default:
      return meta.allPhrase ?? `all ${meta.plural}`;
  }
}

/**
 * The whole rule as one sentence - "HR can read their department's employees (bank-account field)". With
 * `subjectLabel` omitted it reads as a bare predicate ("can read …"), which is what the commit line on the
 * modal's Add button wants ("Grant: <sentence>").
 */
export function ruleSentence(r: AccessRule, subjectLabel?: string): string {
  const who = subjectLabel ?? (r.subject_kind === "role" ? roleLabel(r.subject) : "this person");
  const field = r.field ? ` (${r.field} field)` : "";
  const deny = r.effect === "deny";
  if (r.scope === "create") return `${who} ${deny ? "cannot create" : "can create"} ${metaFor(r.collection).plural}`;
  if (r.verb) return `${who} ${deny ? "cannot use" : "can use"} ${permPhrase(r)} on ${wherePhrase(r)}`;
  if (deny) return `${who} is denied all access to ${wherePhrase(r)}${field}`;
  return `${who} has ${permPhrase(r)} to ${wherePhrase(r)}${field}`;
}

/** "expires in 3d" / "expired" for a rule's expiry, or null when the rule is permanent. */
export function expiryLabel(expiresAt?: string): string | null {
  if (!expiresAt) return null;
  return +new Date(expiresAt) <= Date.now() ? "expired" : `expires ${relativeFuture(expiresAt)}`;
}

export type RuleFlag = { kind: "denied" | "shadowed" | "pending" | "expiring"; note: string };

// Does rule `a` cover everything rule `b` reaches? Only an org-wide rule is a true superset of another tier;
// same-tier rules cover each other. Object-anchored tiers must also name the same object.
function covers(a: AccessRule, b: AccessRule): boolean {
  if (a.scope === "all") return true;
  if (a.scope !== b.scope) return false;
  if (a.scope === "exact" || a.scope === "subtree") return a.scope_ref === b.scope_ref;
  return true;
}

// Same target dimension: same collection, same field, and both about the standard ladder or both about the
// same custom method (a deny on `approve` says nothing about read).
function sameTarget(a: AccessRule, b: AccessRule): boolean {
  return a.collection === b.collection && (a.field ?? "") === (b.field ?? "") && (a.verb ?? "") === (b.verb ?? "");
}

// Rules the same subject holds. A ROLE rule is also affected by the `everyone` pseudo-role, which the engine
// unions into every role - so an `everyone` deny kills a role's allow, and that is exactly the kind of silent
// dead rule this lint exists to surface.
function appliesToSameSubject(r: AccessRule, other: AccessRule): boolean {
  if (other.subject_kind !== r.subject_kind) return false;
  if (other.subject === r.subject) return true;
  return r.subject_kind === "role" && other.subject === EVERYONE_ROLE;
}

/**
 * Why this rule may do nothing. Two real failure modes, both invisible without a lint:
 *   • denied  - a deny covering the same target beats it outright (deny always wins).
 *   • shadowed - a broader allow already grants at least as much, so removing this one changes nothing.
 * Plus the lifecycle notes (pending approval, expiring soon) so one badge column answers "is this live?".
 */
export function ruleFlags(r: AccessRule, all: AccessRule[]): RuleFlag[] {
  const flags: RuleFlag[] = [];
  if (r.status === "pending") flags.push({ kind: "pending", note: "Awaiting approval - this rule grants nothing yet." });
  if (r.status === "pending_delete") flags.push({ kind: "pending", note: "Removal awaiting approval - still in force until approved." });
  const exp = expiryLabel(r.expire_time);
  if (exp) flags.push({ kind: "expiring", note: exp === "expired" ? "Expired - no longer in force." : `Temporary access: ${exp}.` });

  if (r.effect === "allow") {
    const deny = all.find((o) => o.path !== r.path && o.effect === "deny" && appliesToSameSubject(r, o) && sameTarget(r, o) && covers(o, r) && o.status !== "pending");
    if (deny) {
      flags.push({
        kind: "denied",
        note: `A deny on ${wherePhrase(deny)}${deny.subject !== r.subject ? ` (via the ${roleLabel(deny.subject)} role)` : ""} overrides this - a deny always wins, so this allow does nothing until that rule is removed.`,
      });
    }
    const mine = LEVEL_RANK[r.level ?? ""] ?? 0;
    const broader = all.find(
      (o) =>
        o.path !== r.path &&
        o.effect === "allow" &&
        o.subject_kind === r.subject_kind &&
        o.subject === r.subject &&
        sameTarget(r, o) &&
        o.status === "active" &&
        !o.expire_time &&
        covers(o, r) &&
        (BREADTH[o.scope] ?? 0) >= (BREADTH[r.scope] ?? 0) &&
        (o.scope !== r.scope || (LEVEL_RANK[o.level ?? ""] ?? 0) > mine) &&
        (LEVEL_RANK[o.level ?? ""] ?? 0) >= mine,
    );
    if (broader) flags.push({ kind: "shadowed", note: `Already covered by a broader rule (${permPhrase(broader)} to ${wherePhrase(broader)}), so this one adds nothing.` });
  }
  return flags;
}

/**
 * The deny that would make a NEW allow inert, for the author-time warning in the ACL modal (the lint above
 * judges rules that already exist; this judges the one about to be written). Returns the offending rule.
 */
export function denyBlocking(
  candidate: { subject_kind: "role" | "user"; subject: string; collection: string; scope: string; scope_ref?: string; field?: string; verb?: string },
  all: AccessRule[],
): AccessRule | undefined {
  const probe = { ...candidate, path: "", effect: "allow" } as AccessRule;
  return all.find((o) => o.effect === "deny" && appliesToSameSubject(probe, o) && sameTarget(probe, o) && covers(o, probe) && o.status !== "pending");
}
