// Role display labels. Authorization itself is capability-driven: the server delivers the caller's capability
// set (users/me access.capabilities) and the UI gates on it via usePermission/<Can> (lib/perm.ts). This module
// only maps a role name to the human label the org gave it.

// Reserved rule-subject (the "allow everyone" primitive): grantable in the ACL UI, never assignable to a user.
// Engine vocabulary, mirrored from src/domain/grants.ts EVERYONE_ROLE.
export const EVERYONE_ROLE = "everyone";

// Roles are data - an org creates, relabels and removes them in Access Management - so the SPA knows no role
// names or labels of its own. Every surface that renders a rule subject has only the role NAME to hand (an
// access rule stores `subject: "e2e_deny_1849"`, never the label), so whoever loads role rows registers what it
// saw: users/me brings the caller's own roles' labels (useMe.ts), and the roles collection brings the rest. The
// map is a display cache, never an authorization input.
const labels = new Map<string, string>();

/** Teach `roleLabel` the labels of the roles just fetched. Call after any load of role rows. */
export function registerRoleLabels(roles: readonly { name?: string | null; label?: string | null }[]): void {
  for (const r of roles) {
    const label = r.label?.trim();
    if (r.name && label) labels.set(r.name, label);
  }
}

export function roleLabel(role: string | undefined): string {
  if (!role) return "-";
  return labels.get(role) ?? role;
}
