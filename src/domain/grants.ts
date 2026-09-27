// Engine vocabulary for grants: the fail-closed empty grant, the reserved `everyone` subject, and the super
// wildcard test. None of this is policy. Who holds what is DATA: the `roles` and `access_rules` tables, edited
// in Access Management and seeded once from bootstrap/authz/.
import type { Grant } from "./permissions";

// Deny-all grant: the fail-closed default for a role with no policy (unknown / unconfigured role).
export const EMPTY_GRANT: Grant = { levels: {}, allow: [] };

// The unrestricted wildcard grant, as a pattern rather than as any role's data: it is what `isSuperGrant`
// recognises, and what the internal system actor (lib/systemActor.ts) carries.
export const SUPER_GRANT: Grant = { levels: { "**": "admin" }, allow: ["**"] };

// Reserved pseudo-role: a rule subject that applies to EVERY authenticated caller (the "allow everyone"
// primitive). It is a real `roles` row so the ACL UI can target it, but it is never assignable to a user
// (users.ts rejects it) - a user still holds exactly one real role. Its rules are unioned into each caller's
// authority at decide time (auth.ts / authz.ts), EXCEPT for super_admin (anyone holding the `**` wildcard),
// who is exempt so an `everyone` deny can never lock out the break-glass identity.
export const EVERYONE_ROLE = "everyone";

// Whether a grant confers the unrestricted super wildcard. Such a caller is exempt from `everyone` rules.
export function isSuperGrant(g: Grant): boolean {
  return g.levels["**"] != null || g.allow.includes("**");
}

/**
 * The role SUBJECTS a per-object rule lookup must fan out over for this caller: every role they hold, plus the
 * `everyone` pseudo-role.
 *
 * ONE DEFINITION, because there are eight call sites and they are the kind that drift. The expression was
 * written out at each of them, so adding secondary roles (db/schema.ts `user_roles`) meant changing all eight or
 * silently having per-object role rules stop applying to somebody's second role at whichever one was missed -
 * a fail-closed bug, but an invisible one: the share simply does not appear.
 *
 * `everyone` applies to every caller EXCEPT super (the `**` holder), who must stay unrestrictable - an
 * `everyone` DENY that could bind super would be a lockout of the break-glass identity.
 */
export function roleSubjectsOf(principal: { role: string; roles?: readonly string[] }, grant: Grant): string[] {
  // The PRIMARY role is the floor. Taking the array alone would mean a principal assembled without one - a test
  // fixture, a future code path that forgets - silently contributed NO role subjects, so every per-object role
  // rule stopped applying to them. That fails closed, which is the right direction and the wrong failure: the
  // share simply does not appear, with nothing to notice. The primary always belongs in the set anyway.
  const held = principal.roles?.length ? [...new Set(principal.roles)] : [principal.role];
  return isSuperGrant(grant) ? held : [...held, EVERYONE_ROLE];
}
