// Role identifiers + display labels. Authorization itself is capability-driven now: the server
// delivers the caller's capability set (users/me access.capabilities) and the UI gates on it via
// usePermission/<Can> (lib/perm.ts). This module only maps a role id to its human label.
export type Role = "everyone" | "employee" | "manager" | "hr_admin" | "payroll_admin" | "super_admin";

// Reserved rule-subject (the "allow everyone" primitive): grantable in the ACL UI, never assignable to a user.
export const EVERYONE_ROLE = "everyone";

export const ROLE_LABELS: Record<Role, string> = {
  everyone: "Everyone",
  employee: "Employee",
  manager: "Manager",
  hr_admin: "HR Admin",
  payroll_admin: "Payroll Admin",
  super_admin: "Super Admin",
};

// Roles are a collection, so the set is open: an org can create its own beside the six seeded ones, and each
// carries a human `label` of its own. Every surface that renders a rule subject has only the role NAME to
// hand (an access rule stores `subject: "e2e_deny_1849"`, never the label), so without this the ACL editor,
// the rule list and every confirm dialog fall back to the machine name. Whoever loads the roles collection
// registers what it saw; the map is a display cache, never an authorization input.
const customLabels = new Map<string, string>();

/** Teach `roleLabel` the labels of the roles just fetched. Call after any load of the `roles` collection. */
export function registerRoleLabels(roles: readonly { name?: string | null; label?: string | null }[]): void {
  for (const r of roles) {
    const label = r.label?.trim();
    if (r.name && label) customLabels.set(r.name, label);
  }
}

export function roleLabel(role: string | undefined): string {
  if (!role) return "-";
  return ROLE_LABELS[role as Role] ?? customLabels.get(role) ?? role;
}
