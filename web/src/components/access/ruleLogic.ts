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
      // A subtree anchored to a DEPARTMENT is the named-department tier and reaches that department's rows,
      // which is a different sentence from "one <thing> and everything below it" - and the one an admin
      // reading the rules list is trying to check. The anchor's collection is on the ref, so they are
      // distinguishable without a second field.
      return r.scope_ref?.startsWith("departments/") ? `one department's ${meta.plural}` : `one ${meta.singular} and everything below it`;
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
/**
 * The per-rule GUARDS, in words: ", up to 50,000, within 30 days, from 198.51.100.0/24".
 *
 * Empty for the overwhelming majority of rules, which carry none. Read in the rule LIST rather than only in the
 * form that set them - a constraint nobody reviewing permissions can see is one nobody will notice is wrong.
 */
function limitPhrase(r: AccessRule): string {
  const parts: string[] = [];
  const c = r.condition as { op?: string; value?: number } | undefined;
  if (c && typeof c.value === "number") {
    const word = c.op === "lt" ? "under" : c.op === "gte" ? "from" : c.op === "gt" ? "over" : "up to";
    parts.push(`${word} ${c.value.toLocaleString()}`);
  }
  const w = r.window as { within_days?: number } | undefined;
  if (w && typeof w.within_days === "number") parts.push(`within ${w.within_days} days`);
  if (r.from_ip) parts.push(`from ${r.from_ip}`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

export function ruleSentence(r: AccessRule, subjectLabel?: string): string {
  const who = subjectLabel ?? (r.subject_kind === "role" ? roleLabel(r.subject) : "this person");
  const field = r.field ? ` (${r.field} field)` : "";
  const deny = r.effect === "deny";
  if (r.scope === "create") return `${who} ${deny ? "cannot create" : "can create"} ${metaFor(r.collection).plural}`;
  // The approval LIMIT, spelled out in the same sentence as the rest of the rule. A cap that only shows as a
  // number in a form the admin has already left is a cap nobody reviewing the list can see.
  const limit = limitPhrase(r);
  if (r.verb) return `${who} ${deny ? "cannot use" : "can use"} ${permPhrase(r)} on ${wherePhrase(r)}${limit}`;
  if (deny) return `${who} is denied all access to ${wherePhrase(r)}${field}`;
  return `${who} has ${permPhrase(r)} to ${wherePhrase(r)}${field}${limit}`;
}

/** "expires in 3d" / "expired" for a rule's expiry, or null when the rule is permanent. */
export function expiryLabel(expiresAt?: string): string | null {
  if (!expiresAt) return null;
  return +new Date(expiresAt) <= Date.now() ? "expired" : `expires ${relativeFuture(expiresAt)}`;
}

export type RuleFlag = { kind: "denied" | "shadowed" | "unlistable" | "pending" | "expiring"; note: string };

// The scopes whose compiled pattern needs a second token, and so cannot match the ONE-token key a list
// request is decided on (`leave-requests.read`). `all` compiles to `<collection>.**`, whose `**` matches zero
// trailing tokens, and `create` IS the bare one-token rule - those two reach the list; nothing else does.
// `reports` / `org` are the MANAGER CHAIN, and they belong here for exactly the same reason `self` and `dept`
// do: `<collection>.my-reports.**` is a two-token pattern, so it cannot match the one-token list key either.
// They were missing, so a chain grant authored anywhere but the ACL modal (the fine-rules editor, an import,
// the API) was the one row-scoped shape that got no warning - the rule reads every report's record and the
// page they are on still 403s.
const ROW_SCOPES = new Set(["self", "dept", "subtree", "exact", "reports", "org"]);

/**
 * Can this subject call the collection endpoint at all - the question every row-scoped rule silently depends
 * on? A rule that decides items correctly and cannot open the list is the most confusing shape in the whole
 * model, because nothing on screen says which half is missing.
 *
 * `everyone` counts for any subject (the engine unions it into every caller). A user's ROLE rules count too,
 * but only when the caller passes the role - the rule row itself does not carry it.
 */
export function reachesCollection(r: AccessRule, all: AccessRule[], subjectRole?: string): boolean {
  const inherited = [EVERYONE_ROLE, ...(r.subject_kind === "user" && subjectRole ? [subjectRole] : [])];
  return all.some(
    (o) =>
      o.collection === r.collection &&
      o.effect === "allow" &&
      o.status !== "pending" &&
      !o.verb &&
      !o.field &&
      (o.scope === "create" || o.scope === "all") &&
      ((o.subject_kind === r.subject_kind && o.subject === r.subject) || (o.subject_kind === "role" && inherited.includes(o.subject))),
  );
}

// Does rule `a` cover everything rule `b` reaches? Only an org-wide rule is a true superset of another tier;
// same-tier rules cover each other. Object-anchored tiers must also name the same object.
function covers(a: AccessRule, b: AccessRule): boolean {
  // `create` is not another tier of the row-scope ladder - it is a separate dimension, the way the standard
  // ladder and a custom method are in `targetCovers` below. `src/domain/policyValidate.ts` says so outright:
  // "scope=create gates collection-level creation; it takes no field or verb". Without this, the `all`
  // shortcut answered true against a create rule, and since `create` is absent from BREADTH the breadth test
  // passed trivially too - so any subject holding BOTH an all-scope write/admin allow AND a create allow on
  // the same collection (what a full-admin role looks like on any catalog) had its create rule badged "adds
  // nothing". Acting on that advice revokes the ability to add records, which is the one direction a lint
  // must not be wrong in.
  if ((a.scope === "create") !== (b.scope === "create")) return false;
  if (a.scope === "all") return true;
  if (a.scope !== b.scope) return false;
  if (a.scope === "exact" || a.scope === "subtree") return a.scope_ref === b.scope_ref;
  return true;
}

/** The wildcard verb: one rule standing for EVERY custom method on a collection. */
export const ALL_VERBS = "*";

// Does `o` speak about the same target as `r` - same collection, same field, and both about the standard
// ladder or both about the same custom method (a deny on `approve` says nothing about read)?
//
// DIRECTIONAL, because of the wildcard. A rule with `verb: "*"` covers every custom method, so it speaks
// about `approve`; a rule on `approve` does not speak about every method. Compared literally, a broad "all
// custom methods" rule matched nothing and so silenced nothing - neither the author-time lint nor the
// `denied` badge - while being exactly the rule most likely to be the one in the way. Every caller asks the
// same question, "does o cover r", so the argument order is the answer's order.
function targetCovers(o: AccessRule, r: AccessRule): boolean {
  if (o.collection !== r.collection || (o.field ?? "") !== (r.field ?? "")) return false;
  const ov = o.verb ?? "", rv = r.verb ?? "";
  if (ov === rv) return true;
  if (!ov || !rv) return false; // the standard ladder and a custom method are different dimensions
  return ov === ALL_VERBS;
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
export function ruleFlags(r: AccessRule, all: AccessRule[], subjectRole?: string): RuleFlag[] {
  const flags: RuleFlag[] = [];
  if (r.status === "pending") flags.push({ kind: "pending", note: "Awaiting approval - this rule grants nothing yet." });
  if (r.status === "pending_delete") flags.push({ kind: "pending", note: "Removal awaiting approval - still in force until approved." });
  const exp = expiryLabel(r.expire_time);
  if (exp) flags.push({ kind: "expiring", note: exp === "expired" ? "Expired - no longer in force." : `Temporary access: ${exp}.` });

  if (r.effect === "allow") {
    const deny = all.find((o) => o.path !== r.path && o.effect === "deny" && appliesToSameSubject(r, o) && targetCovers(o, r) && covers(o, r) && o.status !== "pending");
    if (deny) {
      flags.push({
        kind: "denied",
        note: `A deny on ${wherePhrase(deny)}${deny.subject !== r.subject ? ` (via the ${roleLabel(deny.subject)} role)` : ""} overrides this - a deny always wins, so this allow does nothing until that rule is removed.`,
      });
    }
    const mine = LEVEL_RANK[r.level ?? ""] ?? 0;
    // `appliesToSameSubject`, like the deny check above - not a direct subject comparison. The engine unions
    // the `everyone` pseudo-role into every caller BY CONSTRUCTION, so an `everyone` allow that already grants
    // read on the whole collection really does make every per-role read allow redundant, exactly as an
    // `everyone` deny really does kill a role's allow. Using it here is not a loosening; it is the same rule
    // the deny side already applies, on the side that was still comparing subjects literally and staying silent
    // while admins kept and maintained rules that change nothing.
    const broader = all.find(
      (o) =>
        o.path !== r.path &&
        o.effect === "allow" &&
        appliesToSameSubject(r, o) &&
        targetCovers(o, r) &&
        o.status === "active" &&
        !o.expire_time &&
        covers(o, r) &&
        (BREADTH[o.scope] ?? 0) >= (BREADTH[r.scope] ?? 0) &&
        (o.scope !== r.scope || (LEVEL_RANK[o.level ?? ""] ?? 0) > mine) &&
        (LEVEL_RANK[o.level ?? ""] ?? 0) >= mine,
    );
    if (broader) flags.push({ kind: "shadowed", note: `Already covered by a broader rule (${permPhrase(broader)} to ${wherePhrase(broader)}), so this one adds nothing.` });
    // The half-working rule: every individual record decides correctly and the LIST is refused, so the page
    // that shows those records is a 403 and nothing says why. Only row-scoped LEVEL rules can be in this
    // state - a verb rule grants an action rather than a view, and is left to the grantor.
    if (!r.verb && ROW_SCOPES.has(r.scope) && !reachesCollection(r, all, subjectRole)) {
      flags.push({
        kind: "unlistable",
        note: `This narrows WHICH ${metaFor(r.collection).plural} they reach, but nothing lets them open the list - so the page still refuses them. Pair it with read access to the collection.`,
      });
    }
  }
  return flags;
}

/**
 * The deny that would make a NEW allow inert, for the author-time warning in the ACL modal (the lint above
 * judges rules that already exist; this judges the one about to be written). Returns the offending rule.
 *
 * It shares `covers`, so it inherits the create/non-create split added there - and that is the answer the
 * ENGINE gives, not a convenience. `services/accessRules.ts#buildPattern` compiles a create rule to the bare
 * one-token `<collection>` pattern and says in as many words that it is "distinct from `<collection>.**`
 * (every object)", which is what an org-wide rule compiles to. So an org-wide deny does not bar creation, and
 * warning that it does would send the author looking for a rule that is not in the way.
 */
export function denyBlocking(
  candidate: { subject_kind: "role" | "user"; subject: string; collection: string; scope: string; scope_ref?: string; field?: string; verb?: string },
  all: AccessRule[],
): AccessRule | undefined {
  const probe = { ...candidate, path: "", effect: "allow" } as AccessRule;
  return all.find((o) => o.effect === "deny" && appliesToSameSubject(probe, o) && targetCovers(o, probe) && covers(o, probe) && o.status !== "pending");
}
