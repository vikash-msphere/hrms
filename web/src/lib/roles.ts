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

export function roleLabel(role: string | undefined): string {
  if (!role) return "-";
  return ROLE_LABELS[role as Role] ?? role;
}
