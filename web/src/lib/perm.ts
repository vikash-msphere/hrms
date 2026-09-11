import { createContext, useContext } from "react";

// UI gating against the server-computed capability set (users/me access.capabilities). Mirrors the
// backend's capabilitiesOf model: exact "collection.action", with the super_admin wildcard
// ("**.<action>" / "**.**") treated as match-all. THIS IS UX ONLY - the server enforces every request.
export function hasCapability(caps: string[], perm: string): boolean {
  if (caps.includes(perm)) return true;
  const action = perm.split(".").pop() ?? "";
  if (caps.includes(`**.${action}`) || caps.includes("**.**")) return true;
  // A wildcard-verb rule ("all custom methods of this collection", access rule verb:"*") arrives as the
  // capability `<collection>.**`, so a holder asking about ONE of those verbs has to be answered yes - else
  // the role that was granted everything sees fewer buttons than a role granted one verb by name. It says
  // nothing about the read/write/admin ladder, which is a level grant and a different rule.
  const dot = perm.lastIndexOf(".");
  if (dot > 0 && !LEVELS.has(action) && caps.includes(`${perm.slice(0, dot)}.**`)) return true;
  return false;
}
const LEVELS = new Set(["read", "write", "admin"]);

// The caller's capability set, provided once at the app root (from me.capabilities) so <Can>/usePermission
// don't need it prop-drilled.
export const CapabilitiesContext = createContext<string[]>([]);

export function useCapabilities(): string[] {
  return useContext(CapabilitiesContext);
}

export function usePermission(perm: string): boolean {
  return hasCapability(useCapabilities(), perm);
}

// Holds the `**` wildcard - the only grant collection stripScope never touches, so it is the one capability
// string no scoped grant (self, dept, or an explicit all-scope field grant) can also produce. Needed wherever
// a check must mean "every record, not just mine": e.g. "employees.bank-account.write" is true for EVERY
// role via its own self-service PII grant, so it can't tell a super_admin viewing a colleague's record apart
// from that colleague viewing their own - only the wildcard can.
export function useIsSuperAdmin(): boolean {
  const caps = useCapabilities();
  return caps.includes("**.write") || caps.includes("**.**");
}

// May the caller see the per-entity ACTIVITY trail — the broad `activity.read` cap (any collection) OR the
// per-collection `activity.<collection>.read` cap. UX only: the server still ANDs this with reading the record
// (a narrowed holder who opens the wrong record just gets an empty feed). Pass the record's collection (the
// first path segment) so a per-collection grant lights up only its own collection's affordance.
export function canSeeActivity(caps: string[], collection?: string): boolean {
  return hasCapability(caps, "activity.read") || (!!collection && hasCapability(caps, `activity.${collection}.read`));
}
export function useCanSeeActivity(collection?: string): boolean {
  return canSeeActivity(useCapabilities(), collection);
}

// "Manage access" permission (access-management mode). After the role/user unification there is ONE
// access-control resource (`access-rules`), so a single capability governs managing access for both roles
// and users; it gates the toggle and both modal tabs. Super passes via the ** wildcard. UX only - the
// backend still enforces every access-rules write.
export function useCanManageAccess(): boolean {
  return hasCapability(useCapabilities(), "access-rules.write");
}
